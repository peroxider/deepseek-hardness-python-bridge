/**
 * AST-driven TypeScript generator for the Python Capability Bridge.
 *
 * Parses one or more Python source files, walks `dsh_bridge` decorator calls,
 * and emits a TypeScript bridge package conformant to
 * `@deepseek-ai/dsh-python-bridge-runtime`. The generator never executes user
 * source; it inspects the source text and emits generated artifacts.
 *
 * Two public entry points:
 * - {@link generateBridgePackage} — library function returning the generated
 *   artifacts as a {@link BridgePackageArtifacts} object.
 * - The `dsh-bridge-codegen` CLI bin — reads sources from disk and writes the
 *   package to a target directory.
 *
 * @module @deepseek-ai/dsh-python-bridge-codegen
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

// ---------------------------------------------------------------------------
// Public types — describe the parsed bridge metadata.
// ---------------------------------------------------------------------------

/** One method parameter with its (optional) PEP 484 annotation. */
export interface ParsedParameter {
  name: string
  /** Raw Python annotation text (e.g. `list[str]`); undefined when absent. */
  annotation: string | undefined
  /** Whether the Python signature gives the parameter a default value. */
  hasDefault: boolean
}

/** One dataclass-style class-level field (`name: annotation = default`). */
export interface ParsedField {
  name: string
  annotation: string | undefined
  /** Raw Python default expression (e.g. `32`, `'float32'`); undefined when absent. */
  defaultValue: string | undefined
}

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
  /** Dataclass-style fields (constructor init args). */
  fields: ParsedField[]
  /** Source file path (informational). */
  source: string
}

/** One `@provide_method`-decorated function on a service class. */
export interface ParsedProvideMethod {
  name: string
  parameters: ParsedParameter[]
  /** Raw Python return annotation; undefined when absent. */
  returnAnnotation: string | undefined
  timeoutMs: number | undefined
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
  parametersList: ParsedParameter[]
  returnAnnotation: string | undefined
}

/** One `@on`-decorated function. */
export interface ParsedListener {
  event: string
  mode: 'emit' | 'waterfall' | 'session'
  prepend: boolean
  global: boolean
  functionName: string
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
  parameters: ParsedParameter[]
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
// Parser
// ---------------------------------------------------------------------------

/**
 * Lightweight parser for `dsh_bridge` decorator metadata. Decorator factories
 * take only keyword arguments (plus one leading positional name), so a
 * balanced-paren scan over the source text suffices; the parser never
 * executes user code.
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
        into.services.push({
          className,
          name: kwargs.name ?? positionals[0] ?? className,
          settingsNamespace: kwargs.settings_namespace,
          provideMethods: collectProvideMethods(source, className, argsEnd),
          fields: collectClassFields(source, className, argsEnd),
          source: path,
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
        const signature = readFunctionSignature(source, argsEnd)
        into.tools.push({
          name: kwargs.name ?? positionals[0] ?? fnName,
          description: kwargs.description ?? '',
          parameters: (jsonKwargs.parameters ?? {}) as Record<string, unknown>,
          outputSchema: jsonKwargs.output_schema as Record<string, unknown> | undefined,
          timeoutMs: numericTimeout(kwargs.timeout_ms),
          functionName: fnName,
          parametersList: signature.parameters,
          returnAnnotation: signature.returnAnnotation,
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
        into.listeners.push({
          event: positionals[0] ?? kwargs.event ?? '',
          mode,
          prepend: kwargs.prepend === 'True' || kwargs.prepend === 'true',
          global: kwargs.global_ === 'True' || kwargs.global_ === 'true',
          functionName: fnName,
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
          seam: kwargs.seam ?? positionals[0] ?? '',
          backend: kwargs.backend ?? positionals[1] ?? '',
          className,
          methods: collectCapabilityMethods(source, className, argsEnd),
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
        into.promptSections.push({
          order: Number(kwargs.order ?? positionals[0] ?? 0),
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

interface DecoratorArgs {
  /** String-valued keyword arguments. */
  kwargs: Record<string, string>
  /** Parsed JSON values for dict/list literal arguments (`True`→`true`, trailing commas stripped). */
  jsonKwargs: Record<string, unknown>
  /** Positional arguments with quotes stripped. */
  positionals: string[]
}

