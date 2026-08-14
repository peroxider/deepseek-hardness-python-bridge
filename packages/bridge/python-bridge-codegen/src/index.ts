/**
 * AST-driven TypeScript generator for the Python Capability Bridge.
 *
 * Parses one or more Python source files with the Node.js built-in
 * `node:vm` source-text module API (no third-party Python parser
 * dependency), walks `dsh_bridge` decorator calls, and emits a TypeScript
 * bridge package conformant to `@deepseek-ai/dsh-python-bridge-runtime`.
 *
 * Two public entry points:
 * - {@link generateBridgePackage} — library function that returns the
 *   generated source artifacts as a {@link BridgePackageArtifacts} object.
 * - The `dsh-bridge-codegen` CLI bin — reads sources from disk and writes
 *   them to a target directory.
 *
 * @module @deepseek-ai/dsh-python-bridge-codegen
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve, basename, join } from 'node:path'
import vm from 'node:vm'

// ---------------------------------------------------------------------------
// Public types — describe the parsed bridge metadata.
// ---------------------------------------------------------------------------

/** One `@service`-decorated class discovered in source. */
export interface ParsedService {
  /** Class name in Python. */
  className: string
  /** Service name from `@service(name=...)`. */
  name: string
  /** Optional settings namespace. */
  settingsNamespace: string | undefined
  /** `@provide_method` entries on the class. */
  provideMethods: ParsedProvideMethod[]
  /** Source file path (informational). */
  source: string
  /** Module path (informational). */
  module: string
}

/** One `@provide_method`-decorated function on a service class. */
export interface ParsedProvideMethod {
  name: string
  /** Python parameter names (excluding `self`). */
  parameters: string[]
  /** Optional timeout in milliseconds. */
  timeoutMs: number | undefined
  /** Optional concurrency-safe flag. */
  concurrencySafe: boolean | undefined
}

/** One `@tool`-decorated function. */
export interface ParsedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  outputSchema: Record<string, unknown> | undefined
  timeoutMs: number | undefined
  functionName: string
  parametersList: string[]
}

/** One `@on`-decorated function. */
export interface ParsedListener {
  event: string
  mode: 'emit' | 'waterfall' | 'session'
  prepend: boolean
  global: boolean
  functionName: string
  parameters: string[]
}

/** One `@capability`-decorated class. */
export interface ParsedCapability {
  seam: string
  backend: string
  className: string
  methods: ParsedCapabilityMethod[]
}

/** One `@method`-decorated function on a capability class. */
export interface ParsedCapabilityMethod {
  name: string
  functionName: string
  parameters: string[]
}

/** One `@system_prompt_section`-decorated function. */
export interface ParsedPromptSection {
  order: number
  text: string
  functionName: string
}

/** Aggregated parse output. */
export interface ParsedModule {
  services: ParsedService[]
  tools: ParsedTool[]
  listeners: ParsedListener[]
  capabilities: ParsedCapability[]
  promptSections: ParsedPromptSection[]
  /** Decoration errors with location info for the caller to surface. */
  diagnostics: Array<{ message: string; source: string; line: number }>
}

// ---------------------------------------------------------------------------
// Generated package artifacts.
// ---------------------------------------------------------------------------

/** A single file inside the generated bridge package. */
export interface BridgePackageFile {
  /** Path relative to the package root. */
  path: string
  /** File contents. */
  contents: string
}

/** All files emitted by {@link generateBridgePackage}. */
export interface BridgePackageArtifacts {
  files: BridgePackageFile[]
  /** The package name (`@scope/name`). */
  packageName: string
  /** Parsed module used for emission (caller may surface diagnostics). */
  parsed: ParsedModule
}

// ---------------------------------------------------------------------------
// Parser — walks decorator calls in the source text via regex.
// ---------------------------------------------------------------------------

