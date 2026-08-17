/**
 * TypeScript runtime for the Python Capability Bridge. One Service Provider
 * (`PythonBridgeService`, registered as `ctx.pythonBridge`) owns every spawned
 * Python interpreter; generated bridge packages call `ctx.pythonBridge.spawn()`
 * to obtain a {@link PythonBridge} client bound to one module/class pair.
 *
 * The bridge owns its spawn the same way SDK-managed transports do (see the
 * `dsh-subprocess` README, "SDK-managed spawns remain outside"): a long-lived
 * `node:child_process` running `python -u -m dsh_bridge.runtime <module>`,
 * framed by `@deepseek-ai/dsh-sdk-protocol` `JsonRpcLineTransport` over the
 * child's stdio. Environment policy stays single-sourced through
 * `scrubbedParentEnv()`; the teardown ladder is `shutdown` notification →
 * stdin EOF → SIGTERM → grace → SIGKILL, mirroring the SDK client README.
 *
 * @module @deepseek-ai/dsh-python-bridge-runtime
 */

import { spawn as spawnChildProcess, spawnSync } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  type JsonRpcTransportPeer,
} from '@deepseek-ai/dsh-sdk-protocol'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Sandbox policy forwarded to `ctx.sandbox.confine()` when the seam is loaded. */
export type PythonBridgeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Reconnect policy matching the spec §6.7 vocabulary (defaults shown). */
export interface PythonBridgeReconnectOptions {
  /** Whether automatic reconnect is enabled (default: true). */
  enabled?: boolean
  /** Initial backoff delay in milliseconds (default: 500). */
  initialDelayMs?: number
  /** Maximum backoff delay in milliseconds (default: 30000). */
  maxDelayMs?: number
  /** Maximum reconnect attempts before the bridge stays down (default: 10). */
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
  /** Optional JSON-serializable object forwarded as `__init__` kwargs to the class. */
  initArgs?: Record<string, unknown>
  /** pip dependencies the deployment must provide (advisory; never auto-installed). */
  pipDeps?: string[]
  /** Python interpreter binary (default: `python`). */
  pythonBin?: string
  /** Import roots prepended to the child process `PYTHONPATH`. */
  pythonPath?: string[]
  /** Working directory for the child process. */
  cwd?: string
  /** Sandbox policy for `ctx.sandbox.confine()` when the seam is loaded. */
  sandbox?: PythonBridgeSandbox
  /** Reconnect policy (default: enabled with exponential backoff). */
  reconnect?: PythonBridgeReconnectOptions
  /** Grace period in milliseconds for each teardown ladder step (default: 3000). */
  graceMs?: number
  /** Maximum threads the Python runtime may use for synchronous calls. */
  maxThreads?: number
}

/** One dataclass constructor field surfaced for Config documentation and initArgs validation. */
export interface PythonBridgeInitField {
  /** Field name (snake_case, Python side). */
  name: string
  /** PEP 484 annotation rendered as text (e.g. `list[str]`); `unknown` when not renderable. */
  annotation: string
  /** JSON-safe plain default value when the field has one. */
  default?: unknown
  /** Default-factory function name when the field uses `field(default_factory=...)`. */
  defaultFactory?: string
}