/**
 * Parse decorator argument text into keyword, parsed-JSON, and positional
 * buckets. Dict/list literal values are approximated as JSON (Python's
 * `True`/`False`/`None` and trailing commas are normalized); on parse
 * failure the raw string is preserved instead.
 */
function parseDecoratorArgs(text: string): DecoratorArgs {
  // Strip `#` comments first: an apostrophe inside a comment (`dsh-tools'`)
  // would otherwise corrupt splitTopLevel's string tracking.
  const parts = splitTopLevel(stripPythonComments(text), ',')
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
    const value = stripQuotes(part.slice(eq + 1).trim())
    kwargs[key] = value
    if (value.startsWith('{') || value.startsWith('[')) {
      // Approximate Python literal syntax as JSON: `#` comments, `True` /
      // `False` / `None` keywords, and trailing commas are normalized. On
      // parse failure the raw string is preserved instead.
      const pyValue = stripPythonComments(value)
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

/** Remove `#` comments outside string literals (single/double quoted, with escapes). */
function stripPythonComments(text: string): string {
  let out = ''
  let inString: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === inString && text[i - 1] !== '\\') inString = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = ch
      out += ch
      continue
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++
      if (i < text.length) out += '\n'
      continue
    }
    out += ch
  }
  return out
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
  // The `\b` boundary rejects `@dataclass`, which embeds the `class` substring.
  const re = /\bclass\s+([A-Za-z_][\w]*)/g
  re.lastIndex = after
  const m = re.exec(source)
  return m ? group(m, 1) : undefined
}

function findNextFunction(source: string, after: number): string | undefined {
  const re = /\bdef\s+([A-Za-z_][\w]*)/g
  re.lastIndex = after
  const m = re.exec(source)
  return m ? group(m, 1) : undefined
}

/**
 * Capture-group access for groups that are mandatory when the regex matched.
 * Under `noUncheckedIndexedAccess`, indexing yields `string | undefined`;
 * the invariant is owned here instead of asserted at every call site.
 */
function group(match: RegExpExecArray, index: number): string {
  const value = match[index]
  if (value === undefined) {
    throw new Error(`codegen: regex matched without mandatory capture group ${index}: ${match[0]}`)
  }
  return value
}

/** Optional capture-group access: the group may be absent by regex design. */
function optionalGroup(match: RegExpExecArray, index: number): string | undefined {
  return match[index]
}

/** One parsed `def` signature: parameters with annotations plus the return annotation. */
interface FunctionSignature {
  parameters: ParsedParameter[]
  returnAnnotation: string | undefined
}

/** Read the `def` signature immediately following a decorator's closing paren. */
function readFunctionSignature(source: string, after: number): FunctionSignature {
  const re = /\bdef\s+[A-Za-z_][\w]*\s*\(/g
  re.lastIndex = after
  const m = re.exec(source)
  if (!m) return { parameters: [], returnAnnotation: undefined }
  const openParen = re.lastIndex - 1
  const closeParen = matchParen(source, openParen + 1)
  if (closeParen < 0) return { parameters: [], returnAnnotation: undefined }
  const paramsText = source.slice(openParen + 1, closeParen)
  const returnRe = /^\)\s*->\s*([^:]+):/
  const returnMatch = returnRe.exec(source.slice(closeParen))
  return {
    parameters: parseParameters(paramsText),
    returnAnnotation: returnMatch?.[1]?.trim(),
  }
}

/** Parse a Python parameter list into name/annotation/default triples. */
function parseParameters(text: string): ParsedParameter[] {
  const out: ParsedParameter[] = []
  for (const part of splitTopLevel(text, ',')) {
    const trimmed = part.trim()
    if (!trimmed || trimmed === 'self' || trimmed === 'cls') continue
    if (trimmed.startsWith('*')) continue // *args / **kwargs are not wire parameters
    const eq = trimmed.indexOf('=')
    const namePart = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim()
    const colon = namePart.indexOf(':')
    const name = (colon < 0 ? namePart : namePart.slice(0, colon)).trim()
    const annotation = colon < 0 ? undefined : namePart.slice(colon + 1).trim()
    if (!name) continue
    out.push({ name, annotation, hasDefault: eq >= 0 })
  }
  return out
}