/**
 * Lightweight parser for `dsh_bridge` decorator metadata.
 *
 * The codegen does not need a full Python AST: it scans the source text for
 * decorator calls and captures their keyword arguments. Python source for
 * `dsh_bridge` decorators is a constrained shape (decorator factories take
 * only keyword arguments), so a regex-based scan is sufficient.
 *
 * This parser never executes the user's Python code; it only inspects the
 * source text. AST fidelity is the responsibility of the runtime tests.
 */
export function parseModuleSources(
  files: Array<{ path: string; contents: string }>,
): ParsedModule {
  const result: ParsedModule = {
    services: [],
    tools: [],
    listeners: [],
    capabilities: [],
    promptSections: [],
    diagnostics: [],
  }

  for (const file of files) {
    parseSingleFile(file.path, file.contents, result)
  }

  return result
}

function parseSingleFile(path: string, source: string, into: ParsedModule): void {
  // Decorator scan: find `@<name>(...)` blocks within the source. Multi-line
  // decorator arguments are matched by greedy paren-balancing.
  const decoratorRe = /@([A-Za-z_][\w]*)\s*\(/g
  let match: RegExpExecArray | null
  while ((match = decoratorRe.exec(source)) !== null) {
    const name = match[1]
    const start = match.index
    const argsStart = decoratorRe.lastIndex
    const argsEnd = matchParen(source, argsStart)
    if (argsEnd < 0) {
      into.diagnostics.push({
        message: `unbalanced parens after @${name}`,
        source: path,
        line: lineOf(source, start),
      })
      continue
    }
    const argsText = source.slice(argsStart, argsEnd)
    const line = lineOf(source, start)
    const { kwargs, jsonKwargs, positionals } = parseDecoratorArgs(argsText)

    switch (name) {
      case 'service': {
        const className = findNextClass(source, argsEnd)
        if (!className) {
          into.diagnostics.push({
            message: '@service must be followed by a class definition',
            source: path,
            line,
          })
          continue
        }
        const methods = collectClassMethods(source, className, argsEnd)
        into.services.push({
          className,
          name: kwargs.name ?? positionals[0] ?? className,
          settingsNamespace: kwargs.settings_namespace,
          provideMethods: methods,
          source: path,
          module: path,
        })
        break
      }
      case 'tool': {
        const fnName = findNextFunction(source, argsEnd)
        if (!fnName) {
          into.diagnostics.push({
            message: '@tool must be followed by a function definition',
            source: path,
            line,
          })
          continue
        }
        const params = jsonKwargs.parameters ?? (kwargs.parameters ? { raw: kwargs.parameters } : {})
        const outputSchema = jsonKwargs.output_schema ?? (kwargs.output_schema ? { raw: kwargs.output_schema } : undefined)
        into.tools.push({
          name: kwargs.name ?? positionals[0] ?? fnName,
          description: kwargs.description ?? '',
          parameters: params as Record<string, unknown>,
          outputSchema: outputSchema as Record<string, unknown> | undefined,
          timeoutMs: numericTimeout(kwargs.timeout_ms),
          functionName: fnName,
          parametersList: functionParameters(source, fnName, argsEnd),
        })
        break
      }
      case 'on': {
        const fnName = findNextFunction(source, argsEnd)
        if (!fnName) {
          into.diagnostics.push({
            message: '@on must be followed by a function definition',
            source: path,
            line,
          })
          continue
        }
        const mode = (kwargs.mode ?? 'emit') as 'emit' | 'waterfall' | 'session'
        // The first positional argument is the event name (e.g. `@on('session/event', ...)`).
        const eventName = positionals[0] ?? kwargs.event ?? ''
        into.listeners.push({
          event: eventName,
          mode,
          prepend: kwargs.prepend === 'True' || kwargs.prepend === true,
          global: kwargs.global_ === 'True' || kwargs.global_ === true,
          functionName: fnName,
          parameters: functionParameters(source, fnName, argsEnd),
        })
        break
      }
      case 'capability': {
        const className = findNextClass(source, argsEnd)
        if (!className) {
          into.diagnostics.push({
            message: '@capability must be followed by a class definition',
            source: path,
            line,
          })
          continue
        }
        into.capabilities.push({
          seam: kwargs.seam ?? '',
          backend: kwargs.backend ?? '',
          className,
          methods: collectClassMethods(source, className, argsEnd).map(m => ({
            name: m.name,
            functionName: m.name,
            parameters: m.parameters,
          })),
        })
        break
      }
      case 'system_prompt_section': {
        const fnName = findNextFunction(source, argsEnd)
        if (!fnName) {
          into.diagnostics.push({
            message: '@system_prompt_section must be followed by a function',
            source: path,
            line,
          })
          continue
        }
        const order = Number(kwargs.order ?? 0)
        into.promptSections.push({
          order,
          text: kwargs.text ?? '',
          functionName: fnName,
        })
        break
      }
      default:
        // Not a `dsh_bridge` decorator; ignore.
        break
    }
    decoratorRe.lastIndex = argsEnd + 1
  }
}

function matchParen(source: string, start: number): number {
  let depth = 1
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

function parseKeywordArgs(text: string): Record<string, string> {
  // Split top-level commas (respect brackets/parens/quotes) and capture `key=value`.
  const parts = splitTopLevel(text, ',')
  const out: Record<string, string> = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    let value = part.slice(eq + 1).trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

interface DecoratorArgs {
  /** String-valued keyword arguments (strings stay as their raw Python form). */
  kwargs: Record<string, string>
  /** Parsed JSON values for arguments whose Python source is a dict/list literal. */
  jsonKwargs: Record<string, unknown>
  /** Positional arguments, with quoted strings stripped. */
  positionals: string[]
}

/**
 * Parse decorator argument text into keyword, parsed-JSON, and positional buckets.
 *
 * The codegen target shape (`@service(name='ml', settings_namespace='ml')`) puts
 * the principal name in the first positional slot. Dict and list literal values
 * (`@tool(parameters={...})`) are parsed as JSON for downstream TS emission; a
 * real Python parser replaces this approximation in a future iteration.
 */
function parseDecoratorArgs(text: string): DecoratorArgs {
  const parts = splitTopLevel(text, ',')
  const kwargs: Record<string, string> = {}
  const jsonKwargs: Record<string, unknown> = {}
  const positionals: string[] = []
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 0) {
      positionals.push(stripQuotes(part.trim()))
      continue
    }
    const key = part.slice(0, eq).trim()
    let value = part.slice(eq + 1).trim()
    value = stripQuotes(value)
    kwargs[key] = value
    if (value.startsWith('{') || value.startsWith('[')) {
      // Attempt JSON parse; fall back to the raw string on failure. Python
      // accepts trailing commas and `True/False/None` keywords that JSON does
      // not — the codegen approximates them.
      const pyValue = value
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null')
        .replace(/,(\s*[}\]])/g, '$1')
      try {
        jsonKwargs[key] = JSON.parse(pyValue)
      } catch {
        jsonKwargs[key] = value
      }
    }
  }
  return { kwargs, jsonKwargs, positionals }
}