/** Manifest returned by `python -u -m dsh_bridge.runtime` during `initialize`. */
export interface PythonBridgeManifest {
  services: Array<{
    name: string
    class: string
    /** Dataclass constructor fields; empty for non-dataclass classes. */
    initFields: PythonBridgeInitField[]
  }>
  provideMethods: Array<{
    name: string
    timeoutMs: number | null
    concurrencySafe: boolean | null
    /** Parameter name → PEP 484 annotation string (empty when none render). */
    parameters: Record<string, string>
    /** Return annotation string; null when the method has no `->` annotation. */
    return: string | null
  }>
  tools: Array<{
    name: string
    description: string
    /** Per-property parameter map (dsh-tools `ParameterSchemaSpec` form). */
    parameters: Record<string, unknown>
    /** Raw JSON Schema value projection; null when the tool declares none. */
    outputSchema: Record<string, unknown> | null
  }>
  listeners: Array<{
    event: string
    mode: string
    prepend: boolean
    global: boolean
    /** Python function name backing the listener (for diagnostics). */
    function: string
  }>
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

/** Per-bridge event delivered to TypeScript consumers of {@link PythonBridge.onEvent}. */
export interface PythonBridgeEventEnvelope {
  /** Wire event name (e.g. `session/event`). */
  event: string
  /** Event payload as forwarded by the Python side. */
  payload: unknown
  /** Module path that registered the listener. */
  module: string
}

/** One `bridge/log` entry forwarded from Python logging or proxied stdout. */
export interface PythonBridgeLogEntry {
  level: string
  source: string
  message: string
}

/**
 * Transport surface the bridge consumes. `JsonRpcLineTransport` satisfies it;
 * tests substitute a mock implementing the same methods.
 */
export interface PythonBridgeTransport extends JsonRpcTransportPeer {
  /** Send a request and await its response, honoring an optional abort signal
   * (the concrete `JsonRpcLineTransport.request` signature; the base
   * `JsonRpcTransportPeer` interface omits `signal`). */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown>
  start(): void
  close(): void
  onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void
}

/** Minimal child-process surface the bridge consumes (tests inject fakes). */
export interface PythonBridgeChild {
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** Optional override hooks for tests / alternative transports. */
export interface PythonBridgeInternals {
  /** Substitute a pre-built transport (skips the real child spawn when paired with no child). */
  transport?: PythonBridgeTransport
  /** Substitute a child-process factory for the real `node:child_process.spawn`. */
  spawnFn?: (argv: readonly string[], options: { cwd: string; env: Record<string, string> }) => PythonBridgeChild
  /** Substitute the interpreter probe (default: `pythonBin -c "import dsh_bridge"`). */
  probeFn?: (pythonBin: string) => boolean
}

// ---------------------------------------------------------------------------
// PythonBridgeService — owns every spawned Python child.
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    pythonBridge: PythonBridgeService
  }
}

/**
 * Cordis service that owns one Python child process per {@link PythonBridge}
 * handle. Teardown is effect-based: the constructor registers the disposer
 * that shuts down every live child when the owning fiber unloads.
 *
 * The service declares no required injections: the bridge owns its spawn, and
 * the optional sandbox seam is read through `ctx.get('sandbox')`.
 */
export class PythonBridgeService extends Service {
  private readonly children = new Set<PythonBridge>()

  constructor(ctx: Context) {
    super(ctx, 'pythonBridge')
    // Cordis never calls a Service.dispose() method; teardown belongs to the
    // fiber's effect disposers (the subprocess-local pattern).
    ctx.effect(() => {
      return async () => {
        await this.dispose()
      }
    }, 'python bridge teardown')
  }

  /**
   * Spawn one Python child process for the given module/class and return a
   * {@link PythonBridge} handle bound to it. The returned object owns the
   * child; disposing it terminates the process.
   *
   * @param spec - module path, optional class, init args, sandbox, and reconnect policy.
   * @param internals - optional transport/spawn overrides for tests.
   * @returns the bound {@link PythonBridge}.
   */
  spawn(spec: PythonBridgeSpawnSpec, internals?: PythonBridgeInternals): PythonBridge {
    const bridge = new PythonBridge(this.ctx, spec, internals)
    this.children.add(bridge)
    bridge.onceDisposed(() => this.children.delete(bridge))
    return bridge
  }

  /** Shut down every live bridge and await their teardown ladders. Idempotent;
   * also registered as the fiber effect disposer at construction. */
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

/** Default per-step teardown grace (matches `@deepseek-ai/dsh-bash-local` `DEFAULT_GRACE_MS`). */
const DEFAULT_GRACE_MS = 3_000

/** Default reconnect policy per spec §6.7. */
const RECONNECT_DEFAULTS = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
} as const