/** Locate the class body span (start of header to the next top-level statement). */
function classBodySpan(source: string, className: string, after: number): { start: number; end: number } | undefined {
  const headerRe = new RegExp(`\\bclass\\s+${className}\\b[^\\n]*\\n`)
  headerRe.lastIndex = after
  const headerMatch = headerRe.exec(source)
  if (!headerMatch) return undefined
  const start = headerMatch.index + headerMatch[0].length
  let end = source.length
  const lines = source.slice(start).split('\n')
  let offset = start
  for (const line of lines) {
    // A non-empty, non-comment line at indent 0 ends the class body.
    if (/^[^\s#]/.test(line)) {
      end = offset
      break
    }
    offset += line.length + 1
  }
  return { start, end }
}

/** Collect `@provide_method`-decorated methods of one class, with signatures. */
function collectProvideMethods(source: string, className: string, after: number): ParsedProvideMethod[] {
  const span = classBodySpan(source, className, after)
  if (!span) return []
  const body = source.slice(span.start, span.end)
  const methods: ParsedProvideMethod[] = []
  // Walk decorated methods: capture decorator kwargs then the following def.
  const decRe = /@provide_method\s*\(([^)]*)\)\s*\n\s*def\s+([A-Za-z_][\w]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = decRe.exec(body)) !== null) {
    const { kwargs } = parseDecoratorArgs(group(m, 1))
    const openParen = decRe.lastIndex - 1
    const closeParen = matchParen(body, openParen + 1)
    const paramsText = closeParen < 0 ? '' : body.slice(openParen + 1, closeParen)
    const returnMatch = closeParen < 0 ? null : /^\)\s*->\s*([^:]+):/.exec(body.slice(closeParen))
    methods.push({
      name: group(m, 2),
      parameters: parseParameters(paramsText),
      returnAnnotation: returnMatch?.[1]?.trim(),
      timeoutMs: numericTimeout(kwargs.timeout_ms),
      concurrencySafe: kwargs.is_concurrency_safe === 'True' || kwargs.is_concurrency_safe === 'true'
        ? true
        : kwargs.is_concurrency_safe === 'False' || kwargs.is_concurrency_safe === 'false'
          ? false
          : undefined,
    })
  }
  return methods
}

/** Collect `@method`-decorated methods of one `@capability` class. */
function collectCapabilityMethods(source: string, className: string, after: number): ParsedCapabilityMethod[] {
  const span = classBodySpan(source, className, after)
  if (!span) return []
  const body = source.slice(span.start, span.end)
  const methods: ParsedCapabilityMethod[] = []
  const decRe = /@method\s*\(([^)]*)\)\s*\n\s*def\s+([A-Za-z_][\w]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = decRe.exec(body)) !== null) {
    const { kwargs, positionals } = parseDecoratorArgs(group(m, 1))
    const openParen = decRe.lastIndex - 1
    const closeParen = matchParen(body, openParen + 1)
    const paramsText = closeParen < 0 ? '' : body.slice(openParen + 1, closeParen)
    methods.push({
      name: kwargs.name ?? positionals[0] ?? group(m, 2),
      functionName: group(m, 2),
      parameters: parseParameters(paramsText),
    })
  }
  return methods
}

