# Python Capability Bridge — ML Example

English | [中文](README.zh.md)

A runnable example that exposes a Python ML provider as a Cordis Service through the Python Capability Bridge. The Python code in [`provider.py`](provider.py) carries only `dsh_bridge` decorators — the algorithm bodies are unchanged. Codegen produces a TypeScript bridge package that wraps the long-lived Python child process.

## Run

```sh
# 1. Generate the bridge package (one-time).
pnpm dsh-bridge-codegen examples/python-bridge-ml/provider.py \
  --out packages/@my-org/python-bridge-ml \
  --name @my-org/python-bridge-ml

# 2. Boot dsh with the generated bridge package loaded.
pnpm dsh --profile examples/python-bridge-ml
```

## Decorators in use

| Decorator | Where | Effect |
| --- | --- | --- |
| `@service(name='ml')` | `MLProvider` | Class becomes `ctx.ml` (a `Service` subclass). |
| `@provide_method(timeout_ms=10_000)` | `MLProvider.embed` | Forwarded as `bridge.call('embed', { texts })`. |
| `@provide_method(timeout_ms=5_000, is_concurrency_safe=True)` | `MLProvider.classify` | Same, with the concurrency-safe advisory surfaced in TS. |
| `@tool(name='resize_image', …)` | `resize_image` | `ctx.tools.register(defineTool({...}))` against the function. |
| `@on('session/event', mode='emit')` | `audit_tool_call` | `ctx.on('session/event', …)` listener bridged to Python. |
| `@on('agent/status', mode='emit')` | `observe_status` | Same, for agent lifecycle events. |

## Verification

The bundled `provider.py` smoke-test runs the provider end-to-end without any bridge:

```sh
PYTHONPATH=examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

This validates the decorator side effects and the algorithm bodies in a single command.