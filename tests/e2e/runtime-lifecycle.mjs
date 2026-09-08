/**
 * Offline lifecycle checks for `@peroxider/dsh-python-bridge-runtime`,
 * mirroring the fake-child vitest cases in
 * `packages/bridge/python-bridge-runtime/tests/bridge.spec.ts` with plain
 * assertions so they run without a package install:
 *
 *   node scripts/setup-stubs.mjs   # once per clone
 *   node --experimental-strip-types tests/e2e/runtime-lifecycle.mjs
 */
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { delimiter } from 'node:path'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  PYTHON_BRIDGE_CLIENT_NAME,
  PYTHON_BRIDGE_CLIENT_VERSION,
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
  const bridge = service.spawn({ module: 'example', reconnect: { enabled: false } }, { spawnFn: () => child, probeFn: () => true })
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
  const bridge = service.spawn({ module: 'example', reconnect: { enabled: false } }, { spawnFn: () => child, probeFn: () => true })
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
    { spawnFn: () => { const c = new FakeChild(); withInitialize(c); children.push(c); return c }, probeFn: () => true },
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
  const bridge = service.spawn({ module: 'example', graceMs: 5, reconnect: { enabled: false } }, { spawnFn: () => child, probeFn: () => true })
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
    { spawnFn: (argv) => { argvSeen.push([...argv]); return child }, probeFn: () => true },
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
  const previousPythonPath = process.env.PYTHONPATH
  process.env.DSH_TEST_LEAK = 'leak'
  process.env.MY_API_KEY = 'secret'
  process.env.PYTHONPATH = ['inherited', 'packages'].join(delimiter)
  const service = new PythonBridgeService(ctx)
  let envSeen = null
  const child = new FakeChild()
  withInitialize(child)
  service.spawn(
    { module: 'm', pythonPath: ['configured', 'source'], reconnect: { enabled: false } },
    { spawnFn: (_argv, opts) => { envSeen = opts.env; return child }, probeFn: () => true },
  )
  assert(envSeen && !('DSH_TEST_LEAK' in envSeen), 'DSH_* names scrubbed')
  assert(envSeen && !('MY_API_KEY' in envSeen), 'credential-shaped names scrubbed')
  assert(envSeen && envSeen.PYTHONUNBUFFERED === '1', 'PYTHONUNBUFFERED set')
  assert(envSeen?.PYTHONPATH === ['configured', 'source', 'inherited', 'packages'].join(delimiter),
    `configured pythonPath precedes inherited PYTHONPATH (got ${envSeen?.PYTHONPATH})`)
  delete process.env.DSH_TEST_LEAK
  delete process.env.MY_API_KEY
  if (previousPythonPath === undefined) delete process.env.PYTHONPATH
  else process.env.PYTHONPATH = previousPythonPath
  await service.dispose()
}

