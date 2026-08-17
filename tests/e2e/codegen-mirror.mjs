/**
 * Offline mirror of the codegen vitest assertions in
 * `packages/bridge/python-bridge-codegen/tests/codegen.spec.ts`, runnable
 * without a package install:
 *
 *   node --experimental-strip-types tests/e2e/codegen-mirror.mjs
 */
import {
  generateBridgePackage,
  parseModuleSources,
  pythonTypeToTs,
  snakeToCamel,
} from '@deepseek-ai/dsh-python-bridge-codegen'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

let failures = 0
function assert(cond, message) {
  if (!cond) {
    failures++
    console.error(`FAIL: ${message}`)
  } else {
    console.log(`ok: ${message}`)
  }
}

const sampleSource = readFileSync(join(root, 'examples/python-bridge-ml/provider.py'), 'utf8')

// -- parser ------------------------------------------------------------------
const parsed = parseModuleSources([{ path: 'provider.py', contents: sampleSource }])
assert(parsed.diagnostics.length === 0, 'no diagnostics on the example module')
const service = parsed.services[0]
assert(service.name === 'ml' && service.className === 'MLProvider', 'service identity parsed')
assert(JSON.stringify(service.fields.map(f => f.name)) === JSON.stringify(['model_path', 'batch_size', 'precision']),
  'dataclass fields parsed')
assert(service.fields[1].defaultValue === '32', 'field default captured')
assert(service.provideMethods.map(m => m.name).join(',') === 'embed,classify', 'provide methods parsed')
assert(service.provideMethods[0].returnAnnotation === 'list[list[float]]', 'return annotation captured')
assert(service.provideMethods[0].timeoutMs === 10_000, 'timeout captured')
assert(service.provideMethods[1].concurrencySafe === true, 'concurrencySafe captured')
assert(parsed.tools[0].name === 'resize_image', 'tool parsed')
assert(typeof parsed.tools[0].parameters === 'object' && parsed.tools[0].parameters.input_path?.type === 'string',
  'tool parameters parsed as JSON')
assert(parsed.listeners.map(l => l.event).join(',') === 'session/event,agent/status', 'listeners parsed')

// -- type projection -----------------------------------------------------------
const typeCases = [
  ['int', 'number'], ['float', 'number'], ['bool', 'boolean'], ['str', 'string'], ['bytes', 'string'],
  ['dict', 'Record<string, unknown>'], ['list', 'unknown[]'],
  ['list[int]', 'number[]'], ['list[list[float]]', 'number[][]'], ['dict[str, int]', 'Record<string, number>'],
  ['Optional[int]', 'number | null'], ['int | None', 'number | null'],
  ['int | str', 'number | string'], ['Union[int, str]', 'number | string'],
]
for (const [input, expected] of typeCases) {
  const got = pythonTypeToTs(input)
  assert(got === expected, `pythonTypeToTs(${input}) === ${expected} (got ${got})`)
}
assert(snakeToCamel('model_path') === 'modelPath', 'snakeToCamel works')

// Private dataclass fields (underscore-prefixed) are internal state, never config.
const privSource = `
from dataclasses import dataclass, field
from dsh_bridge import service

@service(name="store")
@dataclass
class Store:
    root: str
    _cache: list = field(default_factory=list)
`
const privParsed = parseModuleSources([{ path: 'store.py', contents: privSource }])
assert(JSON.stringify(privParsed.services[0].fields.map(f => f.name)) === JSON.stringify(['root']),
  'private dataclass fields skipped (got ' + JSON.stringify(privParsed.services[0].fields.map(f => f.name)) + ')')

// -- service-class package ------------------------------------------------------
const artifacts = generateBridgePackage({
  module: 'examples.python-bridge-ml.provider',
  packageName: '@my-org/python-bridge-ml',
  sources: [{ path: 'provider.py', contents: sampleSource }],
})
const index = artifacts.files.find(f => f.path === 'src/index.ts')
const pkg = JSON.parse(artifacts.files.find(f => f.path === 'package.json').contents)

assert(index.contents.includes(`import z from '@deepseek-ai/schemastery'`), 'z imported')
assert(index.contents.includes(`import { defineTool } from '@deepseek-ai/dsh-tools'`), 'defineTool imported')
assert(pkg.dependencies['@deepseek-ai/dsh-tools'] !== undefined, 'dsh-tools dependency emitted')
assert(pkg.dependencies['@deepseek-ai/schemastery'] !== undefined, 'schemastery dependency emitted')

assert(!index.contents.includes('TODO'), 'no TODO placeholder')
assert(!index.contents.includes('MODULE_PATH'), 'no MODULE_PATH placeholder')
assert(!index.contents.includes(', ... }'), 'no broken spread')
assert(index.contents.includes('class MlService extends Service'), 'service class emitted')
assert(index.contents.includes('export default MlService'), 'default export emitted')

