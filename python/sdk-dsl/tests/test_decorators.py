"""Decorator-side-effect coverage.

Each test isolates the bridge registry through `reset_registry()` so other
tests' decorators do not leak.
"""

from __future__ import annotations

import pytest

import dsh_bridge
from dsh_bridge import (
    capability,
    guard,
    method,
    on,
    provide_method,
    restrict_tools,
    service,
    system_prompt_section,
    tool,
)
from dsh_bridge._bridge_metadata import get_registry, reset_registry


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_registry()
    yield
    reset_registry()


def test_service_returns_class_unchanged():
    @service(name="ml")
    class Provider:
        pass

    assert Provider.__name__ == "Provider"
    assert get_registry().services["ml"].cls is Provider


def test_provide_method_records_metadata():
    @service(name="ml")
    class Provider:
        @provide_method(timeout_ms=1000, is_concurrency_safe=True)
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[0.0]]

    metadata = get_registry().provide_methods[0]
    assert metadata.name == "embed"
    assert metadata.timeout_ms == 1000
    assert metadata.is_concurrency_safe is True


def test_provide_method_requires_service_owner():
    with pytest.raises(ValueError):
        @provide_method()
        def free_function():
            pass


def test_tool_records_metadata():
    @tool(
        name="resize",
        description="resize an image",
        parameters={"width": {"type": "integer"}},
        output_schema={"type": "object"},
    )
    def resize(width: int) -> dict:
        return {"width": width}

    metadata = get_registry().tools[0]
    assert metadata.name == "resize"
    assert metadata.description == "resize an image"
    assert metadata.parameters == {"width": {"type": "integer"}}


def test_tool_rejects_duplicate_names():
    @tool(name="dup", description="", parameters={})
    def first():
        pass

    with pytest.raises(ValueError):
        @tool(name="dup", description="", parameters={})
        def second():
            pass


def test_on_records_listener_metadata():
    @on("session/event", mode="waterfall", prepend=True, global_=True)
    def listener(event: str, payload: dict, next_fn) -> None:
        next_fn()

    metadata = get_registry().listeners[0]
    assert metadata.event == "session/event"
    assert metadata.mode == "waterfall"
    assert metadata.prepend is True
    assert metadata.global_ is True


def test_on_rejects_invalid_mode():
    with pytest.raises(ValueError):
        @on("session/event", mode="nope")
        def listener(event: str, payload: dict) -> None:
            pass


def test_capability_method_records_metadata():
    @capability(seam="fs", backend="remote-s3")
    class Provider:
        @method(name="read")
        def read(self) -> bytes:
            return b""

    capabilities = get_registry().capabilities
    assert capabilities[0].seam == "fs"
    assert capabilities[0].backend == "remote-s3"
    assert get_registry().capability_methods[0].name == "read"


def test_capability_method_defaults_name_to_function_name():
    @capability(seam="fs", backend="remote-s3")
    class Provider:
        @method()
        def list_dir(self) -> list:
            return []

    assert get_registry().capability_methods[0].name == "list_dir"


def test_system_prompt_section_records_metadata():
    @system_prompt_section(order=10, text="prompt section text")
    def section() -> str:
        return "prompt section text"

    metadata = get_registry().prompt_sections[0]
    assert metadata.order == 10
    assert metadata.text == "prompt section text"


def test_guard_records_metadata():
    @guard()
    def policy(tool_call: dict) -> bool:
        return True

    assert get_registry().guards[0].func is policy


def test_restrict_tools_requires_at_least_one_field():
    with pytest.raises(ValueError):
        @restrict_tools()
        def policy():
            pass


def test_restrict_tools_records_metadata():
    @restrict_tools(allow=["a"], deny=["b"])
    def policy():
        pass

    metadata = get_registry().restrictions[0]
    assert metadata.allow == ["a"]
    assert metadata.deny == ["b"]


def test_decorator_returns_original_callable():
    @tool(name="echo", description="", parameters={})
    def echo(x):
        return x

    # The decorator must not wrap the function — runtime equality is the
    # spec contract (no Python business-code changes).
    assert echo("ok") == "ok"


def test_public_exports_match():
    expected = {
        "service",
        "provide_method",
        "tool",
        "on",
        "capability",
        "method",
        "system_prompt_section",
        "guard",
        "restrict_tools",
    }
    assert expected.issubset(set(dir(dsh_bridge)))