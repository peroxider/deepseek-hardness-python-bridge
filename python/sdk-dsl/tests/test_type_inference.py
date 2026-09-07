"""PEP 484 → JSON Schema type inference.

The codegen reads `__annotations__` off decorated functions and methods; this
suite asserts the supported subset produces the right JSON Schema and TS
shapes (the TS side is mirrored here as the spec calls them out).

Note: tests in this module deliberately omit `from __future__ import
annotations` so PEP 484 type expressions are evaluated eagerly and the runtime
`__annotations__` mapping carries real type objects (not PEP 563 strings). The
PEP 563 case is covered separately via the `fixture_module/pep563_types.py`
fixture, whose annotations are resolved through `typing.get_type_hints`.
"""

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

import pytest

from dsh_bridge._type_inference import (
    _dataclass_schema,
    infer_tool_parameters,
    python_type_to_json_schema,
)

_FIXTURES = Path(__file__).resolve().parent / "fixture_module"


def _pep563_module():
    """Load the PEP 563 fixture module.

    The module is registered in `sys.modules` so `typing.get_type_hints` can
    resolve its annotations against the module's own globals.
    """
    name = "pep563_types"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, _FIXTURES / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def test_primitives():
    def f(a: int, b: float, c: bool, d: str, e: bytes) -> None:
        pass

    schema = python_type_to_json_schema(f.__annotations__)
    assert schema == {
        "a": {"type": "integer"},
        "b": {"type": "number"},
        "c": {"type": "boolean"},
        "d": {"type": "string"},
        "e": {"type": "string", "contentEncoding": "base64"},
    }


def test_collections():
    def f(a: list[int], b: dict[str, int], c: list[dict[str, int]]) -> None:
        pass

    schema = python_type_to_json_schema(f.__annotations__)
    assert schema == {
        "a": {"type": "array", "items": {"type": "integer"}},
        "b": {"type": "object", "additionalProperties": {"type": "integer"}},
        "c": {"type": "array", "items": {"type": "object", "additionalProperties": {"type": "integer"}}},
    }


def test_optional_and_union():
    def f(a: Optional[int], b: Union[int, str], c: int | None, d: int | str) -> None:
        pass

    schema = python_type_to_json_schema(f.__annotations__)
    assert schema["a"] == {"oneOf": [{"type": "integer"}, {"type": "null"}]}
    assert schema["b"] == {"oneOf": [{"type": "integer"}, {"type": "string"}]}
    assert schema["c"] == {"oneOf": [{"type": "integer"}, {"type": "null"}]}
    assert schema["d"] == {"oneOf": [{"type": "integer"}, {"type": "string"}]}


def test_dataclass():
    @dataclass
    class Point:
        x: int
        y: int
        label: Optional[str] = None

    def f(p: Point) -> None:
        pass

    schema = python_type_to_json_schema(f.__annotations__)
    assert schema["p"]["type"] == "object"
    assert schema["p"]["properties"] == {
        "x": {"type": "integer"},
        "y": {"type": "integer"},
        "label": {"oneOf": [{"type": "string"}, {"type": "null"}]},
    }
    assert set(schema["p"]["required"]) == {"x", "y"}


def test_pydantic_basemodel():
    import pytest

    pydantic = pytest.importorskip("pydantic")

    class Shape(pydantic.BaseModel):
        width: int
        height: int
        name: str | None = None

    def f(s: Shape) -> None:
        pass

    schema = python_type_to_json_schema(f.__annotations__)
    assert schema["s"]["type"] == "object"
    assert "properties" in schema["s"]


def test_unsupported_type_falls_back_to_string():
    """Unknown annotations are encoded as plain `string` to fail safe."""

    class Custom:
        pass

    def f(x: "Custom") -> None:  # forward reference
        pass

    # Forward references are not resolvable at runtime without the original
    # module namespace; the inference layer degrades to plain string.
    schema = python_type_to_json_schema(f.__annotations__)
    assert schema["x"] == {"type": "string"}


def test_python_310_union_syntax():
    if sys.version_info < (3, 10):
        import pytest

        pytest.skip("requires Python 3.10+")
    def f(x: int | str) -> None:
        pass
    schema = python_type_to_json_schema(f.__annotations__)
    assert schema["x"] == {"oneOf": [{"type": "integer"}, {"type": "string"}]}


def test_pep563_dataclass_resolves_string_annotations():
    """`from __future__ import annotations` stores raw annotation strings on
    `field.type`; the inference must resolve them instead of degrading every
    field to `string`."""
    module = _pep563_module()
    assert _dataclass_schema(module.Config) == {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "count": {"type": "integer"},
            "ratio": {"type": "number"},
            "tags": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["name", "count"],
    }


def test_pep563_dataclass_param_resolved_via_owner():
    """The `owner` argument lets the entry point resolve PEP 563 strings,
    including a nested dataclass parameter."""
    module = _pep563_module()
    schema = python_type_to_json_schema(module.build.__annotations__, owner=module.build)
    assert schema["config"]["type"] == "object"
    assert schema["config"]["properties"]["count"] == {"type": "integer"}
    assert schema["limit"] == {"oneOf": [{"type": "integer"}, {"type": "null"}]}


def test_pep563_strings_without_owner_degrade_to_string():
    """Without an owner there is no namespace to resolve strings against; the
    inference degrades to plain string rather than guessing."""
    module = _pep563_module()
    schema = python_type_to_json_schema(module.build.__annotations__)
    assert schema["config"] == {"type": "string"}
    assert schema["limit"] == {"type": "string"}


def test_pep563_unresolvable_forward_ref_degrades_gracefully():
    """A `TYPE_CHECKING`-style unimportable annotation fails wholesale hint
    resolution; fields degrade to `string` and requiredness survives."""
    module = _pep563_module()
    schema = _dataclass_schema(module.WithGhostRef)
    assert schema["properties"] == {
        "ok_count": {"type": "string"},
        "ghost": {"type": "string"},
    }
    assert schema["required"] == ["ok_count", "ghost"]


def test_infer_tool_parameters_helper_eager():
    """`infer_tool_parameters` returns the same per-parameter JSON Schema the
    helper would compute via `python_type_to_json_schema` for eagerly-evaluated
    annotations."""

    def f(a: int, b: str = "x") -> None:
        pass

    assert infer_tool_parameters(f) == {
        "a": {"type": "integer"},
        "b": {"type": "string"},
    }


def test_infer_tool_parameters_helper_pep563_via_owner():
    """The helper must pass `func` itself as the `owner` so PEP 563 string
    annotations resolve through the function's defining module globals —
    otherwise nested dataclasses degrade to `string`."""
    module = _pep563_module()
    schema = infer_tool_parameters(module.build)
    assert schema["config"]["type"] == "object"
    assert schema["config"]["properties"]["count"] == {"type": "integer"}
    assert schema["limit"] == {"oneOf": [{"type": "integer"}, {"type": "null"}]}


def test_infer_tool_parameters_helper_no_annotations_raises():
    """A function with no parameter annotations has nothing to infer from —
    the helper raises a clear error so authors get actionable feedback."""

    def f():
        return 42

    with pytest.raises(ValueError, match="cannot infer parameters"):
        infer_tool_parameters(f)