/** Number of trailing stderr lines retained for worker-exit diagnostics. */
const STDERR_RING_LINES = 100

/** JSON-RPC code for a spawn-time probe failure (missing dsh-bridge runtime). */
const DEPENDENCY_MISSING_CODE = -32012

/**
 * Client identity sent during `initialize` for version negotiation. The Python
 * runtime rejects the handshake as a `protocol-mismatch` (`-32006`) when the
 * client version's major differs from its own, so bumping the major here and
 * in `dsh_bridge.__version__` must happen together.
 */
export const PYTHON_BRIDGE_CLIENT_NAME = 'dsh-python-bridge-runtime'
export const PYTHON_BRIDGE_CLIENT_VERSION = '0.1.0'

/**
 * Interpreter probe results keyed by `pythonBin`. `dsh_bridge` presence is a
 * per-interpreter fact, so a cached positive skips redundant probes on every
 * reconnect and a cached negative makes the fast-fail error repeatable
 * without re-spawning the interpreter.
 */
const interpreterProbeCache = new Map<string, boolean>()

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * Per-spawn client. Owns its child process and transport; methods called on a
 * disposed or not-yet-initialized bridge reject with {@link PythonBridgeError}
 * of kind `bridge-down`; calls in flight when the child exits reject with
 * kind `worker-exit` (`-32011`).
 */
export class PythonBridge {
  private readonly spec: PythonBridgeSpawnSpec
  private readonly ctx: Context
  private readonly internals: PythonBridgeInternals
  private child: PythonBridgeChild | undefined
  private transport: PythonBridgeTransport | undefined
  private exitPromise: Promise<ChildExit> | undefined
  private resolveExit: ((exit: ChildExit) => void) | undefined
  private initialized = false
  private manifest: PythonBridgeManifest | undefined
  private disposed = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private lastReadyAt = 0
  private readonly stderrRing: string[] = []
  private readonly eventListeners = new Set<(envelope: PythonBridgeEventEnvelope) => void>()
  private readonly logListeners = new Set<(entry: PythonBridgeLogEntry) => void>()
  private disposedCallbacks: Array<() => void> = []
  private readonly readyPromise: Promise<PythonBridgeManifest>
  private resolveReady!: (manifest: PythonBridgeManifest) => void
  private rejectReady!: (error: PythonBridgeError) => void

  /** The manifest returned by the Python side during initialization. */
  get bridgeManifest(): PythonBridgeManifest | undefined {
    return this.manifest
  }

  /** Whether the bridge completed its initialize handshake and is not disposed. */
  get ready(): boolean {
    return this.initialized && !this.disposed
  }

  constructor(ctx: Context, spec: PythonBridgeSpawnSpec, internals: PythonBridgeInternals = {}) {
    this.ctx = ctx
    this.spec = spec
    this.internals = internals
    this.readyPromise = new Promise<PythonBridgeManifest>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.readyPromise.catch(() => undefined)
    this.spawnChild()
  }

  /**
   * Wait for the initial handshake and return its manifest.
   *
   * @returns The first successfully initialized worker manifest.
   * @throws {@link PythonBridgeError} when initialization fails or disposal starts first.
   */
  waitUntilReady(): Promise<PythonBridgeManifest> {
    return this.readyPromise
  }

  /**
   * Subscribe to events the Python side forwards (`event/deliver` echoes).
   * @param handler - one envelope per delivered event.
   * @returns an unsubscribe function.
   */
  onEvent(handler: (envelope: PythonBridgeEventEnvelope) => void): () => void {
    this.eventListeners.add(handler)
    return () => this.eventListeners.delete(handler)
  }

  /**
   * Subscribe to Python logging and proxied stdout (`bridge/log`).
   * @param handler - one entry per log notification.
   * @returns an unsubscribe function.
   */
  onLog(handler: (entry: PythonBridgeLogEntry) => void): () => void {
    this.logListeners.add(handler)
    return () => this.logListeners.delete(handler)
  }