// 8. sandbox confine: real ConfinedArgv shape ({ argv, enforcement, ... }) is
// unwrapped; danger-full-access bypasses confinement entirely.
{
  const confinedCalls = []
  const DENIAL_SIGNATURES = ['bwrap: Can\'t create file', 'EROFS']
  const RUNNER_FAILURE_RULES = [
    { allowedExitCodes: [0, 1], fatalSignatures: ['bwrap: execvp'], informationalLines: ['bwrap: note'] },
  ]
  const fakeSandbox = {
    confine: (argv, policy) => {
      confinedCalls.push({ argv, policy })
      return {
        argv: ['bwrap', '--ro-bind', '/', '/', ...argv],
        enforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES,
        runnerFailureRules: RUNNER_FAILURE_RULES,
      }
    },
  }
  const ctxWithSandbox = new Context({ sandbox: fakeSandbox })
  const service = new PythonBridgeService(ctxWithSandbox)
  const argvSeen = []
  const child = new FakeChild()
  withInitialize(child)
  const bridge = service.spawn(
    { module: 'm', sandbox: 'workspace-write', cwd: '/tmp/ws', reconnect: { enabled: false } },
    { spawnFn: (argv) => { argvSeen.push([...argv]); return child }, probeFn: () => true },
  )
  assert(argvSeen[0]?.[0] === 'bwrap', `confined argv used (got ${argvSeen[0]?.[0]})`)
  assert(confinedCalls[0]?.policy?.mode === 'workspace-write', 'policy mode forwarded')
  // resolve() keeps the expectation platform-correct: on POSIX `/tmp/ws` is
  // unchanged, on Windows it becomes `C:\tmp\ws` exactly as the runtime's
  // `resolve(cwd)` produces.
  assert(confinedCalls[0]?.policy?.workspaceRoot === resolve('/tmp/ws'), 'workspaceRoot resolved from cwd')

  // The rest of ConfinedArgv (enforcement / denialSignatures /
  // runnerFailureRules) used to be discarded. It is now captured so operators
  // can tell "confinement is partial" from "confinement is full".
  assert(bridge.sandboxInfo?.enforcement === 'full',
    `sandboxInfo.enforcement captured (got ${bridge.sandboxInfo?.enforcement})`)
  assert(JSON.stringify(bridge.sandboxInfo?.denialSignatures) === JSON.stringify(DENIAL_SIGNATURES),
    `sandboxInfo.denialSignatures captured (got ${JSON.stringify(bridge.sandboxInfo?.denialSignatures)})`)
  assert(bridge.sandboxInfo?.runnerFailureRules?.[0]?.fatalSignatures?.[0] === 'bwrap: execvp',
    'sandboxInfo.runnerFailureRules captured')
  assert(bridge.sandboxInfo?.policy?.mode === 'workspace-write', 'sandboxInfo carries the policy')
  // Defensive copy: mutating the array the fake sandbox returned must not
  // reach through into the captured info.
  DENIAL_SIGNATURES.push('MUTATED')
  assert(bridge.sandboxInfo?.denialSignatures?.length === 2,
    'sandboxInfo.denialSignatures is a defensive copy')
  DENIAL_SIGNATURES.pop()

  await waitFor(() => bridge.ready, 'ready before manifest.sandbox assertions')
  assert(bridge.manifest?.sandbox?.enforcement === 'full',
    `manifest.sandbox.enforcement mirrors sandboxInfo (got ${bridge.manifest?.sandbox?.enforcement})`)
  assert(JSON.stringify(bridge.manifest?.sandbox?.denialSignatures) === JSON.stringify(DENIAL_SIGNATURES),
    `manifest.sandbox.denialSignatures mirrors sandboxInfo (got ${JSON.stringify(bridge.manifest?.sandbox?.denialSignatures)})`)

  // A runner denial on stderr surfaces as a bridge/log WARN naming the
  // signature that matched, rather than only appearing in stderrTail at exit.
  const sandboxLogs = []
  bridge.onLog(entry => { if (entry.source === 'sandbox') sandboxLogs.push(entry) })
  child.stderr.write('EROFS: read-only file system\nunrelated chatter\n')
  await waitFor(() => sandboxLogs.length > 0, 'sandbox denial line surfaced as bridge/log')
  assert(sandboxLogs[0]?.level === 'WARN', `denial log level is WARN (got ${sandboxLogs[0]?.level})`)
  assert(sandboxLogs[0]?.matchedSignature === 'EROFS',
    `denial log names the matched signature (got ${sandboxLogs[0]?.matchedSignature})`)
  assert(sandboxLogs[0]?.sandboxMode === 'workspace-write',
    `denial log carries the sandbox mode (got ${sandboxLogs[0]?.sandboxMode})`)
  assert(sandboxLogs.length === 1, `non-matching stderr lines are not forwarded (got ${sandboxLogs.length})`)
  await service.dispose()

  const service2 = new PythonBridgeService(ctxWithSandbox)
  const argvSeen2 = []
  const child2 = new FakeChild()
  withInitialize(child2)
  service2.spawn(
    { module: 'm', sandbox: 'danger-full-access', reconnect: { enabled: false } },
    { spawnFn: (argv) => { argvSeen2.push([...argv]); return child2 }, probeFn: () => true },
  )
  assert(argvSeen2[0]?.[0] === 'python', 'danger-full-access bypasses confine')
  assert(confinedCalls.length === 1, 'confine not called for danger-full-access')
  await service2.dispose()
}

// 9. A throwing spawn inside the reconnect timer must not crash the host.
{
  const service = new PythonBridgeService(ctx)
  let spawnCalls = 0
  const children = []
  const bridge = service.spawn(
    { module: 'm', reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 5, maxAttempts: 3 } },
    {
      spawnFn: () => {
        spawnCalls++
        if (spawnCalls > 1) throw new Error('confine exploded')
        const c = new FakeChild()
        withInitialize(c)
        children.push(c)
        return c
      },
      probeFn: () => true,
    },
  )
  await waitFor(() => bridge.ready, 'ready before reconnect-throw case')
  children[0].emitExit(1, null)
  // The reconnect timer fires; spawnFn throws inside it. If the exception
  // escaped, the process would be dead before this line ran.
  await new Promise(r => setTimeout(r, 60))
  assert(spawnCalls >= 2, 'reconnect attempted the respawn')
  assert(true, 'host survived a throwing respawn in the reconnect timer')
  await service.dispose()
}

