# DeepSeek Harness — Python Capability Bridge

English | [中文](README.zh.md)

> **Turn Python modules into [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) plugins.**
>
> This repository converts existing Python code — ML pipelines, NumPy/SciPy/pandas/PyTorch/scikit-learn algorithms, imaging tools, custom providers — into first-class dsh plugins that the agent harness loads from `cordis.yml`, injects as Cordis services, registers as model-facing tools, and wires into event listeners and capability seams.
>
> **Verified end-to-end against the real deepseek-harness**: a test `cordis.yml` boots through the genuine Cordis Loader with real schemastery Config validation, real `ToolRuntime` registration, and the real event system, driving a real Python child process; the bridge packages and a generated example package pass the monorepo's strict `tsc -b` with zero errors. See [Verification status](#verification-status) for the exact coverage and remaining limits.

## What it does

DeepSeek Harness's plugin surface is TypeScript-only. This bridge is the path that takes a Python module and makes it a native dsh plugin:

| Python side | Becomes in deepseek-harness |
| --- | --- |
| `@service`-decorated class | A `ctx.<name>` Cordis Service other plugins can `inject` |
| `@tool`-decorated function | A model-facing tool (`ctx.tools.register(defineTool(...))`) |
| `@on`-decorated function | A typed event listener (`ctx.on('agent/*' \| 'tools/*' \| 'session/event' \| ...)`) |
| `@capability`-decorated class | A replacement provider for a capability seam (`ctx.fs`, `ctx.shell`, `ctx.subprocess`, …) |
| `@system_prompt_section` | A contribution to the agent's system prompt |
| `@guard()` / `@restrict_tools()` | Tool policy hooks |

**Zero changes to Python business code** — only decorator annotations and type signatures. A codegen step produces a TypeScript bridge package that spawns a long-lived Python child process and forwards decorated methods through newline-delimited JSON-RPC 2.0 over stdio. The generated plugin receives the same sandboxing, env scrub, approval flow, session log, and persistence as any TypeScript plugin in the dsh composition.

## Verification status

The premise is proven by four verification tiers, all reproducible offline via `node scripts/verify.mjs`:

1. **Python suite** — 43 pytest tests covering decorators, PEP 484 type inference, the JSON-RPC runtime, and real-subprocess integration over stdio.
2. **Offline TypeScript E2E** — plain-Node assertions (no package install) covering codegen emission (55+ assertions), runtime lifecycle (worker-exit, reconnect, teardown ladder, env scrub), a real `python3` child round-trip, and a generated package mounted on a stub Cordis context.
3. **REAL-composition** — a test `cordis.yml` booted through the genuine vendored Cordis Loader (`vendor/loader` + `vendor/include`), with real schemastery applying the generated `static Config`, the real `ToolRuntime` holding the registered tool, a real `ctx.emit('session/event')` reaching the Python listener, and `ctx.fiber.dispose()` tearing the child down through the effect disposers.
4. **Strict typecheck** — `tsc -b` (typescript 6.0.3, monorepo `tsconfig.base.json` flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) over the two bridge packages and a generated example package inside the monorepo's project-reference graph: zero errors.

Remaining limits, honestly stated:

- **"Any Python module" means the constrained decorator shape** — keyword-argument decorators with one leading positional name (`@service(name='ml', ...)`). Qualified calls (`@dsh_bridge.service(...)`), import aliases (`from dsh_bridge import service as svc`), and non-keyword arguments are silently ignored by the regex-based parser. Only the first `@service` class per module is emitted; non-dataclass `__init__` parameters are not introspected.
- **`@capability` / `@guard` / `@restrict_tools` / `@system_prompt_section` are parsed but not emitted** — they produce no generated code yet.
- **The vitest suites under `packages/bridge/*/tests/` have not run in this environment** (vitest's own dependency closure is unavailable offline); their assertions are mirrored by the plain-Node E2E scripts in `tests/e2e/` and run for real inside the monorepo.
- **Monorepo integration is verified, not merged** — the deepseek-harness checkout holds the bridge packages plus a `tsconfig.base.json` paths registration as uncommitted working-tree changes from the verification run.

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
# One-command verification (stubs, pytest, codegen, lifecycle, real-child
# runtime E2E, generated-package E2E; plus the REAL-composition and strict
# typecheck tiers when a monorepo checkout and tsc are available):
node scripts/verify.mjs

# Python only: 43 tests (decorators, type inference, runtime, real-subprocess integration)
cd python/sdk-dsl && PYTHONPATH=src python3 -m pytest tests/

# Example smoke test (no bridge required)
PYTHONPATH=examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

The standalone repository resolves `@deepseek-ai/*` imports through committed stubs (`tests/stubs/`, materialized by `scripts/setup-stubs.mjs`) for the offline tier; the integration tier (`scripts/setup-integration.mjs`, `tests/integration/real-composition.mjs`, `scripts/typecheck-integration.mjs`) binds the genuine monorepo sources instead. Inside the deepseek-harness monorepo, pnpm workspace resolution binds the genuine packages and the vitest suites under `packages/bridge/*/tests/` run there.

## Non-goals

- **In-process CPython embedding** (Pyodide / pyo3) — all execution stays in a separate Python child process.
- **Replacing Code Mode's planned Python backend** — complementary, not competing.
- **Bidirectional state sharing** beyond method calls — the bridge is message-passing, not shared-memory.
- **A Python reimplementation of Cordis** — Python modules attach to dsh's existing Cordis context.

## License

MIT.