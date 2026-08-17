---
name: dsh-python-plugin
description: Convert a Python module or codebase into a DeepSeek Harness (dsh) plugin through the Python Capability Bridge. Use whenever the user wants to expose Python code to dsh/cordis — as a ctx.<name> service, model-facing tools, event listeners, or a capability provider — or mentions dsh_bridge decorators, bridge.py, python-bridge, ctx.pythonBridge, converting/wrapping a Python module into a dsh/deepseek-harness plugin, or installing one via cordis.yml / cordis.patch.yml, even if they never say "plugin" explicitly.
---

# Convert a Python module into a dsh plugin

The Python Capability Bridge lets a Python module become a first-class dsh plugin with zero changes to business code. This skill drives the conversion end to end. Two paths load the same decorated module: the **generic plugin** (`@peroxider/dsh-python-bridge`) needs no codegen and no build — one `cordis.yml` entry is the whole integration; the **codegen** path builds a self-contained TypeScript package with static per-module types. Start with the generic path (Step 2a); fall back to codegen when the install cannot resolve the bridge packages as source or you want typed TS surfaces (Step 2b).

The codegen pipeline:

```
bridge.py ──▶ codegen ──▶ build ──▶ assemble ──▶ patch
(decorated     TS package   JS lib   plugin dir   cordis.patch.yml
 module)      (generated)  (tsc)     (self-contained)  (loader entries)
```

Only the first step (authoring the decorated module) involves judgment; the rest is mechanical and automated by `scripts/install-python-plugin.py` in the bridge repository.

## Step 0 — Locate the bridge repository

Every command runs from the bridge repo. Find it in this order:

1. An existing checkout mentioned in the conversation or visible in the workspace.
2. The environment variable hints the user provides.
3. Otherwise ask the user for the path.

All paths below are relative to the bridge repo root unless absolute.

## Step 1 — Author the decorated module (the only development step)

Create a thin wrapper module (convention: `<pkg>_dsh/bridge.py` beside the business code) that imports the business code and adds `dsh_bridge` decorators. Never modify the business code itself.

Choose the surface per capability:

| Goal | Decorator | Generated result |
| --- | --- | --- |
| Stateful capability other plugins inject | `@service(name='x')` on a `@dataclass` class | `ctx.x` Service; dataclass fields become `cordis.yml` config keys (`board_id` → `boardId`) |
| Public method on that service | `@provide_method(timeout_ms=…)` inside the class | typed TS method forwarding to Python |
| Model-facing action | `@tool(name, description, parameters, output_schema=…)` on a function | `ctx.tools.register(defineTool(...))` |
| React to harness events | `@on('session/event', mode='emit')` on a function | `ctx.on(...)` listener bridged to Python |

Hard constraints the codegen parser enforces (violations are silently ignored — check first when a decorator "does nothing"):

- Decorator factories take **keyword arguments plus at most one leading positional name**: `@service(name='ml')` and `@service('ml')` both work; `@dsh_bridge.service(...)` and `from dsh_bridge import service as svc` do **not**.
- Every JSON Schema object in `parameters` / `output_schema` must set `"additionalProperties": False` explicitly (the dsh-tools compiler rejects it otherwise).
- Method parameters and returns must be **JSON-serializable** (a dataclass return hangs the call; return plain dicts/lists/scalars — convert with `dataclasses.asdict()` or explicit field mapping).
- Only the first `@service` class per module is emitted.

Read `references/decorators.md` for the full decorator contract, and `references/contracts.md` for the host-library integration patterns (e.g. how to discover and honor ownership/lifecycle contracts like LKB's `owner == actor` rule). The `initialize` manifest schema the runtime reports (services, methods, tools, listeners) lives in `references/manifest.md`.

## Step 2 — Mount the plugin

### Step 2a — Generic path (zero-build, default)

When the dsh install can resolve `@peroxider/dsh-python-bridge` and the runtime (source launch, or an install that ships them), one `cordis.patch.yml` entry is the whole integration — no codegen, no `tsc`:

```yaml
- id: <short>
  name: '@peroxider/dsh-python-bridge'
  config:
    pythonBin: python3
    module: <pkg>_dsh.bridge
    pythonPath: [/abs/path/to/python/src]
    initArgs:
      <snake_case_field>: value
```

The generic plugin reads the runtime manifest on `initialize` and registers the decorated service, tools, and listeners with the schemas the decorators declare. Prefer `pythonPath` (import roots) over copying source into the plugin dir when the business code must stay put.

### Step 2b — Codegen path (built package)

When the install cannot resolve the bridge packages (a built dsh install that ships neither the runtime nor the generic plugin), or you want a static per-module package, run the codegen pipeline from the bridge repo root:

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

If the installer cannot run in the current environment (no tsc, no dsh install), follow `references/manual-pipeline.md` instead.

## Step 3 — Verify

1. The installer's smoke step already proves the module imports inside the plugin dir.
2. For a live instance: `ps aux | grep dsh_bridge.runtime` shows the Python child (`python3 -u -m dsh_bridge.runtime <module> --class <Class> …`); `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080` (or the instance's URL) stays 200.
3. New plugin entries hot-apply through the patch-layer watcher; **replacing an already-loaded plugin's artifacts requires restarting `dsh web`** — the in-memory copy is authoritative until then.

When something fails, match the symptom in `references/pitfalls.md` before debugging from scratch — it catalogs the defects hit by real conversions (hang on unserializable results, confine contract mismatch, missing tool registration, silent decorator skips, and more) with their fixes.
