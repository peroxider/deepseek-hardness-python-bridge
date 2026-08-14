/**
 * Offline lifecycle checks for `@deepseek-ai/dsh-python-bridge-runtime`,
 * mirroring the fake-child vitest cases in
 * `packages/bridge/python-bridge-runtime/tests/bridge.spec.ts` with plain
 * assertions so they run without a package install:
 *
 *   node scripts/setup-stubs.mjs   # once per clone
 *   node --experimental-strip-types tests/e2e/runtime-lifecycle.mjs
 */
import { PassThrough } from 'node:stream'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  PythonBridgeService,
  PythonBridgeError,
  toPythonBridgeError,
} from '../../packages/bridge/python-bridge-runtime/src/index.ts'
import { Context } from '@deepseek-ai/cordis'

let failures = 0
function assert(cond, message) {
  if (!cond) {
    failures++
    console.error(`FAIL: ${message}`)
  } else {
    console.log(`ok: ${message}`)
  }
}

async function waitFor(cond, message, timeoutMs = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      failures++
      console.error(`FAIL (timeout): ${message}`)
      return false
    }
    await new Promise(r => setTimeout(r, 10))
  }
  console.log(`ok: ${message}`)
  return true
}

class FakeChild {
  constructor() {
    const toChild = new PassThrough()
    const fromChild = new PassThrough()
    this.stdin = toChild
    this.stdout = fromChild
    this.stderr = new PassThrough()
    this.kills = []
    this.exitListeners = []
    this.peer = new JsonRpcLineTransport(toChild, fromChild)
    this.peer.start()
  }
  kill(signal) { this.kills.push(signal); return true }
  once(_e, l) { this.exitListeners.push(l) }
  removeListener(_e, l) { this.exitListeners = this.exitListeners.filter(x => x !== l) }
  emitExit(code = 1, signal = null) { for (const l of [...this.exitListeners]) l(code, signal) }
}

function withInitialize(child) {
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

const ctx = new Context({})

// 1. worker-exit: in-flight call rejects with -32011 when the child dies.
{
  const service = new PythonBridgeService(ctx)
  const child = new FakeChild()
  withInitialize(child)
  const bridge = service.spawn({ module: 'example', reconnect: { enabled: false } }, { spawnFn: () => child })
  await waitFor(() => bridge.ready, 'ready before worker-exit case')
  let caught = null
  const pending = bridge.call('never-answered', {}).catch(e => { caught = e })
  child.emitExit(1, null)
  await pending
  assert(caught instanceof PythonBridgeError && caught.kind === 'worker-exit' && caught.code === -32011,
    `worker-exit classification (got ${caught?.kind}/${caught?.code})`)
  await service.dispose()
}

// 2. bridge-down after exit when reconnect is disabled.
{
  const service = new PythonBridgeService(ctx)
  const child = new FakeChild()
  withInitialize(child)
  const bridge = service.spawn({ module: 'example', reconnect: { enabled: false } }, { spawnFn: () => child })
  await waitFor(() => bridge.ready, 'ready before bridge-down case')
  child.emitExit(1, null)
  let caught = null
  await bridge.call('embed', {}).catch(e => { caught = e })
  assert(caught?.kind === 'bridge-down' && caught?.code === -32010,
    `bridge-down after exit (got ${caught?.kind}/${caught?.code})`)
  await service.dispose()
}

// 3. reconnect: unexpected exit respawns the child.
{
  const service = new PythonBridgeService(ctx)
  const children = []
  const bridge = service.spawn(
    { module: 'example', reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 5 } },
    { spawnFn: () => { const c = new FakeChild(); withInitialize(c); children.push(c); return c } },
  )
  await waitFor(() => bridge.ready, 'ready before reconnect case')
  children[0].emitExit(1, null)
  await waitFor(() => children.length === 2, 'respawn happened')
  await waitFor(() => bridge.ready, 'ready after respawn')
  await service.dispose()
}

// 4. teardown ladder: EOF ignored → SIGTERM → SIGKILL.
{
  const service = new PythonBridgeService(ctx)
  const child = new FakeChild()
  withInitialize(child)
  const bridge = service.spawn({ module: 'example', graceMs: 5, reconnect: { enabled: false } }, { spawnFn: () => child })
  await waitFor(() => bridge.ready, 'ready before ladder case')
  const shutdown = bridge.shutdown()
  await waitFor(() => child.kills.includes('SIGTERM'), 'SIGTERM after first grace')
  await waitFor(() => child.kills.includes('SIGKILL'), 'SIGKILL after second grace')
  child.emitExit(null, 'SIGKILL')
  await shutdown
  await service.dispose()
}

// 5. argv passthrough: module/class/initArgs reach the spawn.
{
  const service = new PythonBridgeService(ctx)
  const argvSeen = []
  const child = new FakeChild()
  withInitialize(child)
  service.spawn(
    { module: 'my.mod', className: 'Provider', initArgs: { a: 1 }, reconnect: { enabled: false } },
    { spawnFn: (argv) => { argvSeen.push([...argv]); return child } },
  )
  const expected = ['python', '-u', '-m', 'dsh_bridge.runtime', 'my.mod', '--class', 'Provider', '--init-args', '{"a":1}']
  assert(JSON.stringify(argvSeen[0]) === JSON.stringify(expected), `argv passthrough (${JSON.stringify(argvSeen[0])})`)
  await service.dispose()
}

// 6. toPythonBridgeError mappings.
{
  const err = new JsonRpcResponseError(-32001, 'deadline', { kind: 'timeout' })
  const mapped = toPythonBridgeError(err)
  assert(mapped instanceof PythonBridgeError && mapped.kind === 'timeout' && mapped.code === -32001,
    'JsonRpcResponseError → kind/code preserved')
  assert(toPythonBridgeError(new Error('x')).kind === 'exception', 'plain Error → exception')
}

// 7. env scrub: no DSH_* or credential-shaped names reach the child env.
{
  process.env.DSH_TEST_LEAK = 'leak'
  process.env.MY_API_KEY = 'secret'
  const service = new PythonBridgeService(ctx)
  let envSeen = null
  const child = new FakeChild()
  withInitialize(child)
  service.spawn(
    { module: 'm', reconnect: { enabled: false } },
    { spawnFn: (_argv, opts) => { envSeen = opts.env; return child } },
  )
  assert(envSeen && !('DSH_TEST_LEAK' in envSeen), 'DSH_* names scrubbed')
  assert(envSeen && !('MY_API_KEY' in envSeen), 'credential-shaped names scrubbed')
  assert(envSeen && envSeen.PYTHONUNBUFFERED === '1', 'PYTHONUNBUFFERED set')
  delete process.env.DSH_TEST_LEAK
  delete process.env.MY_API_KEY
  await service.dispose()
}

if (failures > 0) {
  console.error(`${failures} lifecycle check(s) failed`)
  process.exit(1)
}
console.log('ALL LIFECYCLE CHECKS PASSED')
