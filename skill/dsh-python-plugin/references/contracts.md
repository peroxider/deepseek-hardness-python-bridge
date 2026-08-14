# Host-library contract patterns

A decorated module forwards calls into a library written for a different host. The bridge preserves the library's runtime contracts — the wrapper must honor them. Read the library's handler/validate/apply code before writing the wrapper.

## Discovery pattern

1. Find the library's command/handler layer (e.g. LKB's `plan_graph.py` handlers).
2. Read each handler's `apply` for preconditions (ownership, ordering, state).
3. Encode the preconditions in the wrapper — never let a deniable contract leak to the model as a bare failure.

## Case: LKB `owner == actor` (claim before start)

`StartTaskHandler.apply` denies `start_task` when `node.owner != command.actor`. The correct flow is claim → start → complete. The wrapper encodes this:

```python
@provide_method(timeout_ms=10_000)
def update_task(self, task_id: str, status: str) -> dict:
    kind = _STATUS_KIND.get(status)
    if kind is None:
        raise ValueError(f"unsupported status {status!r}; expected one of {sorted(_STATUS_KIND)}")
    if kind == "start_task":
        # start_task requires owner == actor; claim first (idempotent).
        claim = self._core.execute("claim_task", {"task_id": task_id}, task_id=task_id)
        if claim.decision != "committed":
            return {"taskId": task_id, "status": status, **_decision_payload(claim)}
    ...
```

Patterns worth copying:

- **Auto-satisfy idempotent preconditions** (claim before start) rather than exposing two operations.
- **Return the host's decision vocabulary** (`decision: committed|denied` + `reason`) instead of raising for domain denials; raise only for programmer errors (`ValueError` for unknown status maps to `invalid-args` on the wire).
- **Ensure resource bootstrap**: LKB requires the board file to exist before commands — the wrapper creates it on first use (`_ensure_board` catching `BoardNotFoundError`).

## Serialization contract

Everything returned crosses the wire as JSON. Dataclasses, datetime, Path, enums, and custom objects break the call (the runtime downgrades to an `exception` error frame rather than hanging, but the caller still fails). Convert at the wrapper boundary:

```python
"revision": dict(revision.revisions) if revision is not None else {}
```

## Process model

- One Python child per `@service` instance — long-lived state (connections, loaded models) lives there.
- Module-level `@tool` functions share the service's child when both are mounted; without a service instance they must build their own context (env-var fallback).
- The child's cwd is the plugin directory; Python imports resolve from there. Keep the plugin root self-contained.

## Configuration contract

- Service config flows: `cordis.yml` camelCase keys → generated Config → `initArgs` snake_case kwargs → dataclass fields.
- Tools do not receive config; use module-global registration or `MYAPP_*` env vars (only `DSH_*` and credential-shaped names are scrubbed from the child env).
