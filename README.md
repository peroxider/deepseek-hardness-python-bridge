# DeepSeek Harness — Python Capability Bridge

English | [中文](README.zh.md)

> **Turn any Python module or codebase into a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) plugin.**
>
> This repository converts existing Python code — ML pipelines, NumPy/SciPy/pandas/PyTorch/scikit-learn algorithms, imaging tools, custom providers — into first-class dsh plugins that the agent harness can load from `cordis.yml`, inject as Cordis services, register as model-facing tools, and wire into event listeners and capability seams.

## What it does

DeepSeek Harness's plugin surface is TypeScript-only. This bridge is the path that takes a Python codebase and makes it a native dsh plugin:

| Python side | Becomes in deepseek-harness |
| --- | --- |
| `@service`-decorated class | A `ctx.<name>` Cordis Service other plugins can `inject` |
| `@tool`-decorated function | A model-facing tool (`ctx.tools.register(defineTool(...))`) |
| `@on`-decorated function | A typed event listener (`ctx.on('agent/*' \| 'tools/*' \| 'session/event' \| ...)`) |
| `@capability`-decorated class | A replacement provider for a capability seam (`ctx.fs`, `ctx.shell`, `ctx.subprocess`, …) |
| `@system_prompt_section` | A contribution to the agent's system prompt |
| `@guard()` / `@restrict_tools()` | Tool policy hooks |

**Zero changes to Python business code** — only decorator annotations and type signatures. A codegen step produces a TypeScript bridge package that spawns a long-lived Python child process and forwards decorated methods through newline-delimited JSON-RPC 2.0 over stdio. The generated plugin receives the same sandboxing, env scrub, approval flow, session log, and persistence as any TypeScript plugin in the dsh composition.

## Repository layout

```
python/sdk-dsl/                          dsh-bridge PyPI package: decorators + runtime
  src/dsh_bridge/__init__.py               9 zero-side-effect decorators
  src/dsh_bridge/runtime.py                python -u -m dsh_bridge.runtime <module> entry point
  src/dsh_bridge/_type_inference.py        PEP 484 → JSON Schema inference
  src/dsh_bridge/_errors.py                exception → JSON-RPC code/kind vocabulary
  tests/                                   pytest: unit + real-subprocess integration (43 tests)
packages/bridge/
  python-bridge-runtime/                 @deepseek-ai/dsh-python-bridge-runtime
    src/index.ts                           PythonBridgeService (ctx.pythonBridge) + PythonBridge client
    tests/                                 vitest: transport, error mapping, reconnect
  python-bridge-codegen/                 @deepseek-ai/dsh-python-bridge-codegen
    src/index.ts                           AST-driven TS generator (parseModuleSources / generateBridgePackage)
    bin/dsh-bridge-codegen.js              CLI entry point
    tests/                                 vitest: parser, type projection, emitter
examples/python-bridge-ml/               Runnable Service Provider + tool + listeners snapshot
docs/cookbook/adding-a-python-bridge.md  Step-by-step user guide (EN/ZH)
docs/subsystems/python-bridge.md         Subsystem reference (EN/ZH)
tests/stubs/                             Standalone-dev @deepseek-ai/* stubs (offline resolution)
tests/e2e/                               Offline end-to-end checks (real Python child)
scripts/setup-stubs.mjs                  Materialize stubs into node_modules/
scripts/verify.mjs                       One-command offline verification
.agents/notes/implemented/feature/       Agent Note documenting the shipped design
```

## Quick start

The three-step pipeline from Python codebase to loaded dsh plugin:

### 1. Author a Python module

```python
from dataclasses import dataclass
from dsh_bridge import provide_method, service, tool, on


@service(name="ml")
@dataclass
class MLProvider:
    model_path: str

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] * 768 for _ in texts]


@tool(name="shout", description="Upper-case a string.",
      parameters={"text": {"type": "string"}})
def shout(text: str) -> dict:
    return {"text": text.upper()}


@on("session/event", mode="emit")
def audit(event: str, payload: dict) -> None:
    ...
```

Decorators return the original callable unchanged — business code runs unmodified when no bridge is attached.

### 2. Generate the TypeScript bridge package

```sh
pnpm dsh-bridge-codegen src/my_ml/provider.py \
  --out packages/@my-org/python-bridge-ml \
  --name @my-org/python-bridge-ml
```

### 3. Wire it in `cordis.yml`

```yaml
- id: ml
  name: '@my-org/python-bridge-ml'
  config:
    pythonBin: python
    module: my_ml.provider
    className: MLProvider
    sandbox: workspace-write
    modelPath: /opt/models/embeddings.npy
```

## Decorators

| Decorator | Codegen target |
| --- | --- |
| `@service(name, settings_namespace=None)` | `class XxxService extends Service` |
| `@provide_method(timeout_ms=None, is_concurrency_safe=None)` | TS method forwarding to `bridge.call` |
| `@tool(name, description, parameters, …)` | `ctx.tools.register(defineTool({…}))` |
| `@on(event, mode='emit', prepend=False, global_=False)` | `ctx.on(event, handler, { mode, prepend, global })` |
| `@capability(seam, backend)` | `ctx.<seam>.backend.register(backend, impl)` |
| `@method(name=None)` | Capability backend method |
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
| process exit during call | `-32011` | `worker-exit` |

## Testing

```sh
# One-command offline verification (stubs, pytest, codegen, lifecycle,
# real-child runtime E2E, generated-package E2E):
node scripts/verify.mjs

# Python only: 43 tests (decorators, type inference, runtime, real-subprocess integration)
cd python/sdk-dsl && PYTHONPATH=src python3 -m pytest tests/

# Example smoke test (no bridge required)
PYTHONPATH=examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

The standalone repository resolves `@deepseek-ai/*` imports through committed stubs (`tests/stubs/`, materialized by `scripts/setup-stubs.mjs`); inside the deepseek-harness monorepo, pnpm workspace resolution binds the genuine packages and the vitest suites under `packages/bridge/*/tests/` run instead.

## Non-goals

- **In-process CPython embedding** (Pyodide / pyo3) — all execution stays in a separate Python child process.
- **Replacing Code Mode's planned Python backend** — complementary, not competing.
- **Bidirectional state sharing** beyond method calls — the bridge is message-passing, not shared-memory.
- **A Python reimplementation of Cordis** — Python modules attach to dsh's existing Cordis context.

## License

MIT.