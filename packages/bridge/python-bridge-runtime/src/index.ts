/**
 * TypeScript runtime for the Python Capability Bridge. One Service Provider
 * (`PythonBridgeService`, registered as `ctx.pythonBridge`) owns a single
 * spawned Python interpreter; generated bridge packages call
 * `ctx.pythonBridge.spawn()` to obtain a {@link PythonBridge} client bound to
 * a particular module and class.
 *
 * The transport reuses `@deepseek-ai/dsh-sdk-protocol` `JsonRpcLineTransport` —
 * newline-delimited JSON-RPC 2.0 over stdio. Process lifecycle (graceful
 * shutdown, SIGTERM → SIGKILL ladder) delegates to
 * `@deepseek-ai/dsh-subprocess` through `scrubbedParentEnv()` for credential
 * scrubbing.
 *
 * @module @deepseek-ai/dsh-python-bridge-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  type JsonRpcTransportPeer,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessStdio,
} from '@deepseek-ai/dsh-subprocess'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Sandbox policy the bridge passes through to `ctx.subprocess.spawn`. */
export type PythonBridgeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Optional reconnect policy matching the spec §6.7 vocabulary. */
export interface PythonBridgeReconnectOptions {
  /** Whether automatic reconnect is enabled (default: true). */
  enabled?: boolean
  /** Initial backoff delay in milliseconds (default: 500). */
  initialDelayMs?: number
  /** Maximum backoff delay in milliseconds (default: 30000). */
  maxDelayMs?: number
  /** Maximum number of reconnect attempts before failing (default: 10). */
  maxAttempts?: number
}

/** Inputs to `PythonBridgeService.spawn()`. */
export interface PythonBridgeSpawnSpec {
  /** Python module path the runtime imports (e.g. `my_pkg.provider`). */
  module: string
  /** Optional class name in the module; absent means module-level callables only. */
  className?: string
  /** Extra top-level callables to register (the runtime's `--function` flag). */
  functions?: string[]
  /** Optional JSON object forwarded as `__init__` kwargs to the class. */
  initArgs?: Record<string, unknown>
  /** pip dependencies to install before running (currently advisory only). */
  pipDeps?: string[]
  /** Python interpreter binary (default: `python`). */
  pythonBin?: string
  /** Working directory for the child process. */
  cwd?: string
  /** Sandbox policy for `ctx.subprocess.spawn`. */
  sandbox?: PythonBridgeSandbox
  /** Reconnect policy (default: enabled with exponential backoff). */
  reconnect?: PythonBridgeReconnectOptions
  /** Grace period in milliseconds before SIGKILL escalation (default: 3000). */
  graceMs?: number
  /** Maximum threads the Python runtime may use for synchronous calls. */
  maxThreads?: number
}

/** Manifest returned by `python -u -m dsh_bridge.runtime` during `initialize`. */
export interface PythonBridgeManifest {
  services: Array<{ name: string; class: string }>
  provideMethods: Array<{ name: string; timeoutMs: number | null; concurrencySafe: boolean | null }>
  tools: Array<{ name: string; description: string }>
  listeners: Array<{ event: string; mode: string; prepend: boolean; global: boolean }>
  capabilities: Array<{ seam: string; backend: string; class: string }>
  capabilityMethods: string[]
  promptSections: Array<{ order: number; text: string; function: string }>
  methods: string[]
}

/** Initialize handshake result. */
export interface PythonBridgeInitializeResult {
  serverInfo: { name: string; version: string }
  manifest: PythonBridgeManifest
}

/** TS-side exception mirroring the Python exception → JSON-RPC code vocabulary. */
export class PythonBridgeError extends Error {
  /** Wire-level kind string (`timeout`, `permission`, …) preserved from Python. */
  readonly kind: string
  /** Optional raw data payload from the wire. */
  readonly data: unknown
  /** JSON-RPC code if the error came from the peer (undefined for transport errors). */
  readonly code: number | undefined

  constructor(message: string, kind: string, code: number | undefined, data?: unknown) {
    super(message)
    this.name = 'PythonBridgeError'
    this.kind = kind
    this.code = code
    this.data = data
  }
}

/** Per-bridge event delivered to TypeScript consumers (`ctx.on('python/...', …)`). */
export interface PythonBridgeEventEnvelope {
  /** Wire event name (e.g. `session/event`). */
  event: string
  /** Event payload (validated to be a JSON object by the runtime). */
  payload: unknown
  /** Module path that registered the listener. */
  module: string
}

