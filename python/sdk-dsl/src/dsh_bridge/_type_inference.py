"""PEP 484 annotation → JSON Schema inference.

The codegen reads `__annotations__` off decorated functions and methods and
produces JSON Schema for both the TypeScript-side parameter typing and the
JSON-RPC payload validation. This module is the single source of truth for
the supported subset of PEP 484 (per `spec-python-capability-bridge.md` §5.6).

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


def _dataclass_schema(cls: type) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for field in fields(cls):
        annotation = field.type
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


def python_type_to_json_schema(annotations: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Project a `__annotations__` mapping onto a per-parameter JSON Schema dict.

    @param annotations - a function's `__annotations__` mapping.
    @returns `{parameter_name: json_schema}` with one entry per declared parameter.
    """
    out: dict[str, dict[str, Any]] = {}
    for name, annotation in annotations.items():
        if name == "return":
            continue
        out[name] = _schema_for_annotation(annotation)
    return out