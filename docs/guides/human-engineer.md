# Human Engineer Guide — Turning Python Capability into a dsh Plugin

English | [中文](human-engineer.zh.md)

The **Python Capability Bridge** is the conversion path from *"I have working Python code"* to *"that code is now a native deepseek-harness (dsh) plugin"*. This guide is written for a human engineer sitting at a terminal. If you are an AI coding agent, use the [Agent-friendly guide](agent-friendly.md) instead — it drives the same workflow through the project's `dsh-python-plugin` skill.

## What this repo is for

DeepSeek Harness's plugin surface is TypeScript-only. The bridge removes that wall: decorate a Python module with `dsh_bridge` annotations, run one command, and the same code becomes a first-class dsh plugin — a Cordis service other plugins can inject, model-facing tools, event listeners, and more — with **zero changes to the Python business code**.

| Your Python capability | Becomes in deepseek-harness |
| --- | --- |
| `@service`-decorated class | A `ctx.<name>` Cordis Service (`inject`-able by other plugins) |
| `@tool`-decorated function | A model-facing tool (`ctx.tools.register(defineTool(...))`) |
| `@on`-decorated function | A typed event listener (`ctx.on('agent/*' \| 'tools/*' \| 'session/event' \| ...)`) |
| `@capability`-decorated class | A replacement provider for a capability seam (`ctx.fs`, `ctx.shell`, …) |
| `@system_prompt_section` | A contribution to the agent's system prompt |
| `@guard()` / `@restrict_tools()` | Tool policy hooks |

The generated TypeScript bridge package spawns a long-lived Python child process and forwards decorated methods over newline-delimited JSON-RPC 2.0 on stdio. The plugin receives the same sandboxing, env scrub, approval flow, session log, and persistence as any TypeScript plugin in the dsh composition.

## The pipeline at a glance

```
bridge.py ──▶ codegen ──▶ build ──▶ assemble ──▶ patch
(decorated     TS package   JS lib   plugin dir   cordis.patch.yml
 module)      (generated)  (tsc)     (self-contained)  (loader entries)
```

Only the first step (authoring the decorated module) involves judgment; the rest is mechanical and automated by `scripts/install-python-plugin.py`.

## Step 1 — Author the decorated module (the only development step)

Create a thin wrapper module (convention: `<pkg>_dsh/bridge.py` beside the business code) that imports the business code and adds `dsh_bridge` decorators. **Never modify the business code itself.**

```python
# my_ml_dsh/bridge.py
from dataclasses import dataclass
from dsh_bridge import provide_method, service, tool, on


@service(name="ml")
@dataclass
class MLProvider:
    model_path: str                       # → required config key modelPath
    batch_size: int = 32                  # → optional config key batchSize

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        # ... real algorithm, unchanged ...
        return [[0.0] * 768 for _ in texts]


@tool(name="shout", description="Upper-case a string.",
      parameters={"text": {"type": "string"}})
def shout(text: str) -> dict:
    return {"text": text.upper()}


@on("session/event", mode="emit")
def audit(event: str, payload: dict) -> None:
    ...
```

Choose the surface per capability:

| Goal | Decorator | Generated result |
| --- | --- | --- |
| Stateful capability other plugins inject | `@service(name='x')` on a `@dataclass` class | `ctx.x` Service; dataclass fields become `cordis.yml` config keys (`model_path` → `modelPath`) |
| Public method on that service | `@provide_method(timeout_ms=…)` inside the class | typed TS method forwarding to Python |
| Model-facing action | `@tool(name, description, parameters, output_schema=…)` on a function | `ctx.tools.register(defineTool(...))` |
| React to harness events | `@on('session/event', mode='emit')` on a function | `ctx.on(...)` listener bridged to Python |

**Hard constraints the codegen parser enforces** (violations are silently ignored — check first when a decorator "does nothing"):

- Decorator factories take **keyword arguments plus at most one leading positional name**: `@service(name='ml')` and `@service('ml')` both work; `@dsh_bridge.service(...)` and `from dsh_bridge import service as svc` do **not**.
- Every JSON Schema object in `parameters` / `output_schema` must set `"additionalProperties": False` explicitly (the dsh-tools compiler rejects it otherwise).
- Method parameters and returns must be **JSON-serializable** (a dataclass return hangs the call; return plain dicts/lists/scalars — convert with `dataclasses.asdict()` or explicit field mapping).
- Only the first `@service` class per module is emitted; split additional services into separate modules.

Read the full decorator contract in [`skill/dsh-python-plugin/references/decorators.md`](../../skill/dsh-python-plugin/references/decorators.md) before wrapping a host library.

## Step 2 — Install (codegen → build → assemble → patch)

One command from the bridge repo root:

```sh
scripts/install-python-plugin.py \
  --source /abs/path/to/bridge.py \
  --name '@my-org/<short>-bridge' \
  --module <pkg>_dsh.bridge \
  --python-src /abs/path/to/python/src \
  --config-json '{"<camelCaseKey>": "value"}'
```

What it does per step: `codegen` (TS package into `<plugin>/.build/generated/`), `build` (tsc → `lib/`, including the runtime + sdk-protocol packages a built dsh install lacks), `assemble` (Python packages copied to the plugin root; runtime deps linked from the dsh install), `smoke` (imports the module inside the plugin dir), `patch` (idempotent insert into `~/.dsh/profiles/<profile>/cordis.patch.yml`).

Useful variations:

- `--steps codegen,build` — regenerate without touching the profile.
- `--steps patch --config-json …` — re-apply config only.
- `--dry-run` — print the patch without writing.
- `--uninstall` — remove the entries (`--delete-dir` also removes the plugin dir).
- Environment overrides when discovery fails: `DSH_TSC`, `DSH_NODE`, `DSH_MONOREPO`, `DSH_INSTALL`, `DSH_HOME`, `DSH_TYPE_ROOTS`. The script reports every path it tried on failure — read the error before guessing.

If the installer cannot run in your environment (no tsc, no dsh install), follow the manual pipeline in [`skill/dsh-python-plugin/references/manual-pipeline.md`](../../skill/dsh-python-plugin/references/manual-pipeline.md).

## Step 3 — Verify

1. The installer's smoke step already proves the module imports inside the plugin dir.
2. For a live instance: `ps aux | grep dsh_bridge.runtime` shows the Python child (`python3 -u -m dsh_bridge.runtime <module> --class <Class> …`); `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080` (or the instance's URL) stays 200.
3. New plugin entries hot-apply through the patch-layer watcher; **replacing an already-loaded plugin's artifacts requires restarting `dsh web`** — the in-memory copy is authoritative until then.

## Troubleshooting

Match the symptom in [`skill/dsh-python-plugin/references/pitfalls.md`](../../skill/dsh-python-plugin/references/pitfalls.md) before debugging from scratch — it catalogs the defects hit by real conversions (hang on unserializable results, confine contract mismatch, missing tool registration, silent decorator skips, and more) with their fixes.

## Other routes into the same workflow

- **AI agent doing the conversion** → [Agent-friendly guide](agent-friendly.md) (loads the `dsh-python-plugin` skill and follows it).
- **Full step-by-step walkthrough** → [`docs/cookbook/adding-a-python-bridge.md`](../cookbook/adding-a-python-bridge.md).
- **Runnable example** → [`examples/python-bridge-ml/`](../../examples/python-bridge-ml/README.md) (ML provider + tool + listeners).
- **Decorator / error-mapping reference tables** → the [main README](../../README.md).
