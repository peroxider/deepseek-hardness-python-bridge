/**
 * Vitest coverage for `@deepseek-ai/dsh-python-bridge-codegen`.
 *
 * The codegen is exercised through the library API; the CLI is a thin
 * wrapper that calls into the same code paths.
 */

import { describe, expect, it } from 'vitest'
import {
  generateBridgePackage,
  parseModuleSources,
  pythonTypeToTs,
  snakeToCamel,
} from '../src/index.ts'

const sampleSource = `
from dataclasses import dataclass
from dsh_bridge import service, provide_method, tool, on

@service(name="ml")
@dataclass
class MLProvider:
    model_path: str
    batch_size: int = 32
    precision: str = "float32"

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        return []

    @provide_method(timeout_ms=5_000, is_concurrency_safe=True)
    def classify(self, image_b64: str, top_k: int = 5) -> list[dict]:
        return []


@tool(
    name="resize_image",
    description="Resize an image to the given dimensions.",
    parameters={"input_path": {"type": "string", "required": True}},
)
def resize_image(input_path: str, width: int, height: int) -> dict:
    return {}


@on("session/event", mode="emit")
def audit_tool_call(event: str, payload: dict) -> None:
    pass
`

describe('parseModuleSources', () => {
  it('discovers a service with dataclass fields and annotated methods', () => {
    const parsed = parseModuleSources([{ path: 'provider.py', contents: sampleSource }])
    expect(parsed.services).toHaveLength(1)
    const service = parsed.services[0]
    expect(service.name).toBe('ml')
    expect(service.className).toBe('MLProvider')
    expect(service.fields).toEqual([
      { name: 'model_path', annotation: 'str', defaultValue: undefined },
      { name: 'batch_size', annotation: 'int', defaultValue: '32' },
      { name: 'precision', annotation: 'str', defaultValue: '"float32"' },
    ])
    expect(service.provideMethods.map(m => m.name)).toEqual(['embed', 'classify'])
    const embed = service.provideMethods[0]
    expect(embed.parameters).toEqual([{ name: 'texts', annotation: 'list[str]', hasDefault: false }])
    expect(embed.returnAnnotation).toBe('list[list[float]]')
    expect(embed.timeoutMs).toBe(10_000)
    const classify = service.provideMethods[1]
    expect(classify.parameters[1]).toEqual({ name: 'top_k', annotation: 'int', hasDefault: true })
    expect(classify.concurrencySafe).toBe(true)
  })

  it('discovers tools with parsed JSON parameters', () => {
    const parsed = parseModuleSources([{ path: 'provider.py', contents: sampleSource }])
    expect(parsed.tools).toHaveLength(1)
    expect(parsed.tools[0].name).toBe('resize_image')
    expect(parsed.tools[0].parameters).toEqual({ input_path: { type: 'string', required: true } })
    expect(parsed.tools[0].returnAnnotation).toBe('dict')
    expect(parsed.tools[0].parametersList.map(p => p.name)).toEqual(['input_path', 'width', 'height'])
  })

  it('discovers listeners with positional or keyword event names', () => {
    const parsed = parseModuleSources([{ path: 'provider.py', contents: sampleSource }])
    expect(parsed.listeners).toHaveLength(1)
    expect(parsed.listeners[0].event).toBe('session/event')
    const kwSource = `@on(event='agent/status', mode='emit')\ndef observe(event: str, payload: dict) -> None:\n    pass\n`
    const kwParsed = parseModuleSources([{ path: 'kw.py', contents: kwSource }])
    expect(kwParsed.listeners[0].event).toBe('agent/status')
  })

  it('surfaces decoration errors as diagnostics', () => {
    const parsed = parseModuleSources([{ path: 'broken.py', contents: `@service(name="x")\n` }])
    expect(parsed.diagnostics).toHaveLength(1)
    expect(parsed.diagnostics[0].message).toMatch(/class definition/i)
  })
})

describe('pythonTypeToTs', () => {
  it('translates primitives and bare collections', () => {
    expect(pythonTypeToTs('int')).toBe('number')
    expect(pythonTypeToTs('float')).toBe('number')
    expect(pythonTypeToTs('bool')).toBe('boolean')
    expect(pythonTypeToTs('str')).toBe('string')
    expect(pythonTypeToTs('bytes')).toBe('string')
    expect(pythonTypeToTs('dict')).toBe('Record<string, unknown>')
    expect(pythonTypeToTs('list')).toBe('unknown[]')
  })

  it('translates parameterized collections', () => {
    expect(pythonTypeToTs('list[int]')).toBe('number[]')
    expect(pythonTypeToTs('list[list[float]]')).toBe('number[][]')
    expect(pythonTypeToTs('dict[str, int]')).toBe('Record<string, number>')
  })

  it('translates optionals and unions', () => {
    expect(pythonTypeToTs('Optional[int]')).toBe('number | null')
    expect(pythonTypeToTs('int | None')).toBe('number | null')
    expect(pythonTypeToTs('int | str')).toBe('number | string')
    expect(pythonTypeToTs('Union[int, str]')).toBe('number | string')
  })
})

