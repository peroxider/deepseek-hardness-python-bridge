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

`PythonBridgeService.dispose()` 会终止所有仍在运行的子进程，在 SIGKILL 升级前最多等待 `graceMs`（默认 3000）毫秒。清理顺序与 `packages/sdk/client/README.md` 中的 `stdin-EOF → SIGTERM → SIGKILL` 一致。

## 重连

`PythonBridge.spawn()` 接受一个 `reconnect` 配置块：

```ts
reconnect: {
  enabled: true,        // 默认
  initialDelayMs: 500,  // 默认
  maxDelayMs: 30_000,   // 默认
  maxAttempts: 10,      // 默认
}
```

断连期间，`call()` 会以 `PythonBridgeError(kind: 'bridge-down')` 拒绝。

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

`sandbox` 字段会转发到 `ctx.subprocess.spawn()`；当 sandbox 服务存在时由 `ctx.sandbox.confine()` 应用策略。

## 模型体验

无：本包不暴露模型可见的表面；prompt / 工具 schema 由生成的 bridge 包根据其装饰的 Python 模块提供。

#### KV Cache 效果

无；bridge 只是传输层。

## 已知限制与未完成工作

- **第一代传输依赖 subprocess 服务的 raw pipe 派发；** 内置 subprocess 服务把 `stdout` 暴露为 `Readable`。后续迭代会在 prompt 驱动的 Python REPL 集成落地后切换到 node-pty 后端通道。
- **默认不内嵌 CPython 解释器**；本包是进程管理层而非运行时。Pyodide 低延迟路径单独追踪（见 `packages/core/tools/README.md:27`）。
- **无协议版本协商** —— 预发布阶段，不承诺兼容性。