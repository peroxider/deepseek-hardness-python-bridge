"""Bridge metadata dataclasses and the process-global registry.

Decorators in `dsh_bridge` populate the registry at module-import time.
The codegen reads the registry offline; the runtime reads it when the
TypeScript side spawns the Python child process.

@module dsh_bridge._bridge_metadata
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from typing import ClassVar


@dataclass
class ProvideMethodMetadata:
    """One `@provide_method`-decorated function on a `@service` class."""

    name: str
    func: Callable[..., Any]
    timeout_ms: Optional[int] = None
    is_concurrency_safe: Optional[bool] = None


@dataclass
class ToolMetadata:
    """One `@tool`-decorated function."""

    name: str
    description: str
    parameters: dict
    output_schema: Optional[dict]
    timeout_ms: Optional[int]
    func: Callable[..., Any]


@dataclass
class OnMetadata:
    """One `@on`-decorated function."""

    event: str
    mode: str
    prepend: bool
    global_: bool
    func: Callable[..., Any]


@dataclass
class CapabilityMethodMetadata:
    """One `@method`-decorated function on a `@capability` class."""

    name: str
    func: Callable[..., Any]


@dataclass
class ServiceMetadata:
    """One `@service`-decorated class."""

    name: str
    settings_namespace: Optional[str]
    cls: type


@dataclass
class CapabilityMetadata:
    """One `@capability`-decorated class."""

    seam: str
    backend: str
    cls: type


@dataclass
class SystemPromptSectionMetadata:
    """One `@system_prompt_section`-decorated function."""

    order: int
    text: str
    func: Callable[..., Any]


@dataclass
class GuardMetadata:
    """One `@guard`-decorated function."""

    func: Callable[..., Any]


@dataclass
class RestrictToolsMetadata:
    """One `@restrict_tools`-decorated function."""

    allow: Optional[list[str]]
    deny: Optional[list[str]]
    func: Callable[..., Any]


@dataclass
class BridgeRegistry:
    """Process-global registry of bridge-decorated objects.

    Decorators populate this on import; the runtime and codegen read it after
    import to wire up the bridge. The registry is keyed by service/capability
    name for unique registrations and is list-typed for repeatable ones.
    """

    services: dict[str, ServiceMetadata] = field(default_factory=dict)
    provide_methods: list[ProvideMethodMetadata] = field(default_factory=list)
    tools: list[ToolMetadata] = field(default_factory=list)
    listeners: list[OnMetadata] = field(default_factory=list)
    capabilities: list[CapabilityMetadata] = field(default_factory=list)
    capability_methods: list[CapabilityMethodMetadata] = field(default_factory=list)
    prompt_sections: list[SystemPromptSectionMetadata] = field(default_factory=list)
    guards: list[GuardMetadata] = field(default_factory=list)
    restrictions: list[RestrictToolsMetadata] = field(default_factory=list)


# Process-global singleton; tests call reset_registry() to start clean.
_REGISTRY: BridgeRegistry | None = None


def get_registry() -> BridgeRegistry:
    """Return the process-global registry, creating it on first call."""
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = BridgeRegistry()
    return _REGISTRY


def reset_registry() -> None:
    """Clear the registry. Tests use this to isolate decorator side effects."""
    global _REGISTRY
    _REGISTRY = BridgeRegistry()


# Backwards-compatibility alias used by `__init__.py` re-exports.
BridgeMetadata = BridgeRegistry