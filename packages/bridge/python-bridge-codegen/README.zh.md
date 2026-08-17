# @peroxidess/dsh-python-bridge-codegen

[English](README.md) | 中文

Python Capability Bridge 的基于 AST 的 TypeScript 生成器。读取一个或多个 Python 源文件，扫描 `dsh_bridge` 装饰器调用，并产出符合 [`@peroxidess/dsh-python-bridge-runtime`](../python-bridge-runtime/README.md) 规范的 TypeScript bridge 包。生成器不执行用户源码，仅做静态扫描并生成产物。

## 用法

```sh
pnpm dsh-bridge-codegen src/my_provider.py --out packages/my-org-bridge --name @my-org/bridge
```

CLI 将诊断信息（装饰错误及其文件/行号）输出到 stderr，发现任何错误即以退出码 1 结束。

## 生成的包

生成器产出：

- `package.json` —— Cordis peer 依赖 + `@peroxidess/dsh-python-bridge-runtime` 运行时依赖。
- `src/index.ts` —— `Service` 子类（包含 `static Config` schemastery 模式）以及用于 tool consumer / listener 的 `apply()` 函数。
- `src/diagnostics.ts` —— 当发现装饰错误时产出。

## 公共库

```ts
import { generateBridgePackage, parseModuleSources, pythonTypeToTs } from '@peroxidess/dsh-python-bridge-codegen'

const parsed = parseModuleSources([
  { path: 'provider.py', contents: sourceText },
])
const artifacts = generateBridgePackage({
  module: 'my_pkg.provider',
  packageName: '@my-org/bridge',
  sources: [{ path: 'provider.py', contents: sourceText }],
})
```

## 类型推断

生成器与 Python `dsh_bridge._type_inference` 的子集对齐：

| Python 注解 | TypeScript |
| --- | --- |
| `int` / `float` | `number` |
| `bool` | `boolean` |
| `str` | `string` |
| `bytes` | `string`（base64） |
| `list[T]` | `T[]` |
| `dict[str, T]` | `Record<string, T>` |
| `Optional[T]` / `T \| None` | `T \| null` |
| `T \| U` / `Union[T, U]` | `T \| U` |

## 限制

- **无完整 Python AST** —— 解析器基于正则约束于 `dsh_bridge` 装饰器的形状。仅关键字参数之外的装饰器写法暂不支持。
- **不支持 `**/*.py` 递归遍历** —— 请显式传入文件列表或包含 `.py` 的目录。

## 生成包的两种形态

- **模块含 `@service`** —— 默认导出的 `Service` 类。Dataclass 字段成为命名 config key（`model_path` → `modelPath`）并带 zod 默认值；构造函数再把它们映射回 snake_case 的 `initArgs`。同模块的工具与监听器注册到同一个共享 bridge（每个 Service Provider 实例一个 Python 子进程，spec §6.1）。
- **模块不含 `@service`** —— 函数插件（命名导出 `name` / `inject` / `Config` / `apply`，按 `packages/AGENTS.md` 约定无默认导出）。`apply()` 为模块内所有工具与监听器派生一个共享 bridge。

## 模型体验

无 —— 本包是构建时工具。

## 已知限制与未完成工作

- **不支持递归 glob 遍历** —— 请显式传入文件列表。后续迭代将引入 `tinyglobby`（或等价物）以提供更友好的体验。
- **每个模块只发射第一个 `@service` 类** —— 其余 service 请拆到独立模块以生成独立包。
- **非 dataclass 的 `__init__` 参数不做自省** —— 仅类级注解字段会成为 config key；其他类回退到 `pickInitArgs` 透传。
- **`@capability` / `@guard` / `@restrict_tools` / `@system_prompt_section` 的发射尚未接线** —— 这些装饰器会被解析但暂不产生生成代码。