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

`PythonBridgeService.dispose()` terminates every still-running child and waits up to `graceMs` (default 3000) before SIGKILL escalation. The disposal ladder mirrors `packages/sdk/client/README.md` `stdin-EOF → SIGTERM → SIGKILL`.

## Reconnect

`PythonBridge.spawn()` accepts a `reconnect` block:

```ts
reconnect: {
  enabled: true,        // default
  initialDelayMs: 500,  // default
  maxDelayMs: 30_000,   // default
  maxAttempts: 10,      // default
}
```

While disconnected, `call()` rejects with `PythonBridgeError(kind: 'bridge-down')`.

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

`PythonBridgeError` carries `kind` and `code` matching the wire vocabulary, plus the original `data` payload for diagnostics.

## Environment

`scrubbedParentEnv()` drops credential-shaped names (`/KEY|PASSWORD|SECRET|TOKEN/i`) and all `DSH_*` names. Explicit `env` entries merge after the scrub. `PYTHONUNBUFFERED=1` is set so stdout is flushed per frame.

## Sandbox

The `sandbox` config field is forwarded to `ctx.subprocess.spawn()`; `ctx.sandbox.confine()` applies the policy when present.

## Model Experience

None, as this package defines no model-visible surface; generated bridge packages own the prompt and tool-schema contributions of their decorated modules.

#### KV Cache effect

None; the bridge is a transport.

## Known Limitations and Deferred Work

- **Generation 1 transport relies on the subprocess service's raw pipe disposition;** the bundled subprocess service exposes `stdout` as a `Readable`. A future iteration will switch to a node-pty backed channel when prompt-driven Python REPL integration lands.
- **No in-process CPython embedding** by design; this is a process-management seam, not a runtime. Pyodide-based low-latency paths are tracked separately (see `packages/core/tools/README.md:27`).
- **No protocol-version negotiation** — pre-release stance, no compatibility promise.