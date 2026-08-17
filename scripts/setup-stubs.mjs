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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const STUBS = [
  ['@deepseek-ai/cordis', 'cordis.mjs'],
  ['@deepseek-ai/dsh-sdk-protocol', 'sdk-protocol.mjs'],
  ['@deepseek-ai/dsh-subprocess', 'subprocess.mjs'],
  ['@deepseek-ai/dsh-invariants', 'invariants.mjs'],
  ['@deepseek-ai/schemastery', 'schemastery.mjs'],
  ['@deepseek-ai/dsh-tools', 'tools.mjs'],
  ['@peroxider/dsh-python-bridge-runtime', null], // self-link for generated-package imports
  ['@peroxider/dsh-python-bridge', null],
]

for (const [name, file] of STUBS) {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  let target
  if (file === null) {
    // Self-link so generated bridge packages can import the runtime source.
    const packageDir = name === '@peroxider/dsh-python-bridge'
      ? 'python-bridge'
      : 'python-bridge-runtime'
    const href = pathToFileURL(join(root, 'packages/bridge', packageDir, 'src/index.ts')).href
    target = `export * from '${href}'\nexport { default } from '${href}'\n`
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

// The integration setup symlinks package-local node_modules to the REAL
// monorepo wrappers; remove those links so the offline e2e resolves the
// stubs above instead.
for (const pkg of ['python-bridge-runtime', 'python-bridge-codegen', 'python-bridge']) {
  const link = join(root, 'packages/bridge', pkg, 'node_modules')
  rmSync(link, { recursive: true, force: true })
}
console.log('standalone stubs ready')
