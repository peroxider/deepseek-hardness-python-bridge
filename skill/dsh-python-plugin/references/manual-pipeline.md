# Manual pipeline (without the installer)

Use when `scripts/install-python-plugin.py` cannot run (missing tsc, missing dsh install, or you need a custom layout). Each stage lists its exact inputs and outputs so partial automation stays possible.

## 0. Generic path (zero-build, default)

When the dsh install can resolve `@peroxider/dsh-python-bridge` and the runtime (source launch, or an install that ships them), the pipeline collapses to one `cordis.patch.yml` entry — no codegen, no build:

```yaml
- insert:
  - id: python-bridge
    name: '@peroxider/dsh-python-bridge-runtime'
  - id: <short>
    name: '@peroxider/dsh-python-bridge'
    config:
      pythonBin: python3
      module: <pkg>_dsh.bridge
      pythonPath: [/abs/path/to/python/src]
      initArgs:
        <snake_case_field>: value
```

The generic plugin reads the runtime manifest on `initialize` and registers the decorated service, tools, and listeners with the decorator schemas; `pythonPath` supplies import roots so business source can stay put. Skip ahead to [5. verify](#5-verify). The codegen stages below produce the self-contained built package for installs that cannot resolve the bridge packages as source.

## 1. codegen — Python source → TS package

```sh
node --experimental-transform-types --no-warnings \
  <bridge-repo>/scripts/run-codegen.mjs \
  /abs/path/to/bridge.py \
  --out <out-dir> --name '@my-org/<short>-bridge' --module '<pkg>_dsh.bridge'
```

Output: `<out-dir>/package.json` + `<out-dir>/src/index.ts` (+ `src/diagnostics.ts` when the parser found problems — always check).

## 2. build — TS → JS

A built dsh install cannot load `.ts` source. Transpile three packages with any tsc 6.x:

```sh
TSC=<path-to-tsc>
$TSC --ignoreConfig <pkg>/src/index.ts --outDir <pkg>/lib \
  --module esnext --target es2024 --moduleResolution bundler --skipLibCheck \
  --rewriteRelativeImportExtensions --declaration false --sourceMap false
```

Packages: the generated one, plus `packages/bridge/python-bridge-runtime` (bridge repo) and `packages/sdk/protocol` (monorepo) — the dsh install ships neither. Copy each `package.json` next to its `lib/`. Type-resolution diagnostics from missing `@types/*` are harmless here; strict checking belongs to the verification suite.

## 3. assemble — the self-contained plugin directory

```
<plugin>/
  dsh_bridge/          # from <bridge-repo>/python/sdk-dsl/src/
  <your packages>/     # from your --python-src roots
  <short>-bridge/      # generated package: package.json + lib/index.js
  node_modules/@deepseek-ai/
    dsh-python-bridge-runtime/   # built in step 2
    dsh-sdk-protocol/            # built in step 2
    cordis, schemastery, dsh-tools, dsh-session, dsh-subprocess,
    dsh-invariants, dsh-llm, dsh-scope, dsh-system-prompt, dsh-timeout,
    cosmokit, …                  # links into the dsh install
```

Rules that make it work:

- The Python child spawns with `cwd = <plugin>`; every imported Python package must sit at the plugin root.
- Link dependencies from `<npm root -g>/@deepseek-ai/dsh/node_modules/@deepseek-ai`; linked packages resolve their own deps inside that tree. Copy instead when symlinks are denied.
- Copy `package.json` beside every built `lib/` so `main: lib/index.js` resolves.

## 4. patch — cordis.patch.yml

Append an insert entry to `~/.dsh/profiles/<profile>/cordis.patch.yml` (a YAML array; preserve existing entries):

```yaml
- insert:
  - id: python-bridge
    name: 'file://<plugin>/node_modules/@peroxider/dsh-python-bridge-runtime/lib/index.js'
  - id: <short>
    name: 'file://<plugin>/<short>-bridge/lib/index.js'
    config:
      pythonBin: python3
      module: <pkg>_dsh.bridge
      cwd: <plugin>
      # …config keys matching the dataclass fields, camelCase…
```

Notes:

- Entry `name` must point at built JS via a `file://` URL.
- Re-running: replace entries with the same ids instead of appending duplicates.
- The patch-layer watcher hot-applies new entries; rebuilt artifacts require restarting `dsh web`.

## 5. verify

```sh
cd <plugin> && python3 -c "import <pkg>_dsh.bridge"   # import smoke
ps aux | grep dsh_bridge.runtime                     # child alive
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080
```
