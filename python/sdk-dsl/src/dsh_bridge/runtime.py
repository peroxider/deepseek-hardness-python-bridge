"""`python -u -m dsh_bridge.runtime <module> [--class <ClassName>] [--function <name>]...`

Long-lived child process spawned by the TypeScript bridge. Imports the target
module, walks the bridge registry, and serves JSON-RPC 2.0 over stdio. The
framing matches `@deepseek-ai/dsh-sdk-protocol` `JsonRpcLineTransport`: one
compact JSON object per `\\n`-terminated line.

Wire method names:
- `initialize` — handshake; returns `serverInfo` + manifest of available methods.
- `<method>` — synchronous call to a `@provide_method` (the bare Python method
  name, e.g. `embed`).
- `<tool>` — synchronous call to a `@tool`-decorated function (the bare tool
  name, e.g. `resize_image`).
- `shutdown` — request graceful exit.
- Notifications from TS to Python:
    - `event/subscribe` — register an event stream; subsequent `event/deliver`
      notifications carry Cordis event payloads that the Python side routes
      into the matching `@on`-decorated listener.
    - `log/notify` — diagnostics the TypeScript side pushes into Python's logger.
- Notifications from Python to TS:
    - `bridge/log` — Python logging routed back to dsh's logger.

@module dsh_bridge.runtime
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import logging
import queue
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Optional

from ._bridge_metadata import (
    BridgeRegistry,
    CapabilityMethodMetadata,
    CapabilityMetadata,
    OnMetadata,
    ProvideMethodMetadata,
    ServiceMetadata,
    ToolMetadata,
    get_registry,
)
from ._errors import (
    BRIDGE_ERROR_KIND_MAP,
    PythonBridgeError,
    WorkerExitBridgeError,
    classify_exception,
)

# Resolved lazily to break the circular import (`dsh_bridge.runtime` is imported by
# `dsh_bridge.__init__`, which defines `__version__`).
def _bridge_version() -> str:
    import dsh_bridge
    return getattr(dsh_bridge, "__version__", "0.0.0.dev0")


SERVER_INFO_NAME = "dsh-python-bridge-runtime"

# Cap on the notification queue (per spec §6.7: drop after 1 MiB per event type).
_NOTIFY_QUEUE_MAX_BYTES = 1024 * 1024


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="dsh_bridge.runtime",
        description="Python capability bridge runtime: serves JSON-RPC over stdio.",
    )
    parser.add_argument("module", help="Python module path to import (e.g. my_pkg.provider).")
    parser.add_argument(
        "--class",
        dest="class_name",
        default=None,
        help="Optional class name to instantiate from the module after import.",
    )
    parser.add_argument(
        "--function",
        dest="functions",
        action="append",
        default=[],
        help="Optional function name to register as a top-level callable; repeatable.",
    )
    parser.add_argument(
        "--init-args",
        dest="init_args_json",
        default=None,
        help="Optional JSON object forwarded as keyword arguments to the class constructor.",
    )
    parser.add_argument(
        "--max-threads",
        dest="max_threads",
        type=int,
        default=8,
        help="Maximum worker threads for synchronous method execution (default: 8).",
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# Router — maps (service_name, method_name) and tool/capability keys onto
# registered callables discovered through the bridge registry.
# ---------------------------------------------------------------------------


@dataclass
class _Route:
    """One wire method's target callable and its timeout policy."""

    func: Callable[..., Any]
    is_async: bool
    timeout_ms: Optional[int]


