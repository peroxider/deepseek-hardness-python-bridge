# Python bridge wire protocol stability

English | [中文](protocol.zh.md)

This document defines the compatibility promise between `@peroxider/dsh-python-bridge-runtime` and the Python `dsh-bridge` runtime. The transport is newline-delimited JSON-RPC 2.0 over stdio. A protocol version is compatible when its major component matches the peer's major component; a different major is rejected during `initialize` as `protocol-mismatch` (`-32006`).

## Version handshake

The TypeScript client starts with `initialize` and sends `clientInfo: { name, version }`. The Python server returns `serverInfo: { name, version }` and `manifest` when the majors match. Versions use dotted decimal text; the first numeric component is the protocol major. Missing or unparsable version data is accepted for legacy peers, but maintained TypeScript clients always send a parseable version.

Within one major, protocol releases may add optional request fields, result fields, manifest fields, notifications, error kinds, and categories of dynamically advertised methods. They do not remove or rename existing fixed protocol fields or methods, change a field's JSON type or meaning, make an optional field required, or reuse an error code or kind for a different condition. Any such incompatible change requires a coordinated major bump in the TypeScript client version and Python package version. A module's own dynamic methods may change when that module's decorators change; the manifest describes that module instance rather than promising its application API forever.

## Method and notification set

Fixed client-to-server control messages:

| Method | Frame | Parameters/result |
| --- | --- | --- |
| `initialize` | request | Sends `cwd` and `clientInfo {name, version}`; returns `serverInfo {name, version}` and `manifest`. |
| `shutdown` | notification | Sends an empty object and starts worker shutdown; no response is expected. |

The manifest's `methods` array advertises dynamic request names. These names cover decorated service methods, tools, capability methods, and explicitly registered functions. Their parameters are JSON objects mapped to Python keyword arguments; their results must be JSON values. A client must not infer an unadvertised dynamic method.

Stable notifications are:

| Direction | Method | Purpose |
| --- | --- | --- |
| TypeScript → Python | `event/deliver` | Deliver a named Cordis event and payload to matching Python listeners. |
| TypeScript → Python | `log/notify` | Write a TypeScript diagnostic through the Python logger. |
| Python → TypeScript | `bridge/log` | Forward Python logging and proxied stdout diagnostics. |

Unknown notifications are ignored so a newer peer can add notifications within the same major. Unknown requests receive JSON-RPC `-32601` and must not be retried under another name.

## Error kind dictionary

JSON-RPC failures carry a stable machine-readable `error.data.kind`. Consumers must preserve unknown kinds and may treat them as `exception`; they must not reject an otherwise valid response solely because a newer same-major peer added a kind.

| Code | Kind | Meaning |
| --- | --- | --- |
| `-32001` | `timeout` | The Python call exceeded its deadline. |
| `-32002` | `abort` | The call was cancelled. |
| `-32003` | `permission` | Policy denied the operation. |
| `-32004` | `invalid-args` | Call arguments were invalid. |
| `-32005` | `not-found` | A referenced name or attribute was absent. |
| `-32006` | `protocol-mismatch` | Client and server protocol majors differ. |
| `-32010` | `bridge-down` | The transport is unavailable. |
| `-32011` | `worker-exit` | The Python worker exited during a call. |
| `-32012` | `dependency-missing` | The configured interpreter cannot import `dsh_bridge`. |
| `-32603` | `exception` | An unclassified Python or serialization failure occurred. |

`-32601` is the standard JSON-RPC method-not-found response and may omit `data.kind`. Custom `PythonBridgeError` subclasses may add kinds under `-32603`; names in the table above are reserved and retain their stated meanings.

## Manifest evolution

The `initialize` manifest contains these stable top-level arrays: `services`, `provideMethods`, `tools`, `listeners`, `capabilities`, `capabilityMethods`, `promptSections`, and `methods`.

Readers must ignore unknown object fields and unknown top-level manifest fields. Writers may append optional fields without a major bump. Existing fields are additive-only within a major: their names, JSON types, nullability, and meanings remain stable. A new decorator surface may add a top-level array or optional member; removing a field, changing its interpretation, or requiring an older reader to act on a new field requires a major bump.

Collection order is descriptive unless a field explicitly carries ordering semantics. `promptSections.order` is semantic; consumers must not assign meaning to the incidental order of other arrays. Names in `methods` are the authority for callable dynamic requests, while the richer arrays provide registration metadata.
