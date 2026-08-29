// The drift CLI's process shell. Composition only: everything it does lives in
// ./drift-cli.ts, where it can be tested without a process.

import { runDriftCommand } from "./drift-cli.js";

process.exitCode = runDriftCommand({
  argv: process.argv.slice(2),
  env: process.env,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
