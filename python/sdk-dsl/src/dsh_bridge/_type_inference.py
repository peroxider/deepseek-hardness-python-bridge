"""PEP 484 annotation → JSON Schema inference (runtime projector).

When `@tool(..., parameters=None)` is omitted, or a `@service`-decorated
dataclass surfaces Config fields to the generic plugin, this module resolves
Python type hints into JSON Schema (per `spec-python-capability-bridge.md`
§5.6). The TypeScript codegen ships its own source-text projector
(`pythonTypeToTs` in `packages/bridge/python-bridge-codegen`) that covers the
same PEP 484 subset; the two implementations are independent — the codegen
never imports the Python module and vice versa.

@module dsh_bridge._type_inference
"""

from __future__ import annotations

import dataclasses
import sys
import types
import typing
from dataclasses import fields, is_dataclass
from typing import Any, Union, get_args, get_origin

# Subset of PEP 484 we currently support. New kinds must be added here AND to
# `spec-python-capability-bridge.md` §5.6 to keep the spec and the inference in
# sync.


_PRIMITIVE_SCHEMAS: dict[type, dict[str, Any]] = {
    int: {"type": "integer"},
    float: {"type": "number"},
    bool: {"type": "boolean"},
    str: {"type": "string"},
    bytes: {"type": "string", "contentEncoding": "base64"},
    type(None): {"type": "null"},
}


_UNION_ORIGINS = {Union}
if sys.version_info >= (3, 10):
    _UNION_ORIGINS.add(types.UnionType)


def _is_union_origin(origin: Any) -> bool:
    return origin in _UNION_ORIGINS


def _schema_for_annotation(value: Any) -> dict[str, Any]:
    """Return the JSON Schema fragment for one type expression."""
    if value in _PRIMITIVE_SCHEMAS:
        return dict(_PRIMITIVE_SCHEMAS[value])

    origin = get_origin(value)
    args = get_args(value)

    if origin in (list, typing.List):
        if not args:
            return {"type": "array"}
        return {"type": "array", "items": _schema_for_annotation(args[0])}

    if origin in (dict, typing.Dict):
        if len(args) != 2:
            return {"type": "object"}
        return {
            "type": "object",
            "additionalProperties": _schema_for_annotation(args[1]),
        }

    if _is_union_origin(origin):
        # Optional[T] / T | None / Union[T, U]
        if not args:
            return {}
        if len(args) == 2 and type(None) in args:
            other = next(a for a in args if a is not type(None))
            return {"oneOf": [_schema_for_annotation(other), {"type": "null"}]}
        return {"oneOf": [_schema_for_annotation(arg) for arg in args]}

    # Dataclass and pydantic.BaseModel shapes.
    if isinstance(value, type):
        if is_dataclass(value):
            return _dataclass_schema(value)
        if _is_pydantic(value):
            return _pydantic_schema(value)

    # String forward references or unknown annotations: degrade to plain string
    # so the inference never silently drops a field. The codegen reports the
    # degraded fields so authors can tighten annotations.
    return {"type": "string"}


_MISSING_SENTINEL = object()


def _resolved_type_hints(obj: Any) -> dict[str, Any]:
    """Resolve `obj`'s annotations to runtime types, PEP 563-safe.

    Under `from __future__ import annotations`, `field.type` / `__annotations__`
    hold the raw annotation strings (e.g. `"int"`), which the inference cannot
    interpret on its own; `typing.get_type_hints` evaluates them against the
    owner's module globals. Unresolvable forward references (e.g. a
    `TYPE_CHECKING`-only import) raise, so callers get `{}` back and degrade
    to the raw strings per field instead of crashing.
    """
    try:
        return typing.get_type_hints(obj)
    except Exception:  # noqa: BLE001
        return {}


def _dataclass_schema(cls: type) -> dict[str, Any]:
    hints = _resolved_type_hints(cls)
    properties: dict[str, Any] = {}
    required: list[str] = []
    for field in fields(cls):
        # Under PEP 563 `field.type` is the raw annotation string; prefer the
        # resolved hint and fall back to the raw string only when wholesale
        # resolution failed, so the field degrades instead of crashing.
        annotation = hints.get(field.name, field.type)
        try:
            properties[field.name] = _schema_for_annotation(annotation)
        except Exception:  # noqa: BLE001
            properties[field.name] = {"type": "string"}
        # `Optional[T]` / `T | None` defaults make the field non-required.
        origin = get_origin(annotation)
        if _is_union_origin(origin) and type(None) in get_args(annotation):
            continue
        # Default values (from `field.default` or `field.default_factory`) mean non-required.
        # `dataclasses.MISSING` is the canonical sentinel; comparing against the
        # singleton guarantees the field has neither default.
        has_default = field.default is not dataclasses.MISSING
        has_default_factory = field.default_factory is not dataclasses.MISSING
        if has_default or has_default_factory:
            continue
        required.append(field.name)
    return {"type": "object", "properties": properties, "required": required}


def _pydantic_schema(cls: type) -> dict[str, Any]:
    try:
        # Pydantic v2.
        model_json_schema = getattr(cls, "model_json_schema", None)
        if callable(model_json_schema):
            return model_json_schema()
    except Exception:  # noqa: BLE001
        pass
    # Fall back to a permissive object shape — the codegen surfaces the gap.
    return {"type": "object"}


def _is_pydantic(cls: type) -> bool:
    base = getattr(cls, "__base__", None)
    while base is not None:
        mod = getattr(base, "__module__", "")
        name = base.__name__
        if mod.startswith("pydantic") and name in {"BaseModel", "RootModel"}:
            return True
        base = getattr(base, "__base__", None)
    return False


def python_type_to_json_schema(
    annotations: dict[str, Any], *, owner: Any = None
) -> dict[str, dict[str, Any]]:
    """Project a `__annotations__` mapping onto a per-parameter JSON Schema dict.

    @param annotations - a function's `__annotations__` mapping.
    @param owner - optional object the annotations were declared on (function,
                   class, or module). Under `from __future__ import annotations`
                   the mapping carries raw strings that only the owner's module
                   namespace can resolve; pass the owner so
                   `typing.get_type_hints` can evaluate them. Without an owner,
                   string annotations degrade to plain string schemas.
    @returns `{parameter_name: json_schema}` with one entry per declared parameter.
    """
    if owner is not None:
        hints = _resolved_type_hints(owner)
        if hints:
            annotations = hints
    out: dict[str, dict[str, Any]] = {}
    for name, annotation in annotations.items():
        if name == "return":
            continue
        out[name] = _schema_for_annotation(annotation)
    return out


def infer_tool_parameters(func: Any) -> dict[str, Any]:
    """Project a tool function's parameter annotations onto a JSON Schema dict.

    Thin wrapper around `python_type_to_json_schema` for the `@tool`
    decorator's default-parameter inference path. Raises a clear error when
    the function carries no parameter annotations the caller could rely on.

    @param func - the tool function whose signature supplies annotations.
    @returns `{parameter_name: json_schema}` with one entry per declared parameter.
    @raises ValueError when the function has no parameter annotations.
    """
    annotations = getattr(func, "__annotations__", None) or {}
    params = {k: v for k, v in annotations.items() if k != "return"}
    if not params:
        qualname = getattr(func, "__qualname__", repr(func))
        raise ValueError(
            f"dsh_bridge.tool: cannot infer parameters for {qualname!r} — "
            "the function carries no parameter annotations. Pass an explicit "
            "`parameters=...` JSON Schema or add type hints to the signature."
        )
    return python_type_to_json_schema(annotations, owner=func)