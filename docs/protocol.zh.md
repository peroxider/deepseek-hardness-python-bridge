# Python bridge 线协议稳定性

[English](protocol.md) | 中文

本文定义 `@peroxider/dsh-python-bridge-runtime` 与 Python `dsh-bridge` runtime 之间的兼容承诺。传输使用 stdio 上以换行分隔的 JSON-RPC 2.0。协议版本的 major 分量相同时兼容；major 不同时，`initialize` 以 `protocol-mismatch`（`-32006`）拒绝连接。

## 版本握手

TypeScript client 首先发送 `initialize`，其中包含 `clientInfo: { name, version }`。major 相同时，Python server 返回 `serverInfo: { name, version }` 和 `manifest`。版本使用点分十进制文本，第一个数字分量是协议 major。为兼容旧 peer，缺失或无法解析的版本数据仍被接受；受维护的 TypeScript client 始终发送可解析版本。

同一 major 内，协议版本可以增加可选请求字段、结果字段、manifest 字段、通知、错误 kind 和动态声明的方法类别。不得删除或重命名已有固定协议字段或方法、改变字段的 JSON 类型或含义、把可选字段改成必填，也不得把错误 code 或 kind 复用于另一种条件。任何此类不兼容变更都要求 TypeScript client 版本与 Python 包版本协调提升 major。模块自身的动态方法可以随该模块的装饰器变化；manifest 描述的是该模块实例，不永久承诺其应用 API。

## 方法与通知集合

固定的 client 到 server 控制消息：

| 方法 | 帧类型 | 参数/结果 |
| --- | --- | --- |
| `initialize` | request | 发送 `cwd` 与 `clientInfo {name, version}`；返回 `serverInfo {name, version}` 和 `manifest`。 |
| `shutdown` | notification | 发送空对象并开始关闭 worker；不等待响应。 |

manifest 的 `methods` 数组声明动态请求名，包括带装饰器的 service 方法、工具、capability 方法和显式注册的函数。参数是映射到 Python 关键字参数的 JSON 对象，结果必须是 JSON 值。client 不得推断未声明的动态方法。

稳定通知如下：

| 方向 | 方法 | 用途 |
| --- | --- | --- |
| TypeScript → Python | `event/deliver` | 把具名 Cordis 事件及 payload 交给匹配的 Python listener。 |
| TypeScript → Python | `log/notify` | 通过 Python logger 写入 TypeScript 诊断。 |
| Python → TypeScript | `bridge/log` | 转发 Python 日志和代理的 stdout 诊断。 |

未知通知会被忽略，因此较新的 peer 可以在同一 major 内增加通知。未知请求返回 JSON-RPC `-32601`，调用方不得换一个名称重试。

## 错误 kind 词典

JSON-RPC 失败通过 `error.data.kind` 携带稳定、机器可读的分类。消费者必须保留未知 kind，并可按 `exception` 处理；不得仅因较新的同 major peer 增加了 kind 就拒绝其他方面有效的响应。

| Code | Kind | 含义 |
| --- | --- | --- |
| `-32001` | `timeout` | Python 调用超过截止时间。 |
| `-32002` | `abort` | 调用被取消。 |
| `-32003` | `permission` | 策略拒绝操作。 |
| `-32004` | `invalid-args` | 调用参数无效。 |
| `-32005` | `not-found` | 引用的名称或属性不存在。 |
| `-32006` | `protocol-mismatch` | client 与 server 的协议 major 不同。 |
| `-32010` | `bridge-down` | 传输不可用。 |
| `-32011` | `worker-exit` | Python worker 在调用期间退出。 |
| `-32012` | `dependency-missing` | 配置的解释器无法导入 `dsh_bridge`。 |
| `-32603` | `exception` | 出现未分类的 Python 或序列化失败。 |

`-32601` 是标准 JSON-RPC method-not-found 响应，可以不带 `data.kind`。自定义 `PythonBridgeError` 子类可以在 `-32603` 下增加 kind；上表名称均为保留名称，并保持所述含义。

## Manifest 演进

`initialize` manifest 包含以下稳定顶层数组：`services`、`provideMethods`、`tools`、`listeners`、`capabilities`、`capabilityMethods`、`promptSections` 和 `methods`。

读取方必须忽略未知对象字段和未知顶层 manifest 字段。写入方可以在不提升 major 的情况下追加可选字段。同一 major 内已有字段只增不改：名称、JSON 类型、可空性与含义保持稳定。新的装饰器能力可以增加顶层数组或可选成员；删除字段、改变字段解释，或要求旧读取方必须处理新字段，都需要提升 major。

除非字段显式携带排序语义，否则集合顺序仅用于描述。`promptSections.order` 具有语义；消费者不得赋予其他数组的偶然顺序任何含义。`methods` 中的名称是动态请求可调用性的权威来源，更丰富的数组负责提供注册元数据。
