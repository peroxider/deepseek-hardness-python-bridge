/**
 * Generated-package end-to-end check: runs the codegen against the bundled
 * `examples/python-bridge-ml` provider, loads the generated package, mounts
 * its `MlService` on a stub Cordis context backed by the REAL
 * `PythonBridgeService`, and drives model-facing calls through a real Python
 * child process. This is the offline proof of the repository's premise: a
 * decorated Python module becomes a working dsh plugin.
 *
 * Run from the repository root:
 *
 *   node scripts/setup-stubs.mjs   # once per clone
 *   node --experimental-strip-types tests/e2e/generated-package.mjs
 */
import { generateBridgePackage } from '@deepseek-ai/dsh-python-bridge-codegen'
import { PythonBridgeService } from '@deepseek-ai/dsh-python-bridge-runtime'
import { Context } from '@deepseek-ai/cordis'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
process.env.PYTHONPATH = ['examples/python-bridge-ml', 'python/sdk-dsl/src'].join(delimiter)

let failures = 0
function assert(cond, message) {
  if (!cond) {
    failures++
    console.error(`FAIL: ${message}`)
  } else {
    console.log(`ok: ${message}`)
  }
}

// 1. Generate the bridge package from the Python source.
const source = readFileSync(join(root, 'examples/python-bridge-ml/provider.py'), 'utf8')
const artifacts = generateBridgePackage({
  module: 'examples.python-bridge-ml.provider',
  packageName: '@my-org/python-bridge-ml',
  sources: [{ path: 'provider.py', contents: source }],
})
assert(artifacts.parsed.diagnostics.length === 0, 'no codegen diagnostics')

const outDir = join(root, '.gen/python-bridge-ml')
rmSync(outDir, { recursive: true, force: true })
for (const f of artifacts.files) {
  const p = join(outDir, f.path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, f.contents)
}
console.log('ok: package generated into .gen/python-bridge-ml')

// 2. Load the generated package and mount its Service on a stub context.
// The pythonBridge service lives on the root context; the generated plugin is
// mounted on a child (forked) context so we can prove its fiber effects tear
// down the child and unregister the tool WITHOUT disposing the service.
const generated = await import(pathToFileURL(join(outDir, 'src/index.ts')).href)
const tools = []
const eventHandlers = []
const parent = new Context({})
parent.pythonBridge = new PythonBridgeService(parent)
const ctx = parent.fork()
ctx.tools = {
  register: (def) => {
    tools.push(def)
    return () => {
      const i = tools.indexOf(def)
      if (i >= 0) tools.splice(i, 1)
    }
  },
}
ctx.on = (event, handler, options) => { eventHandlers.push({ event, handler, options }); return () => {} }

const config = {
  pythonBin: process.env.DSH_E2E_PYTHON ?? 'python3',
  module: 'examples.python-bridge-ml.provider',
  cwd: root,
  sandbox: 'workspace-write',
  graceMs: 3000,
  modelPath: '/tmp/model',
  batchSize: 16,
  precision: 'float16',
  // Reconnect would mask real failures in this check; disable it.
  reconnect: { enabled: false },
}
const service = new generated.MlService(ctx, config)
assert(service.key === 'ml', 'service registered under ctx.ml key')

// 3. Wait for the real child to come up, then exercise the typed methods.
for (let i = 0; i < 200 && !service.bridge.ready; i++) await new Promise(r => setTimeout(r, 50))
assert(service.bridge.ready, 'generated service bridge became ready')

const embedded = await service.embed(['hello', 'plugin'])
assert(Array.isArray(embedded) && embedded.length === 2 && embedded[0].length === 768,
  'service.embed() returns 768-dim vectors through the generated class')

const classified = await service.classify('aW1hZ2U=', 3)
assert(Array.isArray(classified) && classified.length === 3 && classified[0].label === 'class_0',
  'service.classify() honors the top_k default override')

// 4. The constructor registered the module's tool against the same bridge.
assert(tools.length === 1 && tools[0].name === 'resize_image', 'resize_image tool registered')
let toolError = null
try {
  await tools[0].execute({ input_path: '/nonexistent.png', width: 2, height: 2 }, {})
} catch (e) { toolError = e }
assert(toolError !== null && toolError.kind === 'exception',
  `tool execute surfaces PythonBridgeError (got ${toolError?.kind})`)

// 5. The constructor registered both module listeners.
assert(eventHandlers.length === 2, 'two listeners registered')
assert(eventHandlers.some(h => h.event === 'session/event'), 'session/event listener registered')
assert(eventHandlers.some(h => h.event === 'agent/status'), 'agent/status listener registered')

// Listener forwarding reaches the Python side (its print proxies back as bridge/log).
const logs = []
service.bridge.onLog(e => logs.push(e))
const sessionHandler = eventHandlers.find(h => h.event === 'session/event')
sessionHandler.handler({ type: 'tool/call', data: { name: 'resize_image' } })
await new Promise(r => setTimeout(r, 400))
assert(logs.some(l => l.message.includes('audit')), 'listener payload reached Python (audit log)')

// 6. Teardown: disposing ONLY the plugin's fiber (not the pythonBridge
// service) must run the generated fiber effects — shutting down the child
// and unregistering the tool. This is the hot-unload reversibility contract.
await ctx.dispose()
assert(service.bridge.ready === false, 'child torn down by plugin-fiber effects (service still alive)')
assert(tools.length === 0, 'tool unregistered by plugin-fiber effects')
assert(parent.pythonBridge.children.size === 0, 'service children set cleaned by plugin disposal')
await parent.pythonBridge.dispose()
console.log('ok: bridge disposed')

if (failures > 0) {
  console.error(`${failures} generated-package check(s) failed`)
  process.exit(1)
}
console.log('ALL GENERATED-PACKAGE CHECKS PASSED')