assert(index.contents.includes('modelPath: string'), 'modelPath config field')
assert(index.contents.includes('batchSize?: number'), 'batchSize config field')
assert(index.contents.includes('batchSize: z.number().default(32)'), 'batchSize zod default')
assert(index.contents.includes('precision: z.string().default("float32")'), 'precision zod default')
assert(index.contents.includes('modelPath: z.string().required()'), 'modelPath required (schemastery semantics)')
assert(index.contents.includes('module: z.string().required()'), 'module required (schemastery semantics)')
assert(!index.contents.includes('.optional()'), 'no .optional() — real schemastery lacks it')
assert(index.contents.includes(`z.union(['read-only', 'workspace-write', 'danger-full-access'] as const)`),
  'sandbox as literal union (real schemastery has no z.enum)')
assert(index.contents.includes('initArgs: { model_path: config.modelPath, batch_size: config.batchSize, precision: config.precision }'),
  'initArgs snake_case mapping')
assert(index.contents.includes(`className: config.className ?? 'MLProvider'`), 'className fallback')

assert(index.contents.includes('embed(texts: string[]): Promise<number[][]>'), 'typed embed signature')
assert(index.contents.includes('classify(image_b64: string, top_k?: number): Promise<Record<string, unknown>[]>'),
  'typed classify signature')

assert(index.contents.includes('ctx.effect(() => ctx.tools.register(defineTool({'), 'tool registration emitted as a fiber effect')
assert(index.contents.includes('ctx.effect(() => () => this.bridge.shutdown())'), 'child teardown bound to the plugin fiber')
assert(index.contents.includes('output: {'), 'defineTool output shape emitted')
assert(index.contents.includes('render:'), 'defineTool render emitted')
assert(index.contents.includes(`ctx.on("session/event"`), 'listener registration emitted')
assert(!index.contents.includes('export function apply'), 'no apply() in service-class form')

// Real Cordis API compatibility (verified against vendor/cordis/src/events.ts
// and packages/AGENTS.md):
assert(index.contents.includes(`static inject = ['pythonBridge', 'tools']`),
  'ctx.tools access declared in static inject')
assert(!/mode:/.test(index.contents), 'no mode option in ctx.on registration (EventOptions is { prepend, global })')
assert(index.contents.includes('{ prepend: false, global: false }'), 'listener options limited to prepend/global')

const waterfallSource = `
from dsh_bridge import on

@on("session/event", mode="waterfall")
def audit(event: str, payload: dict, next_fn) -> None:
    next_fn()
`
const wfArtifacts = generateBridgePackage({
  module: 'example.waterfall',
  packageName: '@my-org/bridge-wf',
  sources: [{ path: 'wf.py', contents: waterfallSource }],
})
const wfIndex = wfArtifacts.files.find(f => f.path === 'src/index.ts')
assert(wfIndex.contents.includes('(payload: unknown, next: () => void)'), 'waterfall handler receives next')
assert(wfIndex.contents.includes('return next()'), 'waterfall handler calls next() (chain hygiene)')

// -- function-plugin package ------------------------------------------------------
const toolsOnly = `
from dsh_bridge import tool, on

@tool(name="shout", description="Upper-case a string.", parameters={"text": {"type": "string"}})
def shout(text: str) -> dict:
    return {"text": text.upper()}

@on("session/event", mode="emit")
def audit(event: str, payload: dict) -> None:
    pass
`
const fpArtifacts = generateBridgePackage({
  module: 'example.tools',
  packageName: '@my-org/bridge-tools',
  sources: [{ path: 'tools.py', contents: toolsOnly }],
})
const fpIndex = fpArtifacts.files.find(f => f.path === 'src/index.ts')
assert(fpIndex.contents.includes(`export const name = 'python-bridge-tools'`), 'function-plugin name export')
assert(fpIndex.contents.includes(`export const inject = ['pythonBridge', 'tools']`), 'function-plugin inject export')
assert(fpIndex.contents.includes('export const Config'), 'function-plugin Config export')
assert(fpIndex.contents.includes('export function apply(ctx: Context, config: BridgeToolsConfig)'), 'apply() emitted')
assert(!fpIndex.contents.includes('export default'), 'no default export in function-plugin form')
assert(fpIndex.contents.includes('const bridge = ctx.pythonBridge.spawn({'), 'shared bridge in apply()')
assert(fpIndex.contents.includes('ctx.effect(() => () => bridge.shutdown())'), 'function-plugin teardown bound to the fiber')

if (failures > 0) {
  console.error(`${failures} codegen check(s) failed`)
  process.exit(1)
}
console.log('ALL CODEGEN CHECKS PASSED')