/** Collect dataclass-style class-level fields (`name: annotation = default`). */
function collectClassFields(source: string, className: string, after: number): ParsedField[] {
  const span = classBodySpan(source, className, after)
  if (!span) return []
  const body = source.slice(span.start, span.end)
  const fields: ParsedField[] = []
  // Only lines at the class body's own indent level are attributes: method
  // parameters in multi-line signatures sit one level deeper and would
  // otherwise be misread as fields.
  let attrIndent: number | undefined
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (attrIndent === undefined) {
      if (!/^\s+([A-Za-z_][\w]*)\s*:/.test(line)) continue
      attrIndent = indent
    }
    if (indent !== attrIndent) continue
    // One indent level, `name: annotation` with optional `= default`.
    const m = /^\s+([A-Za-z_][\w]*)\s*:\s*([^=\n]+?)(?:\s*=\s*(.+))?$/.exec(line)
    if (!m) continue
    const fieldName = group(m, 1)
    // Underscore-prefixed fields are internal state by Python convention
    // (e.g. `_notes: list = field(default_factory=list)`), never config keys.
    if (fieldName.startsWith('_')) continue
    const annotation = group(m, 2).trim()
    // Annotations of real attributes never carry parameter-list punctuation.
    if (annotation.includes(',') || annotation.includes('(')) continue
    fields.push({
      name: fieldName,
      annotation,
      defaultValue: optionalGroup(m, 3)?.trim(),
    })
  }
  return fields
}

function numericTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined
  // Python integer literals may use `_` digit separators (`10_000`).
  const num = Number(value.replace(/_/g, ''))
  return Number.isFinite(num) ? num : undefined
}

// ---------------------------------------------------------------------------
// Type inference — Python annotation text → TypeScript type expression.
// ---------------------------------------------------------------------------

/**
 * Best-effort TypeScript type projection from a Python annotation string,
 * covering the subset documented in `spec-python-capability-bridge.md` §5.6.
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
  if (trimmed === 'bytes') return 'string' // base64 on the wire
  if (trimmed === 'dict' || trimmed === 'Dict') return 'Record<string, unknown>'
  if (trimmed === 'list' || trimmed === 'List') return 'unknown[]'
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

/** snake_case → camelCase for TS-facing config field names. */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())
}

// ---------------------------------------------------------------------------
// Bridge package generation
// ---------------------------------------------------------------------------

/**
 * Generate a TypeScript bridge package from one or more Python source files.
 *
 * Package form follows `packages/AGENTS.md`: a module with `@service` yields
 * a default-exported Service class (module tools and listeners register
 * against the same shared bridge in the constructor); a module without one
 * yields a function plugin (named `name`/`inject`/`Config`/`apply`).
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
  const files: BridgePackageFile[] = [
    generatePackageJson(options.packageName),
    generateIndexTs(parsed, options.module),
  ]
  if (parsed.diagnostics.length > 0) {
    files.push(generateDiagnosticsTs(parsed.diagnostics))
  }
  return { files, packageName: options.packageName, parsed }
}

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
      '@deepseek-ai/dsh-tools': 'workspace:^',
      '@deepseek-ai/dsh-session': 'workspace:^',
      '@deepseek-ai/schemastery': 'workspace:^',
    },
  }
  return {
    path: 'package.json',
    contents: JSON.stringify(pkg, null, 2) + '\n',
  }
}

// ---------------------------------------------------------------------------
// index.ts emission
// ---------------------------------------------------------------------------

function generateIndexTs(parsed: ParsedModule, modulePath: string): BridgePackageFile {
  const needsTools = parsed.tools.length > 0
  const imports = [
    `import { Context, Service } from '@deepseek-ai/cordis'`,
    `import z from '@deepseek-ai/schemastery'`,
    ...(needsTools ? [`import { defineTool } from '@deepseek-ai/dsh-tools'`] : []),
    ...(needsTools ? [`import type { JsonValue } from '@deepseek-ai/dsh-session'`] : []),
    `import { PythonBridgeService, type PythonBridge } from '@deepseek-ai/dsh-python-bridge-runtime'`,
  ]

  const sections: string[] = [
    imports.join('\n'),
    '',
    `declare module '@deepseek-ai/cordis' {`,
    `  interface Context { pythonBridge: PythonBridgeService }`,
    `}`,
    '',
  ]

  if (parsed.services.length > 0) {
    // Service-class package form: one default-exported class owns the bridge;
    // module tools and listeners register against it in the constructor.
    const service = parsed.services[0]
    if (service === undefined) throw new Error('codegen: services list is non-empty but its first entry is undefined')
    if (parsed.services.length > 1) {
      sections.push(`// NOTE: ${parsed.services.length - 1} additional @service classes in this module`)
      sections.push(`// are not emitted; split them into separate modules for separate packages.`)
      sections.push('')
    }
    sections.push(emitServiceClass(service, parsed, modulePath))
  } else {
    // Function-plugin form: named exports only, one shared bridge per apply().
    sections.push(emitFunctionPlugin(parsed, modulePath))
  }

  return { path: 'src/index.ts', contents: sections.join('\n') + '\n' }
}

// -- Service-class form ------------------------------------------------------

/** Config field descriptor shared by the interface and the zod schema. */
interface ConfigField {
  /** TS-facing field name (camelCase). */
  tsName: string
  tsType: string
  zodExpr: string
  optional: boolean
  /** Python-side init-arg name (snake_case) when the field maps to an init arg. */
  initArgName?: string
}

