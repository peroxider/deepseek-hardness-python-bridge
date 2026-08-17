#!/usr/bin/env node
/**
 * Strict TypeScript check of the bridge packages against REAL monorepo
 * sources, using the monorepo's own project-references build:
 *
 *   1. Sync the two bridge packages (and a freshly generated example package)
 *      into `$DSH_MONOREPO/packages/bridge/`.
 *   2. Register their `paths` in the monorepo `tsconfig.base.json` (idempotent).
 *   3. Run `tsc -b` over the three projects with the monorepo's own
 *      strict flags (typescript 6.0.3, `@types/node`, `zod`, and a js-yaml
 *      type shim are linked into the monorepo `node_modules` — all resolved
 *      offline from local caches).
 *
 *   node scripts/typecheck-integration.mjs
 *
 * Environment:
 *   DSH_MONOREPO - absolute path of the deepseek-harness checkout
 *   DSH_TSC      - absolute path of a tsc 6.x binary
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const monorepo = process.env.DSH_MONOREPO ?? '/home/chad/workspace/deepseek-harness'
const tsc = process.env.DSH_TSC ?? '/tmp/dsh-externals/manual/typescript-6.0.3/package/bin/tsc'

if (!existsSync(join(monorepo, 'tsconfig.base.json'))) {
  console.error(`monorepo not found at ${monorepo}; set DSH_MONOREPO`)
  process.exit(1)
}
if (!existsSync(tsc)) {
  console.error(`tsc not found at ${tsc}; set DSH_TSC`)
  process.exit(1)
}

// 1. Sync the bridge packages into the monorepo tree.
for (const pkg of ['python-bridge-runtime', 'python-bridge-codegen', 'python-bridge']) {
  for (const dir of ['src']) {
    cpSync(join(root, 'packages/bridge', pkg, dir), join(monorepo, 'packages/bridge', pkg, dir), { recursive: true })
  }
  for (const file of ['package.json', 'tsconfig.json']) {
    cpSync(join(root, 'packages/bridge', pkg, file), join(monorepo, 'packages/bridge', pkg, file))
  }
}

// 2. Generate the example bridge package into the monorepo and give it a
//    project tsconfig following the monorepo layout conventions.
const { generateBridgePackage } = await import(join(root, 'packages/bridge/python-bridge-codegen/src/index.ts'))
const source = readFileSync(join(root, 'examples/python-bridge-ml/provider.py'), 'utf8')
const artifacts = generateBridgePackage({
  module: 'examples.python-bridge-ml.provider',
  packageName: '@my-org/python-bridge-ml',
  sources: [{ path: 'provider.py', contents: source }],
})
const genOut = join(monorepo, 'packages/bridge/python-bridge-ml')
for (const f of artifacts.files) {
  const p = join(genOut, f.path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, f.contents)
}
writeFileSync(join(genOut, 'tsconfig.json'), JSON.stringify({
  extends: '../../../tsconfig.base.json',
  compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
  include: ['src'],
  references: [
    { path: '../../../vendor/cosmokit' },
    { path: '../../../vendor/cordis' },
    { path: '../../../vendor/schemastery' },
    { path: '../../core/tools' },
    { path: '../python-bridge-runtime' },
    { path: '../../runtime-diagnostics/invariants' },
  ],
}, null, 2) + '\n')

// 3. Register the bridge packages in the monorepo base paths (idempotent).
const basePath = join(monorepo, 'tsconfig.base.json')
const base = readFileSync(basePath, 'utf8')
if (!base.includes('"@deepseek-ai/dsh-python-bridge-runtime"')) {
  const anchor = '"@deepseek-ai/dsh-sdk-protocol": ["./packages/sdk/protocol/src"],'
  if (!base.includes(anchor)) {
    console.error('tsconfig.base.json paths anchor not found; register the bridge packages manually')
    process.exit(1)
  }
  writeFileSync(basePath, base.replace(
    anchor,
    `${anchor}\n      "@deepseek-ai/dsh-python-bridge-runtime": ["./packages/bridge/python-bridge-runtime/src"],\n      "@deepseek-ai/dsh-python-bridge-codegen": ["./packages/bridge/python-bridge-codegen/src"],`,
  ))
  console.log('registered bridge packages in monorepo tsconfig.base.json paths')
}
const baseWithRuntime = readFileSync(basePath, 'utf8')
if (!baseWithRuntime.includes('"@deepseek-ai/dsh-python-bridge"')) {
  const anchor = '"@deepseek-ai/dsh-python-bridge-codegen": ["./packages/bridge/python-bridge-codegen/src"],'
  if (!baseWithRuntime.includes(anchor)) {
    console.error('python bridge codegen path anchor not found')
    process.exit(1)
  }
  writeFileSync(basePath, baseWithRuntime.replace(
    anchor,
    `${anchor}\n      "@deepseek-ai/dsh-python-bridge": ["./packages/bridge/python-bridge/src"],`,
  ))
  console.log('registered generic bridge package in monorepo tsconfig.base.json paths')
}

// 4. Build the three projects with the monorepo's own reference graph.
const projects = [
  'packages/bridge/python-bridge-runtime',
  'packages/bridge/python-bridge-codegen',
  'packages/bridge/python-bridge',
  'packages/bridge/python-bridge-ml',
]
const result = spawnSync(tsc, ['-b', ...projects], { cwd: monorepo, stdio: 'inherit' })
if (result.status !== 0) {
  console.error(`strict typecheck failed (exit ${result.status})`)
  process.exit(result.status ?? 1)
}
console.log('strict typecheck passed: runtime + generic plugin + codegen + generated package (full monorepo reference graph)')
