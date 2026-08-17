#!/usr/bin/env node
/**
 * Materialize standalone-development stub packages into `node_modules/`.
 *
 * The bridge repository is developed standalone (outside the deepseek-harness
 * monorepo) where `workspace:^` dependencies cannot resolve. The committed
 * stubs under `tests/stubs/` implement the minimal surface each
 * `@deepseek-ai/*` dependency exposes; this script writes thin wrapper
 * packages into `node_modules/` so plain Node resolution (and
 * `--experimental-strip-types` execution) finds them. Wrappers are gitignored
 * and regenerated on demand — run after every clone:
 *
 *   node scripts/setup-stubs.mjs
 *
 * Inside the real monorepo these stubs are NOT used: pnpm workspace
 * resolution binds the genuine packages.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const monorepo = process.env.DSH_MONOREPO ?? '/home/chad/workspace/deepseek-harness'
if (!existsSync(join(monorepo, 'packages', 'bridge'))) {
  console.error(`deepseek-harness not found at ${monorepo}; set DSH_MONOREPO`)
  process.exit(1)
}

const STUBS = [
  ['@deepseek-ai/cordis', 'cordis.mjs'],
  ['@deepseek-ai/dsh-sdk-protocol', 'sdk-protocol.mjs'],
  ['@deepseek-ai/dsh-subprocess', 'subprocess.mjs'],
  ['@deepseek-ai/dsh-invariants', 'invariants.mjs'],
  ['@deepseek-ai/schemastery', 'schemastery.mjs'],
  ['@deepseek-ai/dsh-tools', 'tools.mjs'],
  ['@deepseek-ai/dsh-python-bridge-runtime', null], // self-link for generated-package imports
  ['@deepseek-ai/dsh-python-bridge', null],
  ['@deepseek-ai/dsh-python-bridge-codegen', null],
]

for (const [name, file] of STUBS) {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  let target
  if (file === null) {
    const packageDir = name.slice('@deepseek-ai/dsh-'.length)
    const href = pathToFileURL(join(monorepo, 'packages/bridge', packageDir, 'src/index.ts')).href
    target = `export * from '${href}'\n`
    if (name !== '@deepseek-ai/dsh-python-bridge-codegen') target += `export { default } from '${href}'\n`
  } else {
    const stub = pathToFileURL(join(root, 'tests/stubs', file)).href
    target = `export * from '${stub}'\n`
    if (file === 'schemastery.mjs') target += `export { default } from '${stub}'\n`
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0-stub',
    type: 'module',
    main: './index.mjs',
    exports: { '.': './index.mjs' },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'index.mjs'), target)
  console.log(`stubbed ${name}`)
}

console.log('standalone stubs ready')