function baseConfigFields(): ConfigField[] {
  // Schemastery semantics (vendor/schemastery): object properties are optional
  // unless `.required()`; there is no `.optional()` method, and unions of
  // literals replace `z.enum`.
  return [
    { tsName: 'pythonBin', tsType: 'string', zodExpr: `z.string().default('python')`, optional: true },
    { tsName: 'module', tsType: 'string', zodExpr: `z.string().required()`, optional: false },
    { tsName: 'className', tsType: 'string', zodExpr: `z.string()`, optional: true },
    { tsName: 'pipDeps', tsType: 'string[]', zodExpr: `z.array(z.string()).default([])`, optional: true },
    { tsName: 'cwd', tsType: 'string', zodExpr: `z.string()`, optional: true },
    { tsName: 'sandbox', tsType: `'read-only' | 'workspace-write' | 'danger-full-access'`, zodExpr: `z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('workspace-write')`, optional: true },
    { tsName: 'graceMs', tsType: 'number', zodExpr: `z.number().default(3000)`, optional: true },
  ]
}

/** Map one parsed dataclass field to a config field (camelCase TS name, zod with default). */
function userConfigField(field: ParsedField): ConfigField {
  const tsName = snakeToCamel(field.name)
  const tsType = field.annotation ? pythonTypeToTs(field.annotation) : 'unknown'
  const zodBase = zodForAnnotation(field.annotation)
  if (field.defaultValue !== undefined) {
    const zodDefault = pythonLiteralToTs(field.defaultValue)
    if (zodDefault === null) {
      // `None` default: the field is optional (schemastery default semantics).
      return { tsName, tsType, zodExpr: zodBase, optional: true, initArgName: field.name }
    }
    return { tsName, tsType, zodExpr: `${zodBase}.default(${zodDefault})`, optional: true, initArgName: field.name }
  }
  // No dataclass default: the field is required.
  return { tsName, tsType, zodExpr: `${zodBase}.required()`, optional: false, initArgName: field.name }
}

function zodForAnnotation(annotation: string | undefined): string {
  const a = annotation?.trim()
  if (a === 'int' || a === 'float') return 'z.number()'
  if (a === 'bool') return 'z.boolean()'
  if (a === 'str' || a === 'bytes') return 'z.string()'
  if (a?.startsWith('list[') || a?.startsWith('List[')) return 'z.array(z.any())'
  if (a?.startsWith('Optional[') || a?.includes(' | None')) {
    // Schemastery fields are optional by default; Optional[T] needs no marker.
    const inner = a.startsWith('Optional[')
      ? a.slice('Optional['.length, a.lastIndexOf(']'))
      : a.replace(/\s*\|\s*None/g, '')
    return zodForAnnotation(inner)
  }
  return 'z.any()'
}

/** Translate a Python literal default to a TS expression; null marks `None`. */
function pythonLiteralToTs(value: string): string | null {
  const v = value.trim()
  if (v === 'None') return null
  if (v === 'True') return 'true'
  if (v === 'False') return 'false'
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return JSON.stringify(v.slice(1, -1))
  }
  return 'undefined'
}

