# Python Capability Bridge — 发布态开发 TODO

> 目标形态：用户只需**写 `bridge.py`**（装饰器模块）+ **一行 `cordis.yml`**，即可把任意
> Python 模块转化为 deepseek-harness 插件。本文档是达到该形态的完整执行计划。
>
> 状态基线：2026-08-15。开发态闭环已验证（9 层验证套件 + LKB 生产转化 + 一键安装脚本
> + dsh-python-plugin skill）。

---

## 0. 现状基线（已完成，勿重复）

| 资产 | 位置 | 状态 |
| --- | --- | --- |
| Python 装饰器库 + 运行时 | `python/sdk-dsl/` | 44 pytest 全绿；真实子进程 wire 验证 |
| TS 运行时 `PythonBridgeService` | `packages/bridge/python-bridge-runtime/` | owned-spawn + 关停阶梯 + 重连 + sandbox confine（rc.6 契约） |
| codegen | `packages/bridge/python-bridge-codegen/` | 正则解析 + 两种包形态 + dataclass 字段映射（私有字段豁免） |
| 一键安装脚本 | `scripts/install-python-plugin.py` | 步骤解耦 + 环境自适应 + `--steps/--uninstall/--dry-run` |
| 转化技能 | `skill/dsh-python-plugin/` | 首轮 6/6 评估通过 |
| 实证案例 | LKB（clawcodex `extensions/lkb/src/lkb_dsh/`） | 生产实例热加载运行中 |
| 验证体系 | `scripts/verify.mjs`（9 步）+ `tests/integration/` | 全绿，含真实 Loader 组合 + 严格 tsc -b |

**已知边界（发布前必须遵守）**：

- 装饰器解析为受限正则形状：关键字参数 + 至多一个位置名；不支持全限定调用/别名导入。
- `@capability` / `@guard` / `@restrict_tools` / `@system_prompt_section` 只解析不发射。
- 运行中的生产实例（`dsh web` @ 3080）持有内存产物；替换产物需重启。
- 离线环境：无 registry 访问；tsc 在 `/tmp/dsh-externals/manual/typescript-6.0.3/package/bin/tsc`；
  TS 源码执行需 `node --experimental-transform-types`；`@deepseek-ai/*` 解析走
  `tests/stubs/`（离线）或 `.gen/integration`（真实源码）。

---

## 里程碑 M1 — 通用声明式 bridge 插件（核心）

> 让一行 cordis.yml 配置直接成为插件，无需 per-module codegen。
> 目标产物：`@peroxider/dsh-python-bridge`（新包，`packages/bridge/python-bridge/`）。

### M1.1 manifest 扩充（Python 运行时）

`dsh_bridge.runtime` 的 `initialize` 目前只返回工具 `name`/`description`、方法名。
动态注册需要完整 schema。

- [x] **任务**：manifest 增加：
  - `tools[].parameters` / `tools[].outputSchema`（直接取 `ToolMetadata.parameters` / `output_schema`）
  - `provideMethods[].parameters`（名字 + PEP 484 注解字符串）/ `provideMethods[].return`
  - `services[].initFields`（dataclass 字段名 + 注解 + 默认值，供 Config 文档与 initArgs 校验）
  - `listeners[].function`（函数名，供诊断）
- [x] **验收**：pytest 新增断言，manifest 含上述字段；`python -m pytest tests/` 全绿。
- [x] **验证命令**：`cd python/sdk-dsl && PYTHONPATH=src python3 -m pytest tests/ -q`

### M1.2 通用插件 TS 实现

新包 `packages/bridge/python-bridge/`（Service Provider 形态，注册为插件而非 `ctx.*` 服务）。

- [x] **任务**：实现 `PythonModulePlugin`：
  - `static inject = ['pythonBridge', 'tools']`（tools 仅当 manifest 含工具时）
  - `static Config`（schemastery）：`module: z.string().required()`、`className: z.string()`、
    `functions: z.array(z.string()).default([])`、`initArgs: z.record(z.any()).default({})`、
    `pythonBin: z.string().default('python')`、`pythonPath: z.array(z.string()).default([])`（见 M2）、
    `sandbox: z.union([...] as const).default('workspace-write')`、`graceMs: z.number().default(3000)`、
    `reconnect` 子对象（默认值同 runtime）、`settingsNamespace: z.string()`
  - 构造时：`ctx.pythonBridge.spawn({...})` → 等待 ready → 读 manifest →
    - manifest.services[0] 存在 → 动态创建 `class extends Service`，以 `service.name` 注册
      `ctx.<name>`，为每个 provideMethod 生成转发方法（`bridge.call(name, args)`）
    - 每个 manifest tool → `ctx.tools.register(defineTool({...}))`（schema 直接来自 manifest）
    - 每个 manifest listener → `ctx.on(event, handler, {prepend, global})`，handler 转发
      `bridge.notify('event/deliver', {event, payload})`；waterfall 模式 handler 必须 `return next()`
  - `ctx.effect()` 注册拆毁（fiber unload → `bridge.shutdown()`）
