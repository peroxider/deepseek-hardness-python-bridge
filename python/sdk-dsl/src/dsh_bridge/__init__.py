"""dsh-bridge: Python decorator library that lets a Python module expose itself
as a Cordis Service Provider / Tool Consumer / Event Listener / Capability
Provider through a generated TypeScript bridge.

Decorators are zero-side-effect at import time: each one returns the original
callable unchanged so business code runs unmodified when no bridge runtime is
attached. The bridge runtime (`dsh_bridge.runtime`) discovers and dispatches
decorated callables when the TypeScript side spawns the Python process.

@module dsh_bridge
"""

from __future__ import annotations

import logging

from ._bridge_metadata import (
    BridgeMetadata,
    BridgeRegistry,
    ServiceMetadata,
    ProvideMethodMetadata,
    ToolMetadata,
    OnMetadata,
    CapabilityMetadata,
    CapabilityMethodMetadata,
    SystemPromptSectionMetadata,
    GuardMetadata,
    RestrictToolsMetadata,
    get_registry,
    reset_registry,
)
from ._errors import PythonBridgeError, BRIDGE_ERROR_KIND_MAP

__version__ = "0.0.1"


def __getattr__(name: str):
    # `runtime` is imported lazily so `python -m dsh_bridge.runtime` does not
    # trigger the "module found in sys.modules" runpy warning.
    if name == "runtime":
        from . import runtime as _runtime

        return _runtime
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "service",
    "provide_method",
    "tool",
    "on",
    "capability",
    "method",
    "system_prompt_section",
    "guard",
    "restrict_tools",
    "PythonBridgeError",
    "BRIDGE_ERROR_KIND_MAP",
    "BridgeRegistry",
    "BridgeMetadata",
    "ServiceMetadata",
    "ProvideMethodMetadata",
    "ToolMetadata",
    "OnMetadata",
    "CapabilityMetadata",
    "CapabilityMethodMetadata",
    "SystemPromptSectionMetadata",
    "GuardMetadata",
    "RestrictToolsMetadata",
    "get_registry",
    "reset_registry",
    "runtime",
]


def service(name: str, settings_namespace: str | None = None):
    """Class decorator: marks a class as a `ctx.<name>` Service Provider.

    The decorator records a ServiceMetadata entry on the global bridge registry
    and returns the class unchanged. Codegen (`@deepseek-ai/dsh-python-bridge-codegen`)
    reads the registry to emit a TypeScript bridge package whose `Service`
    subclass forwards calls to a long-lived Python child process.

    @param name - the Cordis service key; the generated class is named `<Name>Service`.
    @param settings_namespace - optional settings namespace for `installSettingsSection`
                                integration (currently advisory; full integration is
        delivered in a follow-up).
    """

    def decorator(cls):
        registry = get_registry()
        existing = registry.services.get(name)
        if existing is not None and existing.cls is not cls:
            raise ValueError(
                f"dsh_bridge.service: duplicate service name {name!r} "
                f"(already registered on {existing.cls.__qualname__})"
            )
        metadata = ServiceMetadata(name=name, settings_namespace=settings_namespace, cls=cls)
        registry.services[name] = metadata
        return cls

    return decorator


def provide_method(*, timeout_ms: int | None = None, is_concurrency_safe: bool | None = None):
    """Method decorator inside a `@service`-decorated class: each decorated
    method becomes a public TypeScript method that forwards to the Python child
    over JSON-RPC.

    @param timeout_ms - optional per-call timeout in milliseconds; an absent value
                        defers to the call-site override (no built-in timeout).
    @param is_concurrency_safe - optional advisory flag the codegen surfaces
                                  alongside each generated method (true means
                                  the function is safe to call concurrently
                                  from multiple fibers; false or absent means
                                  serialization is the caller's responsibility).
    """

    def decorator(func):
        registry = get_registry()
        # Reject functions not defined as methods on a class. A plain module-level
        # `def` has no `.` in `__qualname__`; nested local functions do, so we
        # require at least two dots and a non-empty enclosing scope (class bodies
        # have `<ClassName>.<func_name>`; local functions have `<scope>.<locals>.<func_name>`).
        qualname = getattr(func, "__qualname__", "")
        if qualname.count(".") < 1 or qualname.split(".")[-2] == "<locals>":
            raise ValueError(
                f"dsh_bridge.provide_method: must decorate a method on a "
                f"@service-annotated class; got {qualname!r}"
            )
        metadata = ProvideMethodMetadata(
            name=func.__name__,
            func=func,
            timeout_ms=timeout_ms,
            is_concurrency_safe=is_concurrency_safe,
        )
        registry.provide_methods.append(metadata)
        func.__dsh_bridge_provide_method__ = metadata  # type: ignore[attr-defined]
        return func

    return decorator


