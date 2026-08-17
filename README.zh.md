# DeepSeek Harness — Python Capability Bridge

[English](README.md) | 中文

🌐 **[在线站点 →](https://peroxider.github.io/deepseek-hardness-python-bridge/)** — 面向发现的产品页（hero、装饰器参考、架构图、验证、路线图）。

> **将 Python 模块转化为 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 可用的插件。**
>
> 本仓库把现有 Python 代码 —— ML 流水线、NumPy/SciPy/pandas/PyTorch/scikit-learn 算法、图像工具、自定义 provider —— 转化为一等公民的 dsh 插件：agent harness 可以从 `cordis.yml` 加载它、把它作为 Cordis service 注入、把它注册为模型可见的工具、并把它接入事件监听与 capability seam。
>
> **已对真实 deepseek-harness 完成端到端验证**：测试用 `cordis.yml` 经真实 Cordis Loader 启动，真实 schemastery 校验 Config、真实 `ToolRuntime` 注册工具、真实事件系统转发，驱动真实 Python 子进程；bridge 包与生成的示例包在 monorepo 严格 `tsc -b` 下零错误通过。具体覆盖范围与剩余限制见[验证状态](#验证状态)。

**能力转化，而非重新实现。** bridge 是从 *Python 能力* 到 *dsh 插件* 的转化通道：算法、库与状态留在 Python 侧——harness 看到的是一个原生 TypeScript 插件。下面的[能力对照表](#它做什么)就是映射关系：每个 `@dsh_bridge` 装饰器把一种 Python 能力面转化为一种 dsh 插件面。

## 文档

两份使用指南从不同的操作者视角覆盖同一工作流，均为中英双语：

| 指南 | 操作者 | 路径 |
| --- | --- | --- |
| **🌐 [在线站点](https://peroxider.github.io/deepseek-hardness-python-bridge/)** | 浏览项目的任何人 | 由 `.github/workflows/pages.yml` 从 `site/` 部署 |
| 人类工程师指南 | 坐在终端前的人 | [`docs/guides/human-engineer.zh.md`](docs/guides/human-engineer.zh.md) |
| Agent 友好型指南 | AI 编码 Agent（使用 `dsh-python-plugin` skill） | [`docs/guides/agent-friendly.zh.md`](docs/guides/agent-friendly.zh.md) |
| 逐步教程 cookbook | 两者（完整走查） | [`docs/cookbook/adding-a-python-bridge.zh.md`](docs/cookbook/adding-a-python-bridge.zh.md) |
| 线协议稳定性 | Runtime 与集成维护者 | [`docs/protocol.zh.md`](docs/protocol.zh.md) |
| 标准 skill | 支持加载 skill 的 Agent 运行时 | [`skill/dsh-python-plugin/SKILL.md`](skill/dsh-python-plugin/SKILL.md) |

## 它做什么

DeepSeek Harness 的插件面是纯 TypeScript 的。本 bridge 是把 Python 模块变成 dsh 原生插件的通道：

| Python 侧 | 在 deepseek-harness 中变成 |
| --- | --- |
| `@service` 装饰的类 | 其他插件可 `inject` 的 `ctx.<name>` Cordis Service |
| `@tool` 装饰的函数 | 模型可见的工具（`ctx.tools.register(defineTool(...))`） |
| `@on` 装饰的函数 | 类型化事件监听器（`ctx.on('agent/*' \| 'tools/*' \| 'session/event' \| ...)`） |
| `@capability` 装饰的类 | capability seam 的替换 provider（`ctx.fs`、`ctx.shell`、`ctx.subprocess` 等） |
| `@system_prompt_section` | 对 agent system prompt 的贡献 |
| `@guard()` / `@restrict_tools()` | 工具策略钩子 |

**Python 业务代码零改动** —— 只加装饰器注解与类型签名。Codegen 步骤产出一个 TypeScript bridge 包，它派生一个长生命周期的 Python 子进程，并通过 stdio 上的换行符分隔 JSON-RPC 2.0 协议转发装饰过的方法。生成的插件与 dsh 组合中的任何 TypeScript 插件一样，获得相同的沙箱、环境清洗、审批流、会话日志与持久化。

## 验证状态

本仓库的前提由四层验证支撑，均可通过 `node scripts/verify.mjs` 离线复现：

1. **Python 套件** —— 49 个 pytest，覆盖装饰器、PEP 484 类型推断、JSON-RPC 运行时、版本协商，以及真实子进程 stdio 集成。
2. **离线 TypeScript E2E** —— 纯 Node 断言（无需安装依赖），覆盖 codegen 发射（55+ 断言）、运行时生命周期（worker-exit、重连、关停阶梯、环境清洗）、真实 `python3` 子进程往返、挂载在 stub Cordis context 上的通用插件，以及挂载在相同 stub 上的生成包。
3. **REAL-composition** —— 测试用 `cordis.yml` 经真实 vendored Cordis Loader（`vendor/loader` + `vendor/include`）启动：真实 schemastery 应用生成的 `static Config`，真实 `ToolRuntime` 持有注册的工具，真实 `ctx.emit('session/event')` 到达 Python 监听器，`ctx.fiber.dispose()` 通过 effect disposer 拆毁子进程。通用插件与 codegen 两条路径都驱动同一个外部 LKB 示例经真实 ToolRuntime 端到端跑通。
4. **严格类型检查** —— `tsc -b`（typescript 6.0.3，monorepo `tsconfig.base.json` 标志：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）覆盖三个 bridge 包和生成的示例包，在 monorepo project-reference 图中零错误。

如实陈述的剩余限制：

- **"任意 Python 模块"指受约束的装饰器形状** —— 关键字参数装饰器加一个前置位置名（`@service(name='ml', ...)`）。全限定调用（`@dsh_bridge.service(...)`）、导入别名（`from dsh_bridge import service as svc`）、非关键字参数会被基于正则的解析器**静默忽略**。每个模块只发射第一个 `@service` 类；非 dataclass 的 `__init__` 参数不做自省。
- **`@capability` / `@guard` / `@restrict_tools` / `@system_prompt_section` 只解析不发射** —— 暂不产生生成代码。
- **`packages/bridge/*/tests/` 下的 vitest 套件尚未在本环境运行**（vitest 自身依赖闭包离线不可得）；其断言已由 `tests/e2e/` 下的纯 Node 脚本镜像，并在 monorepo 内真实运行。
- **monorepo 集成已验证但尚未合并** —— deepseek-harness 检出中留有验证产生的未提交工作区改动（bridge 包副本与 `tsconfig.base.json` 的 paths 注册）。

## 仓库结构

```
python/sdk-dsl/                          dsh-bridge PyPI 包：装饰器 + 运行时
  src/dsh_bridge/__init__.py               9 个零副作用装饰器
  src/dsh_bridge/runtime.py                python -u -m dsh_bridge.runtime <module> 入口
  src/dsh_bridge/_type_inference.py        PEP 484 → JSON Schema 推断
  src/dsh_bridge/_errors.py                异常 → JSON-RPC code/kind 词典
  tests/                                   pytest：单元 + 真实子进程集成（49 个测试）
packages/bridge/
  python-bridge-runtime/                 @deepseek-ai/dsh-python-bridge-runtime
    src/index.ts                           PythonBridgeService（ctx.pythonBridge）+ PythonBridge 客户端
    tests/                                 vitest：传输、错误映射、重连
  python-bridge/                        @deepseek-ai/dsh-python-bridge
    src/index.ts                           通用 manifest 驱动插件（PythonModulePlugin）
  python-bridge-codegen/                 @deepseek-ai/dsh-python-bridge-codegen
    src/index.ts                           基于 AST 的 TS 生成器（parseModuleSources / generateBridgePackage）
    bin/dsh-bridge-codegen.js              CLI 入口
    tests/                                 vitest：解析器、类型投影、输出
examples/python-bridge-ml/               可运行的 Service Provider + tool + listener 快照
docs/cookbook/adding-a-python-bridge.md  用户逐步指南（中英双语）
docs/guides/human-engineer.md            人类工程师使用指南（中英双语）
docs/guides/agent-friendly.md            Agent 友好型使用指南（中英双语）
skill/dsh-python-plugin/SKILL.md         驱动转化工作流的标准 skill
tests/stubs/                             独立开发用 @deepseek-ai/* stub（离线解析）
tests/e2e/                               离线端到端检查（真实 Python 子进程）
scripts/setup-stubs.mjs                  将 stub 物化到 node_modules/
scripts/verify.mjs                       一键离线验证
.agents/notes/implemented/feature/       记录已交付设计的 Agent Note
```

## 通用插件 vs. codegen

同一个装饰器模块有两种加载方式——**通用插件**是默认路径，无需构建；**codegen** 是面向静态类型的高级路径：

| | 通用插件（默认） | codegen（高级） |
| --- | --- | --- |
| 包 | `@deepseek-ai/dsh-python-bridge` | `@deepseek-ai/dsh-python-bridge-codegen` |
| 构建 | 无——一行 `cordis.yml` 条目 | 生成 TS 包，再 `tsc` 构建 |
| 类型 | 动态——表面在运行时按 manifest 注册 | 静态——per-module TS 接口 + schemastery Config |
| 配置 | `module` + `initArgs` + 通用键（`pythonBin`、`sandbox`、`pythonPath` 等） | 由 dataclass 字段映射出的 per-module camelCase 键 |
| 工具 schema | 运行时原样应用装饰器里的 JSON Schema | 相同 schema 被发射进 `defineTool(...)` |
| 适用 | 零构建集成、Python-first 模块、快速迭代 | 需要类型化 TS 表面与生成式配置校验的团队 |

先上通用插件；需要静态 per-module 类型与可构建的包时再转向 codegen。

## 快速开始

### 0. 通用插件快速开始（零构建）

当组合加载了 `@deepseek-ai/dsh-python-bridge-runtime` 时，一行 `cordis.yml` 条目就是完整集成——无需 codegen、无需构建：

```yaml
- id: lkb
  name: '@deepseek-ai/dsh-python-bridge'
  config:
    pythonBin: python3
    module: lkb_dsh.bridge
    pythonPath: [/path/to/lkb/src]
    initArgs:
      board_id: main
```

`initialize` 时通用插件读取 Python 运行时上报的 manifest，注册被装饰的 service（`ctx.lkb`）、每个 `@tool` 与每个 listener——工具 schema 原样取自装饰器。下文 codegen 步骤仍是无法加载 `.ts` 源码的部署获得可构建、自包含包的路径。

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

### 一键安装（codegen → 构建 → 组装 → patch）

针对开发态工作流（构建版 dsh 无法加载 `.ts` 源码），`scripts/install-python-plugin.py` 把全部机械步骤收敛为一条命令 —— codegen、`tsc` 构建、自包含插件目录组装、`cordis.patch.yml` 条目写入：

```sh
scripts/install-python-plugin.py \
  --source path/to/bridge.py \
  --name '@my-org/lkb-bridge' \
  --module lkb_dsh.bridge \
  --python-src path/to/my-python/src \
  --config-json '{"boardId": "my-board"}'
```

唯一需要人工编写的只剩装饰器模块本身，其余都由该脚本完成。

各步骤已解耦——每一步都消费上一步留在磁盘上的产物，因此可以通过 `--steps codegen,build,assemble,smoke,patch` 单独运行任意子集（例如 `--steps patch` 只重放配置而不重新构建，`--steps codegen,build` 不触碰 profile）。其他开关：`--dry-run` 只打印 patch 不写盘；`--uninstall` 移除条目（加 `--delete-dir` 连插件目录一并删除）。环境覆盖项（`DSH_TSC`、`DSH_NODE`、`DSH_MONOREPO`、`DSH_INSTALL`、`DSH_HOME`、`DSH_TYPE_ROOTS`）让脚本适配不同机器；缺少 PyYAML 时 YAML 编辑回退到 dsh 自带的 js-yaml；符号链接被拒绝时依赖链接回退为复制。完整说明见脚本的模块 docstring。

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
| 解释器缺少 dsh-bridge（spawn 时探测） | `-32012` | `dependency-missing` |

## 测试

```sh
# 一键验证（stub、pytest、codegen、生命周期、真实子进程 runtime E2E、生成包 E2E；
# 当 monorepo 检出与 tsc 可用时还会运行 REAL-composition 与严格类型检查层）：
node scripts/verify.mjs

# 仅 Python：46 个测试（装饰器、类型推断、运行时、真实子进程集成）
cd python/sdk-dsl && PYTHONPATH=src python3 -m pytest tests/

# 示例 smoke test（无需 bridge）
PYTHONPATH=examples/python-bridge-ml:python/sdk-dsl/src \
  python3 examples/python-bridge-ml/provider.py
```

独立仓库在离线层通过提交的 stub（`tests/stubs/`，由 `scripts/setup-stubs.mjs` 物化）解析 `@deepseek-ai/*` 导入；集成层（`scripts/setup-integration.mjs`、`tests/integration/real-composition.mjs`、`scripts/typecheck-integration.mjs`）则绑定真实的 monorepo 源码。在 deepseek-harness monorepo 内，pnpm workspace 解析绑定真实包，`packages/bridge/*/tests/` 下的 vitest 套件在那里运行。

## 非目标

- **不内嵌 CPython**（Pyodide / pyo3）—— 所有执行都在独立的 Python 子进程中。
- **不替代 Code Mode 计划中的 Python 后端** —— 二者互补而非竞争。
- **不共享方法调用之外的双向状态** —— bridge 是消息传递而非共享内存。
- **不重新实现 Python 版 Cordis** —— Python 模块挂载到 dsh 现有的 Cordis 上下文。

## 许可证

MIT。
