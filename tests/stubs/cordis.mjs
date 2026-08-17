/**
 * Standalone-development stub for `@deepseek-ai/cordis`.
 *
 * Only the surface the bridge packages consume: the `Service` base class and
 * the `Context` class (a value export in real cordis). Inside the real
 * deepseek-harness monorepo the genuine package replaces this stub via pnpm
 * workspace resolution; this file exists so the standalone repository can
 * typecheck and execute tests offline.
 */
export class Context {
  constructor(services = {}) {
    this._services = services
    this._disposers = []
    this._listeners = []
  }

  get(name) {
    return this._services[name]
  }

  /**
   * Mirror cordis' child-context: a new context that keeps the parent's
   * services (and own properties) visible but owns a fresh disposer list, so
   * disposing the child does not dispose the parent's services.
   */
  fork() {
    const child = new Context(this._services)
    for (const key of Object.keys(this)) {
      if (key === '_services' || key === '_disposers') continue
      child[key] = this[key]
    }
    return child
  }

  on(event, handler, options) {
    const entry = { event, handler, options }
    this._listeners.push(entry)
    return () => { this._listeners = this._listeners.filter(item => item !== entry) }
  }

  inject(_dependencies, callback) {
    return Promise.resolve(callback(this))
  }

  /** Mirror cordis' effect-based teardown: the returned function is the disposer. */
  effect(callback) {
    const disposer = callback()
    if (typeof disposer === 'function') this._disposers.push(disposer)
    return typeof disposer === 'function' ? disposer : () => {}
  }

  async dispose() {
    for (const disposer of this._disposers.splice(0)) {
      await disposer()
    }
  }
}

export class Service {
  static init = Symbol.for('cordis.init')

  constructor(ctx, key) {
    this.ctx = ctx
    this.key = key
    ctx._services[key] = this
  }
}
