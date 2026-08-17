/**
 * Invariant companion for `@deepseek-ai/dsh-python-bridge`.
 * @module @deepseek-ai/dsh-python-bridge/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-python-bridge'

/** Cordis companion plugin name. */
export const name = 'python-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: registrations are owned by the source Python module
 * and are already observable through the Cordis service, tool, and event
 * registries that own their respective relationships.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
