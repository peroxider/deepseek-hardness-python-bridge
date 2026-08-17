# `@peroxidess/dsh-python-bridge`

这个 Cordis 插件无需生成 TypeScript 包即可加载一个带装饰器的 Python 模块。它通过 `ctx.pythonBridge` 启动模块，等待 manifest，注册第一个声明的 service 及其方法，把每个工具连同 manifest JSON Schema 注册到工具运行时，并把声明的事件转发给 Python 子进程。

## 配置

```yaml
- id: my-python-module
  name: '@peroxidess/dsh-python-bridge'
  config:
    module: my_package.bridge
    className: MyService
    pythonPath:
      - /absolute/path/to/python/src
    initArgs:
      storage_path: /absolute/path/to/data
```

`module` 必填。模块通过装饰类上的 `@provide_method` 暴露方法时，`className` 必填。`functions` 指定额外的模块级可调用对象；`initArgs` 使用 Python 参数名；`pythonPath` 条目排在继承的 `PYTHONPATH` 之前；`pythonBin`、`sandbox`、`graceMs` 与 `reconnect` 配置插件拥有的 Python 子进程。

## 通用路径与 codegen 路径

部署不需要生成的 TypeScript service 签名或逐字段 schemastery 配置时，默认使用本包。模块 manifest 是 service 方法、工具、监听器和 JSON Schema 的运行时来源，因此修改 Python 声明后只需重启子进程。

TypeScript 消费者需要静态类型的 `ctx.<service>` 方法，或者每个 Python dataclass 字段都必须成为独立且带文档的 Cordis 配置字段时，使用 `@peroxidess/dsh-python-bridge-codegen`。两条路径共用相同的 Python 运行时和线协议行为。

## 模型体验

插件只增加 Python 模块声明的工具。工具名称、描述、参数 schema 和结果 schema 通过 `ctx.tools` 进入模型；service 方法和事件监听器本身不增加提示词。

## 已知限制与延期工作

通用 service 类型是动态的，并且一个模块只注册第一个 service。插件无法在 Python worker 启动前推断 service 类，因此基于类的模块必须显式配置 `className`。
