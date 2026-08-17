#!/usr/bin/env node
/**
 * Thin driver over the codegen library's runCli so the installer script can
 * invoke code generation as a plain subprocess:
 *
 *   node --experimental-transform-types scripts/run-codegen.mjs \
 *     <source.py>... --out <dir> --name <pkg> --module <python.module>
 *
 * The codegen imports only node builtins, so no stub/workspace resolution is
 * needed here.
 */
import { runCli } from '../packages/bridge/python-bridge-codegen/src/index.ts'

process.exit(runCli(process.argv.slice(2)))
