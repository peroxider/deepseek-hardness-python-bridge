# Adding a Python Capability Bridge

English | [中文](adding-a-python-bridge.zh.md)

This guide walks through creating a Python module that exposes itself as a Cordis Service / Event listener / capability Provider through the Python Capability Bridge. By the end you will have:

1. A Python module decorated with `dsh_bridge` annotations.
2. A generated TypeScript bridge package.
3. A `cordis.yml` entry that mounts the bridge as a plugin.

## Prerequisites

- Python 3.10+ with `dsh-bridge` installed (`pip install dsh-bridge`).
- A checkout of `deepseek-harness` with `pnpm install`.
- A configured `pythonBin` pointing at the right interpreter.

## Generic vs. codegen: choose your path

Two ways mount the same decorated module. **Start with the generic plugin** — it needs no build, no codegen:

```yaml
- id: ml
  name: '@deepseek-ai/dsh-python-bridge'
  config:
    pythonBin: python
    module: my_ml.provider
    className: MLProvider
```

On `initialize` the generic plugin reads the runtime manifest and registers the service, tools, and listeners with the schemas the decorators declare — zero codegen, zero `tsc`. Tool `outputSchema` and `parameters` pass through verbatim; object schemas missing `additionalProperties` default to `false` (the dsh-tools compiler requires it explicitly).

The rest of this guide walks the **codegen** path, which produces a self-contained TypeScript package: static per-module method types, camelCase Config keys mapped from dataclass fields, and generated `static Config` validation. Reach for it when you want a buildable package (e.g. a built dsh install that cannot load `.ts` source) or typed TS surfaces.

| | Generic plugin | codegen |
| --- | --- | --- |
| Package | `@deepseek-ai/dsh-python-bridge` | your generated package |
| Build | none | `pnpm dsh-bridge-codegen` + `tsc` |
| Config | `module` + `initArgs` + generic keys | camelCase dataclass-field keys |
| Types | dynamic (runtime manifest) | static per-module TS |

## 1. Author the Python module

Decorate a class to expose it as a Cordis Service Provider:

```python
# my_ml/provider.py
from dataclasses import dataclass
from dsh_bridge import provide_method, service


@service(name="ml")
@dataclass
class MLProvider:
    model_path: str

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] * 768 for _ in texts]
```

Each `@provide_method` becomes a public TypeScript method on the generated `MlService` class.

Decorate functions for tools, listeners, and capability providers:

```python
from dsh_bridge import on, tool


@tool(
    name="resize_image",
    description="Resize an image to the given dimensions.",
    parameters={"input_path": {"type": "string", "required": True}},
)
def resize_image(input_path: str, width: int, height: int) -> dict:
    return {"output_path": input_path, "bytes_written": 0}


@on("session/event", mode="emit")
def audit_tool_call(event: str, payload: dict) -> None:
    if payload.get("type") == "tool/call":
        print("audit:", payload)
```

Business code is unchanged; the only additions are decorators and type annotations.

## 2. Generate the bridge package

Run the codegen against your Python source:

```sh
pnpm dsh-bridge-codegen src/my_ml/provider.py \
  --out packages/@my-org/python-bridge-ml \
  --name @my-org/python-bridge-ml
```

The generated package contains:

- `package.json` — Cordis peer dependency + runtime dependency.
- `src/index.ts` — `MlService` class with `static Config` schema and `apply()` for tools/listeners.

## 3. Wire it up in `cordis.yml`

```yaml
- id: ml
  name: '@my-org/python-bridge-ml'
  config:
    pythonBin: python
    module: my_ml.provider
    className: MLProvider
    pipDeps: ['numpy>=1.26']
    sandbox: workspace-write
    modelPath: /opt/models/embeddings.npy
```

Boot dsh with the composition:

```sh
pnpm dsh --profile path/to/cordis.yml
```

## 4. Verify

The Python side exposes a smoke test entry point that exercises decorators and algorithm bodies without the bridge:

```sh
PYTHONPATH=src:examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

This prints the bridge registry contents and runs one method to validate the wiring end-to-end.

## What the generated TS package looks like

```ts
// auto-generated python-bridge-ml/src/index.ts
import { Context, Service, z } from '@deepseek-ai/cordis'
import { PythonBridgeService, type PythonBridge } from '@deepseek-ai/dsh-python-bridge-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context { pythonBridge: PythonBridgeService }
}

export interface MlConfig {
  pythonBin?: string
  module: string
  className?: string
  pipDeps?: string[]
  cwd?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  graceMs?: number
  modelPath: string
}

export class MlService extends Service {
  static inject = ['pythonBridge']
  static Config: z<MlConfig> = z.object({ /* ... */ })

  private bridge: PythonBridge

  constructor(ctx: Context, config: MlConfig) {
    super(ctx, 'ml')
    this.bridge = ctx.pythonBridge.spawn({
      module: config.module,
      className: config.className,
      initArgs: { model_path: config.modelPath },
      sandbox: config.sandbox,
      graceMs: config.graceMs,
    })
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.bridge.call('embed', { texts }) as Promise<number[][]>
  }
}

export default MlService
```

## Decorator reference

| Decorator | Codegen target |
| --- | --- |
| `@service(name, settings_namespace=None)` | `class XxxService extends Service` |
| `@provide_method(timeout_ms=None, is_concurrency_safe=None)` | TS method forwarding to `bridge.call` |
| `@tool(name, description, parameters, …)` | `ctx.tools.register(defineTool({…}))` |
| `@on(event, mode='emit', prepend=False, global_=False)` | `ctx.on(event, handler, { mode, prepend, global })` |
| `@capability(seam, backend)` | `ctx.<seam>.backend.register(backend, backendImpl)` |
| `@method(name=None)` | Backend method |
| `@system_prompt_section(order, text)` | `ctx.systemPrompt.section({ order, text })` |
| `@guard()` | `ctx.tools.guard(fn)` |
| `@restrict_tools(allow=None, deny=None)` | `ctx.tools.restrict({ allow, deny })` |

## Error mapping

| Python exception | JSON-RPC `code` | `data.kind` |
| --- | --- | --- |
| `TimeoutError` | `-32001` | `timeout` |
| `asyncio.CancelledError` | `-32002` | `abort` |
| `PermissionError` | `-32003` | `permission` |
| `ValueError` | `-32004` | `invalid-args` |
| `KeyError` / `AttributeError` | `-32005` | `not-found` |
| `ConnectionError` | `-32010` | `bridge-down` |
| any other | `-32603` | `exception` |

`PythonBridgeError` carries the wire `kind` and `code` so Tool execute paths can convert to `ToolCallError` per `packages/core/tools/src/index.ts:343`.

## Troubleshooting

- **`bridge-down` after a call** — the Python child exited; check stderr for the traceback and verify `pipDeps` is installed.
- **Method calls return `-32601` method not found** — confirm the `@provide_method` decorator sits inside a `@service`-decorated class.
- **`-32004` invalid-args on a correct call** — the JSON Schema on the TypeScript side rejected the input; review the parameter types and re-run codegen.