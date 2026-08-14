# DeepSeek Harness — Python Capability Bridge

[English](README.md) | 中文

> **将任意 Python 模块/代码库转化为 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 可用的插件。**
>
> 本仓库把现有 Python 代码 —— ML 流水线、NumPy/SciPy/pandas/PyTorch/scikit-learn 算法、图像工具、自定义 provider —— 转化为一等公民的 dsh 插件：agent harness 可以从 `cordis.yml` 加载它、把它作为 Cordis service 注入、把它注册为模型可见的工具、并把它接入事件监听与 capability seam。

## 它做什么

DeepSeek Harness 的插件面是纯 TypeScript 的。本 bridge 是把 Python 代码库变成 dsh 原生插件的通道：

| Python 侧 | 在 deepseek-harness 中变成 |
| --- | --- |
| `@service` 装饰的类 | 其他插件可 `inject` 的 `ctx.<name>` Cordis Service |
| `@tool` 装饰的函数 | 模型可见的工具（`ctx.tools.register(defineTool(...))`） |
| `@on` 装饰的函数 | 类型化事件监听器（`ctx.on('agent/*' \| 'tools/*' \| 'session/event' \| ...)`） |
| `@capability` 装饰的类 | capability seam 的替换 provider（`ctx.fs`、`ctx.shell`、`ctx.subprocess` 等） |
| `@system_prompt_section` | 对 agent system prompt 的贡献 |
| `@guard()` / `@restrict_tools()` | 工具策略钩子 |

**Python 业务代码零改动** —— 只加装饰器注解与类型签名。Codegen 步骤产出一个 TypeScript bridge 包，它派生一个长生命周期的 Python 子进程，并通过 stdio 上的换行符分隔 JSON-RPC 2.0 协议转发装饰过的方法。生成的插件与 dsh 组合中的任何 TypeScript 插件一样，获得相同的沙箱、环境清洗、审批流、会话日志与持久化。

## 仓库结构

```
python/sdk-dsl/                          dsh-bridge PyPI 包：装饰器 + 运行时
  src/dsh_bridge/__init__.py               9 个零副作用装饰器
  src/dsh_bridge/runtime.py                python -u -m dsh_bridge.runtime <module> 入口
  src/dsh_bridge/_type_inference.py        PEP 484 → JSON Schema 推断
  src/dsh_bridge/_errors.py                异常 → JSON-RPC code/kind 词典
  tests/                                   pytest：单元 + 真实子进程集成（43 个测试）
packages/bridge/
  python-bridge-runtime/                 @deepseek-ai/dsh-python-bridge-runtime
    src/index.ts                           PythonBridgeService（ctx.pythonBridge）+ PythonBridge 客户端
    tests/                                 vitest：传输、错误映射、重连
  python-bridge-codegen/                 @deepseek-ai/dsh-python-bridge-codegen
    src/index.ts                           基于 AST 的 TS 生成器（parseModuleSources / generateBridgePackage）
    bin/dsh-bridge-codegen.js              CLI 入口
    tests/                                 vitest：解析器、类型投影、输出
examples/python-bridge-ml/               可运行的 Service Provider + tool + listener 快照
docs/cookbook/adding-a-python-bridge.md  用户逐步指南（中英双语）
docs/subsystems/python-bridge.md         子系统参考页（中英双语）
.agents/notes/implemented/feature/       记录已交付设计的 Agent Note
```

## 快速开始

从 Python 代码库到被加载的 dsh 插件，只需三步：

### 1. 编写 Python 模块

```python
from dataclasses import dataclass
from dsh_bridge import provide_method, service, tool, on


@service(name="ml")
@dataclass
class MLProvider:
    model_path: str

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] * 768 for _ in texts]


@tool(name="shout", description="Upper-case a string.",
      parameters={"text": {"type": "string"}})
def shout(text: str) -> dict:
    return {"text": text.upper()}


@on("session/event", mode="emit")
def audit(event: str, payload: dict) -> None:
    ...
```

装饰器原样返回被装饰的可调用对象 —— 未挂载 bridge 时业务代码完全不变。

### 2. 生成 TypeScript bridge 包

```sh
pnpm dsh-bridge-codegen src/my_ml/provider.py \
  --out packages/@my-org/python-bridge-ml \
  --name @my-org/python-bridge-ml
```

### 3. 在 `cordis.yml` 中接线

```yaml
- id: ml
  name: '@my-org/python-bridge-ml'
  config:
    pythonBin: python
    module: my_ml.provider
    className: MLProvider
    sandbox: workspace-write
    modelPath: /opt/models/embeddings.npy
```

## 装饰器

| 装饰器 | codegen 目标 |
| --- | --- |
| `@service(name, settings_namespace=None)` | `class XxxService extends Service` |
| `@provide_method(timeout_ms=None, is_concurrency_safe=None)` | 转发到 `bridge.call` 的 TS 方法 |
| `@tool(name, description, parameters, …)` | `ctx.tools.register(defineTool({…}))` |
| `@on(event, mode='emit', prepend=False, global_=False)` | `ctx.on(event, handler, { mode, prepend, global })` |
| `@capability(seam, backend)` | `ctx.<seam>.backend.register(backend, impl)` |
| `@method(name=None)` | capability backend 方法 |
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

## 测试

```sh
# Python：43 个测试（装饰器、类型推断、运行时、真实子进程集成）
cd python/sdk-dsl && PYTHONPATH=src python3 -m pytest tests/

# 示例 smoke test（无需 bridge）
PYTHONPATH=examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

## 非目标

- **不内嵌 CPython**（Pyodide / pyo3）—— 所有执行都在独立的 Python 子进程中。
- **不替代 Code Mode 计划中的 Python 后端** —— 二者互补而非竞争。
- **不共享方法调用之外的双向状态** —— bridge 是消息传递而非共享内存。
- **不重新实现 Python 版 Cordis** —— Python 模块挂载到 dsh 现有的 Cordis 上下文。

## 许可证

MIT。