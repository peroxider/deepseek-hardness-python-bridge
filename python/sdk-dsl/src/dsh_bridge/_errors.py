"""Cross-language error vocabulary shared with the TypeScript bridge.

The TypeScript bridge maps Python exceptions to JSON-RPC error responses using
the same `kind` vocabulary as `packages/code-runtime/code-runtime-worker-thread`.
Each entry pairs an exception type with a JSON-RPC `code` and a string `kind`
that the TypeScript `PythonBridgeError` surfaces.

@module dsh_bridge._errors
"""

from __future__ import annotations

import asyncio
from typing import Any


# JSON-RPC error codes aligned with `spec-python-capability-bridge.md` §6.5.
class PythonBridgeError(Exception):
    """Base class for errors that originate inside the Python bridge process.

    The TypeScript `PythonBridgeError` carries a matching `kind` string from
    `BRIDGE_ERROR_KIND_MAP`; subclasses here provide the canonical mapping
    from a Python exception type to the wire vocabulary.
    """

    kind: str = "exception"

    def __init__(self, message: str, *, data: Any | None = None) -> None:
        super().__init__(message)
        self.data = data


class TimeoutBridgeError(PythonBridgeError):
    """`TimeoutError`: the call exceeded its deadline."""

    kind = "timeout"


class AbortBridgeError(PythonBridgeError):
    """`asyncio.CancelledError` / `CancelledError`: the call was aborted."""

    kind = "abort"


class PermissionBridgeError(PythonBridgeError):
    """`PermissionError`: the callee refused on policy grounds."""

    kind = "permission"


class InvalidArgsBridgeError(PythonBridgeError):
    """`ValueError`: the call arguments were invalid."""

    kind = "invalid-args"


class NotFoundBridgeError(PythonBridgeError):
    """`KeyError` / `AttributeError`: a referenced name was missing."""

    kind = "not-found"


class BridgeDownError(PythonBridgeError):
    """`ConnectionError`: the bridge transport is unavailable."""

    kind = "bridge-down"


class WorkerExitBridgeError(PythonBridgeError):
    """The Python child process exited during the call."""

    kind = "worker-exit"


# Maps Python exception classes to (jsonrpc_code, kind) per spec §6.5.
BRIDGE_ERROR_KIND_MAP: dict[type[BaseException], tuple[int, str]] = {
    TimeoutError: (-32001, "timeout"),
    asyncio.CancelledError: (-32002, "abort"),
    PermissionError: (-32003, "permission"),
    ValueError: (-32004, "invalid-args"),
    KeyError: (-32005, "not-found"),
    AttributeError: (-32005, "not-found"),
    ConnectionError: (-32010, "bridge-down"),
}


def classify_exception(exc: BaseException) -> tuple[int, str]:
    """Return the (jsonrpc_code, kind) pair for a Python exception.

    Subclasses of `PythonBridgeError` use their own `kind` and a fixed
    generic code; mapped built-in exceptions use the table; everything else
    falls through to `(-32603, "exception")`.
    """
    if isinstance(exc, PythonBridgeError):
        return (-32603, exc.kind)
    for cls, (code, kind) in BRIDGE_ERROR_KIND_MAP.items():
        if isinstance(exc, cls):
            return (code, kind)
    return (-32603, "exception")