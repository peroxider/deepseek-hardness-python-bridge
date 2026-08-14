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
} from '../src/index.ts'

const sampleSource = `
from dsh_bridge import service, provide_method, tool, on

@service(name="ml")
@dataclass
class MLProvider:
    model_path: str
    batch_size: int = 32

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        return []

    @provide_method(timeout_ms=5_000, is_concurrency_safe=True)
    def classify(self, image_b64: str, top_k: int = 5) -> list[dict]:
        return []


@tool(
    name="resize_image",
    description="Resize an image to the given dimensions.",
    parameters={"input_path": {"type": "string"}},
)
def resize_image(input_path: str, width: int, height: int) -> dict:
    return {}


@on("session/event", mode="emit")
def audit_tool_call(event: str, payload: dict) -> None:
    pass
`

describe('parseModuleSources', () => {
  it('discovers a service and its provide methods', () => {
    const parsed = parseModuleSources([{ path: 'provider.py', contents: sampleSource }])
    expect(parsed.services).toHaveLength(1)
    const service = parsed.services[0]
    expect(service.name).toBe('ml')
    expect(service.className).toBe('MLProvider')
    expect(service.provideMethods.map(m => m.name)).toEqual(['embed', 'classify'])
  })

  it('discovers tools', () => {
    const parsed = parseModuleSources([{ path: 'provider.py', contents: sampleSource }])
    expect(parsed.tools).toHaveLength(1)
    expect(parsed.tools[0].name).toBe('resize_image')
    expect(parsed.tools[0].functionName).toBe('resize_image')
  })

  it('discovers listeners with positional event name', () => {
    const parsed = parseModuleSources([{ path: 'provider.py', contents: sampleSource }])
    expect(parsed.listeners).toHaveLength(1)
    expect(parsed.listeners[0].event).toBe('session/event')
    expect(parsed.listeners[0].mode).toBe('emit')
  })

  it('discovers listeners with keyword event name', () => {
    const source = `@on(event='agent/status', mode='emit')\ndef observe(event: str, payload: dict) -> None:\n    pass\n`
    const parsed = parseModuleSources([{ path: 'kw.py', contents: source }])
    expect(parsed.listeners).toHaveLength(1)
    expect(parsed.listeners[0].event).toBe('agent/status')
  })

  it('surfaces decoration errors as diagnostics', () => {
    const bad = `@service(name="x")\n` // missing class
    const parsed = parseModuleSources([{ path: 'broken.py', contents: bad }])
    expect(parsed.diagnostics).toHaveLength(1)
    expect(parsed.diagnostics[0].message).toMatch(/class definition/i)
  })
})

describe('pythonTypeToTs', () => {
  it('translates primitives', () => {
    expect(pythonTypeToTs('int')).toBe('number')
    expect(pythonTypeToTs('float')).toBe('number')
    expect(pythonTypeToTs('bool')).toBe('boolean')
    expect(pythonTypeToTs('str')).toBe('string')
    expect(pythonTypeToTs('bytes')).toBe('string')
  })

  it('translates collections', () => {
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

describe('generateBridgePackage', () => {
  it('emits a service class for each @service decorator', () => {
    const artifacts = generateBridgePackage({
      module: 'example.provider',
      packageName: '@my-org/bridge',
      sources: [{ path: 'provider.py', contents: sampleSource }],
    })
    const index = artifacts.files.find(f => f.path === 'src/index.ts')
    expect(index).toBeDefined()
    expect(index!.contents).toContain('class MlService extends Service')
    expect(index!.contents).toContain('static inject = [\'pythonBridge\']')
  })

  it('emits a package.json with the runtime dependency', () => {
    const artifacts = generateBridgePackage({
      module: 'example.provider',
      packageName: '@my-org/bridge',
      sources: [{ path: 'provider.py', contents: sampleSource }],
    })
    const pkg = artifacts.files.find(f => f.path === 'package.json')
    expect(pkg).toBeDefined()
    const parsed = JSON.parse(pkg!.contents)
    expect(parsed.dependencies['@deepseek-ai/dsh-python-bridge-runtime']).toBeDefined()
  })

  it('generates an apply() function when tools or listeners are present', () => {
    const artifacts = generateBridgePackage({
      module: 'example.provider',
      packageName: '@my-org/bridge',
      sources: [{ path: 'provider.py', contents: sampleSource }],
    })
    const index = artifacts.files.find(f => f.path === 'src/index.ts')
    expect(index!.contents).toContain('export function apply(ctx: Context)')
    expect(index!.contents).toContain('resize_image')
    expect(index!.contents).toContain('session/event')
  })
})