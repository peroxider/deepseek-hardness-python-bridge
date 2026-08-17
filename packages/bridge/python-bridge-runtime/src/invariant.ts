/**
 * Package-owned invariant companion for `@peroxidess/dsh-python-bridge-runtime`.
 * @module @peroxidess/dsh-python-bridge-runtime/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@peroxidess/dsh-python-bridge-runtime'

/** Cordis companion plugin name. */
export const name = 'python-bridge-runtime-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge is a process-management seam whose only
 * side effects are child-process stdio frames and lifecycle. It owns no
 * Cordis event stream or mutable data relation; subscribers observe Cordis
 * events through `ctx.on(...)` regardless of which runtime owns them.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
