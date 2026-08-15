# Bridge runtime manifest (initialize)

The Python bridge child answers the `initialize` request with `serverInfo` and a `manifest` that lists every dynamically registered surface. The generic plugin builds the TypeScript plugin surface from this document at runtime; codegen consumers use the same field vocabulary offline. The manifest is a JSON object with these top-level arrays:

```json
{
  "services": [...],
  "provideMethods": [...],
  "tools": [...],
  "listeners": [...],
  "capabilities": [...],
  "capabilityMethods": [...],
  "promptSections": [...],
  "methods": [...]
}
```

## `services[]`

One entry per `@service` class:

- `name` — the `ctx.<name>` registration key.
- `class` — the Python class name.
- `initFields` — the dataclass constructor fields, each `{ "name", "annotation", "default"? | "defaultFactory"? }`. `annotation` is the PEP 484 annotation string (or `"unknown"` when it cannot render). `default` is present only when the field default is JSON-safe; `defaultFactory` carries the factory name otherwise. Non-dataclass services report `[]` — their constructor is opaque to the bridge.

## `provideMethods[]`

One entry per `@provide_method`:

- `name`, `timeoutMs`, `concurrencySafe`
- `parameters` — map of parameter name to PEP 484 annotation string (e.g. `{"texts": "list[str]"}`); `self` and `cls` are excluded.
- `return` — the return annotation string (e.g. `"list[list[float]]"`), or `null` when the method declares none. An explicit `-> None` renders as `"None"`.

## `tools[]`

One entry per `@tool`:

- `name`, `description`
- `parameters` — the JSON Schema passed to `@tool(parameters=...)`.
- `outputSchema` — the `output_schema` value, or `null`.

The generic plugin registers the tool with these schemas verbatim. Every object in a schema must set `"additionalProperties": false` explicitly — the dsh-tools compiler rejects implicit objects.

## `listeners[]`

One entry per `@on`:

- `event`, `mode`, `prepend`, `global`
- `function` — the Python function name, for diagnostics.

## Other sections

- `capabilities[]` — `{ seam, backend, class }` per `@capability`.
- `capabilityMethods[]` — names of `@method`-decorated backend methods.
- `promptSections[]` — `{ order, text, function }` per `@system_prompt_section`.
- `methods` — the flat list of wire-callable method names (service methods plus tools) the router exposes.
