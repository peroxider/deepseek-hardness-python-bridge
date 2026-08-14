/**
 * Standalone-development stub for `@deepseek-ai/schemastery`.
 *
 * Minimal chainable `z` builder: every call returns a recorder object so the
 * generated bridge packages can be imported and their `static Config`
 * inspected offline. The real schemastery replaces this stub in the monorepo.
 */
function makeSchema(kind, args = {}) {
  return {
    kind,
    args,
    default: (value) => makeSchema(kind, { ...args, default: value }),
    optional: () => makeSchema(kind, { ...args, optional: true }),
  }
}

const z = {
  object: (shape) => makeSchema('object', { shape }),
  string: () => makeSchema('string'),
  number: () => makeSchema('number'),
  boolean: () => makeSchema('boolean'),
  array: (item) => makeSchema('array', { item }),
  enum: (values) => makeSchema('enum', { values }),
}

export default z
