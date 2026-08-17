#!/usr/bin/env node
/**
 * Materialize the REAL-source integration harness into `.gen/integration/`.
 *
 * The monorepo at `$DSH_MONOREPO` (default: /home/chad/workspace/deepseek-harness)
 * has no built `lib/` in a fresh clone, so this harness points thin wrapper
 * packages at the real `src/` entries and executes them through Node's
 * `--experimental-transform-types`. Every `@deepseek-ai/*` import in the
 * composition test resolves to genuine monorepo source — cordis, the
 * Loader/Include/Group plugins, schemastery, dsh-tools, and the two bridge
 * packages. Only two externals are needed and both resolve offline:
 * `@standard-schema/spec` (pnpm store) and `js-yaml` (any local install).
 *
 * A `pnpm install` in the monorepo creates workspace symlinks
 * (`vendor/<pkg>/node_modules/@deepseek-ai/<dep>`, `packages/<group>/<pkg>/node_modules/@deepseek-ai/<dep>`)
 * pointing at the vendored/workspace dirs whose package.json `main` is the
 * unbuilt `lib/`. Those shadow the root wrappers and break every bare import
 * from a real source, so this script first unshadows them (removes any such
 * symlink for a REAL_PACKAGES name) and lets Node's upward walk reach the
 * wrappers at `$DSH_MONOREPO/node_modules`.
 *
 * Wrappers are written to two resolution roots:
 *   1. `.gen/integration/node_modules` — app code + explicit test imports
 *   2. `$DSH_MONOREPO/node_modules` — real monorepo sources import each other
 *      by package name; Node resolves those by walking up that tree
 *
 *   node scripts/setup-integration.mjs
 *   node --experimental-transform-types tests/integration/real-composition.mjs
 *
 * Environment:
 *   DSH_MONOREPO        - absolute path of the deepseek-harness checkout
 *   DSH_JS_YAML         - absolute path of a js-yaml install
 *   DSH_STANDARD_SCHEMA - absolute path of an @standard-schema/spec install
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const monorepo = process.env.DSH_MONOREPO ?? '/home/chad/workspace/deepseek-harness'
const jsYaml = process.env.DSH_JS_YAML
  ?? '/home/chad/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/js-yaml'
const standardSchema = process.env.DSH_STANDARD_SCHEMA
  ?? '/tmp/dsh-externals/node_modules/@standard-schema/spec'
const zod = process.env.DSH_ZOD
  ?? '/home/chad/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/zod'
const out = join(root, '.gen/integration')

if (!existsSync(join(monorepo, 'vendor/cordis/src/index.ts'))) {
  console.error(`monorepo not found at ${monorepo}; set DSH_MONOREPO`)
  process.exit(1)
}
if (!existsSync(join(standardSchema, 'package.json'))) {
  console.error(`@standard-schema/spec not found at ${standardSchema}; set DSH_STANDARD_SCHEMA`)
  process.exit(1)
}
if (!existsSync(join(jsYaml, 'package.json'))) {
  console.error(`js-yaml not found at ${jsYaml}; set DSH_JS_YAML`)
  process.exit(1)
}

/** name → absolute entry file (real monorepo source). */
const REAL_PACKAGES = {
  '@deepseek-ai/cordis': `${monorepo}/vendor/cordis/src/index.ts`,
  '@deepseek-ai/cordis-plugin-loader': `${monorepo}/vendor/loader/src/index.ts`,
  '@deepseek-ai/cordis-plugin-include': `${monorepo}/vendor/include/src/index.ts`,
  '@deepseek-ai/cordis-plugin-group': `${monorepo}/vendor/group/src/index.ts`,
  '@deepseek-ai/schemastery': `${monorepo}/vendor/schemastery/src/index.ts`,
  '@deepseek-ai/cosmokit': `${monorepo}/vendor/cosmokit/src/index.ts`,
  '@deepseek-ai/dsh-sdk-protocol': `${monorepo}/packages/sdk/protocol/src/index.ts`,
  '@deepseek-ai/dsh-subprocess': `${monorepo}/packages/subprocess/subprocess/src/index.ts`,
  '@deepseek-ai/dsh-sandbox': `${monorepo}/packages/sandbox/sandbox/src/index.ts`,
  '@deepseek-ai/dsh-tools': `${monorepo}/packages/core/tools/src/index.ts`,
  '@deepseek-ai/dsh-system-prompt': `${monorepo}/packages/core/system-prompt/src/index.ts`,
  '@deepseek-ai/dsh-scope': `${monorepo}/packages/core/scope/src/index.ts`,
  '@deepseek-ai/dsh-llm': `${monorepo}/packages/llm/llm/src/index.ts`,
  '@deepseek-ai/dsh-session': `${monorepo}/packages/core/session/src/index.ts`,
  '@deepseek-ai/dsh-timeout': `${monorepo}/packages/util/timeout/src/index.ts`,
  '@deepseek-ai/dsh-invariants': `${monorepo}/packages/runtime-diagnostics/invariants/src/index.ts`,
  '@deepseek-ai/dsh-python-bridge-runtime': `${monorepo}/packages/bridge/python-bridge-runtime/src/index.ts`,
  '@deepseek-ai/dsh-python-bridge': `${monorepo}/packages/bridge/python-bridge/src/index.ts`,
  '@deepseek-ai/dsh-python-bridge-codegen': `${monorepo}/packages/bridge/python-bridge-codegen/src/index.ts`,
}