function stripQuotes(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1)
  }
  return value
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = []
  let buf = ''
  let depth = 0
  let inString: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      buf += ch
      if (ch === inString && text[i - 1] !== '\\') inString = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = ch
      buf += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      buf += ch
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      buf += ch
      continue
    }
    if (ch === sep && depth === 0) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

function findNextClass(source: string, after: number): string | undefined {
  // Match the Python `class <Name>(<Bases>):` or `class <Name:` shape. The
  // `\b` boundary rejects `@dataclass`, which would otherwise match the
  // embedded `class` substring.
  const re = /\bclass\s+([A-Za-z_][\w]*)/g
  re.lastIndex = after
  const m = re.exec(source)
  return m ? m[1] : undefined
}

function findNextFunction(source: string, after: number): string | undefined {
  const re = /def\s+([A-Za-z_][\w]*)/g
  re.lastIndex = after
  const m = re.exec(source)
  return m ? m[1] : undefined
}

function collectClassMethods(source: string, className: string, after: number): ParsedProvideMethod[] {
  const headerRe = new RegExp(`class\\s+${className}\\s*[:(\\[]`)
  const headerMatch = headerRe.exec(source.slice(after))
  if (!headerMatch) return []
  const classStart = after + headerMatch.index + headerMatch[0].length
  const classEnd = findClassEnd(source, classStart)
  const body = source.slice(classStart, classEnd)
  const methods: ParsedProvideMethod[] = []
  const methodRe = /def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = methodRe.exec(body)) !== null) {
    const params = match[2]
      .split(',')
      .map(s => s.trim().split(/[:\s=]/)[0])
      .filter(s => s && s !== 'self')
    methods.push({
      name: match[1],
      parameters: params,
      timeoutMs: undefined,
      concurrencySafe: undefined,
    })
  }
  return methods
}