class _Router:
    """Maps wire method names (`<service>.<method>`) to Python callables."""

    def __init__(
        self,
        registry: BridgeRegistry,
        instance: Any | None,
        extra_functions: list[Callable[..., Any]],
    ) -> None:
        self._registry = registry
        self._instance = instance
        self._extra_functions = extra_functions
        self._routes: dict[str, _Route] = {}
        self._disposers: list[Callable[[], None]] = []

    # -- Registration ----------------------------------------------------

    def build(self) -> None:
        if self._instance is not None:
            self._register_instance_methods()
        self._register_module_tools()
        self._register_module_listeners()
        self._register_extra_functions()

    def _register_instance_methods(self) -> None:
        """Bind `@provide_method` decorators that live on the instance class."""
        instance_class = type(self._instance)
        for metadata in self._registry.provide_methods:
            func = getattr(self._instance, metadata.func.__name__, None)
            if func is None:
                # Provide method lives on a different class — skip rather than fail.
                continue
            owner_qualname = getattr(metadata.func, "__qualname__", "")
            if owner_qualname and instance_class.__name__ not in owner_qualname:
                continue
            self._add_route(metadata.func.__name__, func, timeout_ms=metadata.timeout_ms)

    def _register_module_tools(self) -> None:
        for metadata in self._registry.tools:
            # The wire method name uses the function name (matching the
            # `@tool(name=...)` decorator's `name` when the names coincide),
            # so the TypeScript side calls the tool the model registered.
            self._add_route(metadata.name, metadata.func, timeout_ms=metadata.timeout_ms)

    def _register_module_listeners(self) -> None:
        # Listeners are registered here for documentation purposes; the actual
        # event routing happens in `_dispatch_event` based on per-listener
        # subscribe notifications from the TypeScript side.
        for metadata in self._registry.listeners:
            self._disposers.append(lambda m=metadata: None)

    def _register_extra_functions(self) -> None:
        for func in self._extra_functions:
            self._add_route(func.__name__, func)

    def _add_route(
        self,
        name: str,
        func: Callable[..., Any],
        *,
        timeout_ms: Optional[int] = None,
        prefix: str = "",
    ) -> None:
        route = _Route(func=func, is_async=asyncio.iscoroutinefunction(func), timeout_ms=timeout_ms)
        self._routes[f"{prefix}{name}"] = route

    # -- Lookup ----------------------------------------------------------

    def lookup(self, method: str) -> Optional[_Route]:
        return self._routes.get(method)

    def methods(self) -> list[str]:
        return sorted(self._routes.keys())

    def listener_methods(self) -> list[OnMetadata]:
        return list(self._registry.listeners)

    def capability_methods(self) -> list[CapabilityMethodMetadata]:
        return list(self._registry.capability_methods)

    def prompt_sections(self) -> list[dict[str, Any]]:
        return [
            {"order": m.order, "text": m.text, "function": m.func.__name__}
            for m in sorted(self._registry.prompt_sections, key=lambda m: m.order)
        ]


# ---------------------------------------------------------------------------
# Transport — newline-delimited JSON-RPC over stdio.
# ---------------------------------------------------------------------------


class _StdioTransport:
    """Reads JSON-RPC frames from stdin and writes responses to stdout.

    Frames follow the same shape as `@deepseek-ai/dsh-sdk-protocol`:
    `{"jsonrpc": "2.0", "id": <id>, "method": <m>, "params": {...}}` for requests,
    `{"jsonrpc": "2.0", "method": <m>, "params": {...}}` for notifications,
    `{"jsonrpc": "2.0", "id": <id>, "result": ...}` / `{"jsonrpc": "2.0", "id": <id>, "error": ...}`
    for responses.
    """

    def __init__(self, *, stdin=None, stdout=None) -> None:
        self._stdin = stdin if stdin is not None else sys.stdin
        self._stdout = stdout if stdout is not None else sys.stdout
        self._write_lock = threading.Lock()
        self._closed = threading.Event()

    def write(self, message: dict[str, Any]) -> None:
        if self._closed.is_set():
            return
        try:
            payload = json.dumps(message, separators=(",", ":")) + "\n"
        except TypeError:
            # A success response carrying a non-JSON-serializable result must
            # not hang the peer: downgrade to an error frame naming the fault.
            # Error frames themselves are built from plain types and always
            # serialize; if the offending message was already an error frame,
            # dropping it is the only remaining option.
            if "result" not in message:
                return
            payload = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "error": {
                        "code": -32603,
                        "message": "dsh_bridge: method result is not JSON-serializable",
                        "data": {"kind": "exception"},
                    },
                },
                separators=(",", ":"),
            ) + "\n"
        try:
            with self._write_lock:
                self._stdout.write(payload)
                self._stdout.flush()
        except (OSError, ValueError):
            self._closed.set()

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self.write(message)

    def respond(self, request_id: Any, result: Any) -> None:
        self.write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(
        self,
        request_id: Any,
        code: int,
        message: str,
        data: Any | None = None,
    ) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self.write({"jsonrpc": "2.0", "id": request_id, "error": error})

    def close(self) -> None:
        self._closed.set()


