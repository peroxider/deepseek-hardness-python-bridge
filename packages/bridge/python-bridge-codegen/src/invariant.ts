/**
 * Runtime invariants for `@deepseek-ai/dsh-python-bridge-codegen`.
 *
 * The codegen runs at build time and emits source artifacts; it owns no
 * Cordis event/data relations. Empty companion `No runtime invariant:`
 * justifications are acceptable per the package invariant policy.
 *
 * @module @deepseek-ai/dsh-python-bridge-codegen/invariant
 */

import type { InvariantCheck } from '@deepseek-ai/dsh-invariants'

export const manifest = '@deepseek-ai/dsh-python-bridge-codegen' as const

export const checks: InvariantCheck[] = [
  // No runtime invariant: this package is a build-time tool that emits
  // source artifacts; it registers no Cordis plugins, owns no event/data
  // relations, and has no observable side effects at runtime.
]