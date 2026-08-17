/** Offline behavior check for the manifest-driven generic plugin. */
import { Context, Service } from '@deepseek-ai/cordis'
import PythonModulePlugin from '../../packages/bridge/python-bridge/src/index.ts'

function assert(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`ok: ${message}`)
}

const calls = []
const notifications = []
let shutdown = false
const bridge = {
  ready: true,
  bridgeManifest: {
    services: [{ name: 'sample', class: 'Sample', initFields: [] }],
    provideMethods: [{
      name: 'greet', timeoutMs: null, concurrencySafe: null,
      parameters: { name: 'str' }, return: 'str',
    }],
    tools: [{
      name: 'sample_lookup', description: 'Look up a sample.',
      parameters: { query: { type: 'string' } },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    }],
    listeners: [{ event: 'sample/event', mode: 'waterfall', prepend: true, global: false, function: 'observe' }],
    capabilities: [], capabilityMethods: [], promptSections: [], methods: ['greet', 'sample_lookup'],
  },
  call(method, args) { calls.push({ method, args }); return Promise.resolve({ method, args }) },
  notify(method, args) { notifications.push({ method, args }) },
  shutdown() { shutdown = true; return Promise.resolve() },
}
const tools = []
const ctx = new Context({
  pythonBridge: { spawn: () => bridge },
  tools: { register: tool => { tools.push(tool); return () => tools.splice(tools.indexOf(tool), 1) } },
})
ctx.pythonBridge = ctx.get('pythonBridge')
ctx.tools = ctx.get('tools')
const plugin = new PythonModulePlugin(ctx, { module: 'sample.bridge' })
await plugin[Service.init]()

assert(typeof ctx.get('sample').greet === 'function', 'manifest service registered')
await ctx.get('sample').greet('Ada')
assert(calls[0].method === 'greet' && calls[0].args.name === 'Ada', 'service arguments mapped by manifest order')
assert(tools.length === 1 && tools[0].name === 'sample_lookup', 'manifest tool registered')
assert(tools[0].output.schema.additionalProperties === false, 'missing additionalProperties defaults to false')
await tools[0].execute({ query: 'x' })
assert(calls[1].method === 'sample_lookup', 'tool call forwarded')
let continued = false
ctx._listeners[0].handler({ value: 1 }, () => { continued = true })
assert(continued, 'waterfall listener delegates to next')
assert(notifications[0].method === 'event/deliver', 'listener forwarded to Python')
await ctx.dispose()
assert(shutdown, 'fiber disposal shuts down the bridge')
assert(tools.length === 0, 'fiber disposal unregisters tools')
