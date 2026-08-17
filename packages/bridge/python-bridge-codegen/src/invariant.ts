/**
 * Package-owned invariant companion for `@peroxidess/dsh-python-bridge-codegen`.
 * @module @peroxidess/dsh-python-bridge-codegen/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@peroxidess/dsh-python-bridge-codegen'

/** Cordis companion plugin name. */
export const name = 'python-bridge-codegen-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the codegen is a build-time tool that emits source
 * artifacts. It registers no Cordis plugins, owns no event stream or mutable
 * data relation, and has no observable side effects at runtime.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
