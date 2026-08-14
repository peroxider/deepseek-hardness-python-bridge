# @deepseek-ai/dsh-python-bridge-codegen

English | [中文](README.zh.md)

AST-based TypeScript generator for the Python Capability Bridge. Reads one or more Python source files, walks `dsh_bridge` decorator calls, and emits a TypeScript bridge package that conforms to [`@deepseek-ai/dsh-python-bridge-runtime`](../python-bridge-runtime/README.md). The generator never executes user source; it only inspects the source text and emits generated artifacts.

## Usage

```sh
pnpm dsh-bridge-codegen src/my_provider.py --out packages/my-org-bridge --name @my-org/bridge
```

The CLI prints diagnostics (decoration errors with file/line) to stderr and exits with code 1 if any are found.

## Generated package

The generator emits:

- `package.json` — Cordis peer dependency + `@deepseek-ai/dsh-python-bridge-runtime` runtime dep.
- `src/index.ts` — `Service` subclass(es) with `static Config` schemastery schema, `apply()` function for tool consumers / listeners.
- `src/diagnostics.ts` — when decoration errors are found.

## Public library

```ts
import { generateBridgePackage, parseModuleSources, pythonTypeToTs } from '@deepseek-ai/dsh-python-bridge-codegen'

const parsed = parseModuleSources([
  { path: 'provider.py', contents: sourceText },
])
const artifacts = generateBridgePackage({
  module: 'my_pkg.provider',
  packageName: '@my-org/bridge',
  sources: [{ path: 'provider.py', contents: sourceText }],
})
```

## Type inference

The codegen mirrors the Python `dsh_bridge._type_inference` subset:

| Python annotation | TypeScript |
| --- | --- |
| `int` / `float` | `number` |
| `bool` | `boolean` |
| `str` | `string` |
| `bytes` | `string` (base64) |
| `list[T]` | `T[]` |
| `dict[str, T]` | `Record<string, T>` |
| `Optional[T]` / `T \| None` | `T \| null` |
| `T \| U` / `Union[T, U]` | `T \| U` |

## Limitations

- **No full Python AST** — the parser is regex-based over the constrained `dsh_bridge` decorator shape. Author-provided decorators with non-keyword arguments are not supported.
- **No `**/*.py` recursive walking** — pass an explicit file list or a directory containing `.py` files.
- **Generated `initArgs` carry plain types** — a future iteration will surface dataclass fields as named config keys.

## Model Experience

None — this package is a build-time tool.

## Known Limitations and Deferred Work

- **Recursive glob walking is unsupported** — pass an explicit file list. A future iteration will add `tinyglobby` (or equivalent) for ergonomic usage.
- **No initArgs ↔ dataclass introspection** — the generator emits a placeholder `initArgs` passthrough today; integration with `python_type_to_json_schema` lands in a follow-up.