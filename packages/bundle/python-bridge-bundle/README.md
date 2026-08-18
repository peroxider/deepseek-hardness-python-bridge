# `@peroxider/dsh-python-bridge-bundle`

This out-of-tree dsh bundle installs the Python Capability Bridge packages and adds the runtime row required by the generic plugin. It leaves the generic plugin unmounted because each profile supplies its own Python module and import path.

Install it into a profile that already includes the official `@deepseek-ai/dsh-base` bundle:

```bash
dsh plugin install @peroxider/dsh-python-bridge-bundle
```

Then add one profile patch row:

```yaml
- id: my-python-plugin
  name: '@peroxider/dsh-python-bridge'
  config:
    module: my_package.bridge
    pythonBin: /absolute/path/to/.venv/bin/python
    pythonPath:
      - /absolute/path/to/python/src
```

The Python environment must contain `dsh-python-bridge`.
