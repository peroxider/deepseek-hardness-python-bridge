"""Runtime coverage: framing, dispatch, error mapping, initialize handshake."""

import io
import json
import threading

import pytest

import dsh_bridge
from dsh_bridge import on, provide_method, service, tool
from dsh_bridge._bridge_metadata import get_registry, reset_registry
from dsh_bridge._errors import (
    BRIDGE_ERROR_KIND_MAP,
    TimeoutBridgeError,
    classify_exception,
)
from dsh_bridge.runtime import (
    _Dispatcher,
    _Router,
    _Server,
    _StdioTransport,
    SERVER_INFO_NAME,
    parse_args,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _InMemoryStdio:
    """A minimal in-memory replacement for stdin/stdout."""

    def __init__(self) -> None:
        self._buffer = io.StringIO()
        self._lock = threading.Lock()

    def write(self, data: str) -> None:
        with self._lock:
            self._buffer.write(data)

    def flush(self) -> None:
        pass

    def read_lines(self) -> list[str]:
        with self._lock:
            value = self._buffer.getvalue()
        return [line for line in value.split("\n") if line]


def _build_transport(inp: io.StringIO, out: io.StringIO) -> _StdioTransport:
    transport = _StdioTransport(stdin=inp, stdout=out)
    return transport


def _build_request(method: str, params: dict | None = None, request_id: str = "r1") -> str:
    message = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    return json.dumps(message, separators=(",", ":")) + "\n"


def _build_notification(method: str, params: dict | None = None) -> str:
    message = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        message["params"] = params
    return json.dumps(message, separators=(",", ":")) + "\n"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_registry()
    yield
    reset_registry()


def test_parse_args_defaults():
    args = parse_args(["my.module"])
    assert args.module == "my.module"
    assert args.class_name is None
    assert args.functions == []
    assert args.max_threads == 8


def test_parse_args_full():
    args = parse_args(
        [
            "my.module",
            "--class",
            "Provider",
            "--function",
            "extra1",
            "--function",
            "extra2",
            "--max-threads",
            "4",
            "--init-args",
            '{"a": 1}',
        ]
    )
    assert args.class_name == "Provider"
    assert args.functions == ["extra1", "extra2"]
    assert args.max_threads == 4
    assert args.init_args_json == '{"a": 1}'


def test_router_records_provide_methods():
    @service(name="ml")
    class Provider:
        @provide_method(timeout_ms=10)
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.0] for _ in texts]

    router = _Router(get_registry(), Provider(), [])
    router.build()

    route = router.lookup("embed")
    assert route is not None
    assert route.timeout_ms == 10
    assert router.methods() == ["embed"]


def test_router_records_tools():
    @tool(name="echo", description="", parameters={})
    def echo(x: str) -> str:
        return x

    router = _Router(get_registry(), None, [])
    router.build()

    route = router.lookup("echo")
    assert route is not None
    assert route.func("hi") == "hi"


def test_stdio_transport_downgrades_unserializable_result_to_error_frame():
    """A success response whose result cannot be JSON-serialized must not hang
    the peer: the transport downgrades it to an -32603/exception error frame."""

    class NotSerializable:
        pass

    sink = io.StringIO()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=sink)
    transport.respond("id1", {"value": NotSerializable()})

    frames = [json.loads(line) for line in sink.getvalue().split("\n") if line]
    assert len(frames) == 1
    assert frames[0]["id"] == "id1"
    assert frames[0]["error"]["code"] == -32603
    assert frames[0]["error"]["data"] == {"kind": "exception"}
    assert "not JSON-serializable" in frames[0]["error"]["message"]


def test_stdio_transport_writes_one_line_per_frame():
    sink = io.StringIO()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=sink)
    transport.notify("ping", {"x": 1})
    transport.respond("id1", {"ok": True})
    transport.respond_error("id2", -32001, "boom", {"kind": "timeout"})

    lines = sink.getvalue().split("\n")
    assert len(lines) == 4  # 3 messages + trailing empty
    payloads = [json.loads(line) for line in lines if line]
    assert payloads[0] == {"jsonrpc": "2.0", "method": "ping", "params": {"x": 1}}
    assert payloads[1] == {"jsonrpc": "2.0", "id": "id1", "result": {"ok": True}}
    assert payloads[2] == {
        "jsonrpc": "2.0",
        "id": "id2",
        "error": {"code": -32001, "message": "boom", "data": {"kind": "timeout"}},
    }


def test_dispatcher_invokes_function_and_returns_result():
    @service(name="math")
    class Provider:
        @provide_method()
        def add(self, a: int, b: int) -> int:
            return a + b

    router = _Router(get_registry(), Provider(), [])
    router.build()
    sink = io.StringIO()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=sink)
    dispatcher = _Dispatcher(router, transport)

    dispatcher.dispatch("add", "r1", {"a": 1, "b": 2})
    dispatcher.shutdown()

    frames = [json.loads(line) for line in sink.getvalue().split("\n") if line]
    assert frames[0] == {"jsonrpc": "2.0", "id": "r1", "result": 3}


