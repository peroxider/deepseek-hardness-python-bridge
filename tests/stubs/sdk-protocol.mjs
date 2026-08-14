/**
 * Standalone-development stub for `@deepseek-ai/dsh-sdk-protocol`.
 *
 * Functional (not ornamental): implements the same newline-delimited JSON-RPC
 * 2.0 framing as the real `JsonRpcLineTransport` so the bridge runtime's
 * real-child-process tests exercise genuine protocol behavior offline. Inside
 * the monorepo the real package replaces this stub.
 */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export class JsonRpcResponseError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'JsonRpcResponseError'
    this.code = code
    this.data = data
  }
}

export class JsonRpcLineTransport {
  #buffer = ''
  #decoder = new StringDecoder('utf8')
  #started = false
  #requestHandler
  #notificationHandler
  #pending = new Map()
  #input
  #output

  constructor(input, output) {
    this.#input = input
    this.#output = output
  }

  start() {
    if (this.#started) return
    this.#started = true
    this.#input.on('data', this.#onData)
    this.#input.on('error', this.#onError)
    this.#input.on('end', this.#onEnd)
  }

  close() {
    this.#input.off('data', this.#onData)
    this.#input.off('error', this.#onError)
    this.#input.off('end', this.#onEnd)
    this.#failPending(new Error('JSON-RPC transport closed'))
  }

  onRequest(handler) { this.#requestHandler = handler }
  onNotification(handler) { this.#notificationHandler = handler }

  request(method, params, signal) {
    const id = `req_${randomUUID().replaceAll('-', '')}`
    return new Promise((resolve, reject) => {
      let detach = () => {}
      if (signal !== undefined) {
        if (signal.aborted) { reject(new Error('aborted')); return }
        const onAbort = () => { this.#pending.delete(id); reject(new Error('aborted')) }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => signal.removeEventListener('abort', onAbort)
      }
      this.#pending.set(id, {
        resolve: (v) => { detach(); resolve(v) },
        reject: (e) => { detach(); reject(e) },
      })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        detach()
        reject(error)
      }
    })
  }

  notify(method, params) {
    this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  #onData = (chunk) => {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk)
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      void this.#handleLine(line)
    }
  }

  #onError = (error) => this.#failPending(error)

  #onEnd = () => {
    this.#buffer += this.#decoder.end()
    this.#failPending(new Error('JSON-RPC input closed'))
  }

  async #handleLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (!message || typeof message !== 'object') return
    const { id, method } = message
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      const handler = this.#requestHandler
      if (!handler) { this.#write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }); return }
      try {
        const result = await handler(method, message.params ?? {})
        this.#write({ jsonrpc: '2.0', id, result })
      } catch (error) {
        this.#write({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      if (message.error && typeof message.error === 'object') {
        pending.reject(new JsonRpcResponseError(
          typeof message.error.code === 'number' ? message.error.code : undefined,
          typeof message.error.message === 'string' ? message.error.message : 'JSON-RPC error',
          message.error.data,
        ))
        return
      }
      pending.resolve(message.result)
      return
    }
    if (typeof method === 'string') this.#notificationHandler?.(method, message.params ?? {})
  }

  #write(message) {
    this.#output.write(`${JSON.stringify(message)}\n`)
  }

  #failPending(error) {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}
