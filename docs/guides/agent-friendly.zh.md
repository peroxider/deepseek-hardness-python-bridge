# Agent 友好型指南——把 Python 能力变成 dsh 插件

[English](agent-friendly.md) | 中文

本指南面向 AI 编码 Agent（代替用户读文件、跑命令、改代码的助手）。它驱动与[人类工程师指南](human-engineer.md)相同的转化工作流，但按 Agent 的工作方式做了调整：本项目为这项工作专门提供了一个 **skill**，本指南告诉你如何用它、动手前检查什么、以及如何验证成果。

如果你是人，请改用[人类工程师指南](human-engineer.md)。

## 首先：加载 skill

仓库中带有面向本工作流的标准 skill，位于 [`skill/dsh-python-plugin/SKILL.md`](../../skill/dsh-python-plugin/SKILL.md)。**如果你的运行环境支持加载 skill（例如通过 skill 加载机制），请先加载 `dsh-python-plugin` 并遵循它**——它是最权威的分步流程。本指南是其精简、不依赖 skill 的版本；若两者不一致，以 skill 为准。

skill 的参考文件是遇到边界情况时该查阅的深度文档：

| 参考文件 | 何时打开 |
| --- | --- |
| [`references/decorators.md`](../../skill/dsh-python-plugin/references/decorators.md) | 每个装饰器的精确契约（字段 → 配置键、可选性、类型投影） |
| [`references/pitfalls.md`](../../skill/dsh-python-plugin/references/pitfalls.md) | 症状 → 原因 → 修复目录；从头调试前先打开它 |
| [`references/manual-pipeline.md`](../../skill/dsh-python-plugin/references/manual-pipeline.md) | 一键安装器无法运行时的回退方案 |

## 任务一句话

把用户想暴露给 dsh 的 Python 模块变成一等公民的 dsh 插件——`ctx.<name>` service、模型可见的工具、事件监听器——**业务代码零改动**，只需加 `dsh_bridge` 装饰器并运行 bridge 的安装器。

## 流程（除第 1 步外全是机械步骤）

```
bridge.py ──▶ codegen ──▶ build ──▶ assemble ──▶ patch
(装饰好的     TS 包        JS 库    插件目录        cordis.patch.yml
 模块)       (生成)      (tsc)     (自包含)        (loader 条目)
```

## 第 1 步——编写装饰好的模块（唯一需要判断的步骤）

在业务代码旁建一个薄包装模块（约定名：`<pkg>_dsh/bridge.py`），导入业务代码并加装饰器。永远不要修改业务代码。

按能力目标选择装饰面：

| 目标 | 装饰器 | 生成结果 |
| --- | --- | --- |
| 其他插件注入的有状态能力 | 在 `@dataclass` 类上 `@service(name='x')` | `ctx.x` Service；dataclass 字段变成 `cordis.yml` 配置键（`model_path` → `modelPath`） |
| 该 service 上的公开方法 | 类内 `@provide_method(timeout_ms=…)` | 转发到 Python 的类型化 TS 方法 |
| 模型可见的动作 | 函数上的 `@tool(name, description, parameters, output_schema=…)` | `ctx.tools.register(defineTool(...))` |
| 响应 harness 事件 | 函数上的 `@on('session/event', mode='emit')` | 桥接到 Python 的 `ctx.on(...)` 监听器 |

### 动手前先检查这些（违反会被静默忽略）

codegen 解析器会**静默跳过**违反其约束的装饰器——你不会看到报错，只会看到 service/工具缺失。提前逐一核对这些：

1. **装饰器形状**：关键字参数加至多一个前置位置名。`@service(name='ml')` 和 `@service('ml')` 都可以；`@dsh_bridge.service(...)` 和 `from dsh_bridge import service as svc` **不行**。
2. **`additionalProperties: False`**：`parameters` / `output_schema` 中每个 JSON Schema 对象都必须显式设置——dsh-tools 编译器会拒绝隐式对象。
3. **边界可 JSON 序列化**：方法参数/返回值必须是普通 JSON 类型（返回 dataclass 会挂起调用——在包装层用 `dataclasses.asdict()` 转换）。
4. **每个模块只有一个 `@service` 类**——其余 service 拆到独立模块。
5. **`@capability` / `@guard` / `@restrict_tools` / `@system_prompt_section` 只解析不发射**——不要在转化中承诺这些功能。

## 第 2 步——一条命令安装

在 bridge 仓库根目录：

```sh
scripts/install-python-plugin.py \
  --source /abs/path/to/bridge.py \
  --name '@my-org/<short>-bridge' \
  --module <pkg>_dsh.bridge \
  --python-src /abs/path/to/python/src \
  --config-json '{"<camelCaseKey>": "value"}'
```

各步骤：`codegen`（TS 包生成到 `<plugin>/.build/generated/`）、`build`（tsc → `lib/`）、`assemble`（Python 包复制到插件根目录，运行时依赖链接）、`smoke`（在插件目录内导入模块）、`patch`（幂等写入 `cordis.patch.yml`）。

这样处理失败：

- **先读错误再猜**。脚本在发现失败时会报告所有尝试过的路径——对照报告的路径，不要发明新路径。
- 缺少 tsc 或 dsh 安装时，回退到 `references/manual-pipeline.md` 并如实说明。
- 发现失败时的环境覆盖项：`DSH_TSC`、`DSH_NODE`、`DSH_MONOREPO`、`DSH_INSTALL`、`DSH_HOME`、`DSH_TYPE_ROOTS`。
- `--dry-run` 只打印 patch 不写盘；`--uninstall` 移除条目（`--delete-dir` 连插件目录一起删除）。用 `--steps codegen,build` 只重新生成、不碰 profile。

## 第 3 步——验证（不要跳过）

1. 安装器的 `smoke` 步骤证明模块能在插件目录内导入——报告它已运行。
2. 对运行中的实例：`ps aux | grep dsh_bridge.runtime` 能看到 Python 子进程；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080`（或该实例 URL）保持 200。
3. 如果插件已加载，告诉用户**替换产物需要重启 `dsh web`**——patch watcher 只热应用条目列表的变更。

## 出问题时

**先**在 [`references/pitfalls.md`](../../skill/dsh-python-plugin/references/pitfalls.md) 里对照症状，再从头调试。它覆盖了转化中真实踩过的坑：不可序列化结果导致挂起、`spawn argv is empty`（runtime 构建过期）、`z.string(...).optional is not a function`（重新生成）、`additionalProperties` 被拒、装饰器静默跳过、`method not found`、`owner_required` 拒绝、子进程立即退出、插件变更不生效。

## Agent 行为守则

- **永远不要修改业务代码**——只改包装模块。未挂载 bridge 时业务代码原样运行。
- **永远不要承诺 capability / guard / system-prompt 功能**——它们只解析不发射。
- **如实报告**：如果安装器无法运行（无 tsc / 无 dsh 安装）而改用手动流程，要说清楚；如果无法对运行中的实例验证，也要说清楚。
