#!/usr/bin/env node
/**
 * One-command offline verification for the standalone bridge repository.
 *
 *   node scripts/verify.mjs
 *
 * Runs, in order:
 *   1. Stub materialization (`scripts/setup-stubs.mjs`)
 *   2. Python test suite (pytest; requires pytest on PATH)
 *   3. Codegen mirror checks (`tests/e2e/codegen-mirror.mjs`)
 *   4. Runtime lifecycle checks (`tests/e2e/runtime-lifecycle.mjs`)
 *   5. Real-child runtime E2E (`tests/e2e/runtime-real-child.mjs`)
 *   6. Generated-package E2E (`tests/e2e/generated-package.mjs`)
 *
 * Exits non-zero when any step fails.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.DSH_E2E_PYTHON ?? 'python3'

const steps = [
  ['stub materialization', 'node', ['scripts/setup-stubs.mjs']],
  ['python test suite', python, ['-m', 'pytest', 'tests/'], { cwd: join(root, 'python/sdk-dsl'), env: { ...process.env, PYTHONPATH: 'src' } }],
  ['codegen mirror checks', 'node', ['--experimental-strip-types', 'tests/e2e/codegen-mirror.mjs']],
  ['runtime lifecycle checks', 'node', ['--experimental-strip-types', 'tests/e2e/runtime-lifecycle.mjs']],
  ['runtime real-child E2E', 'node', ['--experimental-strip-types', 'tests/e2e/runtime-real-child.mjs']],
  ['generated-package E2E', 'node', ['--experimental-strip-types', 'tests/e2e/generated-package.mjs']],
]

let failed = 0
for (const [name, command, args, options] of steps) {
  console.log(`\n=== ${name} ===`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    ...options,
  })
  if (result.status !== 0) {
    failed++
    console.error(`=== ${name}: FAILED (exit ${result.status}) ===`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} verification step(s) failed`)
  process.exit(1)
}
console.log('\nALL VERIFICATION STEPS PASSED')