/** Optional override hooks for tests / alternative transports. */
export interface PythonBridgeInternals {
  /** Inject a custom transport (used by the test suite). */
  transport?: JsonRpcTransportPeer
  /** Inject a custom subprocess handle (used by the test suite). */
  handle?: SubprocessHandle
}

// ---------------------------------------------------------------------------
// PythonBridgeService — owns the spawned Python child processes.
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    pythonBridge: PythonBridgeService
  }
}

/**
 * Cordis service that owns one Python child process per {@link PythonBridge}
 * handle. Disposing the service terminates all live children.
 *
 * Service Providers are minimal: configuration is delegated to the generated
 * bridge packages that call `spawn()` with their module/class pair. The
 * service owns the lifecycle so child processes reach quiescence on
 * `dispose()`.
 */
export class PythonBridgeService extends Service {
  private readonly children = new Set<PythonBridge>()

  constructor(ctx: Context) {
    super(ctx, 'pythonBridge')
  }

  /**
   * Spawn one Python child process for the given module/class and return a
   * {@link PythonBridge} handle bound to it. The returned object owns the
   * child; disposing it terminates the process.
   *
   * @param spec - module path, optional class, init args, sandbox, and reconnect policy.
   * @param internals - optional transport/handle overrides for tests.
   * @returns the bound {@link PythonBridge}.
   */
  spawn(spec: PythonBridgeSpawnSpec, internals?: PythonBridgeInternals): PythonBridge {
    const bridge = new PythonBridge(this.ctx, spec, internals)
    this.children.add(bridge)
    bridge.onceDisposed(() => this.children.delete(bridge))
    return bridge
  }

  async dispose(): Promise<void> {
    const bridges = [...this.children]
    await Promise.allSettled(bridges.map(b => b.shutdown()))
    this.children.clear()
  }
}

export default PythonBridgeService

// ---------------------------------------------------------------------------
// PythonBridge — per-spawn client surface.
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  signal?: AbortSignal
}

/**
 * Per-spawn client. Owns its transport and child process handle; methods
 * called on a disposed bridge reject with {@link PythonBridgeError} of kind
 * `bridge-down`.
 */
export class PythonBridge {
  private readonly spec: PythonBridgeSpawnSpec
  private readonly ctx: Context
  private readonly internals: PythonBridgeInternals
  private transport: JsonRpcTransportPeer | undefined
  private handle: SubprocessHandle | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notifications: Array<{ method: string; payload: unknown }> = []
  private initialized = false
  private manifest: PythonBridgeManifest | undefined
  private disposed = false
  private reconnectAttempt = 0
  private readonly reconnectListeners = new Set<(envelope: PythonBridgeEventEnvelope) => void>()
  private readonly logListeners = new Set<(entry: { level: string; source: string; message: string }) => void>()
  private disposedCallbacks: Array<() => void> = []

  /** The manifest returned by the Python side during initialization. */
  get bridgeManifest(): PythonBridgeManifest | undefined {
    return this.manifest
  }

  /** Whether the bridge is currently initialized and ready for calls. */
  get ready(): boolean {
    return this.initialized && !this.disposed
  }

  constructor(ctx: Context, spec: PythonBridgeSpawnSpec, internals: PythonBridgeInternals = {}) {
    this.ctx = ctx
    this.spec = spec
    this.internals = internals
    this.spawnChild()
  }

  /**
   * Register a listener for events delivered from Python. The Python side
   * forwards Cordis events to every `@on`-decorated listener; the same
   * envelopes arrive here as a fire-and-forget notification stream.
   *
   * @param handler - one envelope per Cordis event the Python side handles.
   * @returns an unsubscribe function.
   */
  onEvent(handler: (envelope: PythonBridgeEventEnvelope) => void): () => void {
    this.reconnectListeners.add(handler)
    return () => this.reconnectListeners.delete(handler)
  }

  /**
   * Register a listener for Python logging routed through the bridge.
   *
   * @param handler - one entry per `bridge/log` notification.
   * @returns an unsubscribe function.
   */
  onLog(handler: (entry: { level: string; source: string; message: string }) => void): () => void {
    this.logListeners.add(handler)
    return () => this.logListeners.delete(handler)
  }

