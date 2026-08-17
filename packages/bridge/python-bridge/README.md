# `@deepseek-ai/dsh-python-bridge`

This Cordis plugin loads one decorated Python module without generating a TypeScript package. It starts the module through `ctx.pythonBridge`, waits for its manifest, registers the first declared service and its methods, registers every tool with the manifest JSON Schemas, and forwards declared events to the Python child.

## Configuration

```yaml
- id: my-python-module
  name: '@deepseek-ai/dsh-python-bridge'
  config:
    module: my_package.bridge
    className: MyService
    pythonPath:
      - /absolute/path/to/python/src
    initArgs:
      storage_path: /absolute/path/to/data
```

`module` is required. `className` is required when the module exposes `@provide_method` methods on a decorated class. `functions` names additional module callables. `initArgs` uses Python parameter names. `pythonPath` entries precede the inherited `PYTHONPATH`. `pythonBin`, `sandbox`, `graceMs`, and `reconnect` configure the owned Python child.

## Generic and codegen paths

Use this package by default when deployment does not require generated TypeScript service signatures or per-field schemastery configuration. The module manifest is the runtime source for service methods, tools, listeners, and JSON Schemas, so changing Python declarations requires only a child restart.

Use `@deepseek-ai/dsh-python-bridge-codegen` when TypeScript consumers require statically typed `ctx.<service>` methods or when each Python dataclass field must appear as its own documented Cordis config field. Both paths use the same Python runtime and wire behavior.

## Model Experience

The plugin adds only the tools declared by the Python module. Their names, descriptions, parameter schemas, and result schemas reach the model through `ctx.tools`; service methods and event listeners do not add prompt text by themselves.

## Known Limitations and Deferred Work

The generic service type is dynamic, and only the first service in a module is registered. A service class cannot be inferred before the Python worker starts, so class-based modules must configure `className` explicitly.