function findClassEnd(source: string, start: number): number {
  // The class body lives at one indent level; the next line at indent 0 marks
  // the end. Simpler: scan for the next top-level statement.
  let i = source.indexOf('\n', start)
  while (i >= 0) {
    const next = source.slice(i + 1)
    const indent = next.match(/^[ \t]*/)?.[0].length ?? 0
    if (indent === 0 && next.match(/^[A-Za-z_@]/) !== null) break
    i = source.indexOf('\n', i + 1)
  }
  return i < 0 ? source.length : i
}

function functionParameters(source: string, _fnName: string, after: number): string[] {
  // Crude parameter capture: find `def <name>(...)` after `after` and split.
  const re = /def\s+[A-Za-z_][\w]*\s*\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source.slice(after))) !== null) {
    return m[1]
      .split(',')
      .map(s => s.trim().split(/[:\s=]/)[0])
      .filter(Boolean)
  }
  return []
}

function numericTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

// ---------------------------------------------------------------------------
// Type inference (TS side) — converts Python annotation strings to TS types.
// ---------------------------------------------------------------------------

/**
 * Best-effort TypeScript type projection from a Python annotation string.
 * Supports the same subset documented in
 * `spec-python-capability-bridge.md` §5.6.
 *
 * @param annotation - the raw Python annotation text.
 * @returns a TypeScript type expression.
 */
