#!/usr/bin/env node
/**
 * CLI entry point for the Python Capability Bridge codegen.
 *
 * Usage:
 *   dsh-bridge-codegen <python-source-glob> --out <ts-package-dir> \
 *     [--name <pkg>] [--module <python.module.path>]
 */
import { runCli } from '../lib/index.js'

const exitCode = runCli(process.argv.slice(2))
process.exit(exitCode)