  /** Register a one-shot callback fired when the bridge finishes disposal. */
  onceDisposed(callback: () => void): void {
    this.disposedCallbacks.push(callback)
  }

  /**
   * Issue one call against the Python child.
   *
   * @param method - the wire method name (e.g. `embed` for a `@provide_method`).
   * @param params - keyword arguments serialized as a JSON object.
   * @param signal - optional abort signal forwarded to the transport.
   * @returns the resolved result; rejects with {@link PythonBridgeError}.
   */
  async call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport
    if (this.disposed || !this.initialized || !transport) {
      throw new PythonBridgeError(
        `python bridge is not ready (module=${this.spec.module})`,
        'bridge-down',
        -32010,
      )
    }
    const request = transport.request(method, params, signal).catch((error: unknown) => {
      throw toPythonBridgeError(error)
    })
    // A child exit mid-call must classify as worker-exit, not a generic
    // transport failure, so callers can distinguish crashes from peer errors.
    if (!this.exitPromise) return request
    return Promise.race([request, this.exitPromise.then(exit => {
      throw new PythonBridgeError(
        `python worker exited during call (module=${this.spec.module}, ${describeExit(exit)})${this.stderrTail()}`,
        'worker-exit',
        -32011,
      )
    })])
  }

  /**
   * Send a fire-and-forget notification to the Python side. Dropped when the
   * bridge is not ready (notifications carry no caller-visible failure).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.transport || !this.initialized || this.disposed) return
    this.transport.notify(method, params ?? {})
  }

  /**
   * Graceful teardown ladder: `shutdown` notification → stdin EOF → wait
   * `graceMs` → SIGTERM → wait `graceMs` → SIGKILL. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.rejectReady(new PythonBridgeError(
      `python bridge disposed before initialization completed (module=${this.spec.module})`,
      'bridge-down',
      -32010,
    ))
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.initialized = false
    try {
      this.transport?.notify('shutdown', {})
    } catch { /* transport may already be broken; the ladder continues */ }
    const child = this.child
    if (child) {
      const graceMs = this.spec.graceMs ?? DEFAULT_GRACE_MS
      try { child.stdin?.end() } catch { /* stdin may already be closed */ }
      if (!(await this.waitForExit(graceMs))) {
        child.kill('SIGTERM')
        if (!(await this.waitForExit(graceMs))) {
          child.kill('SIGKILL')
          await this.waitForExit(graceMs)
        }
      }
    }
    this.transport?.close?.()
    this.transport = undefined
    this.child = undefined
    for (const callback of this.disposedCallbacks) {
      try { callback() } catch { /* disposal listeners must not break teardown */ }
    }
    this.disposedCallbacks = []
  }

  // -------------------------------------------------------------------------
  // Internal: spawn, handshake, exit handling, reconnect.
  // -------------------------------------------------------------------------

  private spawnChild(): void {
    // Injected-transport path (tests): no child, no exit ladder.
    if (this.internals.transport) {
      this.transport = this.internals.transport
      this.wireTransport(this.transport)
      void this.initialize()
      return
    }

    const python = this.spec.pythonBin ?? 'python'
    const env = this.buildEnv()
    const cwd = this.spec.cwd ?? process.cwd()

    // Fast-fail when the interpreter cannot import the bridge runtime. A
    // missing dsh-bridge must surface as an actionable error with install
    // guidance, not as a confusing immediate `worker-exit` from the child.
    // No reconnect is scheduled here: a probe failure is a per-interpreter
    // fact (cached), so an orphaned retry loop on the throwing constructor
    // would be pointless. The reconnect timer's catch re-arms its own budget.
    if (!this.probeInterpreter(python, env, cwd)) {
      throw new PythonBridgeError(
        `python interpreter '${python}' cannot import the dsh-bridge runtime ` +
        `(needed to load module '${this.spec.module}'). ` +
        'Install it with `pip install dsh-bridge`, or make the package ' +
        "importable in that interpreter's environment, then retry.",
        'dependency-missing',
        DEPENDENCY_MISSING_CODE,
      )
    }

    const argv = this.buildArgv()

    const spawnFn = this.internals.spawnFn ?? ((a: readonly string[], o: { cwd: string; env: Record<string, string> }) => {
      const executable = a[0]
      if (executable === undefined) throw new Error('python bridge: spawn argv is empty')
      return spawnChildProcess(executable, [...a.slice(1)], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as PythonBridgeChild
    })

    let child: PythonBridgeChild
    try {
      child = spawnFn(argv, { cwd, env })
    } catch (error) {
      this.scheduleReconnect()
      throw toPythonBridgeError(error)
    }
    this.child = child
    this.exitPromise = new Promise<ChildExit>(resolve => {
      this.resolveExit = resolve
    })
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.removeListener('exit', onExit)
      this.onChildExit({ code, signal })
    }
    child.once('exit', onExit)

    child.stderr?.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) {
        if (!line) continue
        this.stderrRing.push(line)
        if (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift()
      }
    })

    if (!child.stdout || !child.stdin) {
      this.onChildExit({ code: null, signal: null })
      return
    }
    this.transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    this.transport.start()
    this.wireTransport(this.transport)
    void this.initialize()
  }

  /**
   * Verify the interpreter can import the dsh-bridge runtime before spawning.
   * An injected `probeFn` (tests) bypasses the process cache for determinism;
   * the default runs `pythonBin -c "import dsh_bridge"` with the child's
   * cwd/env and caches the per-interpreter result.
   *
   * @param pythonBin - interpreter binary from the spawn spec.
   * @param env - child environment (also used for the probe subprocess).
   * @param cwd - child working directory (also used for the probe subprocess).
   * @returns true when the interpreter can import `dsh_bridge`.
   */
  private probeInterpreter(pythonBin: string, env: Record<string, string>, cwd: string): boolean {
    const injected = this.internals.probeFn
    if (injected) return injected(pythonBin)
    const cached = interpreterProbeCache.get(pythonBin)
    if (cached !== undefined) return cached
    let ok = false
    try {
      const result = spawnSync(pythonBin, ['-c', 'import dsh_bridge'], {
        cwd,
        env,
        stdio: 'ignore',
        windowsHide: true,
      })
      ok = result.status === 0
    } catch {
      ok = false
    }
    interpreterProbeCache.set(pythonBin, ok)
    return ok
  }

  private buildArgv(): readonly string[] {
    const python = this.spec.pythonBin ?? 'python'
    const argv = [
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
    // Optional sandbox confinement. `danger-full-access` bypasses confinement
    // by contract; when the seam is absent the child runs unconfined (the
    // deployment chose not to load one). `confine()` failures (SandboxError)
    // propagate — the bridge never silently bypasses confinement.
    if (!this.spec.sandbox || this.spec.sandbox === 'danger-full-access') {
      return argv
    }
    const sandbox = this.ctx.get?.('sandbox') as SandboxProvider | undefined
    if (!sandbox) return argv
    const policy: SandboxPolicy = {
      mode: this.spec.sandbox,
      workspaceRoot: resolve(this.spec.cwd ?? process.cwd()),
    }
    return sandbox.confine(argv, policy).argv
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...scrubbedParentEnv(), PYTHONUNBUFFERED: '1' }
    if (this.spec.pythonPath?.length) {
      env.PYTHONPATH = [
        ...this.spec.pythonPath,
        ...(env.PYTHONPATH ? [env.PYTHONPATH] : []),
      ].join(delimiter)
    }
    return env
  }

  private wireTransport(transport: PythonBridgeTransport): void {
    transport.onRequest(async (method) => {
      // Server→client requests are dead capability per spec §6.5; reject any
      // inbound call so the wire stays symmetric.
      throw new Error(`python bridge does not accept worker-initiated requests: ${method}`)
    })
    transport.onNotification((method, params) => {
      this.dispatchNotification(method, params)
    })
  }

  private async initialize(): Promise<void> {
    const transport = this.transport
    if (!transport) return
    try {
      const result = (await transport.request('initialize', {
        cwd: this.spec.cwd ?? process.cwd(),
        clientInfo: { name: PYTHON_BRIDGE_CLIENT_NAME, version: PYTHON_BRIDGE_CLIENT_VERSION },
      })) as PythonBridgeInitializeResult
      if (this.disposed) return
      this.manifest = result.manifest
      this.initialized = true
      this.lastReadyAt = Date.now()
      this.resolveReady(result.manifest)
    } catch (error) {
      if (this.disposed) return
      const bridgeError = toPythonBridgeError(error)
      this.rejectReady(bridgeError)
      // Handshake failure (import error, crash on boot): the child typically
      // exits right after, and onChildExit owns the reconnect decision.
      if (this.child) return
      this.scheduleReconnect()
    }
  }

  private onChildExit(exit: ChildExit): void {
    const resolve = this.resolveExit
    this.resolveExit = undefined
    resolve?.(exit)
    this.initialized = false
    this.manifest = undefined
    this.transport?.close?.()
    this.transport = undefined
    this.child = undefined
    if (this.disposed) return
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const reconnect = { ...RECONNECT_DEFAULTS, ...this.spec.reconnect }
    if (!reconnect.enabled) return
    // A bridge that stayed up for at least maxDelayMs earned a fresh budget.
    if (this.lastReadyAt > 0 && Date.now() - this.lastReadyAt >= reconnect.maxDelayMs) {
      this.reconnectAttempt = 0
    }
    if (this.reconnectAttempt >= reconnect.maxAttempts) return
    const delay = Math.min(reconnect.initialDelayMs * 2 ** this.reconnectAttempt, reconnect.maxDelayMs)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.disposed) return
      try {
        this.spawnChild()
      } catch {
        // Respawn failures (confine errors, missing interpreter) consume
        // budget and retry; they must never crash the host process.
        this.scheduleReconnect()
      }
    }, delay)
  }

  private waitForExit(graceMs: number): Promise<boolean> {
    const exitPromise = this.exitPromise
    if (!exitPromise) return Promise.resolve(true)
    return Promise.race([
      exitPromise.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), graceMs)),
    ])
  }

  private dispatchNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'bridge/log') {
      const entry: PythonBridgeLogEntry = {
        level: typeof params.level === 'string' ? params.level : 'INFO',
        source: typeof params.source === 'string' ? params.source : 'dsh_bridge',
        message: typeof params.message === 'string' ? params.message : '',
      }
      for (const handler of this.logListeners) {
        try { handler(entry) } catch { /* listener errors must not break the wire */ }
      }
      return
    }
    if (method === 'event/deliver') {
      const envelope: PythonBridgeEventEnvelope = {
        event: typeof params.event === 'string' ? params.event : '',
        payload: params.payload,
        module: this.spec.module,
      }
      for (const handler of this.eventListeners) {
        try { handler(envelope) } catch { /* listener errors must not break the wire */ }
      }
      return
    }
    // Unknown notifications are dropped (per spec §6.5).
  }

  private stderrTail(): string {
    if (this.stderrRing.length === 0) return ''
    return `\nstderr tail:\n${this.stderrRing.slice(-20).join('\n')}`
  }
}

/** Render one exit fact pair for diagnostics. */
function describeExit(exit: ChildExit): string {
  if (exit.signal !== null) return `signal=${exit.signal}`
  return `code=${exit.code ?? 'null'}`
}

/**
 * Normalize any rejection into a {@link PythonBridgeError}. The TS surface
 * preserves the wire `code` and `data.kind` per spec §6.5.
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
