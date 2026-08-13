#!/usr/bin/env node
// The `libero` process shell. Composition only: everything it does lives in
// ./cli.ts, where it can be tested without a process.

import { runCli } from "./cli.js";

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