def test_dispatcher_surfaces_python_exception_as_wire_error():
    @service(name="math")
    class Provider:
        @provide_method()
        def boom(self) -> int:
            raise ValueError("nope")

    router = _Router(get_registry(), Provider(), [])
    router.build()
    sink = io.StringIO()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=sink)
    dispatcher = _Dispatcher(router, transport)

    dispatcher.dispatch("boom", "r1", {})
    dispatcher.shutdown()

    frames = [json.loads(line) for line in sink.getvalue().split("\n") if line]
    assert frames[0]["jsonrpc"] == "2.0"
    assert frames[0]["id"] == "r1"
    error = frames[0]["error"]
    assert error["code"] == -32004  # invalid-args
    assert error["data"] == {"kind": "invalid-args"}


def test_dispatcher_unknown_method_returns_minus_32601():
    router = _Router(get_registry(), None, [])
    router.build()
    sink = io.StringIO()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=sink)
    dispatcher = _Dispatcher(router, transport)

    dispatcher.dispatch("not-found", "r1", {})
    dispatcher.shutdown()

    frames = [json.loads(line) for line in sink.getvalue().split("\n") if line]
    assert frames[0]["error"]["code"] == -32601


def test_server_initialize_returns_manifest():
    @service(name="ml")
    class Provider:
        @provide_method(timeout_ms=10)
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.0] for _ in texts]

    @tool(name="resize", description="resize", parameters={})
    def resize(width: int, height: int) -> dict:
        return {"width": width, "height": height}

    @on("session/event", mode="emit")
    def listener(event: str, payload: dict) -> None:
        pass

    registry = get_registry()
    router = _Router(registry, Provider(), [])
    router.build()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=io.StringIO())
    dispatcher = _Dispatcher(router, transport)
    server = _Server(router, transport, dispatcher, registry)

    sink = io.StringIO()
    transport._stdout = sink  # redirect for assertion

    server._handle_frame(json.loads(_build_request("initialize", {}, request_id="i1")))

    frames = [json.loads(line) for line in sink.getvalue().split("\n") if line]
    assert frames[0]["id"] == "i1"
    result = frames[0]["result"]
    assert result["serverInfo"]["name"] == SERVER_INFO_NAME
    assert "embed" in result["manifest"]["methods"]
    assert "resize" in result["manifest"]["methods"]
    assert any(s["event"] == "session/event" for s in result["manifest"]["listeners"])


def test_server_handles_event_notification_for_registered_listener():
    captured: list[tuple[str, dict]] = []

    @on("session/event", mode="emit")
    def listener(event: str, payload: dict) -> None:
        captured.append((event, payload))

    registry = get_registry()
    router = _Router(registry, None, [])
    router.build()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=io.StringIO())
    dispatcher = _Dispatcher(router, transport)
    server = _Server(router, transport, dispatcher, registry)

    server._dispatch_notification(
        "event/deliver",
        {"event": "session/event", "payload": {"kind": "tool/call"}},
    )

    assert captured == [("session/event", {"kind": "tool/call"})]


def test_server_waterfall_listener_invokes_next_fn():
    captured: list[str] = []

    @on("session/event", mode="waterfall")
    def listener(event: str, payload: dict, next_fn) -> None:
        captured.append("before")
        next_fn()
        captured.append("after")

    registry = get_registry()
    router = _Router(registry, None, [])
    router.build()
    transport = _StdioTransport(stdin=io.StringIO(), stdout=io.StringIO())
    dispatcher = _Dispatcher(router, transport)
    server = _Server(router, transport, dispatcher, registry)

    server._dispatch_notification(
        "event/deliver",
        {
            "event": "session/event",
            "payload": {"next": lambda: captured.append("next")},
        },
    )

    assert captured == ["before", "next", "after"]


def test_classify_exception_maps_known_types():
    assert classify_exception(ValueError("x")) == (-32004, "invalid-args")
    assert classify_exception(KeyError("x")) == (-32005, "not-found")
    assert classify_exception(AttributeError("x")) == (-32005, "not-found")
    assert classify_exception(PermissionError("x")) == (-32003, "permission")
    assert classify_exception(ConnectionError("x")) == (-32010, "bridge-down")
    assert classify_exception(TimeoutError("x")) == (-32001, "timeout")
    assert classify_exception(Exception("x")) == (-32603, "exception")


def test_classify_exception_uses_bridge_error_kind():
    err = TimeoutBridgeError("deadline")
    assert classify_exception(err) == (-32603, "timeout")


def test_bridge_error_kind_map_is_complete():
    expected = {
        TimeoutError,
        PermissionError,
        ValueError,
        KeyError,
        AttributeError,
        ConnectionError,
    }
    assert expected.issubset(set(BRIDGE_ERROR_KIND_MAP.keys()))