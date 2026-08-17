/**
 * Manifest-driven Cordis plugin for Python modules decorated with `dsh_bridge`.
 * @module @peroxidess/dsh-python-bridge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { PythonBridge, PythonBridgeManifest } from '@peroxidess/dsh-python-bridge-runtime'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Configuration accepted by the generic Python bridge plugin. */
export interface Config {
  module: string
  className?: string
  functions?: string[]
  initArgs?: Record<string, unknown>
  pythonBin?: string
  pythonPath?: string[]
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  graceMs?: number
  reconnect?: {
    enabled?: boolean
    initialDelayMs?: number
    maxDelayMs?: number
    maxAttempts?: number
  }
  settingsNamespace?: string
}

interface JsonSchemaObject {
  [key: string]: unknown
}

const EMPTY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

/** Generic plugin loaded once per configured Python module. */
export class PythonModulePlugin {
  static inject = ['pythonBridge']

  static Config = z.object({
    module: z.string().required(),
    className: z.string(),
    functions: z.array(z.string()).default([]),
    initArgs: z.dict(z.any()).default({}),
    pythonBin: z.string().default('python'),
    pythonPath: z.array(z.string()).default([]),
    sandbox: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('workspace-write'),
    graceMs: z.number().default(3000),
    reconnect: z.object({
      enabled: z.boolean().default(true),
      initialDelayMs: z.number().default(500),
      maxDelayMs: z.number().default(30000),
      maxAttempts: z.number().default(10),
    }).default({ enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }),
    settingsNamespace: z.string(),
  })

  private readonly ctx: Context
  private readonly bridge: PythonBridge

  constructor(ctx: Context, config: Config) {
    this.ctx = ctx
    this.bridge = ctx.pythonBridge.spawn(config)
    ctx.effect(() => () => this.bridge.shutdown())
  }

  /** Wait for initialization, then register every manifest contribution. */
  async [Service.init](): Promise<void> {
    const manifest = await waitForManifest(this.bridge)
    this.registerService(manifest)
    if (manifest.tools.length > 0) {
      await this.ctx.inject(['tools'], ctx => this.registerTools(manifest, ctx))
    }
    this.registerListeners(manifest)
  }

  private registerService(manifest: PythonBridgeManifest): void {
    const service = manifest.services[0]
    if (!service) return
    const bridge = this.bridge
    class DynamicPythonService extends Service {
      readonly bridge = bridge
    }
    for (const method of manifest.provideMethods) {
      const names = Object.keys(method.parameters)
      Object.defineProperty(DynamicPythonService.prototype, method.name, {
        configurable: true,
        value: function (this: DynamicPythonService, ...values: unknown[]): Promise<unknown> {
          return this.bridge.call(method.name, Object.fromEntries(names.map((name, index) => [name, values[index]])))
        },
      })
    }
    new DynamicPythonService(this.ctx, service.name)
  }

  private registerTools(manifest: PythonBridgeManifest, ctx: Context): void {
    for (const tool of manifest.tools) {
      const outputSchema = tool.outputSchema
        ? normalizeObjectSchemas(tool.outputSchema, tool.name, ctx)
        : EMPTY_OUTPUT_SCHEMA
      const definition = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as ParameterSchemaSpec,
        output: {
          schema: outputSchema as ValueSchemaSpec,
          render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: (args: Record<string, unknown>) => this.bridge.call(tool.name, args) as Promise<JsonValue>,
      }
      const defineDynamicTool = defineTool as unknown as (options: unknown) => unknown
      const register = ctx.tools.register as unknown as (definition: unknown) => () => void
      ctx.effect(() => register.call(ctx.tools, defineDynamicTool(definition)))
    }
  }

  private registerListeners(manifest: PythonBridgeManifest): void {
    for (const listener of manifest.listeners) {
      const options = { prepend: listener.prepend, global: listener.global }
      if (listener.mode === 'waterfall') {
        const on = this.ctx.on as unknown as (
          event: string,
          handler: (payload: unknown, next: () => unknown) => unknown,
          options: { prepend: boolean; global: boolean },
        ) => () => void
        on.call(this.ctx, listener.event, (payload: unknown, next: () => unknown) => {
          this.bridge.notify('event/deliver', { event: listener.event, payload })
          return next()
        }, options)
      } else {
        const on = this.ctx.on as unknown as (
          event: string,
          handler: (payload: unknown) => void,
          options: { prepend: boolean; global: boolean },
        ) => () => void
        on.call(this.ctx, listener.event, (payload: unknown) => {
          this.bridge.notify('event/deliver', { event: listener.event, payload })
        }, options)
      }
    }
  }
}

async function waitForManifest(bridge: PythonBridge): Promise<PythonBridgeManifest> {
  return bridge.waitUntilReady()
}

function normalizeObjectSchemas(schema: JsonSchemaObject, toolName: string, ctx: Context): JsonSchemaObject {
  let added = false
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!isRecord(value)) return value
    const normalized = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    if (normalized.type === 'object' && normalized.additionalProperties === undefined) {
      normalized.additionalProperties = false
      added = true
    }
    return normalized
  }
  const normalized = visit(schema) as JsonSchemaObject
  if (added) {
    const logger = (ctx as Context & { logger?: (name: string) => { warn(message: string): void } }).logger
    logger?.('python-bridge').warn(`tool ${toolName}: defaulted missing additionalProperties to false`)
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export default PythonModulePlugin
