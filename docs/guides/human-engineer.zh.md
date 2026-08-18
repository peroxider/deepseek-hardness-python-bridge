# 人类工程师指南——把 Python 能力变成 dsh 插件

[English](human-engineer.md) | 中文

**Python Capability Bridge** 是"我有可用的 Python 代码"到"这段代码现在是 deepseek-harness（dsh）原生插件"的转化通道。本指南面向坐在终端前的人类工程师。如果你是 AI 编码 Agent，请改用 [Agent 友好型指南](agent-friendly.md)——它通过项目自带的 `dsh-python-plugin` skill 驱动同样的工作流。

## 这个仓库是做什么的

DeepSeek Harness 的插件面是纯 TypeScript 的。bridge 拆掉了这堵墙：给 Python 模块加上 `dsh_bridge` 装饰器注解，运行一条命令，同样的代码就变成一等公民的 dsh 插件——其他插件可以 `inject` 的 Cordis service、模型可见的工具、事件监听器等等——**Python 业务代码零改动**。

| 你的 Python 能力 | 在 deepseek-harness 中变成 |
| --- | --- |
| `@service` 装饰的类 | 其他插件可 `inject` 的 `ctx.<name>` Cordis Service |
| `@tool` 装饰的函数 | 模型可见的工具（`ctx.tools.register(defineTool(...))`） |
| `@on` 装饰的函数 | 类型化事件监听器（`ctx.on('agent/*' \| 'tools/*' \| 'session/event' \| ...)`） |
| `@capability` 装饰的类 | capability seam 的替换 provider（`ctx.fs`、`ctx.shell` 等） |
| `@system_prompt_section` | 对 agent system prompt 的贡献 |
| `@guard()` / `@restrict_tools()` | 工具策略钩子 |

生成的 TypeScript bridge 包派生一个长生命周期的 Python 子进程，通过 stdio 上的换行符分隔 JSON-RPC 2.0 协议转发装饰过的方法。插件与 dsh 组合中的任何 TypeScript 插件一样，获得相同的沙箱、环境清洗、审批流、会话日志与持久化。

## 流程一览

```
bridge.py ──▶ codegen ──▶ build ──▶ assemble ──▶ patch
(装饰好的     TS 包        JS 库    插件目录        cordis.patch.yml
 模块)       (生成)      (tsc)     (自包含)        (loader 条目)
```

只有第一步（编写装饰好的模块）需要判断力；其余全是机械步骤，由 `scripts/install-python-plugin.py` 自动完成。

## 第 1 步——编写装饰好的模块（唯一的开发步骤）

在业务代码旁建一个薄包装模块（约定名：`<pkg>_dsh/bridge.py`），导入业务代码并加上 `dsh_bridge` 装饰器。**永远不要修改业务代码本身。**

```python
# my_ml_dsh/bridge.py
from dataclasses import dataclass
from dsh_bridge import provide_method, service, tool, on


@service(name="ml")
@dataclass
class MLProvider:
    model_path: str                       # → 必填配置键 modelPath
    batch_size: int = 32                  # → 可选配置键 batchSize

    @provide_method(timeout_ms=10_000)
    def embed(self, texts: list[str]) -> list[list[float]]:
        # ... 真实算法，原样保留 ...
        return [[0.0] * 768 for _ in texts]


@tool(name="shout", description="Upper-case a string.",
      parameters={"text": {"type": "string"}})
def shout(text: str) -> dict:
    return {"text": text.upper()}


@on("session/event", mode="emit")
def audit(event: str, payload: dict) -> None:
    ...
```

按能力目标选择装饰面：

| 目标 | 装饰器 | 生成结果 |
| --- | --- | --- |
| 其他插件注入的有状态能力 | 在 `@dataclass` 类上 `@service(name='x')` | `ctx.x` Service；dataclass 字段变成 `cordis.yml` 配置键（`model_path` → `modelPath`） |
| 该 service 上的公开方法 | 类内 `@provide_method(timeout_ms=…)` | 转发到 Python 的类型化 TS 方法 |
| 模型可见的动作 | 函数上的 `@tool(name, description, parameters, output_schema=…)` | `ctx.tools.register(defineTool(...))` |
| 响应 harness 事件 | 函数上的 `@on('session/event', mode='emit')` | 桥接到 Python 的 `ctx.on(...)` 监听器 |

