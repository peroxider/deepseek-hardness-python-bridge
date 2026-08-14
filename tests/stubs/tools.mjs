/**
 * Standalone-development stub for `@deepseek-ai/dsh-tools`.
 *
 * `defineTool` returns the options object (identity) so generated bridge
 * packages can be imported and their tool registrations inspected offline.
 */
export function defineTool(options) {
  return { ...options, __definedTool: true }
}
