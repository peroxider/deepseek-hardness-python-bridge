# Python Capability Bridge — ML 示例

[English](README.md) | 中文

一个可运行的示例：通过 Python Capability Bridge 把一个 Python ML Provider 暴露为 Cordis Service。[`provider.py`](provider.py) 中的 Python 代码仅添加 `dsh_bridge` 装饰器，算法主体完全不变。Codegen 产出一个包装长生命周期 Python 子进程的 TypeScript bridge 包。

## 运行

```sh
# 1. 生成 bridge 包（一次性）。
pnpm dsh-bridge-codegen examples/python-bridge-ml/provider.py \
  --out packages/@my-org/python-bridge-ml \
  --name @my-org/python-bridge-ml

# 2. 启动 dsh 并加载生成的 bridge 包。
pnpm dsh --profile examples/python-bridge-ml
```

## 用到的装饰器

| 装饰器 | 位置 | 作用 |
| --- | --- | --- |
| `@service(name='ml')` | `MLProvider` | 类变成 `ctx.ml`（`Service` 子类）。 |
| `@provide_method(timeout_ms=10_000)` | `MLProvider.embed` | 通过 `bridge.call('embed', { texts })` 转发。 |
| `@provide_method(timeout_ms=5_000, is_concurrency_safe=True)` | `MLProvider.classify` | 同上，并在 TS 端暴露并发安全提示。 |
| `@tool(name='resize_image', …)` | `resize_image` | 对应 `ctx.tools.register(defineTool({...}))`。 |
| `@on('session/event', mode='emit')` | `audit_tool_call` | 桥接到 Python 的 `ctx.on('session/event', …)` 监听器。 |
| `@on('agent/status', mode='emit')` | `observe_status` | 同上，针对 agent 生命周期事件。 |

## 验证

附带的 `provider.py` smoke test 可以在不启动 bridge 的情况下端到端运行该 provider：

```sh
PYTHONPATH=examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

一条命令即可验证装饰器副作用和算法主体。