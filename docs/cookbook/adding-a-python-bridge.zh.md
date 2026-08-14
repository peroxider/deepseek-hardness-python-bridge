# 添加 Python Capability Bridge

[English](adding-a-python-bridge.md) | 中文

本指南演示如何创建一个 Python 模块，并通过 Python Capability Bridge 将其暴露为 Cordis Service / Event listener / capability Provider。完成后你将拥有：

1. 一个带有 `dsh_bridge` 装饰器的 Python 模块。
2. 一个由 codegen 生成的 TypeScript bridge 包。
3. 一个把 bridge 挂载为 plugin 的 `cordis.yml` 条目。

## 前置条件

- Python 3.10+，并已安装 `dsh-bridge`（`pip install dsh-bridge`）。
- 已 `pnpm install` 的 `deepseek-harness` 工作区。
- `pythonBin` 指向正确的解释器。

## 1. 编写 Python 模块

通过装饰类把它暴露为 Cordis Service Provider：

```python
# my_ml/provider.py
from dataclasses import dataclass
from dsh_bridge import provide_method, service


@service(name="ml")
@dataclass
class MLProvider:
    model_path: str

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] * 768 for _ in texts]
```

每个 `@provide_method` 都会成为生成出的 `MlService` 类上的公共 TypeScript 方法。

为工具、监听器和 capability provider 装饰函数：

```python
from dsh_bridge import on, tool


@tool(
    name="resize_image",
    description="Resize an image to the given dimensions.",
    parameters={"input_path": {"type": "string", "required": True}},
)
def resize_image(input_path: str, width: int, height: int) -> dict:
    return {"output_path": input_path, "bytes_written": 0}


@on("session/event", mode="emit")
def audit_tool_call(event: str, payload: dict) -> None:
    if payload.get("type") == "tool/call":
        print("audit:", payload)
```

业务代码保持不变；新增的只有装饰器和类型注解。

## 2. 生成 bridge 包

针对你的 Python 源码运行 codegen：

```sh
pnpm dsh-bridge-codegen src/my_ml/provider.py \
  --out packages/@my-org/python-bridge-ml \
  --name @my-org/python-bridge-ml
```

生成包包含：

- `package.json` —— Cordis peer 依赖 + 运行时依赖。
- `src/index.ts` —— `MlService` 类，带 `static Config` schema 和 `apply()`（用于工具/监听器）。

## 3. 在 `cordis.yml` 中接线

```yaml
- id: ml
  name: '@my-org/python-bridge-ml'
  config:
    pythonBin: python
    module: my_ml.provider
    className: MLProvider
    pipDeps: ['numpy>=1.26']
    sandbox: workspace-write
    modelPath: /opt/models/embeddings.npy
```

启动 dsh：

```sh
pnpm dsh --profile path/to/cordis.yml
```

## 4. 验证

Python 侧提供了一个 smoke test 入口，可在不启动 bridge 的情况下端到端验证装饰器和算法主体：

```sh
PYTHONPATH=src:examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

它会打印 bridge registry 内容并调用一个方法以验证整体接线。

## 生成出的 TS 包长什么样

```ts
// auto-generated python-bridge-ml/src/index.ts
import { Context, Service, z } from '@deepseek-ai/cordis'
import { PythonBridgeService, type PythonBridge } from '@deepseek-ai/dsh-python-bridge-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context { pythonBridge: PythonBridgeService }
}

export interface MlConfig {
  pythonBin?: string
  module: string
  className?: string
  pipDeps?: string[]
  cwd?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  graceMs?: number
  modelPath: string
}

export class MlService extends Service {
  static inject = ['pythonBridge']
  static Config: z<MlConfig> = z.object({ /* ... */ })

  private bridge: PythonBridge

  constructor(ctx: Context, config: MlConfig) {
    super(ctx, 'ml')
    this.bridge = ctx.pythonBridge.spawn({
      module: config.module,
      className: config.className,
      initArgs: { model_path: config.modelPath },
      sandbox: config.sandbox,
      graceMs: config.graceMs,
    })
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.bridge.call('embed', { texts }) as Promise<number[][]>
  }
}

export default MlService
```

## 装饰器速查

| 装饰器 | codegen 目标 |
| --- | --- |
| `@service(name, settings_namespace=None)` | `class XxxService extends Service` |
| `@provide_method(timeout_ms=None, is_concurrency_safe=None)` | 转发到 `bridge.call` 的 TS 方法 |
| `@tool(name, description, parameters, …)` | `ctx.tools.register(defineTool({…}))` |
| `@on(event, mode='emit', prepend=False, global_=False)` | `ctx.on(event, handler, { mode, prepend, global })` |
| `@capability(seam, backend)` | `ctx.<seam>.backend.register(backend, backendImpl)` |
| `@method(name=None)` | Backend 方法 |
| `@system_prompt_section(order, text)` | `ctx.systemPrompt.section({ order, text })` |
| `@guard()` | `ctx.tools.guard(fn)` |
| `@restrict_tools(allow=None, deny=None)` | `ctx.tools.restrict({ allow, deny })` |

## 错误映射

| Python 异常 | JSON-RPC `code` | `data.kind` |
| --- | --- | --- |
| `TimeoutError` | `-32001` | `timeout` |
| `asyncio.CancelledError` | `-32002` | `abort` |
| `PermissionError` | `-32003` | `permission` |
| `ValueError` | `-32004` | `invalid-args` |
| `KeyError` / `AttributeError` | `-32005` | `not-found` |
| `ConnectionError` | `-32010` | `bridge-down` |
| 其它 | `-32603` | `exception` |

`PythonBridgeError` 携带 wire `kind` 和 `code`，让 tool execute 路径可以按 `packages/core/tools/src/index.ts:343` 转换为 `ToolCallError`。

## 排错

- **调用后报 `bridge-down`** —— Python 子进程已退出；查看 stderr 的堆栈并确认 `pipDeps` 已安装。
- **方法调用返回 `-32601` method not found** —— 确认 `@provide_method` 装饰器位于 `@service` 装饰的类内。
- **正确调用却得到 `-32004` invalid-args** —— TypeScript 端的 JSON Schema 拒绝了输入；检查参数类型并重新运行 codegen。