/** Packages whose default export the wrappers must re-export. */
const HAS_DEFAULT = new Set([
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-python-bridge-runtime',
  '@deepseek-ai/dsh-python-bridge',
])

/** Type-only peers of the closure: value imports never reach these. */
const TYPE_ONLY_STUBS = [
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-code-runtime',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-subagent',
]

/**
 * Remove pnpm workspace symlinks that would shadow the root wrappers.
 * A `pnpm install` in the monorepo creates `node_modules/@deepseek-ai/<name>`
 * symlinks under every workspace package; those point at the vendored/workspace
 * dirs whose package.json `main` is the unbuilt `lib/`. Deleting every such
 * symlink for a REAL_PACKAGES name under the `vendor/` and `packages/` trees
 * lets Node's upward walk resolve those bare imports to the wrappers written
 * at `$DSH_MONOREPO/node_modules`.
 */
function unshadowMonorepo(monorepo) {
  let removed = 0
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const nm = join(dir, 'node_modules', '@deepseek-ai')
    if (existsSync(nm)) {
      for (const name of readdirSync(nm)) {
        const scoped = `@deepseek-ai/${name}`
        if (scoped in REAL_PACKAGES) {
          rmSync(join(nm, name), { recursive: true, force: true })
          removed++
        }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
      visit(join(dir, entry.name))
    }
  }
  for (const area of ['vendor', 'packages']) {
    const tree = join(monorepo, area)
    if (existsSync(tree)) visit(tree)
  }
  if (removed > 0) console.log(`unshadowed ${removed} pnpm workspace symlink(s) under ${monorepo}/vendor, /packages`)
}

function writeWrapper(baseModules, name, targetEntry) {
  const dir = join(baseModules, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0-real-src',
    type: 'module',
    main: './index.mjs',
    exports: { '.': './index.mjs', './package.json': './package.json' },
  }, null, 2) + '\n')
  const defaultLine = HAS_DEFAULT.has(name) ? `export { default } from '${targetEntry}'\n` : ''
  writeFileSync(join(dir, 'index.mjs'), `export * from '${targetEntry}'\n${defaultLine}`)
}

function writeExternalLink(baseModules, name, target) {
  const dir = join(baseModules, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dirname(dir), { recursive: true })
  try {
    symlinkSync(target, dir, 'dir')
  } catch {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, version: '0.0.0-link', type: 'module',
      main: join(target, 'index.js'),
      exports: { '.': join(target, 'index.js') },
    }, null, 2) + '\n')
  }
}

/** Write the complete wrapper set into one `node_modules` root. */
function populateNodeModules(baseModules) {
  for (const [name, entry] of Object.entries(REAL_PACKAGES)) {
    if (!existsSync(entry)) {
      console.error(`missing real source: ${entry}`)
      process.exit(1)
    }
    writeWrapper(baseModules, name, entry)
  }
  for (const name of TYPE_ONLY_STUBS) {
    const dir = join(baseModules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, version: '0.0.0-stub', type: 'module', main: './index.mjs',
      exports: { '.': './index.mjs' },
    }, null, 2) + '\n')
    writeFileSync(join(dir, 'index.mjs'), 'export {}\n')
  }
  writeExternalLink(baseModules, '@standard-schema/spec', standardSchema)
  writeExternalLink(baseModules, 'zod', zod)
  writeExternalLink(baseModules, 'js-yaml', jsYaml)
}

// Neutralize pnpm workspace symlinks before writing wrappers, so real sources
// resolve their bare imports to the root wrappers (see unshadowMonorepo).
unshadowMonorepo(monorepo)

// 1. The harness root: app code and explicit test imports resolve here.
populateNodeModules(join(out, 'node_modules'))

// 2. The monorepo root: real sources import one another by package name.
populateNodeModules(join(monorepo, 'node_modules'))

console.log(`integration harness ready at ${out}`)
console.log(`  monorepo node_modules: ${join(monorepo, 'node_modules')}`)
console.log(`  js-yaml: ${jsYaml}`)
console.log(`  @standard-schema/spec: ${standardSchema}`)
