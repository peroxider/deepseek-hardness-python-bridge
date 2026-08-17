# @peroxider/dsh-python-bridge-runtime

[English](README.md) | 中文

Python Capability Bridge 的 TypeScript 运行时半边。一个 Cordis Service Provider（`PythonBridgeService`，注册为 `ctx.pythonBridge`）负责派生长生命周期的 `python -u -m dsh_bridge.runtime <module>` 子进程，并通过 stdio 上的换行符分隔 JSON-RPC 2.0 协议转发装饰过的方法调用（复用 [`@deepseek-ai/dsh-sdk-protocol`](../sdk/protocol/README.md) 的帧格式）。进程生命周期（优雅关闭、SIGTERM → SIGKILL 升级链）通过 `scrubbedParentEnv()` 委托给 [`@deepseek-ai/dsh-subprocess`](../subprocess/subprocess/README.md) 做凭据清洗。

本包仅提供运行时，不包含任何生成的 Service 类。Service / Tool / Listener / Capability 类由 [`@peroxider/dsh-python-bridge-codegen`](../python-bridge-codegen/README.md) 从 Python 模块的 `dsh_bridge` 装饰器生成，并依赖本包。

## 接线

```ts
import { PythonBridgeService } from '@peroxider/dsh-python-bridge-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pythonBridge: PythonBridgeService
  }
}
```

一个典型的生成入口会在构造函数中调用 `ctx.pythonBridge.spawn({ module, className, initArgs, sandbox })`，并把每个 `@provide_method` 调用转发为 `this.bridge.call('methodName', args)`。

`PythonBridge.waitUntilReady()` 会返回首次握手得到的 worker manifest。initialize 握手失败或 bridge 在 ready 前开始销毁时，该方法以 `PythonBridgeError` 拒绝，使插件初始化不会在导入或协议错误后无限轮询。

## 生命周期

`PythonBridgeService.dispose()` 让每个存活的 bridge 走完关停阶梯：`shutdown` 通知 → stdin EOF → 等待 `graceMs`（默认 3000）→ SIGTERM → 再等待 `graceMs` → SIGKILL，与 `packages/sdk/client/README.md` 的 `stdin-EOF → SIGTERM → SIGKILL` 模型一致。

## 进程所有权

Bridge 以 SDK 托管传输层相同的方式拥有自己的 spawn（见 `dsh-subprocess` README 的 "SDK-managed spawns remain outside"）：一个长生命周期的 `node:child_process`，通过 stdio 上的 `JsonRpcLineTransport` 组帧。环境策略通过 `scrubbedParentEnv()` 保持单一来源。

## 解释器探测

spawn 之前，bridge 会用 `pythonBin -c "import dsh_bridge"` 验证解释器能否导入 bridge 运行时。探测失败时抛出 `PythonBridgeError`，`kind: 'dependency-missing'`、`code: -32012`，并附带 `pip install dsh-python-bridge` 安装指引——而不是令人困惑的即时 `worker-exit`。探测结果按 `pythonBin` 缓存，已确认正常的解释器不会在重连时重复探测。测试可通过 `internals.probeFn` 替换探测。

## 版本协商

`initialize` 握手携带 `clientInfo: { name, version }`（`PYTHON_BRIDGE_CLIENT_NAME` / `PYTHON_BRIDGE_CLIENT_VERSION`）。Python 运行时在客户端版本 major 与自身 `serverInfo.version` major 相同时接受握手，否则以 `protocol-mismatch`（`-32006`）和可读消息拒绝。发布时必须保持两端 major 一致。

[线协议稳定性参考](../../../docs/protocol.md)定义固定方法集、错误 kind 词典与 manifest 字段只增不改的演进规则。

## 重连

子进程意外退出时会按指数退避重启解释器（spec §6.7）。`PythonBridge.spawn()` 接受 `reconnect` 配置块：

```ts
reconnect: {
  enabled: true,        // 默认
  initialDelayMs: 500,  // 默认
  maxDelayMs: 30_000,   // 默认
  maxAttempts: 10,      // 默认
}
```

稳定运行满 `maxDelayMs` 后重试预算重置。断连期间 `call()` 以 `PythonBridgeError(kind: 'bridge-down')` 拒绝；子进程在调用中途死亡时，该调用以 `kind: 'worker-exit'`（`-32011`）拒绝，并附带子进程 stderr 尾部用于诊断。

## 错误

| Python 异常 | JSON-RPC `code` | `data.kind` |
| --- | --- | --- |
| `TimeoutError` | `-32001` | `timeout` |
| `CancelledError` | `-32002` | `abort` |
| `PermissionError` | `-32003` | `permission` |
| `ValueError` | `-32004` | `invalid-args` |
| `KeyError` / `AttributeError` | `-32005` | `not-found` |
| `ConnectionError` | `-32010` | `bridge-down` |
| 其他 | `-32603` | `exception` |
| 调用期间子进程退出 | `-32011` | `worker-exit` |
| 解释器缺少 dsh-bridge（spawn 时探测） | `-32012` | `dependency-missing` |
| initialize 时客户端/服务端版本不兼容 | `-32006` | `protocol-mismatch` |

`PythonBridgeError` 携带 `kind`、`code`（与 wire 一致）以及原始 `data` 负载。

## 环境

`scrubbedParentEnv()` 会剔除凭据形名称（`/KEY|PASSWORD|SECRET|TOKEN/i`）和所有 `DSH_*` 名称；显式 `env` 项在清洗后合并。固定设置 `PYTHONUNBUFFERED=1` 以保证 stdout 按帧 flush。

## 沙箱

当 sandbox seam 已加载时，`ctx.sandbox.confine(argv, { mode })` 在 spawn 前包装子进程 argv，且 confinement 失败会直接抛出（bridge 不会静默绕过）。当 seam 缺失时，无论 `sandbox` 字段如何设置子进程都不受限——需要 confinement 的部署必须加载 `dsh-sandbox` 及其后端。

## 模型体验

无：本包不暴露模型可见的表面；prompt / 工具 schema 由生成的 bridge 包根据其装饰的 Python 模块提供。

#### KV Cache 效果

无；bridge 只是传输层。

## 已知限制与未完成工作

- **沙箱 confinement 依赖可选 seam** —— 未加载 `dsh-sandbox` 时 `sandbox` 字段仅为提示。
- **默认不内嵌 CPython 解释器**；本包是进程管理层而非运行时。Pyodide 低延迟路径单独追踪（见 `packages/core/tools/README.md:27`）。
- **重连期间的监听器通知队列未实现** —— spec §6.7 的每事件类型 1 MiB 队列暂缓；子进程断连期间产生的通知会被丢弃。