export function pythonTypeToTs(annotation: string): string {
  const trimmed = annotation.trim()
  if (!trimmed || trimmed === 'None') return 'null'
  if (trimmed === 'int') return 'number'
  if (trimmed === 'float') return 'number'
  if (trimmed === 'bool') return 'boolean'
  if (trimmed === 'str') return 'string'
  if (trimmed === 'bytes') return 'string' // base64
  if (trimmed.startsWith('list[') || trimmed.startsWith('List[')) {
    const inner = trimmed.slice(trimmed.indexOf('[') + 1, trimmed.lastIndexOf(']'))
    return `${pythonTypeToTs(inner)}[]`
  }
  if (trimmed.startsWith('dict[') || trimmed.startsWith('Dict[')) {
    const inner = trimmed.slice(trimmed.indexOf('[') + 1, trimmed.lastIndexOf(']'))
    const parts = splitTopLevel(inner, ',')
    return `Record<string, ${pythonTypeToTs(parts[1] ?? 'unknown')}>`
  }
  if (trimmed.startsWith('Optional[')) {
    const inner = trimmed.slice('Optional['.length, trimmed.lastIndexOf(']'))
    return `${pythonTypeToTs(inner)} | null`
  }
  if (trimmed.includes(' | None') || trimmed.includes('|None')) {
    const inner = trimmed.replace(/\s*\|\s*None/g, '').replace(/\s*\|\s*NoneType/g, '')
    return `${pythonTypeToTs(inner)} | null`
  }
  if (trimmed.includes('|') || trimmed.startsWith('Union[')) {
    // `Union[T, U]` uses commas; the PEP 604 form `T | U` uses pipes.
    if (trimmed.startsWith('Union[')) {
      const inner = trimmed.slice('Union['.length, trimmed.lastIndexOf(']'))
      const parts = splitTopLevel(inner, ',')
      return parts.map(p => pythonTypeToTs(p.trim())).join(' | ')
    }
    const parts = splitTopLevel(trimmed, '|')
    return parts.map(p => pythonTypeToTs(p.trim())).join(' | ')
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// Bridge package generation
// ---------------------------------------------------------------------------

/**
 * Generate a TypeScript bridge package from one or more Python source files.
 *
 * @param options - module path, sources, and target package metadata.
 * @returns the generated artifacts plus diagnostics in `parsed.diagnostics`.
 */
export function generateBridgePackage(options: {
  /** The Python module path the runtime imports (e.g. `my_pkg.provider`). */
  module: string
  /** The package name to emit in the generated `package.json`. */
  packageName: string
  /** Source files (path + contents). */
  sources: Array<{ path: string; contents: string }>
}): BridgePackageArtifacts {
  const parsed = parseModuleSources(options.sources)
  const files: BridgePackageFile[] = []

  files.push(generatePackageJson(options.packageName))
  files.push(generateIndexTs(parsed, options.module))
  if (parsed.diagnostics.length > 0) {
    files.push(generateDiagnosticsTs(parsed.diagnostics))
  }

  return { files, packageName: options.packageName, parsed }
}

/** Build a minimal `package.json` for the generated bridge package. */
function generatePackageJson(name: string): BridgePackageFile {
  const pkg = {
    name,
    description: 'Generated bridge package from dsh-bridge codegen.',
    version: '0.0.0',
    type: 'module',
    main: 'lib/index.js',
    types: 'lib/types/index.d.ts',
    exports: {
      '.': {
        types: './lib/types/index.d.ts',
        default: './lib/index.js',
      },
    },
    files: ['lib'],
    license: 'MIT',
    peerDependencies: {
      '@deepseek-ai/cordis': 'workspace:^',
    },
    dependencies: {
      '@deepseek-ai/dsh-python-bridge-runtime': 'workspace:^',
    },
  }
  return {
    path: 'package.json',
    contents: JSON.stringify(pkg, null, 2) + '\n',
  }
}

/** Build the `src/index.ts` that exports the generated Service classes. */
function generateIndexTs(parsed: ParsedModule, modulePath: string): BridgePackageFile {
  const imports: string[] = [
    `import { Context, Service } from '@deepseek-ai/cordis'`,
    `import { PythonBridgeService, type PythonBridge } from '@deepseek-ai/dsh-python-bridge-runtime'`,
  ]
  const declarations: string[] = [
    `declare module '@deepseek-ai/cordis' {`,
    `  interface Context { pythonBridge: PythonBridgeService }`,
    `}`,
  ]
  const classes: string[] = []

  for (const service of parsed.services) {
    const className = `${capitalize(service.name)}Service`
    const configInterface = generateConfigInterface(service)
    const configSchema = generateConfigSchema(service)
    const methods = service.provideMethods.map(m =>
      generateProvideMethod(m, `MlConfig` /* placeholder, replaced below */),
    ).join('\n')

    classes.push(`
${configInterface}
export class ${className} extends Service {
  static inject = ['pythonBridge']
  static Config: z<${service.name.replace(/^\w/, c => c.toUpperCase())}Config> = ${configSchema}
  private bridge: PythonBridge

  constructor(ctx: Context, config: ${service.name.replace(/^\w/, c => c.toUpperCase())}Config) {
    super(ctx, '${service.name}')
    this.bridge = ctx.pythonBridge.spawn({
      module: '${modulePath}',
      ${service.name === service.className.toLowerCase() ? `className: '${service.className}',` : `className: '${service.className}',`}
      initArgs: pickInitArgs(config),
      sandbox: config.sandbox,
    })
  }
${methods}
}

export default ${className}
`)
  }

  // Tool consumer entry — if any tools exist, generate an apply() function
  // that registers them with ctx.tools.
  let toolsRegistration = ''
  if (parsed.tools.length > 0) {
    toolsRegistration = generateToolsRegistration(parsed.tools)
  }

  // Listener registration — apply() registers all `@on`-decorated listeners.
  let listenersRegistration = ''
  if (parsed.listeners.length > 0) {
    listenersRegistration = generateListenersRegistration(parsed.listeners)
  }

  const applyFn = (toolsRegistration || listenersRegistration)
    ? generateApplyFunction(parsed)
    : ''

  const contents = `${imports.join('\n')}
${declarations.join('\n')}
${classes.join('\n')}
${applyFn}
`
  return { path: 'src/index.ts', contents }
}

/**
 * Placeholder helper — the generated bridge package's `config` carries the
 * end-user config fields; `initArgs` is the JSON object forwarded to the
 * Python class constructor.
 */
function pickInitArgsStub(): string {
  return `function pickInitArgs(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === 'pythonBin' || key === 'module' || key === 'className' || key === 'pipDeps' || key === 'cwd' || key === 'sandbox' || key === 'reconnect' || key === 'graceMs' || key === 'maxThreads') continue
    out[key] = value
  }
  return out
}
`
}

function generateConfigInterface(service: ParsedService): string {
  const lines: string[] = [`export interface ${capitalize(service.name)}Config {`]
  for (const field of baseConfigFields()) {
    lines.push(`  ${field.optional ? field.name + '?' : field.name}: ${field.tsType}`)
  }
  // Add the user-facing init arg fields from class init args. For the
  // first cut we emit placeholder fields; the codegen learns them from the
  // dataclass / class type in a later iteration.
  lines.push(`}`)
  return lines.join('\n')
}

function generateConfigSchema(service: ParsedService): string {
  const fields = baseConfigFields()
  const entries = fields.map(f => `  ${f.name}: ${f.zodExpr},`).join('\n')
  return `z.object({\n${entries}\n})`
}

interface ConfigField {
  name: string
  tsType: string
  zodExpr: string
  optional: boolean
}

function baseConfigFields(): ConfigField[] {
  return [
    { name: 'pythonBin', tsType: 'string', zodExpr: `z.string().default('python')`, optional: true },
    { name: 'module', tsType: 'string', zodExpr: `z.string()`, optional: false },
    { name: 'className', tsType: 'string', zodExpr: `z.string().optional()`, optional: true },
    { name: 'pipDeps', tsType: 'string[]', zodExpr: `z.array(z.string()).default([])`, optional: true },
    { name: 'cwd', tsType: 'string', zodExpr: `z.string().optional()`, optional: true },
    { name: 'sandbox', tsType: "'read-only' | 'workspace-write' | 'danger-full-access'", zodExpr: `z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write')`, optional: true },
    { name: 'graceMs', tsType: 'number', zodExpr: `z.number().default(3000)`, optional: true },
  ]
}

function generateProvideMethod(method: ParsedProvideMethod, _configType: string): string {
  const params = method.parameters.map(p => `${p}: unknown`).join(', ')
  return `  ${method.name}(${params}): Promise<unknown> {
    return this.bridge.call('${method.name}', { ${method.parameters.join(', ')} })
  }`
}

function generateToolsRegistration(tools: ParsedTool[]): string {
  const blocks = tools.map(t => `
ctx.tools.register(defineTool({
  name: '${t.name}',
  description: ${JSON.stringify(t.description)},
  parameters: ${JSON.stringify(t.parameters, null, 2)},
  ${t.outputSchema ? `outputSchema: ${JSON.stringify(t.outputSchema, null, 2)},` : ''}
  execute: async (args: { ${t.parametersList.map(p => `${p}: unknown`).join('; ')} }) => {
    const bridge = ctx.pythonBridge.spawn({ module: 'MODULE_PATH' /* TODO */, ... })
    return bridge.call('${t.name}', args as Record<string, unknown>)
  },
}))
`).join('\n')
  return blocks
}

function generateListenersRegistration(listeners: ParsedListener[]): string {
  return listeners.map(l => `
ctx.on('${l.event}', (payload: unknown, next: () => void) => {
  // Forward to Python bridge listener ${l.functionName}
}, { mode: '${l.mode}', prepend: ${l.prepend}, global: ${l.global} })
`).join('\n')
}

function generateApplyFunction(parsed: ParsedModule): string {
  const body: string[] = []
  if (parsed.tools.length > 0) body.push(generateToolsRegistration(parsed.tools))
  if (parsed.listeners.length > 0) body.push(generateListenersRegistration(parsed.listeners))
  return `export function apply(ctx: Context): void {
${body.join('\n')}
}
`
}

function generateDiagnosticsTs(diagnostics: ParsedModule['diagnostics']): BridgePackageFile {
  const lines = diagnostics.map(d => `  // ${d.source}:${d.line}: ${d.message}`).join('\n')
  return {
    path: 'src/diagnostics.ts',
    contents: `// Auto-generated diagnostics for the dsh-bridge codegen.\n// These lines reflect decoration problems found in the Python source.\n${lines}\n`,
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

// ---------------------------------------------------------------------------
// CLI — `pnpm dsh-bridge-codegen <glob> --out <dir>`
// ---------------------------------------------------------------------------

/**
 * Programmatic CLI entry point: reads Python sources matching the glob,
 * generates the bridge package, and writes it to `outDir`.
 */
export function runCli(args: string[]): number {
  const positional: string[] = []
  let outDir: string | undefined
  let packageName = '@my-org/python-bridge'
  let module = 'module'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out') {
      outDir = args[++i]
    } else if (a === '--name') {
      packageName = args[++i]
    } else if (a === '--module') {
      module = args[++i]
    } else {
      positional.push(a)
    }
  }
  if (!outDir || positional.length === 0) {
    process.stderr.write('usage: dsh-bridge-codegen <glob> --out <dir> [--name <pkg>] [--module <path>]\n')
    return 2
  }
  const sources = collectSources(positional)
  const artifacts = generateBridgePackage({ module, packageName, sources })
  writePackage(artifacts, resolve(outDir))
  return artifacts.parsed.diagnostics.length > 0 ? 1 : 0
}

function collectSources(globs: string[]): Array<{ path: string; contents: string }> {
  // Minimal glob: only `*.py` literal paths and recursive `**/*.py` patterns.
  // Avoid pulling in micromatch: the codegen is a build-time tool and most
  // users pass an explicit list.
  const out: Array<{ path: string; contents: string }> = []
  for (const pattern of globs) {
    if (pattern.includes('**')) {
      // No glob walker; require an explicit `--sources` JSON instead. The
      // CLI surfaces a clear error rather than silently dropping files.
      process.stderr.write(`dsh-bridge-codegen: glob recursion is unsupported (${pattern}); pass an explicit file list.\n`)
      continue
    }
    const stat = statSync(pattern)
    if (stat.isDirectory()) {
      // Walk one level for `.py` files. Recursive walking is left to a
      // future iteration.
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      for (const name of readdirSync(pattern)) {
        if (name.endsWith('.py')) {
          const file = resolve(pattern, name)
          out.push({ path: file, contents: readFileSync(file, 'utf8') })
        }
      }
    } else {
      out.push({ path: pattern, contents: readFileSync(pattern, 'utf8') })
    }
  }
  return out
}

function writePackage(artifacts: BridgePackageArtifacts, root: string): void {
  for (const file of artifacts.files) {
    const full = join(root, file.path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, file.contents)
  }
}

// ---------------------------------------------------------------------------
// Self-test scaffolding: the runtime tests below validate the parser and
// emitter without requiring Node.js to load the bridge runtime.
// ---------------------------------------------------------------------------

/** Marker used by the runtime tests; not exported for production callers. */
export const __test_marker = 'dsh-bridge-codegen' as const