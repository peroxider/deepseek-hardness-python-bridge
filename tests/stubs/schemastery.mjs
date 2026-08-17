/**
 * Standalone-development stub for `@deepseek-ai/schemastery`.
 *
 * Mirrors the REAL schemastery semantics (vendor/schemastery): object
 * properties are optional unless `.required()`; there is no `.optional()`
 * method; literal unions replace `z.enum`. Every call returns a recorder
 * object so generated bridge packages can be imported and their
 * `static Config` inspected offline.
 */
function makeSchema(kind, args = {}) {
  return {
    kind,
    args,
    default: (value) => makeSchema(kind, { ...args, default: value }),
    required: (value = true) => makeSchema(kind, { ...args, required: value }),
  }
}

const z = {
  object: (shape) => makeSchema('object', { shape }),
  string: () => makeSchema('string'),
  number: () => makeSchema('number'),
  natural: () => makeSchema('natural'),
  boolean: () => makeSchema('boolean'),
  any: () => makeSchema('any'),
  array: (item) => makeSchema('array', { item }),
  dict: (item) => makeSchema('dict', { item }),
  union: (values) => makeSchema('union', { values }),
  const: (value) => makeSchema('const', { value }),
}

export default z
