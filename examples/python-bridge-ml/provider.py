"""ML capability provider exposed through the Python Capability Bridge.

Decorators are the only additions; the underlying algorithms run untouched.
Codegen emits a TypeScript bridge package around this module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from dsh_bridge import on, provide_method, service, tool


@service(name="ml", settings_namespace="ml")
@dataclass
class MLProvider:
    """A minimal ML capability provider (mock embeddings + classification)."""

    model_path: str
    batch_size: int = 32
    precision: str = "float32"

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        # Real implementations call into sentence-transformers / numpy / torch;
        # here we keep the example self-contained.
        return [_fake_embedding(t) for t in texts]

    @provide_method(timeout_ms=5_000, is_concurrency_safe=True)
    def classify(self, image_b64: str, top_k: int = 5) -> list[dict]:
        return [{"label": f"class_{i}", "score": 1.0 - i * 0.1} for i in range(top_k)]


def _fake_embedding(text: str, dim: int = 768) -> list[float]:
    seed = sum(ord(c) for c in text) or 1
    return [math.sin((seed + i) * 0.001) for i in range(dim)]


@tool(
    name="resize_image",
    description="Resize an image to the given dimensions.",
    parameters={
        "input_path": {"type": "string", "required": True},
        "width": {"type": "integer", "required": True},
        "height": {"type": "integer", "required": True},
    },
    output_schema={
        "type": "object",
        # dsh-tools' JSON Schema compiler requires an explicit
        # additionalProperties on every object schema.
        "additionalProperties": False,
        "properties": {
            "output_path": {"type": "string"},
            "bytes_written": {"type": "integer"},
        },
    },
)
def resize_image(input_path: str, width: int, height: int) -> dict:
    from PIL import Image

    img = Image.open(input_path).resize((width, height))
    out = input_path.replace(".", f".{width}x{height}.")
    img.save(out)
    return {"output_path": out, "bytes_written": 0}


@on("session/event", mode="emit")
def audit_tool_call(event: str, payload: dict) -> None:
    """Audit-log every tool call invoked through the bridge."""
    if payload.get("type") == "tool/call":
        print(f"audit: tool call {payload.get('data', {}).get('name', '?')}")


@on("agent/status", mode="emit")
def observe_status(event: str, payload: dict) -> None:
    """Watch for agent lifecycle transitions."""
    status = payload.get("status") if isinstance(payload, dict) else None
    print(f"agent status: {status}")


if __name__ == "__main__":  # pragma: no cover
    # Local smoke test: load the provider, exercise one method, and inspect
    # the bridge registry the runtime will dispatch into.
    from dsh_bridge._bridge_metadata import get_registry

    provider = MLProvider(model_path="/tmp/model", batch_size=8)
    print("registry services:", list(get_registry().services))
    print("registry tools:", [t.name for t in get_registry().tools])
    print("registry listeners:", [l.event for l in get_registry().listeners])
    print("first embedding dim:", len(provider.embed(["hello"])[0]))