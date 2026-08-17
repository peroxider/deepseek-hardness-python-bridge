/**
 * Vitest coverage for the Python Capability Bridge runtime.
 *
 * Two injection seams keep the suite hermetic: `internals.transport`
 * substitutes the wire (no child), and `internals.spawnFn` substitutes the
 * child factory (real transport over in-memory streams where noted).
 */

import { PassThrough } from 'node:stream'
import { delimiter } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  PythonBridge,
  PythonBridgeError,
  PythonBridgeService,
  toPythonBridgeError,
} from '../src/index.ts'
import type {
  PythonBridgeChild,
  PythonBridgeInternals,
  PythonBridgeTransport,
} from '../src/index.ts'

// ---------------------------------------------------------------------------
// Mock transport (no child process involved)
// ---------------------------------------------------------------------------

class MockTransport implements PythonBridgeTransport {
  notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
  notificationHandler: ((method: string, params: Record<string, unknown>) => void) | undefined
  closed = false

  request(method: string, params: object): Promise<unknown> {
    if (!this.requestHandler) return Promise.reject(new Error('no handler'))
    return this.requestHandler(method, params as Record<string, unknown>)
  }

  notify(method: string, params?: object): void {
    this.notifications.push({ method, params: (params ?? {}) as Record<string, unknown> })
  }

  start(): void {}
  close(): void { this.closed = true }

  onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void {
    this.requestHandler = handler
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler
  }

