# @deepseek-ai/dsh-python-bridge-codegen

[English](README.md) | 中文

Python Capability Bridge 的基于 AST 的 TypeScript 生成器。读取一个或多个 Python 源文件，扫描 `dsh_bridge` 装饰器调用，并产出符合 [`@deepseek-ai/dsh-python-bridge-runtime`](../python-bridge-runtime/README.md) 规范的 TypeScript bridge 包。生成器不执行用户源码，仅做静态扫描并生成产物。

## 用法

```sh
pnpm dsh-bridge-codegen src/my_provider.py --out packages/my-org-bridge --name @my-org/bridge
```

CLI 将诊断信息（装饰错误及其文件/行号）输出到 stderr，发现任何错误即以退出码 1 结束。

## 生成的包

生成器产出：

- `package.json` —— Cordis peer 依赖 + `@deepseek-ai/dsh-python-bridge-runtime` 运行时依赖。
- `src/index.ts` —— `Service` 子类（包含 `static Config` schemastery 模式）以及用于 tool consumer / listener 的 `apply()` 函数。
- `src/diagnostics.ts` —— 当发现装饰错误时产出。

## 公共库

```ts
import { generateBridgePackage, parseModuleSources, pythonTypeToTs } from '@deepseek-ai/dsh-python-bridge-codegen'

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
- **生成的 `initArgs` 仅做透传** —— 后续迭代会把 dataclass 字段暴露为命名 config key。

## 模型体验

无 —— 本包是构建时工具。

## 已知限制与未完成工作

- **不支持递归 glob 遍历** —— 请显式传入文件列表。后续迭代将引入 `tinyglobby`（或等价物）以提供更友好的体验。
- **无 initArgs ↔ dataclass 自省** —— 目前生成器输出 `initArgs` 透传占位符；与 `python_type_to_json_schema` 的集成将在后续版本中落地。