/**
 * Runtime invariants for `@deepseek-ai/dsh-python-bridge-runtime`.
 *
 * The bridge owns no Cordis event/data relations of its own: the runtime is
 * a process-management seam, not a model-visible surface. Empty companion
 * `No runtime invariant:` justifications are acceptable per the package
 * invariant policy when the package owns no event/data relations.
 *
 * @module @deepseek-ai/dsh-python-bridge-runtime/invariant
 */

import type { InvariantCheck } from '@deepseek-ai/dsh-invariants'

export const manifest = '@deepseek-ai/dsh-python-bridge-runtime' as const

export const checks: InvariantCheck[] = [
  // No runtime invariant: this package owns no event/data relations; the
  // Python bridge is a process-management seam whose only side effects are
  // stdout frames and subprocess lifecycle. Subscribers observe Cordis
  // events through `ctx.on(...)` regardless of which runtime owns them, so
  // there is no bridge-specific event invariant to enforce.
]