function emitServiceClass(service: ParsedService, parsed: ParsedModule, modulePath: string): string {
  const typeName = `${capitalize(service.name)}Service`
  const configName = `${capitalize(service.name)}Config`
  const configFields = [...baseConfigFields(), ...service.fields.map(userConfigField)]

  const interfaceLines = configFields.map(f =>
    `  ${f.tsName}${f.optional ? '?' : ''}: ${f.tsType}`,
  )
  const zodEntries = configFields.map(f => `    ${f.tsName}: ${f.zodExpr},`)

  const initArgFields = configFields.filter(f => f.initArgName !== undefined)
  const initArgsLiteral = initArgFields.length > 0
    ? `{ ${initArgFields.map(f => `${f.initArgName}: config.${f.tsName}`).join(', ')} }`
    : 'pickInitArgs(config)'

  const methods = service.provideMethods.map(m => emitProvideMethod(m)).join('\n\n')

  const toolRegistrations = parsed.tools.map(t => emitToolRegistration(t, 'this.bridge')).join('\n\n')
  const listenerRegistrations = parsed.listeners.map(l => emitListenerRegistration(l, 'this.bridge')).join('\n')

  // `ctx.<name>` access requires a declared injection (packages/AGENTS.md):
  // the tools seam is injected whenever the module registers tools.
  const injectList = ['pythonBridge', ...(parsed.tools.length > 0 ? ['tools'] : [])]

  const out: string[] = [
    `export interface ${configName} {`,
    ...interfaceLines,
    `}`,
    '',
    `export class ${typeName} extends Service {`,
    `  static inject = [${injectList.map(k => `'${k}'`).join(', ')}]`,
    ``,
    `  static Config: z<${configName}> = z.object({`,
    ...zodEntries,
    `  })`,
    ``,
    `  private bridge: PythonBridge`,
    ``,
    `  constructor(ctx: Context, config: ${configName}) {`,
    `    super(ctx, '${service.name}')`,
    `    this.bridge = ctx.pythonBridge.spawn({`,
    `      module: '${modulePath}',`,
    `      className: config.className ?? '${service.className}',`,
    `      initArgs: ${initArgsLiteral},`,
    // exactOptionalPropertyTypes: optional spec keys are spread only when
    // defined (the dsh-shell resolve() pattern).
    `      ...(config.pythonBin !== undefined ? { pythonBin: config.pythonBin } : {}),`,
    `      ...(config.pipDeps !== undefined ? { pipDeps: config.pipDeps } : {}),`,
    `      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),`,
    `      ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}),`,
    `      ...(config.graceMs !== undefined ? { graceMs: config.graceMs } : {}),`,
    `    })`,
  ]
  if (toolRegistrations) {
    out.push(``, `    // Model-facing tools declared in the same module share this bridge's`, `    // Python child (one process per Service Provider instance, spec §6.1).`)
    out.push(indent(toolRegistrations, 4))
  }
  if (listenerRegistrations) {
    out.push(``, `    // Event listeners live next to their containing module (spec §6.1).`)
    out.push(indent(listenerRegistrations, 4))
  }
  out.push(`  }`)
  if (methods) {
    out.push(``, methods)
  }
  out.push(`}`, ``, `export default ${typeName}`)

  if (initArgFields.length === 0) {
    out.push(``, emitPickInitArgsHelper())
  }
  return out.join('\n')
}

function emitProvideMethod(method: ParsedProvideMethod): string {
  const params = method.parameters.map(p =>
    `${p.name}${p.hasDefault ? '?' : ''}: ${p.annotation ? pythonTypeToTs(p.annotation) : 'unknown'}`,
  ).join(', ')
  const returnType = method.returnAnnotation ? pythonTypeToTs(method.returnAnnotation) : 'unknown'
  const argsObject = method.parameters.length > 0
    ? `{ ${method.parameters.map(p => p.name).join(', ')} }`
    : '{}'
  const lines = [
    `  ${method.name}(${params}): Promise<${returnType}> {`,
    `    return this.bridge.call('${method.name}', ${argsObject}) as Promise<${returnType}>`,
    `  }`,
  ]
  return lines.join('\n')
}

