/**
 * Standalone-development stub for `@deepseek-ai/dsh-subprocess`.
 *
 * Carries the real `scrubbedParentEnv()` policy verbatim (it is the
 * single-sourced credential scrub) so standalone tests exercise genuine env
 * behavior. Process-management types exist only for typecheck resolution.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
export const DSH_ENV_PREFIX = 'DSH_'

export function scrubbedParentEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith(DSH_ENV_PREFIX)) env[key] = value
  }
  return env
}