describe('snakeToCamel', () => {
  it('converts snake_case to camelCase', () => {
    expect(snakeToCamel('model_path')).toBe('modelPath')
    expect(snakeToCamel('batch_size')).toBe('batchSize')
    expect(snakeToCamel('precision')).toBe('precision')
  })
})

describe('generateBridgePackage (service-class form)', () => {
  const artifacts = generateBridgePackage({
    module: 'example.provider',
    packageName: '@my-org/bridge',
    sources: [{ path: 'provider.py', contents: sampleSource }],
  })
  const index = artifacts.files.find(f => f.path === 'src/index.ts')!
  const pkg = JSON.parse(artifacts.files.find(f => f.path === 'package.json')!.contents)

  it('imports every runtime dependency the emitted code uses', () => {
    expect(index.contents).toContain(`import z from '@deepseek-ai/schemastery'`)
    expect(index.contents).toContain(`import { defineTool } from '@deepseek-ai/dsh-tools'`)
    expect(index.contents).toContain(`from '@deepseek-ai/dsh-python-bridge-runtime'`)
    expect(pkg.dependencies['@deepseek-ai/dsh-python-bridge-runtime']).toBeDefined()
    expect(pkg.dependencies['@deepseek-ai/dsh-tools']).toBeDefined()
    expect(pkg.dependencies['@deepseek-ai/schemastery']).toBeDefined()
  })

  it('emits a compilable service class: no TODO placeholders or broken spreads', () => {
    expect(index.contents).not.toContain('TODO')
    expect(index.contents).not.toContain(', ... }')
    expect(index.contents).not.toContain('MODULE_PATH')
    expect(index.contents).toContain('class MlService extends Service')
    expect(index.contents).toContain(`static inject = ['pythonBridge']`)
    expect(index.contents).toContain('export default MlService')
  })

  it('emits dataclass fields as named config keys with defaults', () => {
    expect(index.contents).toContain('modelPath: string')
    expect(index.contents).toContain('batchSize?: number')
    expect(index.contents).toContain('precision?: string')
    expect(index.contents).toContain('batchSize: z.number().default(32)')
    expect(index.contents).toContain('precision: z.string().default("float32")')
    expect(index.contents).toContain('modelPath: z.string()')
  })

  it('maps init args from camelCase config back to snake_case kwargs', () => {
    expect(index.contents).toContain(
      'initArgs: { model_path: config.modelPath, batch_size: config.batchSize, precision: config.precision }',
    )
    expect(index.contents).toContain(`className: config.className ?? 'MLProvider'`)
  })

  it('emits typed provide-method signatures', () => {
    expect(index.contents).toContain('embed(texts: string[]): Promise<number[][]>')
    expect(index.contents).toContain('classify(image_b64: string, top_k?: number): Promise<Record<string, unknown>[]>')
  })

  it('registers module tools and listeners in the constructor', () => {
    expect(index.contents).toContain('ctx.tools.register(defineTool({')
    expect(index.contents).toContain(`name: "resize_image"`)
    expect(index.contents).toContain('output: {')
    expect(index.contents).toContain('render:')
    expect(index.contents).toContain(`ctx.on("session/event"`)
    // No standalone apply() in the service-class form.
    expect(index.contents).not.toContain('export function apply')
  })
})

describe('generateBridgePackage (function-plugin form)', () => {
  const toolsOnlySource = `
from dsh_bridge import tool, on

@tool(name="shout", description="Upper-case a string.", parameters={"text": {"type": "string"}})
def shout(text: str) -> dict:
    return {"text": text.upper()}

@on("session/event", mode="emit")
def audit(event: str, payload: dict) -> None:
    pass
`
  const artifacts = generateBridgePackage({
    module: 'example.tools',
    packageName: '@my-org/bridge-tools',
    sources: [{ path: 'tools.py', contents: toolsOnlySource }],
  })
  const index = artifacts.files.find(f => f.path === 'src/index.ts')!

  it('emits named function-plugin exports and no default export', () => {
    expect(index.contents).toContain(`export const name = 'python-bridge-tools'`)
    expect(index.contents).toContain(`export const inject = ['pythonBridge']`)
    expect(index.contents).toContain('export const Config')
    expect(index.contents).toContain('export function apply(ctx: Context, config: BridgeToolsConfig)')
    expect(index.contents).not.toContain('export default')
    expect(index.contents).not.toContain('extends Service')
  })

  it('shares one bridge across the module tools', () => {
    expect(index.contents).toContain('const bridge = ctx.pythonBridge.spawn({')
    expect(index.contents).toContain(`module: 'example.tools'`)
    expect(index.contents).toContain('bridge.call("shout"')
  })
})
