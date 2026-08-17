# dsh-bridge

English | [中文](README.zh.md)

Python decorator library and runtime that exposes a Python module as a Cordis Service Provider, Tool Consumer, Event Listener, or capability seam Provider through the DeepSeek Harness Python Capability Bridge. Decorators are zero-side-effect at import time; the runtime is `python -u -m dsh_bridge.runtime <module>` and serves newline-delimited JSON-RPC 2.0 over stdio (matching `@deepseek-ai/dsh-sdk-protocol` `JsonRpcLineTransport`).

## Installation

```sh
pip install dsh-bridge
```

## Decorators

| Decorator | Purpose |
| --- | --- |
| `@service(name, settings_namespace=None)` | Class decorator; marks a class as a `ctx.<name>` Service Provider |
| `@provide_method(timeout_ms=None, is_concurrency_safe=None)` | Method decorator inside `@service`; each decorated method becomes a public TS method |
| `@tool(name, description, parameters, output_schema=None, timeout_ms=None)` | Function decorator; becomes `ctx.tools.register(defineTool({...}))` |
| `@on(event_name, mode='emit', prepend=False, global_=False)` | Function decorator; becomes `ctx.on(...)` |
| `@capability(seam, backend)` | Class decorator; replaces a capability seam provider |
| `@method(name=None)` | Method decorator inside `@capability` |
| `@system_prompt_section(order, text)` | Function decorator; registers a prompt section |
| `@guard()` | Function decorator; registers as a tool guard |
| `@restrict_tools(allow=None, deny=None)` | Method decorator; per-agent tool restriction |

Each decorator returns the original callable (or class) unchanged — Python business code is unmodified at runtime.

## Runtime

```sh
python -u -m dsh_bridge.runtime <module.path> [--class <ClassName>] [--function <func>]...
```

The runtime walks the bridge registry and dispatches JSON-RPC requests to the matching Python callables. Errors map to the JSON-RPC error vocabulary in `dsh_bridge._errors` (`-32001`/`timeout`, `-32003`/`permission`, etc.).

### Runtime manifest

The `initialize` handshake returns `serverInfo` plus a `manifest` carrying every dynamically registered surface with the metadata a host needs to build the plugin without codegen. The client sends `clientInfo: { name, version }`; a client whose major version differs from the runtime's `serverInfo.version` is rejected with a `protocol-mismatch` error (wire version negotiation).

- `tools[]` — `name`, `description`, `parameters` (JSON Schema), `outputSchema`
- `provideMethods[]` — `name`, `timeoutMs`, `concurrencySafe`, `parameters` (PEP 484 annotation strings), `return`
- `services[]` — `name`, `class`, `initFields` (dataclass field name/annotation/default)
- `listeners[]` — `event`, `mode`, `prepend`, `global`, `function`

The full schema is documented in [`skill/dsh-python-plugin/references/manifest.md`](../../skill/dsh-python-plugin/references/manifest.md) in the bridge repository.

## Test

```sh
pip install -e .[test]
pytest
```

## License

MIT.