- [x] **验收**：真实 Loader 挂载单行配置即注册 `ctx.lkb` + 4 个工具；严格 `tsc -b` 零错误。
- [x] **依赖**：M1.1。

### M1.3 动态注册的 schema 直传

- [x] **任务**：工具注册时 `parameters`/`output.schema` 直接使用 manifest 中的 JSON Schema
  （dsh-tools 编译器约束不变：object 必须显式 `additionalProperties`）。manifest 缺
  `additionalProperties` 时插件侧默认补 `false` 并打诊断日志（codegen 侧已强制，此处是防御）。
- [x] **验收**：`valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue` 对 LKB 四个工具的实际
  返回值全部通过。

### M1.4 REAL-composition 验证（无 codegen 路径）

- [x] **任务**：`tests/integration/generic-plugin.mjs`：
  cordis.yml 仅含 system-prompt + tools + python-bridge-runtime + 一行通用插件配置
  （LKB `lkb_dsh.bridge`），经真实 Loader 启动后：
  `ctx.lkb.create_task` → `claim` → `start` → `complete` 全生命周期 +
  4 工具经真实 ToolRuntime 可见可执行 + fiber dispose 拆毁子进程。
- [x] **验收**：断言全过；与 codegen 路径（`lkb-composition.mjs`）行为等价。
- [x] **依赖**：M1.2、M1.3。

### M1.5 双路径文档

- [x] **任务**：README 增"Generic vs. codegen"章节：通用插件（零构建、动态类型）为默认；
  codegen（静态类型、per-module schemastery Config）为高级路径。cookbook 同步。

---

## 里程碑 M2 — `pythonPath` 配置

> 消灭"复制业务源码进插件目录"：子进程 `PYTHONPATH` 可配置。

### M2.1 runtime spawn 支持 `pythonPath`

- [x] **任务**：`PythonBridgeSpawnSpec` 增加 `pythonPath?: string[]`；
  `buildEnv()` 将其与既有 `PYTHONPATH` 合并（`:` 连接，config 值在前）。
- [x] **验收**：生命周期测试断言 env 合并顺序；child 实际 import 到目标包。
- [x] **依赖**：无。

### M2.2 通用插件 + 安装脚本接线

- [x] **任务**：通用插件 Config 的 `pythonPath` 透传（M1.2 已含）；安装脚本新增
  `--python-path`（可重复），默认不再复制 `--python-src`（保留为兼容开关
  `--copy-python-src`）。
- [x] **验收**：LKB 通过 `pythonPath: [clawcodex/extensions/lkb/src]` 挂载成功，
  插件目录不再含 `lkb/` 副本。

---

## 里程碑 M3 — PyPI 发布 `dsh-bridge`

### M3.1 发布准备

- [x] **任务**：`python/sdk-dsl/pyproject.toml` 完善（version 对齐、classifiers、
  `project.entry-points`）；README 与 PyPI 长描述。
- [x] **验收**：`python3 -m build` 产出 wheel；`pip install dist/*.whl` 后
  `python -c "import dsh_bridge; print(dsh_bridge.__version__)"` 通过。

### M3.2 子进程解释器探测

- [x] **任务**：spawn 前以 `pythonBin -c "import dsh_bridge"` 探测；失败时报错并附
  安装指引（而非静默 `worker-exit`）。探测结果缓存（per pythonBin）。
- [x] **验收**：指向无 `dsh_bridge` 的解释器时错误信息含 `pip install dsh-bridge`。

### M3.3 CI 发布流水线

- [x] **任务**：GitHub workflow：pytest → build → （tag 触发）publish PyPI。
  首版可手动 `twine upload` 验证流程。
- [x] **依赖**：M3.1。

---

## 里程碑 M4 — npm 发布 / dsh-base bundle 集成