**codegen 解析器强制执行的硬约束**（违反会被静默忽略——当装饰器"没起作用"时先检查这些）：

- 装饰器工厂使用**关键字参数加至多一个前置位置名**：`@service(name='ml')` 和 `@service('ml')` 都可以；`@dsh_bridge.service(...)` 和 `from dsh_bridge import service as svc` **不行**。
- `parameters` / `output_schema` 中的每个 JSON Schema 对象都必须显式设置 `"additionalProperties": False`（dsh-tools 编译器会拒绝隐式对象）。
- 方法参数与返回值必须**可 JSON 序列化**（返回 dataclass 会挂起调用；返回普通 dict/list/标量——用 `dataclasses.asdict()` 或显式字段映射转换）。
- 每个模块只发射第一个 `@service` 类；其余 service 拆到独立模块。

完整装饰器契约见 [`skill/dsh-python-plugin/references/decorators.md`](../../skill/dsh-python-plugin/references/decorators.md)。

## 第 2 步——安装（codegen → 构建 → 组装 → patch）

在 bridge 仓库根目录运行一条命令：

```sh
scripts/install-python-plugin.py \
  --source /abs/path/to/bridge.py \
  --name '@my-org/<short>-bridge' \
  --module <pkg>_dsh.bridge \
  --python-src /abs/path/to/python/src \
  --config-json '{"<camelCaseKey>": "value"}'
```

各步骤做的事：`codegen`（TS 包生成到 `<plugin>/.build/generated/`）、`build`（tsc → `lib/`，包括构建版 dsh 缺少的 runtime 与 sdk-protocol 包）、`assemble`（Python 包复制到插件根目录；运行时依赖从 dsh 安装链接）、`smoke`（在插件目录内导入模块）、`patch`（幂等写入 `~/.dsh/profiles/<profile>/cordis.patch.yml`）。

常用变体：

- `--steps codegen,build` —— 只重新生成，不碰 profile。
- `--steps patch --config-json …` —— 只重放配置。
- `--dry-run` —— 只打印 patch 不写盘。
- `--uninstall` —— 移除条目（加 `--delete-dir` 连插件目录一起删除）。
- 发现失败时的环境覆盖项：`DSH_TSC`、`DSH_NODE`、`DSH_MONOREPO`、`DSH_INSTALL`、`DSH_HOME`、`DSH_TYPE_ROOTS`。脚本会在失败时报告所有尝试过的路径——先读错误再猜。

如果当前环境无法运行安装器（没有 tsc、没有 dsh 安装），按 [`skill/dsh-python-plugin/references/manual-pipeline.md`](../../skill/dsh-python-plugin/references/manual-pipeline.md) 走手动流程。

## 第 3 步——验证

1. 安装器的 smoke 步骤已经证明模块能在插件目录内导入。
2. 对运行中的实例：`ps aux | grep dsh_bridge.runtime` 能看到 Python 子进程（`python3 -u -m dsh_bridge.runtime <module> --class <Class> …`）；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080`（或该实例的 URL）保持 200。
3. 新插件条目通过 patch 层 watcher 热生效；**替换已加载插件的产物需要重启 `dsh web`**——在此之前内存中的副本才是权威。

## 故障排查

在从头调试之前，先在 [`skill/dsh-python-plugin/references/pitfalls.md`](../../skill/dsh-python-plugin/references/pitfalls.md) 里对照症状——它记录了真实转化踩过的坑（不可序列化结果导致挂起、confine 契约不匹配、工具注册缺失、装饰器静默跳过等）及修复方法。

## 进入同一工作流的其他入口

- **AI Agent 来做转化** → [Agent 友好型指南](agent-friendly.md)（加载 `dsh-python-plugin` skill 并遵循它）。
- **完整逐步教程** → [`docs/cookbook/adding-a-python-bridge.md`](../cookbook/adding-a-python-bridge.zh.md)。
- **可运行示例** → [`examples/python-bridge-ml/`](../../examples/python-bridge-ml/README.zh.md)（ML provider + tool + 监听器）。
- **装饰器 / 错误映射参考表** → [主 README](../../README.zh.md)。