  respondInitialize(manifestMethods: string[] = []): void {
    this.requestHandler = async (method) => {
      if (method === 'initialize') {
        return {
          serverInfo: { name: 'dsh-python-bridge-runtime', version: '0' },
          manifest: {
            services: [], provideMethods: [], tools: [], listeners: [],
            capabilities: [], capabilityMethods: [], promptSections: [],
            methods: manifestMethods,
          },
        }
      }
      throw new JsonRpcResponseError(-32601, `method not found: ${method}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Fake child (real transport over in-memory streams)
// ---------------------------------------------------------------------------

class FakeChild implements PythonBridgeChild {
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  readonly kills: Array<NodeJS.Signals | number | undefined> = []
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []

  /** The child's own protocol endpoint: tests respond to bridge requests here. */
  readonly peer: JsonRpcLineTransport

  constructor() {
    // stdin: what the bridge writes to the child; stdout: what the child says back.
    const toChild = new PassThrough()
    const fromChild = new PassThrough()
    this.stdin = toChild
    this.stdout = fromChild
    this.stderr = new PassThrough()
    this.peer = new JsonRpcLineTransport(toChild, fromChild)
    this.peer.start()
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }

  once(_event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener)
  }

  removeListener(_event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners = this.exitListeners.filter(l => l !== listener)
  }

  emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    for (const listener of [...this.exitListeners]) listener(code, signal)
  }
}

function fakeChildWithInitialize(child: FakeChild): void {
  child.peer.onRequest(async (method) => {
    if (method === 'initialize') {
      return {
        serverInfo: { name: 'dsh-python-bridge-runtime', version: '0' },
        manifest: {
          services: [], provideMethods: [], tools: [], listeners: [],
          capabilities: [], capabilityMethods: [], promptSections: [], methods: [],
        },
      }
    }
    throw new JsonRpcResponseError(-32601, `method not found: ${method}`)
  })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PythonBridge (mock transport)', () => {
  let transport: MockTransport
  let service: PythonBridgeService

  beforeEach(() => {
    transport = new MockTransport()
    service = new PythonBridgeService({} as never)
  })

  afterEach(async () => {
    await service.dispose()
  })

  it('completes the initialize handshake and exposes the manifest', async () => {
    transport.respondInitialize(['embed'])
    const bridge = service.spawn({ module: 'example' }, { transport })
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    expect(bridge.bridgeManifest?.methods).toContain('embed')
  })

  it('rejects calls before initialization with bridge-down', async () => {
    const bridge = service.spawn({ module: 'example' }, { transport })
    await expect(bridge.call('embed', {})).rejects.toMatchObject({ kind: 'bridge-down', code: -32010 })
  })

  it('maps JsonRpcResponseError to PythonBridgeError preserving kind/code', async () => {
    transport.respondInitialize([])
    const bridge = service.spawn({ module: 'example' }, { transport })
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    transport.requestHandler = async () => {
      throw new JsonRpcResponseError(-32004, 'bad args', { kind: 'invalid-args' })
    }
    await expect(bridge.call('embed', {})).rejects.toMatchObject({ kind: 'invalid-args', code: -32004 })
  })

  it('routes bridge/log notifications to log listeners', async () => {
    transport.respondInitialize([])
    const bridge = service.spawn({ module: 'example' }, { transport })
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    const received: unknown[] = []
    bridge.onLog(entry => received.push(entry))
    transport.notificationHandler?.('bridge/log', { level: 'WARN', source: 'example', message: 'oops' })
    expect(received).toEqual([{ level: 'WARN', source: 'example', message: 'oops' }])
  })

  it('routes event/deliver notifications to event listeners', async () => {
    transport.respondInitialize([])
    const bridge = service.spawn({ module: 'example' }, { transport })
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    const received: unknown[] = []
    bridge.onEvent(env => received.push(env))
    transport.notificationHandler?.('event/deliver', { event: 'session/event', payload: { kind: 'tool/call' } })
    expect(received).toEqual([{ event: 'session/event', payload: { kind: 'tool/call' }, module: 'example' }])
  })

  it('sends a shutdown notification during dispose', async () => {
    transport.respondInitialize([])
    const bridge = service.spawn({ module: 'example' }, { transport })
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    await bridge.shutdown()
    expect(transport.notifications.find(n => n.method === 'shutdown')).toBeDefined()
    expect(transport.closed).toBe(true)
  })

  it('drops notifications while not ready', () => {
    const bridge = service.spawn({ module: 'example' }, { transport })
    expect(() => bridge.notify('event/deliver', {})).not.toThrow()
    expect(transport.notifications).toHaveLength(0)
  })
})

describe('PythonBridge (fake child, real transport)', () => {
  let service: PythonBridgeService

  beforeEach(() => {
    service = new PythonBridgeService({} as never)
  })

  afterEach(async () => {
    await service.dispose()
  })

  it('rejects in-flight calls with worker-exit when the child dies', async () => {
    const child = new FakeChild()
    fakeChildWithInitialize(child)
    const bridge = service.spawn(
      { module: 'example', reconnect: { enabled: false } },
      { spawnFn: () => child },
    )
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    // A request the child never answers stays in flight.
    const pending = bridge.call('never-answered', {})
    child.emitExit(1, null)
    await expect(pending).rejects.toMatchObject({ kind: 'worker-exit', code: -32011 })
  })

  it('rejects calls with bridge-down after the child exits', async () => {
    const child = new FakeChild()
    fakeChildWithInitialize(child)
    const bridge = service.spawn(
      { module: 'example', reconnect: { enabled: false } },
      { spawnFn: () => child },
    )
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    child.emitExit(1, null)
    await expect(bridge.call('embed', {})).rejects.toMatchObject({ kind: 'bridge-down', code: -32010 })
  })

  it('respawns after an unexpected exit when reconnect is enabled', async () => {
    const children: FakeChild[] = []
    const bridge = service.spawn(
      { module: 'example', reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 5 } },
      {
        spawnFn: () => {
          const child = new FakeChild()
          fakeChildWithInitialize(child)
          children.push(child)
          return child
        },
      },
    )
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    children[0].emitExit(1, null)
    await vi.waitFor(() => expect(children.length).toBe(2))
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
  })

  it('escalates the teardown ladder when the child ignores stdin EOF', async () => {
    const child = new FakeChild()
    fakeChildWithInitialize(child)
    const bridge = service.spawn(
      { module: 'example', graceMs: 5, reconnect: { enabled: false } },
      { spawnFn: () => child },
    )
    await vi.waitFor(() => expect(bridge.ready).toBe(true))
    const shutdown = bridge.shutdown()
    // The fake child never exits on EOF: SIGTERM after grace, SIGKILL after another.
    await vi.waitFor(() => expect(child.kills).toContain('SIGTERM'))
    await vi.waitFor(() => expect(child.kills).toContain('SIGKILL'))
    child.emitExit(null, 'SIGKILL')
    await shutdown
  })

  it('passes module/class/initArgs through to the child argv', () => {
    const argvSeen: string[][] = []
    const child = new FakeChild()
    fakeChildWithInitialize(child)
    service.spawn(
      { module: 'my.mod', className: 'Provider', initArgs: { a: 1 }, reconnect: { enabled: false } },
      {
        spawnFn: (argv) => {
          argvSeen.push([...argv])
          return child
        },
      },
    )
    expect(argvSeen[0]).toEqual([
      'python', '-u', '-m', 'dsh_bridge.runtime', 'my.mod',
      '--class', 'Provider', '--init-args', '{"a":1}',
    ])
  })

  it('prepends configured import roots to the inherited PYTHONPATH', () => {
    const previousPythonPath = process.env.PYTHONPATH
    process.env.PYTHONPATH = ['inherited', 'packages'].join(delimiter)
    try {
      let envSeen: Record<string, string> | undefined
      const child = new FakeChild()
      fakeChildWithInitialize(child)
      service.spawn(
        {
          module: 'my.mod',
          pythonPath: ['configured', 'source'],
          reconnect: { enabled: false },
        },
        {
          spawnFn: (_argv, options) => {
            envSeen = options.env
            return child
          },
        },
      )
      expect(envSeen?.PYTHONPATH).toBe(
        ['configured', 'source', 'inherited', 'packages'].join(delimiter),
      )
    } finally {
      if (previousPythonPath === undefined) delete process.env.PYTHONPATH
      else process.env.PYTHONPATH = previousPythonPath
    }
  })
})

describe('toPythonBridgeError', () => {
  it('preserves the wire vocabulary from JsonRpcResponseError', () => {
    const err = new JsonRpcResponseError(-32001, 'deadline', { kind: 'timeout' })
    const mapped = toPythonBridgeError(err)
    expect(mapped).toBeInstanceOf(PythonBridgeError)
    expect(mapped.kind).toBe('timeout')
    expect(mapped.code).toBe(-32001)
    expect(mapped.data).toEqual({ kind: 'timeout' })
  })

  it('maps plain errors to exception/-32603', () => {
    expect(toPythonBridgeError(new Error('x'))).toMatchObject({ kind: 'exception', code: -32603 })
    expect(toPythonBridgeError('y')).toMatchObject({ kind: 'exception', code: -32603 })
  })

  it('passes PythonBridgeError through unchanged', () => {
    const err = new PythonBridgeError('boom', 'abort', -32002)
    expect(toPythonBridgeError(err)).toBe(err)
  })
})