### M4.1 runtime 进入 dsh-base（首选）或独立发布

- [x] **任务**：评估两条路径并落地其一：
  (a) `@peroxider/dsh-python-bridge-runtime` + 通用插件（M1）加入 monorepo 的
      `@deepseek-ai/dsh-base` bundle 依赖，使每个 dsh 安装自带 `ctx.pythonBridge`；
  (b) 独立 npm 发布（profile 侧 `pnpm add` 解析）。
- [x] **验收**：全新 dsh 安装中 cordis.yml 以裸名 `@peroxider/dsh-python-bridge`
  挂载成功，无 file:// 组装。

### M4.2 codegen bin 发布

- [x] **任务**：`@peroxider/dsh-python-bridge-codegen` 可 `pnpm dlx` 执行；
  bin 入口兼容源码直跑与构建产物。

### M4.3 源码归属

- [x] **任务**：本仓 `packages/bridge/*` 是三个 TypeScript bridge 包的单一事实源；
  monorepo 仅提供真实依赖与严格类型检查环境，不保存同步源码副本。

---

## 里程碑 M5 — `dsh plugin install` 子命令

### M5.1 子命令骨架

- [x] **任务**：dsh CLI 增加 `dsh plugin install <source.py> [--name x] [--id x]
  [--profile web] [--config-json '{...}'] [--python-path ...]`。profile 感知
  （读 `~/.dsh/profiles/<profile>/`），环境发现内化（不再需要 `DSH_TSC` 等变量）。

### M5.2 通用路径（默认）

- [x] **任务**：检测到目标为通用插件可承载（service/tool/listener 形状）时，仅向
  `cordis.patch.yml` 插入一行配置（幂等，同 id 替换），无需任何构建。
- [x] **验收**：`dsh plugin install lkb_dsh/bridge.py` 后实例热加载，工具立即可用。

### M5.3 codegen 路径（`--typed`）

- [x] **任务**：保留完整 生成→构建→装配→patch 流程（复用 install-python-plugin.py 逻辑，
  移植为 dsh 内建）。`--steps/--dry-run/--uninstall` 等价物。

---

## 里程碑 M6 — 线协议版本化

### M6.1 initialize 版本协商

- [x] **任务**：TS 侧发送 `clientInfo: {name, version}`；Python 侧校验
  `serverInfo.version` 兼容集（初版策略：major 相同即兼容，否则拒绝并给出
  `protocol-mismatch` 错误 kind）。
- [x] **验收**：伪造不匹配版本时 `initialize` 以可读错误拒绝。

### M6.2 兼容承诺文档

- [x] **任务**：`docs/` 增加协议稳定承诺（wire 方法集、错误 kind 词典、manifest 字段的
  演进规则：只增不改）。

---

## 横切纪律（每个里程碑提交时执行）

1. **验证**：`node scripts/verify.mjs` 全绿后方可提交（含 REAL-composition 与严格 tsc -b）。
2. **README/参考文档随代码同改**：行为变化（config key、默认值、错误 kind、manifest 字段）
   在同一次提交更新 README + `skill/dsh-python-plugin/references/`。
3. **提交范围**：`git add` 明确列文件，不用 `-A`（工作树可能有他人改动）；设计文档
   （spec、`docs/subsystems/`、`.agents/`）不提交。
4. **生产实例**：替换已加载插件的产物后，提醒用户重启 `dsh web`；不自行重启。
5. **推送**：正常 push；改写历史仅 `--force-with-lease` 且先说明原因。
6. **跨仓类型检查**：`scripts/typecheck-integration.mjs` 在 monorepo 的临时 detached worktree
   中装入本仓 bridge 源码并运行 `tsc -b`，不得改动 monorepo 工作树。

---

## 里程碑依赖图

```
M1.1 ──▶ M1.2 ──▶ M1.3 ──▶ M1.4 ──▶ M1.5
                │
M2.1 ──▶ M2.2 ──┘
M3.1 ──▶ M3.2 ──▶ M3.3
M4.1 ──▶ M4.2 ──▶ M4.3
M5.1 ──▶ M5.2 ──▶ M5.3   （M5 依赖 M1 + M4.1）
M6.1 ──▶ M6.2            （M6 与 M3/M4 并行可做）
```

建议执行顺序：**M1 → M2 → M3.1+M3.2 → M4 → M5 → M6**（M3.3 与 M6 可穿插）。
