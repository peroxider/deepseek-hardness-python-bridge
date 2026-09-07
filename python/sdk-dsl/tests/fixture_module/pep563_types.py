"""Fixture module exercising PEP 563 (`from __future__ import annotations`).

Every annotation in this module is stored as a raw string at runtime, so the
inference layer must resolve them via `typing.get_type_hints` to produce
correct JSON Schema types. `Ghost` is deliberately not importable: it stands
in for a `TYPE_CHECKING`-only import and asserts graceful per-field
degradation when wholesale resolution fails.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Config:
    name: str
    count: int
    ratio: float = 1.0
    tags: list[str] = field(default_factory=list)


def build(config: Config, limit: int | None = None) -> dict:
    return {"limit": limit}


@dataclass
class WithGhostRef:
    ok_count: int
    ghost: Ghost
