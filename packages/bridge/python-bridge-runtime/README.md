# @peroxider/dsh-python-bridge-runtime

English | [中文](README.zh.md)

The TypeScript runtime half of the Python Capability Bridge. One Cordis Service Provider (`PythonBridgeService`, registered as `ctx.pythonBridge`) spawns long-lived `python -u -m dsh_bridge.runtime <module>` child processes and forwards decorated method calls through newline-delimited JSON-RPC 2.0 over stdio (reusing [`@deepseek-ai/dsh-sdk-protocol`](../sdk/protocol/README.md) framing). Process lifecycle (graceful shutdown, SIGTERM → SIGKILL ladder) delegates to [`@deepseek-ai/dsh-subprocess`](../subprocess/subprocess/README.md) through `scrubbedParentEnv()` for credential scrubbing.

This package is the runtime; it ships no generated Service classes. Generated Service / Tool / Listener / Capability classes are produced by [`@peroxider/dsh-python-bridge-codegen`](../python-bridge-codegen/README.md) from a Python module's `dsh_bridge` decorators and depend on this package.

## Wiring

```ts
import { PythonBridgeService } from '@peroxider/dsh-python-bridge-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pythonBridge: PythonBridgeService
  }
}
```

A typical generated entry calls `ctx.pythonBridge.spawn({ module, className, initArgs, sandbox })` in its constructor and forwards each `@provide_method` call through `this.bridge.call('methodName', args)`.

`PythonBridge.waitUntilReady()` resolves with the initial worker manifest. It rejects with `PythonBridgeError` when the initialize handshake fails or disposal starts before readiness, so plugin initialization does not poll indefinitely after an import or protocol error.

## Lifecycle

`PythonBridgeService.dispose()` runs every live bridge through the teardown ladder: `shutdown` notification → stdin EOF → wait `graceMs` (default 3000) → SIGTERM → wait `graceMs` → SIGKILL, mirroring `packages/sdk/client/README.md`'s `stdin-EOF → SIGTERM → SIGKILL` model.

## Spawn ownership

The bridge owns its spawn the same way SDK-managed transports do (see the `dsh-subprocess` README, "SDK-managed spawns remain outside"): a long-lived `node:child_process` framed by `JsonRpcLineTransport` over the child's stdio. Environment policy stays single-sourced through `scrubbedParentEnv()`.

## Interpreter probe

Before spawning, the bridge verifies the interpreter can import the bridge runtime with `pythonBin -c "import dsh_bridge"`. A probe failure raises `PythonBridgeError` with `kind: 'dependency-missing'`, `code: -32012`, and `pip install dsh-python-bridge` guidance — never a confusing immediate `worker-exit`. Probe results are cached per `pythonBin`, so known-good interpreters are not re-probed on reconnect. Tests substitute the probe through `internals.probeFn`.

## Version negotiation

The `initialize` handshake carries `clientInfo: { name, version }` (`PYTHON_BRIDGE_CLIENT_NAME` / `PYTHON_BRIDGE_CLIENT_VERSION`). The Python runtime accepts the handshake when the client version's major matches its own `serverInfo.version` major, and rejects it with `protocol-mismatch` (`-32006`) and a readable message otherwise. Keep the two majors in lockstep when releasing.

The [wire protocol stability reference](../../../docs/protocol.md) owns the fixed method set, error-kind dictionary, and additive manifest evolution rules.

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

`confine()` is a **write** allow-list. Reads, network, and process visibility are outside its vocabulary, so under `workspace-write` the child can still read any host file the parent process could — including `~/.aws/credentials` and `/etc/shadow`. Use `readDenyPaths` (below) to close that gap.

### Inspecting what the runner actually enforced

`bridge.sandboxInfo` returns what `confine()` reported, or `undefined` when no confinement happened (seam absent, or `sandbox: 'danger-full-access'`):

```ts
const info = bridge.sandboxInfo
info?.enforcement        // 'full' | 'partial' — 'partial' means the backend could not apply every rule
info?.policy.mode        // the SandboxPolicy that was requested
info?.denialSignatures   // backend-specific stderr prefixes that indicate a denial
info?.runnerFailureRules // backend exit-code / signature rules
```

Available synchronously after `spawn()` returns — it does not wait for the initialize handshake. The same object is mirrored onto `bridge.manifest.sandbox` once the handshake resolves, for callers that already read the manifest.

When a child's stderr line starts with one of `denialSignatures`, the bridge forwards it to `onLog()` subscribers as a `WARN` entry with `source: 'sandbox'`, plus `matchedSignature` and `sandboxMode`. This is best-effort surfacing: a backend whose stderr format drifts from its declared signatures will not be matched.

### `readDenyPaths` — read-side isolation

`readDenyPaths` installs a deny-list inside the Python child, independent of the sandbox mode. It applies even under `danger-full-access`, on the reasoning that a model-controlled tool should not read operator secrets regardless of the operator's write-confinement choice.

```ts
ctx.pythonBridge.spawn({
  module: 'my_pkg.provider',
  sandbox: 'workspace-write',
  readDenyPaths: ['/etc', '/root/.ssh', '/home/*/.aws'],
})
```

The list is JSON-encoded into `DSH_READ_DENY_PATHS_JSON`; the Python runtime installs a `sys.addaudithook` callback before importing your module, so reads performed at module-import time are covered too. A match raises `PermissionError`, which reaches the caller as `kind: 'permission'` / `-32003`.

Matching rules:

- A rule matches the named path **and its whole subtree** — `/etc` covers `/etc/passwd` and `/etc/ssl/private/key.pem`. You do not need a second `/etc/*` rule.
- Symlinks are resolved (`os.path.realpath`) before matching, and the path is also matched as spelled, so a rule can name either the link or its target.
- `*` follows `fnmatch`, where it spans path separators. There is no separate `**` globstar, and consequently rules are **broader** than shell globbing suggests: `/home/*/.aws` also matches `/home/a/b/c/.aws`. Prefer specific prefixes.
- `/proc/self/mem` and `/proc/<pid>/mem` are always denied once the hook is installed, even with an empty rule list.

Omit the field (or pass `[]`) and no hook is installed at all — zero overhead for deployments that do not configure it. An oversized list (over 64 KB encoded) raises `PythonBridgeError` of `kind: 'config-too-large'` before spawn rather than being truncated. Malformed config on the Python side fails **open**, logging a `WARN`, so an operator typo cannot take the bridge down.

Covered audit events are `open`, `os.open`, `os.scandir`, `os.listdir` (CPython 3.12+ only — earlier versions emit no event for it), and `subprocess.Popen`. This is defense-in-depth, not a security boundary: `ctypes.CDLL`/`dlopen` and native code can call `open(2)` directly. Deny `import ctypes` at the policy layer if that matters to you.

## Model Experience

None, as this package defines no model-visible surface; generated bridge packages own the prompt and tool-schema contributions of their decorated modules.

#### KV Cache effect

None; the bridge is a transport.

## Known Limitations and Deferred Work

- **Sandbox confinement requires the optional seam** — without `dsh-sandbox` loaded the `sandbox` field is advisory only.
- **`readDenyPaths` is defense-in-depth, not a boundary** — it is enforced by a Python audit hook inside the child, which native code and `ctypes` can bypass. `os.listdir` is only covered on CPython 3.12+.
- **No in-process CPython embedding** by design; this is a process-management seam, not a runtime. Pyodide-based low-latency paths are tracked separately (see `packages/core/tools/README.md:27`).
- **Listener notification queueing during reconnect is unimplemented** — spec §6.7's 1 MiB per-event-type queue is deferred; notifications raised while the child is down are dropped.