function emitToolRegistration(tool: ParsedTool, bridgeExpr: string): string {
  const parametersJson = JSON.stringify(tool.parameters, null, 2)
  const outputSchemaJson = tool.outputSchema ? JSON.stringify(tool.outputSchema, null, 2) : undefined
  // defineTool infers the execute return from output.schema; wire values are
  // JSON, so `unknown` in the Python-derived type must project to JsonValue.
  const returnType = (tool.returnAnnotation ? pythonTypeToTs(tool.returnAnnotation) : 'unknown')
    .replaceAll('unknown', 'JsonValue')
  const lines = [
    `ctx.tools.register(defineTool({`,
    `  name: ${JSON.stringify(tool.name)},`,
    `  description: ${JSON.stringify(tool.description)},`,
    `  parameters: ${indent(parametersJson, 2).trimStart()},`,
  ]
  if (outputSchemaJson !== undefined) {
    lines.push(`  output: {`)
    lines.push(`    schema: ${indent(outputSchemaJson, 4).trimStart()},`)
    lines.push(`    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],`)
    lines.push(`  },`)
  } else {
    lines.push(`  output: {`)
    // Codegen-authored fallback: dsh-tools' JSON Schema compiler requires an
    // explicit additionalProperties on every object schema.
    lines.push(`    schema: { type: 'object', additionalProperties: false, properties: {} },`)
    lines.push(`    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],`)
    lines.push(`  },`)
  }
  if (tool.timeoutMs !== undefined) {
    lines.push(`  timeoutMs: ${tool.timeoutMs},`)
  }
  lines.push(`  execute: async (args) => {`)
  lines.push(`    // The wire boundary is untyped JSON; output.schema validates the value.`)
  lines.push(`    return ${bridgeExpr}.call(${JSON.stringify(tool.name)}, args as Record<string, unknown>) as Promise<${returnType}>`)
  lines.push(`  },`)
  lines.push(`}))`)
  return lines.join('\n')
}

function emitListenerRegistration(listener: ParsedListener, bridgeExpr: string): string {
  // Cordis `EventOptions` is `{ prepend, global }`; emit/waterfall is the
  // emitter's dispatch semantics, not a listener registration option. A
  // waterfall listener MUST call `next()` to keep the chain alive — the
  // Python side is notified fire-and-forget, and wire-level waterfall
  // continuation (Python's return feeding `next()`) is deferred.
  const options = `{ prepend: ${listener.prepend}, global: ${listener.global} }`
  if (listener.mode === 'waterfall') {
    return [
      `ctx.on(${JSON.stringify(listener.event)}, (payload: unknown, next: () => void) => {`,
      `  ${bridgeExpr}.notify('event/deliver', { event: ${JSON.stringify(listener.event)}, payload })`,
      `  return next()`,
      `}, ${options})`,
    ].join('\n')
  }
  return [
    `ctx.on(${JSON.stringify(listener.event)}, (payload: unknown) => {`,
    `  ${bridgeExpr}.notify('event/deliver', { event: ${JSON.stringify(listener.event)}, payload })`,
    `}, ${options})`,
  ].join('\n')
}

function emitPickInitArgsHelper(): string {
  return [
    `/** Forward non-reserved config keys as the Python class's __init__ kwargs. */`,
    `function pickInitArgs(config: Record<string, unknown>): Record<string, unknown> {`,
    `  const reserved = new Set(['pythonBin', 'module', 'className', 'pipDeps', 'cwd', 'sandbox', 'graceMs'])`,
    `  const out: Record<string, unknown> = {}`,
    `  for (const [key, value] of Object.entries(config)) {`,
    `    if (!reserved.has(key)) out[key] = value`,
    `  }`,
    `  return out`,
    `}`,
  ].join('\n')
}

// -- Function-plugin form ----------------------------------------------------

