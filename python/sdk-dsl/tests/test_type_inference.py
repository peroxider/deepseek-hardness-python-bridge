"""PEP 484 → JSON Schema type inference.

The codegen reads `__annotations__` off decorated functions and methods; this
suite asserts the supported subset produces the right JSON Schema and TS
shapes (the TS side is mirrored here as the spec calls them out).

Note: tests deliberately omit `from __future__ import annotations` so PEP 484
type expressions are evaluated eagerly and the runtime `__annotations__`
mapping carries real type objects (not PEP 563 strings).
"""

import sys
from dataclasses import dataclass
from typing import Optional, Union

from dsh_bridge._type_inference import python_type_to_json_schema


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