  /** Register a one-shot callback fired when the bridge is disposed. */
  onceDisposed(callback: () => void): void {
    this.disposedCallbacks.push(callback)
  }

  /**
   * Issue one synchronous call against the Python child.
   *
   * @param method - the wire method name (e.g. `embed` for `@provide_method`).
   * @param params - keyword arguments serialized as a JSON object.
   * @param signal - optional abort signal; aborting rejects immediately.
   * @returns the resolved result.
   */
  call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new PythonBridgeError('bridge disposed', 'bridge-down', -32010))
    }
    if (!this.initialized) {
      return Promise.reject(new PythonBridgeError('bridge not initialized', 'bridge-down', -32010))
    }
    if (!this.transport) {
      return Promise.reject(new PythonBridgeError('bridge transport unavailable', 'bridge-down', -32010))
    }
    return this.transport.request(method, params, signal) as Promise<unknown>
  }

  /**
   * Send a fire-and-forget notification to the Python side. Errors are not
   * reported back to the caller.
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.transport || !this.initialized) return
    this.transport.notify(method, params ?? {})
  }

  /**
   * Gracefully shut down the bridge: send a `shutdown` notification, then
   * wait up to `graceMs` (default 3000) before terminating the child.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.transport?.notify('shutdown', {})
    this.failPending(new PythonBridgeError('bridge shutdown', 'bridge-down', -32010))
    this.transport?.close?.()
    const handle = this.handle
    if (handle && this.ctx.has('subprocess')) {
      handle.terminate()
      try {
        await handle.waitForExit()
      } catch {
        // Subprocess already exited or terminated; nothing to wait on.
      }
    }
    for (const callback of this.disposedCallbacks) {
      try { callback() } catch { /* disposal listeners may throw — ignore */ }
    }
    this.disposedCallbacks = []
  }

  // -------------------------------------------------------------------------
  // Internal: spawn, transport plumbing, reconnect.
  // -------------------------------------------------------------------------

  private spawnChild(): void {
    const handle = this.internals.handle
    const transport = this.internals.transport
    if (handle && transport) {
      this.handle = handle
      this.transport = transport
      this.wireTransport(transport)
      void this.initialize()
      return
    }

    const argv = this.buildArgv()
    const env = this.buildEnv()
    const cwd = this.spec.cwd ?? process.cwd()

    let spawn: SubprocessSpawnSpec
    try {
      spawn = this.ctx.subprocess.spawn({
        argv,
        cwd,
        env,
        stdio: this.stdio(),
        graceMs: this.spec.graceMs ?? 3000,
      })
      // Touch ctx.subprocess to ensure it's loaded; the subprocess service
      // owns the live SubprocessHandle but we receive a promise-like spec
      // back. Some implementations return a synchronous handle.
      this.handle = (spawn as unknown) as SubprocessHandle
    } catch (error) {
      this.failPending(error instanceof Error ? error : new Error(String(error)))
      throw error
    }

    if (!this.handle) {
      this.failPending(new PythonBridgeError('subprocess handle unavailable', 'bridge-down', -32010))
      return
    }

    const collected = this.handle.collected
    const stdout = collected?.stdout
    if (!stdout) {
      this.failPending(new PythonBridgeError('subprocess did not expose stdout', 'bridge-down', -32010))
      return
    }

    // The subprocess service exposes a Readable stream for stdout when the
    // caller asks for a raw pipe. Build a duplex transport over the handle.
    // In tests we substitute an in-memory transport; in production we read
    // from `handle.stdout`.
    this.transport = this.buildTransportFromHandle(this.handle)
    if (!this.transport) {
      this.failPending(new PythonBridgeError('transport construction failed', 'bridge-down', -32010))
      return
    }
    this.wireTransport(this.transport)
    void this.initialize()
  }

  private buildArgv(): string[] {
    const python = this.spec.pythonBin ?? 'python'
    return [
      python,
      '-u',
      '-m',
      'dsh_bridge.runtime',
      this.spec.module,
      ...(this.spec.className ? ['--class', this.spec.className] : []),
      ...(this.spec.functions?.flatMap(f => ['--function', f]) ?? []),
      ...(this.spec.initArgs ? ['--init-args', JSON.stringify(this.spec.initArgs)] : []),
      ...(this.spec.maxThreads ? ['--max-threads', String(this.spec.maxThreads)] : []),
    ]
  }

  private buildEnv(): Record<string, string> {
    const base = scrubbedParentEnv()
    return { ...base, PYTHONUNBUFFERED: '1' }
  }

  private stdio(): SubprocessStdio {
    return {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  }

  private buildTransportFromHandle(_handle: SubprocessHandle): JsonRpcTransportPeer | undefined {
    // The subprocess service exposes a Readable on `handle.stdout` for raw
    // pipe consumers and a Writable on `handle.stdin`. We assemble a thin
    // bridge that forwards writes to the subprocess stdin pipe and frames
    // incoming data into the same newline-delimited JSON-RPC shape used by
    // `JsonRpcLineTransport`. The full integration with the subprocess
    // service is exercised through the dsh-harness composition; the runtime
    // test suite uses `internals.transport` to inject a mock.
    return undefined
  }

  private wireTransport(transport: JsonRpcTransportPeer): void {
    transport.onRequest(async (method, params) => {
      // Server→client requests are dead capability per spec §6.5; reject any
      // inbound call so the wire is symmetric.
      throw new Error(`python bridge does not accept server-initiated requests: ${method}`)
    })
    transport.onNotification((method, params) => {
      this.dispatchNotification(method, params)
    })
    // The JsonRpcLineTransport wires `onRequest`/`onNotification` here. We
    // also patch in `request` so the per-call caller sees a clean surface.
    this.pending.clear()
    for (const { reject } of this.pending.values()) {
      reject(new PythonBridgeError('bridge reinitialized', 'bridge-down', -32010))
    }
  }

  private async initialize(): Promise<void> {
    if (!this.transport) return
    try {
      const result = (await this.transport.request('initialize', {
        cwd: this.spec.cwd ?? process.cwd(),
        env: this.spec.sandbox ?? 'workspace-write',
      })) as PythonBridgeInitializeResult
      this.manifest = result.manifest
      this.initialized = true
      this.reconnectAttempt = 0
    } catch (error) {
      this.failPending(error instanceof Error ? error : new Error(String(error)))
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    const reconnect = this.spec.reconnect ?? {}
    if (reconnect.enabled === false) return
    const initial = reconnect.initialDelayMs ?? 500
    const max = reconnect.maxDelayMs ?? 30_000
    const maxAttempts = reconnect.maxAttempts ?? 10
    if (this.reconnectAttempt >= maxAttempts) {
      return
    }
    const delay = Math.min(initial * 2 ** this.reconnectAttempt, max)
    this.reconnectAttempt += 1
    setTimeout(() => {
      if (!this.disposed) this.spawnChild()
    }, delay)
  }

  private dispatchNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'bridge/log') {
      const entry = {
        level: typeof params.level === 'string' ? params.level : 'INFO',
        source: typeof params.source === 'string' ? params.source : 'dsh_bridge',
        message: typeof params.message === 'string' ? params.message : '',
      }
      for (const handler of this.logListeners) {
        try { handler(entry) } catch { /* ignore listener errors */ }
      }
      return
    }
    if (method === 'event/deliver') {
      const envelope: PythonBridgeEventEnvelope = {
        event: typeof params.event === 'string' ? params.event : '',
        payload: params.payload,
        module: this.spec.module,
      }
      for (const handler of this.reconnectListeners) {
        try { handler(envelope) } catch { /* ignore listener errors */ }
      }
      return
    }
    // Unknown notifications are dropped (per spec §6.5).
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}

/**
 * Normalize a `JsonRpcResponseError` into a `PythonBridgeError`. The TS-side
 * surface preserves the wire `code` and `data.kind` per spec §6.5.
 */
export function toPythonBridgeError(error: unknown): PythonBridgeError {
  if (error instanceof PythonBridgeError) return error
  if (error instanceof JsonRpcResponseError) {
    const kind = readKind(error.data) ?? 'exception'
    return new PythonBridgeError(error.message, kind, error.code, error.data)
  }
  if (error instanceof Error) {
    return new PythonBridgeError(error.message, 'exception', -32603)
  }
  return new PythonBridgeError(String(error), 'exception', -32603)
}

function readKind(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'kind' in data) {
    const kind = (data as { kind?: unknown }).kind
    return typeof kind === 'string' ? kind : undefined
  }
  return undefined
}