function emitFunctionPlugin(parsed: ParsedModule, modulePath: string): string {
  const configFields = baseConfigFields()
  const interfaceLines = configFields.map(f =>
    `  ${f.tsName}${f.optional ? '?' : ''}: ${f.tsType}`,
  )
  const zodEntries = configFields.map(f => `    ${f.tsName}: ${f.zodExpr},`)
  const toolRegistrations = parsed.tools.map(t => emitToolRegistration(t, 'bridge')).join('\n\n')
  const listenerRegistrations = parsed.listeners.map(l => emitListenerRegistration(l, 'bridge')).join('\n')

  // `ctx.tools` access requires a declared injection (packages/AGENTS.md).
  const injectList = ['pythonBridge', ...(parsed.tools.length > 0 ? ['tools'] : [])]

  const out: string[] = [
    `export interface BridgeToolsConfig {`,
    ...interfaceLines,
    `}`,
    ``,
    `export const name = 'python-bridge-tools'`,
    `export const inject = [${injectList.map(k => `'${k}'`).join(', ')}]`,
    ``,
    `export const Config: z<BridgeToolsConfig> = z.object({`,
    ...zodEntries,
    `})`,
    ``,
    `export function apply(ctx: Context, config: BridgeToolsConfig): void {`,
    `  // One shared Python child hosts every tool and listener of this module`,
    `  // (tools are stateless model-facing entry points, spec §6.1).`,
    `  const bridge = ctx.pythonBridge.spawn({`,
    `    module: '${modulePath}',`,
    `    ...(config.pythonBin !== undefined ? { pythonBin: config.pythonBin } : {}),`,
    `    ...(config.pipDeps !== undefined ? { pipDeps: config.pipDeps } : {}),`,
    `    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),`,
    `    ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}),`,
    `    ...(config.graceMs !== undefined ? { graceMs: config.graceMs } : {}),`,
    `  })`,
  ]
  if (toolRegistrations) out.push(``, indent(toolRegistrations, 2))
  if (listenerRegistrations) out.push(``, indent(listenerRegistrations, 2))
  out.push(`}`)
  return out.join('\n')
}

function generateDiagnosticsTs(diagnostics: ParsedModule['diagnostics']): BridgePackageFile {
  const lines = diagnostics.map(d => `// ${d.source}:${d.line}: ${d.message}`).join('\n')
  return {
    path: 'src/diagnostics.ts',
    contents: `// Auto-generated diagnostics for the dsh-bridge codegen.\n// These lines reflect decoration problems found in the Python source.\n${lines}\n`,
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map(line => line.length > 0 ? pad + line : line).join('\n')
}

// ---------------------------------------------------------------------------
// CLI — `pnpm dsh-bridge-codegen <source.py>... --out <dir>`
// ---------------------------------------------------------------------------

/**
 * Programmatic CLI entry point: reads Python sources, generates the bridge
 * package, and writes it to `outDir`. Exit code 1 when diagnostics exist.
 */
export function runCli(args: string[]): number {
  const positional: string[] = []
  let outDir: string | undefined
  let packageName = '@my-org/python-bridge'
  let module = 'module'
  /** Read the value after a flag, failing loud when the flag is last. */
  const flagValue = (index: number): string => {
    const value = args[index]
    if (value === undefined) throw new Error('dsh-bridge-codegen: missing value after flag')
    return value
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out') {
      outDir = flagValue(++i)
    } else if (a === '--name') {
      packageName = flagValue(++i)
    } else if (a === '--module') {
      module = flagValue(++i)
    } else if (a !== undefined) {
      positional.push(a)
    }
  }
  if (!outDir || positional.length === 0) {
    process.stderr.write('usage: dsh-bridge-codegen <source.py>... --out <dir> [--name <pkg>] [--module <python.module.path>]\n')
    return 2
  }
  const sources = collectSources(positional)
  const artifacts = generateBridgePackage({ module, packageName, sources })
  writePackage(artifacts, resolve(outDir))
  for (const diagnostic of artifacts.parsed.diagnostics) {
    process.stderr.write(`${diagnostic.source}:${diagnostic.line}: ${diagnostic.message}\n`)
  }
  return artifacts.parsed.diagnostics.length > 0 ? 1 : 0
}

function collectSources(paths: string[]): Array<{ path: string; contents: string }> {
  const out: Array<{ path: string; contents: string }> = []
  for (const pattern of paths) {
    if (pattern.includes('**')) {
      process.stderr.write(`dsh-bridge-codegen: glob recursion is unsupported (${pattern}); pass an explicit file list.\n`)
      continue
    }
    const stat = statSync(pattern)
    if (stat.isDirectory()) {
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

/** Marker used by the runtime tests; not part of the production surface. */
export const __test_marker = 'dsh-bridge-codegen' as const
