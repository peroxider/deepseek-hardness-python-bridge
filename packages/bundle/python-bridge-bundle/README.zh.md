# `@peroxider/dsh-python-bridge-bundle`

这是一个树外 dsh bundle，负责安装 Python Capability Bridge 包，并添加 generic plugin 所需的 runtime 行。由于每个 profile 的 Python 模块和导入路径不同，它不会自动挂载 generic plugin。

在已经包含官方 `@deepseek-ai/dsh-base` bundle 的 profile 中安装：

```bash
dsh plugin install @peroxider/dsh-python-bridge-bundle
```

然后在 profile patch 中添加一行：

```yaml
- id: my-python-plugin
  name: '@peroxider/dsh-python-bridge'
  config:
    module: my_package.bridge
    pythonBin: /absolute/path/to/.venv/bin/python
    pythonPath:
      - /absolute/path/to/python/src
```

目标 Python 环境必须安装 `dsh-python-bridge`。
