# Pitfall catalog — symptoms, causes, fixes

Defects hit by real conversions. Match the symptom before debugging from scratch.

## The call hangs forever

**Symptom**: `bridge.call(...)` / a service method never resolves.
**Cause**: the Python return value is not JSON-serializable (dataclass, Path, datetime…). Current runtimes downgrade to an `-32603/exception` error frame instead of hanging, but older ones hang.
**Fix**: convert returns to plain JSON types at the wrapper boundary.

## `dsh bridge: spawn argv is empty` / host process crash on boot

**Symptom**: dsh process exits; log shows spawn errors repeating.
**Cause**: a sandbox-seam contract mismatch — `confine()` returns a `ConfinedArgv` object, not an argv array — and the failure escaped the reconnect timer. Fixed in the runtime; if you see this, your runtime build is stale.
**Fix**: rebuild the runtime from current bridge-repo source and restart `dsh web`.

## `z.string(...).optional is not a function`

**Symptom**: plugin entry fails to apply with a schemastery TypeError.
**Cause**: generated code using zod idioms. Schemastery has no `.optional()` and no `z.enum` — properties are optional unless `.required()`; unions of literals replace enums.
**Fix**: regenerate with the current codegen.

## `unsupported JSON schema: schema.additionalProperties must be explicitly true or false`

**Cause**: a `@tool` parameters/output object schema lacks explicit `additionalProperties`.
**Fix**: add `"additionalProperties": False` to every object schema in the Python decorator.

## Tool registered but execute fails with a type error at build time

**Symptom**: `tsc` reports the tool's `execute` return not assignable to the schema-inferred type.
**Cause**: `Record<string, unknown>` vs `Record<string, JsonValue>` — fixed in current codegen (unknown → JsonValue projection for tool returns).
**Fix**: regenerate.

## A decorator "does nothing"

**Symptom**: the generated package lacks an expected service/tool/listener.
**Cause**: parser constraint violated — qualified call (`@dsh_bridge.service`), import alias, or non-keyword arguments. These are silently ignored.
**Fix**: rewrite the decorator to the constrained shape and regenerate; check `parsed.diagnostics`.

## `method not found` (-32601) for an existing method

**Cause**: `@provide_method` on a free function (must be inside the `@service` class), or the method name differs from the wire name.
**Fix**: move the method into the class; the wire name is the Python function name.

## `owner_required` / `not_owner` denials from LKB-style libraries

**Cause**: the host library requires claim-before-start.
**Fix**: see `references/contracts.md` — auto-claim in the wrapper.

## Schema error reported but the mutation succeeded

**Symptom**: a create/update tool returns a schema validation error listing undeclared fields, yet the task exists / state changed anyway.
**Cause**: the tool's return carries host envelope fields (`commandId`, `revision`, …) the `output_schema` never declared, and `additionalProperties: false` rejects them. The mutation commits before the ToolRuntime validates the return.
**Fix**: split payload shapes — model-facing tools return only domain fields + `decision` + `reason` (see `contracts.md` "Model-facing tool returns"); verify by compiling the declared schema and validating a real return value with dsh-tools' `valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue`.

## `dependency-missing` / `-32012` at spawn

**Symptom**: `ctx.pythonBridge.spawn(...)` (or the generic plugin mount) throws `PythonBridgeError` with `kind: 'dependency-missing'` and the message `pip install dsh-bridge`.
**Cause**: the configured `pythonBin` cannot `import dsh_bridge` — the runtime package is not installed in that interpreter (or `pythonBin` points at the wrong interpreter).
**Fix**: `pip install dsh-bridge` into the target interpreter, or set `pythonBin` to the interpreter that has it. The bridge probes with `pythonBin -c "import dsh_bridge"` before spawning, so a missing runtime is caught immediately instead of surfacing as a confusing `worker-exit`.

## Python child exits immediately (`worker-exit`, `-32011`)

**Cause**: the module fails to import inside the child — the child cwd lacks the packages.
**Fix**: the plugin root must contain every imported Python package (the installer's smoke step catches this). Check the child's stderr tail in the error message.

## Plugin changes do not take effect

**Cause**: the running instance holds the old artifacts in memory.
**Fix**: restart `dsh web` after rebuilding; the patch watcher hot-applies only entry-list changes, not rebuilt JS.

## Patch entry never mounts

**Cause**: the entry `name` is wrong — must be a `file://` URL to the built `lib/index.js`, not a `.ts` source (a built dsh install cannot strip types) and not a bare package name that exists nowhere.
**Fix**: check the URL resolves: `node -e "import('<url>').then(m=>console.log(Object.keys(m)))"`.
