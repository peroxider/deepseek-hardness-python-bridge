/**
 * Real-child end-to-end check for `@deepseek-ai/dsh-python-bridge-runtime`:
 * spawns an actual `python3 -u -m dsh_bridge.runtime` child against the
 * bundled `examples/python-bridge-ml` provider and drives it through the
 * initialize → call → error → event/log → shutdown ladder.
 *
 * Run from the repository root:
 *
 *   node scripts/setup-stubs.mjs   # once per clone
 *   node --experimental-strip-types tests/e2e/runtime-real-child.mjs
 *
 * Exits non-zero on the first failed assertion. In the monorepo this check
 * is superseded by the vitest integration suite; here it is the offline
 * proof that the bridge works against a real Python child.
 */
import { PythonBridgeService, PythonBridgeError } from '@deepseek-ai/dsh-python-bridge-runtime'
import { Context } from '@deepseek-ai/cordis'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
process.env.PYTHONPATH = ['examples/python-bridge-ml', 'python/sdk-dsl/src'].join(delimiter)

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

const ctx = new Context({})
const service = new PythonBridgeService(ctx)

const bridge = service.spawn({
  module: 'examples.python-bridge-ml.provider',
  className: 'MLProvider',
  initArgs: { model_path: '/tmp/model' },
  pythonBin: process.env.DSH_E2E_PYTHON ?? 'python3',
  cwd: root,
  reconnect: { enabled: false },
})

// The handshake completes asynchronously; wait for readiness.
for (let i = 0; i < 200 && !bridge.ready; i++) await new Promise(r => setTimeout(r, 50))
assert(bridge.ready, 'bridge never became ready')
console.log('ready OK; methods:', bridge.bridgeManifest.methods.join(','))

// 1. Happy-path call with real args/result.
const result = await bridge.call('embed', { texts: ['hello', 'world'] })
assert(Array.isArray(result) && result.length === 2 && result[0].length === 768,
  `embed shape wrong: ${JSON.stringify(result).slice(0, 120)}`)
console.log('embed OK; dim:', result[0].length)

// 2. Python exception → PythonBridgeError with the wire kind/code.
let saw = null
try {
  await bridge.call('resize_image', { input_path: '/nonexistent.png', width: 1, height: 1 })
} catch (e) { saw = e }
assert(saw instanceof PythonBridgeError, `expected PythonBridgeError, got ${saw}`)
assert(saw.kind === 'exception' && saw.code === -32603, `expected exception/-32603, got ${saw.kind}/${saw.code}`)
console.log('error mapping OK; kind:', saw.kind, 'code:', saw.code)

// 3. Unknown method → -32601 (method not found).
saw = null
try {
  await bridge.call('no_such_method', {})
} catch (e) { saw = e }
assert(saw instanceof PythonBridgeError && saw.code === -32601, `expected -32601, got ${saw?.code}`)
console.log('unknown method OK; code:', saw.code)

// 4. event/deliver → the listener's print() is proxied back as bridge/log.
const logs = []
bridge.onLog(e => logs.push(e))
bridge.notify('event/deliver', { event: 'session/event', payload: { type: 'tool/call', data: { name: 'resize_image' } } })
await new Promise(r => setTimeout(r, 400))
const audit = logs.find(l => l.message.includes('audit'))
assert(audit, `no audit log proxied; got ${JSON.stringify(logs)}`)
console.log('event/log proxy OK:', audit.message)

// 5. Teardown ladder: shutdown → stdin EOF → exit, no escalation needed.
await service.dispose()
console.log('shutdown OK')
console.log('ALL TS RUNTIME E2E CHECKS PASSED')
process.exit(0)
