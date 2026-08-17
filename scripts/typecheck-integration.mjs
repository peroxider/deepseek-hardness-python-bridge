#!/usr/bin/env node
/** Typecheck the monorepo-owned bridge packages and a generated fixture. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const monorepo = process.env.DSH_MONOREPO ?? '/home/chad/workspace/deepseek-harness'
const tsc = process.env.DSH_TSC ?? join(monorepo, 'node_modules/typescript/bin/tsc')

if (!existsSync(join(monorepo, 'packages/bridge/python-bridge-codegen/src/index.ts'))) {
  console.error(`deepseek-harness bridge sources not found at ${monorepo}; set DSH_MONOREPO`)
  process.exit(1)
}
if (!existsSync(tsc)) {
  console.error(`tsc not found at ${tsc}; set DSH_TSC`)
  process.exit(1)
}

const codegen = pathToFileURL(join(monorepo, 'packages/bridge/python-bridge-codegen/src/index.ts')).href
const { generateBridgePackage } = await import(codegen)
const source = readFileSync(join(root, 'examples/python-bridge-ml/provider.py'), 'utf8')
const artifacts = generateBridgePackage({
  module: 'examples.python-bridge-ml.provider',
  packageName: '@my-org/python-bridge-ml',
  sources: [{ path: 'provider.py', contents: source }],
})
const genOut = join(monorepo, 'packages/bridge/python-bridge-ml')
for (const file of artifacts.files) {
  const target = join(genOut, file.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, file.contents)
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
}, undefined, 2) + '\n')

const projects = [
  'packages/bridge/python-bridge-runtime',
  'packages/bridge/python-bridge-codegen',
  'packages/bridge/python-bridge',
  'packages/bridge/python-bridge-ml',
]
const result = spawnSync(tsc, ['-b', ...projects], { cwd: monorepo, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log('strict typecheck passed against the monorepo-owned bridge sources')
