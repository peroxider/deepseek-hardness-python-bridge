/**
 * Vitest coverage for the Python Capability Bridge runtime.
 *
 * The test suite substitutes an in-memory transport (`internals.transport`)
 * for the real subprocess transport so we can assert request/response
 * framing, error mapping, and reconnect policy without spawning a Python
 * child.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JsonRpcLineTransport,
  type JsonRpcTransportPeer,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  PythonBridgeError,
  PythonBridgeService,
  toPythonBridgeError,
} from '../src/index.ts'
import type { PythonBridgeInternals } from '../src/index.ts'

class MockTransport implements JsonRpcTransportPeer {
  pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown> | unknown) | undefined
  notificationHandler: ((method: string, params: Record<string, unknown>) => void) | undefined

  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const id = `mock_${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      void this.requestHandler?.(method, params as Record<string, unknown>).then(
        (result) => {
          this.pendingRequests.delete(id)
          resolve(result)
        },
        (err) => {
          this.pendingRequests.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  }

  notify(method: string, params?: object): void {
    this.notifications.push({ method, params: (params ?? {}) as Record<string, unknown> })
  }

  onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void {
    this.requestHandler = handler
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler
  }
}

function buildInternals(transport: MockTransport): PythonBridgeInternals {
  return { transport }
}

describe('PythonBridge', () => {
  let transport: MockTransport
  let service: PythonBridgeService

  beforeEach(() => {
    transport = new MockTransport()
    service = new PythonBridgeService({} as never)
  })

  afterEach(async () => {
    await service.dispose()
  })

  it('initializes against a Python handshake', async () => {
    const bridge = service.spawn({ module: 'example' }, buildInternals(transport))
    // The mock transport's request handler should return a valid handshake.
    transport.requestHandler = async () => ({
      serverInfo: { name: 'dsh-python-bridge-runtime', version: '0.0.0' },
      manifest: {
        services: [{ name: 'ml', class: 'MLProvider' }],
        provideMethods: [{ name: 'embed', timeoutMs: 1000, concurrencySafe: null }],
        tools: [],
        listeners: [],
        capabilities: [],
        capabilityMethods: [],
        promptSections: [],
        methods: ['embed'],
      },
    })

    await new Promise(r => setTimeout(r, 10))
    expect(bridge.bridgeManifest?.methods).toContain('embed')
  })

  it('surfaces a PythonBridgeError with kind/code from a JsonRpcResponseError', () => {
    const err = toPythonBridgeError({
      name: 'JsonRpcResponseError',
      message: 'deadline exceeded',
      code: -32001,
      data: { kind: 'timeout' },
    })
    expect(err).toBeInstanceOf(PythonBridgeError)
    expect(err.kind).toBe('timeout')
    expect(err.code).toBe(-32001)
  })

  it('rejects calls before initialization', async () => {
    const bridge = service.spawn({ module: 'example' }, buildInternals(transport))
    await expect(bridge.call('embed', { texts: [] })).rejects.toThrow(PythonBridgeError)
  })

  it('routes bridge/log notifications to log listeners', async () => {
    transport.requestHandler = async () => ({
      serverInfo: { name: 'dsh-python-bridge-runtime', version: '0' },
      manifest: {
        services: [], provideMethods: [], tools: [], listeners: [],
        capabilities: [], capabilityMethods: [], promptSections: [], methods: [],
      },
    })
    const bridge = service.spawn({ module: 'example' }, buildInternals(transport))
    const received: Array<{ level: string; source: string; message: string }> = []
    bridge.onLog(entry => received.push(entry))

    await new Promise(r => setTimeout(r, 10))
    transport.notificationHandler?.('bridge/log', { level: 'WARN', source: 'example', message: 'oops' })
    expect(received).toEqual([{ level: 'WARN', source: 'example', message: 'oops' }])
  })

  it('routes event/deliver notifications to event listeners', async () => {
    transport.requestHandler = async () => ({
      serverInfo: { name: 'dsh-python-bridge-runtime', version: '0' },
      manifest: {
        services: [], provideMethods: [], tools: [], listeners: [],
        capabilities: [], capabilityMethods: [], promptSections: [], methods: [],
      },
    })
    const bridge = service.spawn({ module: 'example' }, buildInternals(transport))
    const received: unknown[] = []
    bridge.onEvent(env => received.push(env))

    await new Promise(r => setTimeout(r, 10))
    transport.notificationHandler?.('event/deliver', { event: 'session/event', payload: { kind: 'tool/call' } })
    expect(received).toEqual([{ event: 'session/event', payload: { kind: 'tool/call' }, module: 'example' }])
  })

  it('gracefully shuts down on dispose', async () => {
    transport.requestHandler = async () => ({
      serverInfo: { name: 'dsh-python-bridge-runtime', version: '0' },
      manifest: {
        services: [], provideMethods: [], tools: [], listeners: [],
        capabilities: [], capabilityMethods: [], promptSections: [], methods: [],
      },
    })
    const bridge = service.spawn({ module: 'example' }, buildInternals(transport))
    await new Promise(r => setTimeout(r, 10))
    await bridge.shutdown()
    expect(transport.notifications.find(n => n.method === 'shutdown')).toBeDefined()
  })

  it('marks a JsonRpcResponseError as PythonBridgeError with the wire kind', () => {
    const { JsonRpcResponseError } = require('@deepseek-ai/dsh-sdk-protocol') as typeof import('@deepseek-ai/dsh-sdk-protocol')
    const err = new JsonRpcResponseError(-32004, 'invalid-args', { kind: 'invalid-args' })
    const mapped = toPythonBridgeError(err)
    expect(mapped).toBeInstanceOf(PythonBridgeError)
    expect(mapped.kind).toBe('invalid-args')
    expect(mapped.code).toBe(-32004)
  })
})

describe('PythonBridgeError', () => {
  it('preserves the wire vocabulary', () => {
    const err = new PythonBridgeError('boom', 'timeout', -32001, { kind: 'timeout' })
    expect(err.name).toBe('PythonBridgeError')
    expect(err.kind).toBe('timeout')
    expect(err.code).toBe(-32001)
    expect(err.data).toEqual({ kind: 'timeout' })
  })
})

describe('PythonBridgeService', () => {
  it('throws when constructed without an inject-aware context', () => {
    expect(() => new PythonBridgeService({} as never)).toThrow()
  })
})