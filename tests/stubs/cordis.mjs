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
  }

  get(name) {
    return this._services[name]
  }

  on() {
    return () => {}
  }
}

export class Service {
  constructor(ctx, key) {
    this.ctx = ctx
    this.key = key
  }
}
