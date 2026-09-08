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

## 通用插件 vs. codegen：选择你的路径

同一个装饰器模块有两种挂载方式。**先试通用插件**——它无需构建、无需 codegen：

```yaml
- id: ml
  name: '@peroxider/dsh-python-bridge'
  config:
    pythonBin: python
    module: my_ml.provider
    className: MLProvider
```

`initialize` 时通用插件读取运行时 manifest，用装饰器声明的 schema 注册 service、工具与监听器——零 codegen、零 `tsc`。工具 `outputSchema` 与 `parameters` 原样透传；缺少 `additionalProperties` 的 object schema 默认补 `false`（dsh-tools 编译器要求显式声明）。

本指南其余部分走 **codegen** 路径，它产出一个自包含的 TypeScript 包：静态的 per-module 方法类型、由 dataclass 字段映射出的 camelCase Config 键、以及生成式 `static Config` 校验。当你需要可构建的包（例如无法加载 `.ts` 源码的构建版 dsh 安装）或类型化的 TS 表面时再选择它。

| | 通用插件 | codegen |
| --- | --- | --- |
| 包 | `@peroxider/dsh-python-bridge` | 你生成的包 |
| 构建 | 无 | `pnpm dsh-bridge-codegen` + `tsc` |
| 配置 | `module` + `initArgs` + 通用键 | camelCase dataclass 字段键 |
| 类型 | 动态（运行时 manifest） | 静态 per-module TS |

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
    readDenyPaths: ['/etc', '/root/.ssh', '/home/*/.aws']
    modelPath: /opt/models/embeddings.npy
```

`readDenyPaths` 是 `sandbox` 在读侧的搭档。sandbox runner 的 `confine()` 只是**写**白名单，所以在 `workspace-write` 下子进程仍可读取任何父进程可读的宿主路径（运维密钥、`/etc/shadow` 等）；`readDenyPaths` 在子进程内安装一份 Python `sys.addaudithook` 拒绝清单，对匹配规则的 `open` / `os.open` / `os.scandir` / `os.listdir` / `subprocess.Popen` 调用直接拒绝。规则同时匹配该路径**及其整个子树**（`/etc` 覆盖 `/etc/passwd`），无需再写一条 `/etc/*`。请注意 `*` 会跨越路径分隔符，因此 `/home/*/.aws` 比 shell 通配**更宽**，会匹配 `/home/a/b/c/.aws`——建议使用更具体的前缀。读隔离独立于 sandbox 模式，即便在 `danger-full-access` 下同样生效；匹配语义与已知边界见 [`packages/bridge/python-bridge-runtime/README.zh.md`](../../packages/bridge/python-bridge-runtime/README.zh.md#readdenypaths--读侧隔离)。

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
import { PythonBridgeService, type PythonBridge } from '@peroxider/dsh-python-bridge-runtime'

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
| 调用期间子进程退出 | `-32011` | `worker-exit` |
| 解释器缺少 dsh-bridge（spawn 时探测） | `-32012` | `dependency-missing` |

`PythonBridgeError` 携带 wire `kind` 和 `code`，让 tool execute 路径可以按 `packages/core/tools/src/index.ts:343` 转换为 `ToolCallError`。

## 排错

- **spawn 时报 `dependency-missing`（`-32012`）** —— 配置的 `pythonBin` 无法 `import dsh_bridge`；错误信息会指明解释器与模块。用 `pip install dsh-bridge` 安装到该解释器（或把 `pythonBin` 指向正确的解释器）。bridge 在 spawn 前先探测，因此会立即暴露问题，而不是表现为 `worker-exit`。
- **调用后报 `bridge-down`** —— Python 子进程已退出；查看 stderr 的堆栈并确认 `pipDeps` 已安装。注意：bridge 本身永远不会安装 `pipDeps`，运维必须在 `spawn()` 之前把目标解释器准备好（基础镜像、requirements 文件，或在部署阶段 `pip install`）。
- **方法调用返回 `-32601` method not found** —— 确认 `@provide_method` 装饰器位于 `@service` 装饰的类内。
- **正确调用却得到 `-32004` invalid-args** —— TypeScript 端的 JSON Schema 拒绝了输入；检查参数类型并重新运行 codegen。