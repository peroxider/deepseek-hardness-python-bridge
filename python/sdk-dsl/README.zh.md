# dsh-bridge

[English](README.md) | 中文

Python 装饰器库与运行时，把 Python 模块通过 DeepSeek Harness Python Capability Bridge 暴露为 Cordis Service Provider / Tool Consumer / Event Listener / capability seam Provider。装饰器在 import 时无副作用；运行时入口为 `python -u -m dsh_bridge.runtime <module>`，通过 stdio 提供换行符分隔的 JSON-RPC 2.0 协议（与 `@deepseek-ai/dsh-sdk-protocol` 的 `JsonRpcLineTransport` 一致）。

## 安装

```sh
pip install dsh-bridge
```

## 装饰器

| 装饰器 | 作用 |
| --- | --- |
| `@service(name, settings_namespace=None)` | 类装饰器；将类标记为 `ctx.<name>` Service Provider |
| `@provide_method(timeout_ms=None, is_concurrency_safe=None)` | `@service` 内的方法装饰器；每个被装饰的方法成为公共 TS 方法 |
| `@tool(name, description, parameters, output_schema=None, timeout_ms=None)` | 函数装饰器；映射为 `ctx.tools.register(defineTool({...}))` |
| `@on(event_name, mode='emit', prepend=False, global_=False)` | 函数装饰器；映射为 `ctx.on(...)` |
| `@capability(seam, backend)` | 类装饰器；替换某个 capability seam 的 provider |
| `@method(name=None)` | `@capability` 内的方法装饰器 |
| `@system_prompt_section(order, text)` | 函数装饰器；注册一段 system prompt |
| `@guard()` | 函数装饰器；注册为 tool guard |
| `@restrict_tools(allow=None, deny=None)` | 方法装饰器；per-agent 工具限制 |

每个装饰器都原样返回被装饰的可调用对象 / 类，Python 业务代码在运行时不发生修改。

## 运行时

```sh
python -u -m dsh_bridge.runtime <module.path> [--class <ClassName>] [--function <func>]...
```

运行时扫描 bridge registry 并将 JSON-RPC 请求分派到匹配的 Python 可调用对象。异常按 `dsh_bridge._errors` 中的 JSON-RPC 错误词典映射（`-32001`/`timeout`、`-32003`/`permission` 等）。

### 运行时 manifest

`initialize` 握手返回 `serverInfo` 外加一个 `manifest`，携带所有动态注册的表面及其元数据，宿主无需 codegen 即可据此构建插件：

- `tools[]` —— `name`、`description`、`parameters`（JSON Schema）、`outputSchema`
- `provideMethods[]` —— `name`、`timeoutMs`、`concurrencySafe`、`parameters`（PEP 484 注解字符串）、`return`
- `services[]` —— `name`、`class`、`initFields`（dataclass 字段名/注解/默认值）
- `listeners[]` —— `event`、`mode`、`prepend`、`global`、`function`

完整 schema 见 bridge 仓库的 [`skill/dsh-python-plugin/references/manifest.md`](../../skill/dsh-python-plugin/references/manifest.md)。

## 测试

```sh
pip install -e .[test]
pytest
```

## 许可证

MIT。