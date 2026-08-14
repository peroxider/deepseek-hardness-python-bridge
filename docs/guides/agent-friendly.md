# Agent-Friendly Guide — Convert Python Capability into a dsh Plugin

English | [中文](agent-friendly.zh.md)

This guide is written for an AI coding agent (an assistant that reads files, runs commands, and edits code on the user's behalf). It drives the same conversion workflow as the [Human Engineer Guide](human-engineer.md), but tuned for how agents work: the project ships a **skill** for exactly this job, and this guide tells you how to use it, what to check before writing anything, and how to verify your work.

If you are a human at a terminal, use the [Human Engineer Guide](human-engineer.md) instead.

## First: load the skill

The repository contains a standard skill for this workflow at [`skill/dsh-python-plugin/SKILL.md`](../../skill/dsh-python-plugin/SKILL.md). **If your runtime supports loading skills (e.g. via a skill-loading mechanism), load `dsh-python-plugin` FIRST and follow it** — it is the authoritative step-by-step procedure. This guide is the condensed, skill-independent version; the skill is more current than this page if they ever disagree.

The skill's reference files are the deep documentation you should consult when a step hits an edge case:

| Reference | When to open it |
| --- | --- |
| [`references/decorators.md`](../../skill/dsh-python-plugin/references/decorators.md) | Every decorator's exact contract (fields → config keys, optionality, type projection) |
| [`references/pitfalls.md`](../../skill/dsh-python-plugin/references/pitfalls.md) | Symptom → cause → fix catalog; open it before debugging from scratch |
| [`references/contracts.md`](../../skill/dsh-python-plugin/references/contracts.md) | Host-library runtime contracts (e.g. LKB `owner == actor` claim-before-start) |
| [`references/manual-pipeline.md`](../../skill/dsh-python-plugin/references/manual-pipeline.md) | Fallback when the one-command installer cannot run |

## The task in one sentence

Take a Python module the user wants exposed to dsh and turn it into a first-class dsh plugin — a `ctx.<name>` service, model-facing tools, event listeners — with **zero changes to the business code**, by adding `dsh_bridge` decorators and running the bridge's installer.

## Pipeline (all mechanical except step 1)

```
bridge.py ──▶ codegen ──▶ build ──▶ assemble ──▶ patch
(decorated     TS package   JS lib   plugin dir   cordis.patch.yml
 module)      (generated)  (tsc)     (self-contained)  (loader entries)
```

## Step 1 — Author the decorated module (the only judgment step)

Create a thin wrapper module (convention: `<pkg>_dsh/bridge.py` beside the business code) that imports the business code and adds decorators. Never edit the business code.

Choose the surface per capability:

| Goal | Decorator | Generated result |
| --- | --- | --- |
| Stateful capability other plugins inject | `@service(name='x')` on a `@dataclass` class | `ctx.x` Service; dataclass fields become `cordis.yml` config keys (`model_path` → `modelPath`) |
| Public method on that service | `@provide_method(timeout_ms=…)` inside the class | typed TS method forwarding to Python |
| Model-facing action | `@tool(name, description, parameters, output_schema=…)` on a function | `ctx.tools.register(defineTool(...))` |
| React to harness events | `@on('session/event', mode='emit')` on a function | `ctx.on(...)` listener bridged to Python |

### Check these BEFORE writing (violations are silently ignored)

The codegen parser will **silently skip** decorators that violate its constraints — you won't get an error, you'll get a missing service/tool. Verify all of these up front:

1. **Decorator shape**: keyword arguments plus at most one leading positional name. `@service(name='ml')` and `@service('ml')` work; `@dsh_bridge.service(...)` and `from dsh_bridge import service as svc` do **not**.
2. **`additionalProperties: False`** on every JSON Schema object in `parameters` / `output_schema` — the dsh-tools compiler rejects implicit ones.
3. **JSON-serializable boundaries**: method params/returns must be plain JSON types (a dataclass return hangs the call — convert with `dataclasses.asdict()` at the wrapper boundary).
4. **One `@service` class per module** — split additional services into separate modules.
5. **`@capability` / `@guard` / `@restrict_tools` / `@system_prompt_section` are parsed but NOT emitted yet** — do not promise them in a conversion.

## Step 2 — Install with one command

From the bridge repo root:

```sh
scripts/install-python-plugin.py \
  --source /abs/path/to/bridge.py \
  --name '@my-org/<short>-bridge' \
  --module <pkg>_dsh.bridge \
  --python-src /abs/path/to/python/src \
  --config-json '{"<camelCaseKey>": "value"}'
```

Per-step: `codegen` (TS package into `<plugin>/.build/generated/`), `build` (tsc → `lib/`), `assemble` (Python packages copied to plugin root, runtime deps linked), `smoke` (imports the module inside the plugin dir), `patch` (idempotent insert into `cordis.patch.yml`).

Handle failures like this:

- **Read the error before guessing.** The script reports every path it tried on discovery failure — check the reported paths, don't invent new ones.
- If tsc or a dsh install is missing, fall back to `references/manual-pipeline.md` and say so.
- Environment overrides if discovery fails: `DSH_TSC`, `DSH_NODE`, `DSH_MONOREPO`, `DSH_INSTALL`, `DSH_HOME`, `DSH_TYPE_ROOTS`.
- `--dry-run` prints the patch without writing; `--uninstall` removes entries (`--delete-dir` also deletes the plugin dir). Use `--steps codegen,build` to regenerate without touching the profile.

## Step 3 — Verify (don't skip)

1. The installer's `smoke` step proves the module imports inside the plugin dir — report that it ran.
2. Live instance checks: `ps aux | grep dsh_bridge.runtime` shows the Python child; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080` (or the instance URL) stays 200.
3. If the plugin was already loaded, tell the user that **replacing artifacts requires restarting `dsh web`** — the patch watcher only hot-applies entry-list changes.

## When something fails

Match the symptom in [`references/pitfalls.md`](../../skill/dsh-python-plugin/references/pitfalls.md) **before** debugging from scratch. It covers the real defects hit by conversions: hang on unserializable results, `spawn argv is empty` (stale runtime build), `z.string(...).optional is not a function` (regenerate), `additionalProperties` rejection, silent decorator skips, `method not found`, `owner_required` denials, child exits immediately, plugin changes not taking effect.

## Agent behavioral notes

- **Never modify business code** — only the wrapper module. Business code runs unmodified when no bridge is attached.
- **Never promise capability/guard/system-prompt features** — they parse but don't emit yet.
- **Read the host library's contracts** (`references/contracts.md`) before writing a wrapper that calls into a library with ownership/lifecycle rules (e.g. LKB `owner == actor`).
- **Report honestly**: if the installer couldn't run (no tsc / no dsh install) and you used the manual pipeline instead, say so; if you couldn't verify against a live instance, say so.