def tool(
    *,
    name: str,
    description: str,
    parameters: dict,
    output_schema: dict | None = None,
    timeout_ms: int | None = None,
):
    """Function decorator: registers a function as a model-facing tool.

    The codegen emits `ctx.tools.register(defineTool({...}))` against this
    function's signature; the TypeScript side forwards `execute()` calls back
    to Python over JSON-RPC.

    @param name - the tool name registered with the tools service.
    @param description - the tool description rendered in the model prompt.
    @param parameters - JSON Schema describing the tool's input parameters.
    @param output_schema - optional JSON Schema describing the tool's output
                           (advisory; not enforced by the codegen).
    @param timeout_ms - optional per-call timeout in milliseconds.
    """

    def decorator(func):
        registry = get_registry()
        metadata = ToolMetadata(
            name=name,
            description=description,
            parameters=parameters,
            output_schema=output_schema,
            timeout_ms=timeout_ms,
            func=func,
        )
        existing = next((t for t in registry.tools if t.name == name), None)
        if existing is not None and existing.func is not func:
            raise ValueError(
                f"dsh_bridge.tool: duplicate tool name {name!r} "
                f"(already registered on {existing.func.__qualname__})"
            )
        registry.tools.append(metadata)
        func.__dsh_bridge_tool__ = metadata  # type: ignore[attr-defined]
        return func

    return decorator


def on(event_name: str, *, mode: str = "emit", prepend: bool = False, global_: bool = False):
    """Function decorator: registers a Cordis event listener.

    The codegen emits `ctx.on(event_name, handler, { mode, prepend, global })`
    against the wrapped function; the TypeScript side forwards emitted events
    to the Python child over JSON-RPC, calling the wrapped function for each.

    @param event_name - the fully-qualified event name (e.g. 'session/event').
    @param mode - listener dispatch mode; one of 'emit', 'waterfall', or
                  'session'. Defaults to 'emit'.
    @param prepend - if true, the listener is prepended to the registration
                     list rather than appended.
    @param global_ - if true, the listener is registered as a global listener
                     that runs before per-fiber ones.
    """

    if mode not in ("emit", "waterfall", "session"):
        raise ValueError(
            f"dsh_bridge.on: invalid mode {mode!r} "
            f"(expected one of 'emit', 'waterfall', 'session')"
        )

    def decorator(func):
        registry = get_registry()
        metadata = OnMetadata(
            event=event_name,
            mode=mode,
            prepend=prepend,
            global_=global_,
            func=func,
        )
        registry.listeners.append(metadata)
        func.__dsh_bridge_on__ = metadata  # type: ignore[attr-defined]
        return func

    return decorator


def capability(seam: str, backend: str):
    """Class decorator: replaces a capability seam provider.

    The codegen emits `ctx.<seam>.backend.register(backend, backendImpl)`
    against an instance of the decorated class; the TypeScript side forwards
    each `@method`-decorated call to the Python child.

    @param seam - the Cordis capability seam key (e.g. 'fs', 'shell', 'subprocess').
    @param backend - the backend identifier passed to `ctx.<seam>.backend.register`.
    """

    def decorator(cls):
        registry = get_registry()
        metadata = CapabilityMetadata(seam=seam, backend=backend, cls=cls)
        registry.capabilities.append(metadata)
        return cls

    return decorator


def method(*, name: str | None = None):
    """Method decorator inside a `@capability`-decorated class: each decorated
    method maps to one seam operation.

    @param name - the operation name exposed on the seam; defaults to the
                  Python method name.
    """

    def decorator(func):
        registry = get_registry()
        operation = name or func.__name__
        metadata = CapabilityMethodMetadata(name=operation, func=func)
        registry.capability_methods.append(metadata)
        func.__dsh_bridge_capability_method__ = metadata  # type: ignore[attr-defined]
        return func

    return decorator


def system_prompt_section(*, order: int, text: str):
    """Function decorator: registers a system prompt section.

    The codegen emits `ctx.systemPrompt.section({ order, text })` against the
    wrapped function; the wrapped function is also retained so a future
    dynamic-section expansion can call it during prompt assembly.

    @param order - section ordering key (lower numbers render first).
    @param text - the static section text.
    """

    def decorator(func):
        registry = get_registry()
        metadata = SystemPromptSectionMetadata(order=order, text=text, func=func)
        registry.prompt_sections.append(metadata)
        return func

    return decorator


def guard():
    """Method decorator: marks a method as a tool guard.

    The codegen emits `ctx.tools.guard(fn)` against the wrapped function; the
    function is called for every tool invocation and may veto or modify the
    request before the tool executes.
    """

    def decorator(func):
        registry = get_registry()
        metadata = GuardMetadata(func=func)
        registry.guards.append(metadata)
        func.__dsh_bridge_guard__ = metadata  # type: ignore[attr-defined]
        return func

    return decorator


def restrict_tools(*, allow: list[str] | None = None, deny: list[str] | None = None):
    """Decorator on a service method: registers a per-agent tool restriction.

    The codegen emits `ctx.tools.restrict({ allow, deny })` against the wrapped
    function; the function is called once per agent composition to compute the
    final allow/deny set.

    @param allow - optional list of tool names to allow (others denied).
    @param deny - optional list of tool names to deny (others allowed).
    """

    if allow is None and deny is None:
        raise ValueError("dsh_bridge.restrict_tools: at least one of 'allow' or 'deny' must be provided")

    def decorator(func):
        registry = get_registry()
        metadata = RestrictToolsMetadata(allow=allow, deny=deny, func=func)
        registry.restrictions.append(metadata)
        return func

    return decorator


# Module-level logger for diagnostics surfaced through the bridge notify channel.
logger = logging.getLogger("dsh_bridge")