# ---------------------------------------------------------------------------
# Dispatch — invokes Python callables and surfaces exceptions through the wire.
# ---------------------------------------------------------------------------


class _Dispatcher:
    """Owns the worker thread pool and runs synchronous calls to bridged methods."""

    def __init__(
        self,
        router: _Router,
        transport: _StdioTransport,
        *,
        max_threads: int = 8,
    ) -> None:
        self._router = router
        self._transport = transport
        self._executor = ThreadPoolExecutor(max_workers=max_threads, thread_name_prefix="dsh-bridge-call")
        self._pending: dict[str, threading.Event] = {}

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=False)

    def dispatch(self, method: str, request_id: Any, params: dict[str, Any]) -> None:
        route = self._router.lookup(method)
        if route is None:
            self._transport.respond_error(request_id, -32601, f"method not found: {method}")
            return
        future = self._executor.submit(self._invoke, route, params)
        future.add_done_callback(lambda f, rid=request_id, m=method: self._on_complete(rid, m, f))

    def _invoke(self, route: _Route, params: dict[str, Any]) -> Any:
        try:
            return route.func(**(params or {}))
        except BaseException as exc:  # noqa: BLE001 — surfaced as wire error.
            self._propagate(exc)
            raise

    def _on_complete(self, request_id: Any, method: str, future) -> None:
        try:
            result = future.result()
        except BaseException as exc:  # noqa: BLE001
            code, kind = classify_exception(exc)
            message = str(exc) or exc.__class__.__name__
            data: Any | None = {"kind": kind}
            if isinstance(exc, PythonBridgeError) and exc.data is not None:
                data["detail"] = exc.data
            self._transport.respond_error(request_id, code, message, data)
            return
        self._transport.respond(request_id, result)

    def _propagate(self, exc: BaseException) -> None:
        # Sentinel for the loop: the exception re-raises inside the worker.
        if isinstance(exc, PythonBridgeError):
            return
        return


# ---------------------------------------------------------------------------
# Server — orchestrates the transport, router, dispatcher, and event routing.
# ---------------------------------------------------------------------------


