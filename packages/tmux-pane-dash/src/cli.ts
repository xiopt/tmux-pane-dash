#!/usr/bin/env node
import process from "node:process"
import { nodeDependencies } from "./dependencies"
import { escapeOutput, exitStatusFor } from "./errors"
import { runCli } from "./runtime"

runCli(process.argv.slice(2), nodeDependencies()).then(
  (status) => { process.exitCode = status },
  (error: unknown) => {
    const code = error instanceof Error ? error.message : "E_INTERNAL"
    process.stderr.write(`${escapeOutput(code)}\n`)
    process.exitCode = exitStatusFor(error)
  },
)
