# @deepseek-ai/dsh-python-bridge-runtime

[English](README.md) | 中文

Python Capability Bridge 的 TypeScript 运行时半边。一个 Cordis Service Provider（`PythonBridgeService`，注册为 `ctx.pythonBridge`）负责派生长生命周期的 `python -u -m dsh_bridge.runtime <module>` 子进程，并通过 stdio 上的换行符分隔 JSON-RPC 2.0 协议转发装饰过的方法调用（复用 [`@deepseek-ai/dsh-sdk-protocol`](../sdk/protocol/README.md) 的帧格式）。进程生命周期（优雅关闭、SIGTERM → SIGKILL 升级链）通过 `scrubbedParentEnv()` 委托给 [`@deepseek-ai/dsh-subprocess`](../subprocess/subprocess/README.md) 做凭据清洗。

本包仅提供运行时，不包含任何生成的 Service 类。Service / Tool / Listener / Capability 类由 [`@deepseek-ai/dsh-python-bridge-codegen`](../python-bridge-codegen/README.md) 从 Python 模块的 `dsh_bridge` 装饰器生成，并依赖本包。

## 接线

```ts
import { PythonBridgeService } from '@deepseek-ai/dsh-python-bridge-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pythonBridge: PythonBridgeService
  }
}
```

一个典型的生成入口会在构造函数中调用 `ctx.pythonBridge.spawn({ module, className, initArgs, sandbox })`，并把每个 `@provide_method` 调用转发为 `this.bridge.call('methodName', args)`。

## 生命周期

`PythonBridgeService.dispose()` 让每个存活的 bridge 走完关停阶梯：`shutdown` 通知 → stdin EOF → 等待 `graceMs`（默认 3000）→ SIGTERM → 再等待 `graceMs` → SIGKILL，与 `packages/sdk/client/README.md` 的 `stdin-EOF → SIGTERM → SIGKILL` 模型一致。

## 进程所有权

Bridge 以 SDK 托管传输层相同的方式拥有自己的 spawn（见 `dsh-subprocess` README 的 "SDK-managed spawns remain outside"）：一个长生命周期的 `node:child_process`，通过 stdio 上的 `JsonRpcLineTransport` 组帧。环境策略通过 `scrubbedParentEnv()` 保持单一来源。

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
- **无协议版本协商** —— 预发布阶段，不承诺兼容性。
- **重连期间的监听器通知队列未实现** —— spec §6.7 的每事件类型 1 MiB 队列暂缓；子进程断连期间产生的通知会被丢弃。