class _Server:
    """Long-lived JSON-RPC server for the Python bridge runtime."""

    def __init__(
        self,
        router: _Router,
        transport: _StdioTransport,
        dispatcher: _Dispatcher,
        registry: BridgeRegistry,
    ) -> None:
        self._router = router
        self._transport = transport
        self._dispatcher = dispatcher
        self._registry = registry
        self._listeners: dict[str, list[OnMetadata]] = {}
        self._logger = logging.getLogger("dsh_bridge.runtime")
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopping = threading.Event()

    # -- Lifecycle -------------------------------------------------------

    def serve(self) -> int:
        """Run the server until stdin closes or `shutdown` is received."""
        self._loop = asyncio.new_event_loop()
        try:
            for line in self._stdin_lines():
                if line is None:
                    break
                try:
                    self._handle_frame(line)
                except Exception as exc:  # noqa: BLE001
                    self._logger.exception("bridge: frame handler failed: %s", exc)
        finally:
            self._stopping.set()
            self._dispatcher.shutdown()
            try:
                self._loop.close()
            except Exception:  # noqa: BLE001
                pass
        return 0

    def _stdin_lines(self):
        for raw in self._stdin_iter():
            line = raw.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # Per spec §6.5: malformed peer lines are ignored.
                continue

    def _stdin_iter(self):
        # Reads come from the transport's stdin handle so tests can inject an
        # in-memory stream alongside the in-memory stdout.
        for line in self._transport._stdin:
            if not line:
                return
            yield line

    # -- Frame dispatch --------------------------------------------------

    def _handle_frame(self, frame: dict[str, Any]) -> None:
        if not isinstance(frame, dict):
            return
        msg_id = frame.get("id")
        method = frame.get("method")
        params = frame.get("params") or {}
        if not isinstance(params, dict):
            params = {}

        if isinstance(msg_id, (str, int)) and isinstance(method, str):
            self._dispatch_request(msg_id, method, params)
            return
        if isinstance(method, str):
            self._dispatch_notification(method, params)
            return
        # Otherwise the frame is a response — servers don't consume them.

    def _dispatch_request(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        if method == "initialize":
            self._handle_initialize(request_id, params)
            return
        if method == "shutdown":
            self._transport.respond(request_id, {})
            self._stopping.set()
            self._transport.close()
            return
        # Special: capability methods use dotted names with backend.
        if "." in method and method.split(".", 1)[0] in {
            m.func.__qualname__.rsplit(".", 1)[0].rsplit(".", 1)[0]
            for m in self._registry.capability_methods
        }:
            self._dispatcher.dispatch(method, request_id, params)
            return
        self._dispatcher.dispatch(method, request_id, params)

    def _dispatch_notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "event/deliver":
            self._deliver_event(params)
            return
        if method == "log/notify":
            level = params.get("level")
            message = params.get("message", "")
            self._logger.log(self._level_for(level), "%s", message)
            return
        # Unknown notifications are ignored.

    # -- Initialize ------------------------------------------------------

    def _handle_initialize(self, request_id: Any, params: dict[str, Any]) -> None:
        server_info = {"name": SERVER_INFO_NAME, "version": _bridge_version()}
        manifest = {
            "services": [
                {"name": m.name, "class": m.cls.__name__}
                for m in self._registry.services.values()
            ],
            "provideMethods": [
                {"name": m.name, "timeoutMs": m.timeout_ms, "concurrencySafe": m.is_concurrency_safe}
                for m in self._registry.provide_methods
            ],
            "tools": [
                {"name": m.name, "description": m.description}
                for m in self._registry.tools
            ],
            "listeners": [
                {"event": m.event, "mode": m.mode, "prepend": m.prepend, "global": m.global_}
                for m in self._registry.listeners
            ],
            "capabilities": [
                {"seam": m.seam, "backend": m.backend, "class": m.cls.__name__}
                for m in self._registry.capabilities
            ],
            "capabilityMethods": [m.name for m in self._registry.capability_methods],
            "promptSections": self._router.prompt_sections(),
            "methods": self._router.methods(),
        }
        self._transport.respond(
            request_id,
            {"serverInfo": server_info, "manifest": manifest},
        )

    # -- Event routing ---------------------------------------------------

    def _deliver_event(self, params: dict[str, Any]) -> None:
        event = params.get("event")
        if not isinstance(event, str):
            return
        payload = params.get("payload") or {}
        # Find listeners registered for this event.
        for listener in self._registry.listeners:
            if listener.event != event:
                continue
            self._invoke_listener(listener, event, payload)

    def _invoke_listener(self, listener: OnMetadata, event: str, payload: Any) -> None:
        try:
            if listener.mode == "waterfall":
                next_fn = payload.get("next") if isinstance(payload, dict) else None
                if not callable(next_fn):
                    next_fn = lambda: None
                listener.func(event=event, payload=payload, next_fn=next_fn)
            else:
                listener.func(event=event, payload=payload)
        except Exception as exc:  # noqa: BLE001
            code, kind = classify_exception(exc)
            self._transport.notify(
                "bridge/log",
                {"level": "ERROR", "source": listener.func.__name__, "message": str(exc), "kind": kind, "code": code},
            )

    # -- Helpers ---------------------------------------------------------

    @staticmethod
    def _level_for(name: str | None) -> int:
        return {
            "DEBUG": logging.DEBUG,
            "INFO": logging.INFO,
            "WARN": logging.WARN,
            "WARNING": logging.WARNING,
            "ERROR": logging.ERROR,
            "FATAL": logging.FATAL,
            "CRITICAL": logging.CRITICAL,
        }.get((name or "INFO").upper(), logging.INFO)


# ---------------------------------------------------------------------------
# Logging bridge — Python logging routed back over the wire as `bridge/log`.
# ---------------------------------------------------------------------------


class _LoggingBridgeHandler(logging.Handler):
    """Routes Python logging records to the TypeScript bridge as `bridge/log`."""

    def __init__(self, transport: _StdioTransport) -> None:
        super().__init__()
        self._transport = transport

    def emit(self, record: logging.LogRecord) -> None:
        level = _LEVEL_NAMES.get(record.levelno, "INFO")
        source = record.name
        message = self.format(record)
        self._transport.notify(
            "bridge/log",
            {"level": level, "source": source, "message": message},
        )


_LEVEL_NAMES = {
    logging.DEBUG: "DEBUG",
    logging.INFO: "INFO",
    logging.WARN: "WARN",
    logging.WARNING: "WARN",
    logging.ERROR: "ERROR",
    logging.FATAL: "FATAL",
    logging.CRITICAL: "FATAL",
}


class _StdoutLogProxy:
    """Replaces `sys.stdout` during bridge service: user-code writes become
    `bridge/log` notifications so the protocol channel stays JSON-only.

    Lines buffer until a newline; a trailing partial line flushes on
    `flush()`. Writes are thread-safe against the transport's write lock.
    """

    def __init__(self, transport: _StdioTransport) -> None:
        self._transport = transport
        self._buffer = ""
        self._lock = threading.Lock()

    def write(self, data: str) -> int:
        with self._lock:
            self._buffer += data
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                if line:
                    self._transport.notify(
                        "bridge/log",
                        {"level": "INFO", "source": "stdout", "message": line},
                    )
        return len(data)

    def flush(self) -> None:
        with self._lock:
            if self._buffer:
                self._transport.notify(
                    "bridge/log",
                    {"level": "INFO", "source": "stdout", "message": self._buffer},
                )
                self._buffer = ""

    def isatty(self) -> bool:
        return False


# ---------------------------------------------------------------------------
# Module entry point.
# ---------------------------------------------------------------------------


def _resolve_extra_functions(module, names: list[str]) -> list[Callable[..., Any]]:
    found: list[Callable[..., Any]] = []
    for name in names:
        attr = getattr(module, name, None)
        if not callable(attr):
            raise ValueError(f"dsh_bridge.runtime: --function target {name!r} is not callable in module {module.__name__}")
        found.append(attr)
    return found


def _instantiate(module, class_name: str | None, init_args: dict[str, Any] | None) -> Any | None:
    if class_name is None:
        return None
    cls = getattr(module, class_name, None)
    if cls is None or not inspect.isclass(cls):
        raise ValueError(f"dsh_bridge.runtime: --class target {class_name!r} is not a class in module {module.__name__}")
    if init_args:
        return cls(**init_args)
    return cls()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # stdout is the protocol: capture the real stream for the transport before
    # replacing `sys.stdout` with a proxy that forwards user-code writes into
    # `bridge/log` notifications. This mirrors the SDK server's "stdout purity
    # is deployment-enforced" contract — the bridge enforces it in-process.
    protocol_stdout = sys.stdout

    registry = get_registry()
    module = importlib.import_module(args.module)
    init_args = json.loads(args.init_args_json) if args.init_args_json else {}
    instance = _instantiate(module, args.class_name, init_args)
    extra = _resolve_extra_functions(module, args.functions)

    router = _Router(registry, instance, extra)
    router.build()

    transport = _StdioTransport(stdout=protocol_stdout)
    sys.stdout = _StdoutLogProxy(transport)  # type: ignore[assignment]
    dispatcher = _Dispatcher(router, transport, max_threads=args.max_threads)
    server = _Server(router, transport, dispatcher, registry)

    # Route Python logging back to the bridge.
    handler = _LoggingBridgeHandler(transport)
    handler.setLevel(logging.DEBUG)
    logging.getLogger().addHandler(handler)
    if logging.getLogger().level == logging.NOTSET or logging.getLogger().level > logging.INFO:
        logging.getLogger().setLevel(logging.INFO)

    return server.serve()


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())