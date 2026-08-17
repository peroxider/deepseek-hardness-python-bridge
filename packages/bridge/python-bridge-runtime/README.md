# @deepseek-ai/dsh-python-bridge-runtime

English | [中文](README.zh.md)

The TypeScript runtime half of the Python Capability Bridge. One Cordis Service Provider (`PythonBridgeService`, registered as `ctx.pythonBridge`) spawns long-lived `python -u -m dsh_bridge.runtime <module>` child processes and forwards decorated method calls through newline-delimited JSON-RPC 2.0 over stdio (reusing [`@deepseek-ai/dsh-sdk-protocol`](../sdk/protocol/README.md) framing). Process lifecycle (graceful shutdown, SIGTERM → SIGKILL ladder) delegates to [`@deepseek-ai/dsh-subprocess`](../subprocess/subprocess/README.md) through `scrubbedParentEnv()` for credential scrubbing.

This package is the runtime; it ships no generated Service classes. Generated Service / Tool / Listener / Capability classes are produced by [`@deepseek-ai/dsh-python-bridge-codegen`](../python-bridge-codegen/README.md) from a Python module's `dsh_bridge` decorators and depend on this package.

## Wiring

```ts
import { PythonBridgeService } from '@deepseek-ai/dsh-python-bridge-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pythonBridge: PythonBridgeService
  }
}
```

A typical generated entry calls `ctx.pythonBridge.spawn({ module, className, initArgs, sandbox })` in its constructor and forwards each `@provide_method` call through `this.bridge.call('methodName', args)`.

## Lifecycle

`PythonBridgeService.dispose()` runs every live bridge through the teardown ladder: `shutdown` notification → stdin EOF → wait `graceMs` (default 3000) → SIGTERM → wait `graceMs` → SIGKILL, mirroring `packages/sdk/client/README.md`'s `stdin-EOF → SIGTERM → SIGKILL` model.

## Spawn ownership

The bridge owns its spawn the same way SDK-managed transports do (see the `dsh-subprocess` README, "SDK-managed spawns remain outside"): a long-lived `node:child_process` framed by `JsonRpcLineTransport` over the child's stdio. Environment policy stays single-sourced through `scrubbedParentEnv()`.

## Interpreter probe

Before spawning, the bridge verifies the interpreter can import the bridge runtime with `pythonBin -c "import dsh_bridge"`. A probe failure raises `PythonBridgeError` with `kind: 'dependency-missing'`, `code: -32012`, and `pip install dsh-bridge` guidance — never a confusing immediate `worker-exit`. Probe results are cached per `pythonBin`, so known-good interpreters are not re-probed on reconnect. Tests substitute the probe through `internals.probeFn`.

## Version negotiation

The `initialize` handshake carries `clientInfo: { name, version }` (`PYTHON_BRIDGE_CLIENT_NAME` / `PYTHON_BRIDGE_CLIENT_VERSION`). The Python runtime accepts the handshake when the client version's major matches its own `serverInfo.version` major, and rejects it with `protocol-mismatch` (`-32006`) and a readable message otherwise. Keep the two majors in lockstep when releasing.

## Reconnect

An unexpected child exit respawns the interpreter with exponential backoff (spec §6.7). `PythonBridge.spawn()` accepts a `reconnect` block:

```ts
reconnect: {
  enabled: true,        // default
  initialDelayMs: 500,  // default
  maxDelayMs: 30_000,   // default
  maxAttempts: 10,      // default
}
```

The attempt budget resets after `maxDelayMs` of stable uptime. While disconnected, `call()` rejects with `PythonBridgeError(kind: 'bridge-down')`; a call in flight when the child dies rejects with `kind: 'worker-exit'` (`-32011`) and carries the child's stderr tail for diagnostics.

## Errors

| Python exception | JSON-RPC `code` | `data.kind` |
| --- | --- | --- |
| `TimeoutError` | `-32001` | `timeout` |
| `CancelledError` | `-32002` | `abort` |
| `PermissionError` | `-32003` | `permission` |
| `ValueError` | `-32004` | `invalid-args` |
| `KeyError` / `AttributeError` | `-32005` | `not-found` |
| `ConnectionError` | `-32010` | `bridge-down` |
| any other | `-32603` | `exception` |
| process exit during call | `-32011` | `worker-exit` |
| interpreter lacks dsh-bridge (spawn-time probe) | `-32012` | `dependency-missing` |
| client/server version skew at initialize | `-32006` | `protocol-mismatch` |

`PythonBridgeError` carries `kind` and `code` matching the wire vocabulary, plus the original `data` payload for diagnostics.

## Environment

`scrubbedParentEnv()` drops credential-shaped names (`/KEY|PASSWORD|SECRET|TOKEN/i`) and all `DSH_*` names. Explicit `env` entries merge after the scrub. `PYTHONUNBUFFERED=1` is set so stdout is flushed per frame.

## Sandbox

When the sandbox seam is loaded, `ctx.sandbox.confine(argv, { mode })` wraps the child argv before spawn and confinement failures propagate (the bridge never silently bypasses). When the seam is absent the child runs unconfined regardless of the `sandbox` field — deployments that require confinement must load `dsh-sandbox` and a backend.

## Model Experience

None, as this package defines no model-visible surface; generated bridge packages own the prompt and tool-schema contributions of their decorated modules.

#### KV Cache effect

None; the bridge is a transport.

## Known Limitations and Deferred Work

- **Sandbox confinement requires the optional seam** — without `dsh-sandbox` loaded the `sandbox` field is advisory only.
- **No in-process CPython embedding** by design; this is a process-management seam, not a runtime. Pyodide-based low-latency paths are tracked separately (see `packages/core/tools/README.md:27`).
- **No protocol-version negotiation** — pre-release stance, no compatibility promise.
- **Listener notification queueing during reconnect is unimplemented** — spec §6.7's 1 MiB per-event-type queue is deferred; notifications raised while the child is down are dropped.