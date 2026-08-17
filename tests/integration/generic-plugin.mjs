/** Run the external LKB composition through the manifest-driven plugin. */
process.env.DSH_GENERIC_BRIDGE = '1'
await import('./lkb-composition.mjs')