// 10. probe: a failing interpreter probe surfaces dependency-missing with
// install guidance, and no child is ever spawned.
{
  const service = new PythonBridgeService(ctx)
  let spawnCalls = 0
  let caught = null
  try {
    service.spawn(
      { module: 'm', reconnect: { enabled: false } },
      { spawnFn: () => { spawnCalls++; return new FakeChild() }, probeFn: () => false },
    )
  } catch (e) { caught = e }
  assert(caught instanceof PythonBridgeError && caught.kind === 'dependency-missing' && caught.code === -32012,
    `dependency-missing classification (got ${caught?.kind}/${caught?.code})`)
        assert((caught?.message ?? '').includes('pip install dsh-python-bridge'), 'install guidance present in message')
  assert(spawnCalls === 0, 'child never spawned after probe failure')
  await service.dispose()
}

// 11. initialize carries clientInfo for version negotiation.
{
  const service = new PythonBridgeService(ctx)
  const child = new FakeChild()
  let initParams = null
  child.peer.onRequest(async (method, params) => {
    if (method === 'initialize') {
      initParams = params
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
  const bridge = service.spawn({ module: 'example', reconnect: { enabled: false } }, { spawnFn: () => child, probeFn: () => true })
  await waitFor(() => bridge.ready, 'ready before clientInfo case')
  assert(
    initParams?.clientInfo?.name === PYTHON_BRIDGE_CLIENT_NAME && initParams?.clientInfo?.version === PYTHON_BRIDGE_CLIENT_VERSION,
    `initialize carries clientInfo {name, version} (got ${JSON.stringify(initParams?.clientInfo)})`,
  )
  await service.dispose()
}

// 12. readDenyPaths: encoded into DSH_READ_DENY_PATHS_JSON for the Python
// child's audit hook. The hook itself is covered by the Python suite
// (`python/sdk-dsl/tests/test_read_isolation.py`); what matters here is that
// the TS side hands the child a well-formed config, omits the env var when
// unconfigured, and fails closed rather than truncating an oversized list.
{
  const service = new PythonBridgeService(ctx)
  let envSeen = null
  const child = new FakeChild()
  withInitialize(child)
  service.spawn(
    { module: 'm', readDenyPaths: ['/tmp/sensitive', '/home/*/.aws'], reconnect: { enabled: false } },
    { spawnFn: (_argv, opts) => { envSeen = opts.env; return child }, probeFn: () => true },
  )
  const decoded = JSON.parse(envSeen?.DSH_READ_DENY_PATHS_JSON ?? '{}')
  assert(JSON.stringify(decoded) === JSON.stringify({ rules: ['/tmp/sensitive', '/home/*/.aws'] }),
    `readDenyPaths encoded as {rules:[...]} (got ${envSeen?.DSH_READ_DENY_PATHS_JSON})`)
  await service.dispose()

  // Unconfigured: the env var must be absent, not an empty JSON document, so
  // the Python side's `parse_config` returns None and no hook is installed.
  const service2 = new PythonBridgeService(ctx)
  let envSeen2 = null
  const child2 = new FakeChild()
  withInitialize(child2)
  service2.spawn(
    { module: 'm', reconnect: { enabled: false } },
    { spawnFn: (_argv, opts) => { envSeen2 = opts.env; return child2 }, probeFn: () => true },
  )
  assert(envSeen2 && !('DSH_READ_DENY_PATHS_JSON' in envSeen2),
    'no readDenyPaths leaves the env var unset')
  await service2.dispose()

  // An empty array is treated as "unconfigured" too — an empty rules list
  // would otherwise install a hook that matches nothing but still pays the
  // per-open audit cost.
  const service3 = new PythonBridgeService(ctx)
  let envSeen3 = null
  const child3 = new FakeChild()
  withInitialize(child3)
  service3.spawn(
    { module: 'm', readDenyPaths: [], reconnect: { enabled: false } },
    { spawnFn: (_argv, opts) => { envSeen3 = opts.env; return child3 }, probeFn: () => true },
  )
  assert(envSeen3 && !('DSH_READ_DENY_PATHS_JSON' in envSeen3),
    'empty readDenyPaths leaves the env var unset')
  await service3.dispose()

  // Oversized config fails closed BEFORE spawn: silently truncating would
  // hand the child a shorter deny list than the operator asked for.
  const service4 = new PythonBridgeService(ctx)
  let spawnCalls = 0
  let caught = null
  const huge = Array.from({ length: 4000 }, (_, i) => `/deny/path/number/${i}/with/padding`)
  try {
    service4.spawn(
      { module: 'm', readDenyPaths: huge, reconnect: { enabled: false } },
      { spawnFn: () => { spawnCalls++; return new FakeChild() }, probeFn: () => true },
    )
  } catch (e) { caught = e }
  assert(caught instanceof PythonBridgeError && caught.kind === 'config-too-large',
    `oversized readDenyPaths rejected (got ${caught?.kind})`)
  assert(spawnCalls === 0, 'no child spawned when readDenyPaths is oversized')
  await service4.dispose()
}

if (failures > 0) {
  console.error(`${failures} lifecycle check(s) failed`)
  process.exit(1)
}
console.log('ALL LIFECYCLE CHECKS PASSED')
