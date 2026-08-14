# Decorator reference — `dsh_bridge`

Import from `dsh_bridge`. Every decorator returns the original callable unchanged: business code runs identically with or without the bridge.

## `@service(name, settings_namespace=None)` — class decorator

Marks a class as a `ctx.<name>` Service Provider. Convention: decorate a `@dataclass`; its fields become the generated `cordis.yml` config keys.

```python
from dataclasses import dataclass
from dsh_bridge import provide_method, service

@service(name="ml")
@dataclass
class MLProvider:
    model_path: str              # required config key: modelPath: z.string().required()
    batch_size: int = 32         # optional config key: batchSize, default 32
    precision: str = "float32"   # optional config key: precision, default "float32"
```

Field mapping rules (dataclass → generated Config):

- `model_path` → `modelPath` (snake_case → camelCase).
- No default → required (`z.<type>().required()`); with default → optional with `z.<type>().default(<value>)`; default `None` → optional, no default emitted.
- Annotation → type: `int`/`float` → `number`, `bool` → `boolean`, `str`/`bytes` → `string`, `list[T]` → `T[]`, `dict[str, T]` → `Record<string, T>`, `Optional[T]` / `T | None` → `T | null`, unions → `T | U`.
- The generated constructor maps config back to `initArgs` snake_case kwargs (`config.modelPath` → `model_path=`).
- Class-body fields must sit at the class indent level; method parameters in multi-line signatures are not fields (the parser filters by indent).
- Underscore-prefixed fields (`_cache: list = field(default_factory=list)`) are internal state by convention and never become config keys — no need to move them into `__post_init__`.

## `@provide_method(timeout_ms=None, is_concurrency_safe=None)` — method decorator

Each decorated method becomes a public TS method forwarding to Python:

```python
@provide_method(timeout_ms=10_000)
def embed(self, texts: list[str]) -> list[list[float]]:
    ...
```

- PEP 484 annotations drive the TS signature: `embed(texts: string[]): Promise<number[][]>`.
- Parameters with defaults become optional TS parameters.
- **TS callers pass positionally** — `service.embed(['a'])`, not `service.embed({texts: ['a']})`.
- Return values must be JSON-serializable (see pitfalls).

## `@tool(name, description, parameters, output_schema=None, timeout_ms=None)` — function decorator

Registers a model-facing tool. `parameters` is a per-property JSON Schema map; mark required fields with `"required": True` per property. Every object schema (parameters or output) must set `"additionalProperties": False` explicitly — the dsh-tools compiler rejects implicit ones.

```python
@tool(
    name="resize_image",
    description="Resize an image to the given dimensions.",
    parameters={
        "input_path": {"type": "string", "required": True},
        "width": {"type": "integer", "required": True},
    },
    output_schema={
        "type": "object",
        "additionalProperties": False,
        "properties": {"output_path": {"type": "string"}},
    },
)
def resize_image(input_path: str, width: int) -> dict:
    ...
```

- Tool functions are module-level. When a `@service` class exists in the same module, tools share the service's Python child process.
- To share the service's configuration, have the service register itself module-globally on construction and let tools fall back to env vars otherwise (the `lkb_dsh/bridge.py` pattern: `_ACTIVE_CORE` + `LKB_*` env).

## `@on(event, mode='emit', prepend=False, global_=False)` — function decorator

Registers a Cordis event listener. The generated TS registers `ctx.on(event, handler, { prepend, global })` and forwards each event to Python via `event/deliver`.

- `mode='waterfall'` generates a handler that calls `next()` (chain hygiene); the Python side is notified fire-and-forget — wire-level waterfall continuation is not implemented.
- Listener signature: `def listener(event: str, payload: dict) -> None`.

## `@capability(seam, backend)` / `@method(name)` — parsed but NOT emitted

The codegen parses these decorators but produces no generated code yet. Same for `@guard()`, `@restrict_tools()`, `@system_prompt_section()`. Do not rely on them in conversions until the emitter lands.

## Parser constraints (silently ignored when violated)

- Keyword arguments + at most one leading positional name only.
- No qualified calls (`@dsh_bridge.service(...)`) or import aliases (`from dsh_bridge import service as svc`).
- Python `#` comments inside decorator literals are handled; everything else exotic (f-strings, computed values) is not.
- One `@service` class per module; split additional services into separate modules.
