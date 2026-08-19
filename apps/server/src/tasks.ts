// The scheduled-checks CLI's process shell. Composition only: everything it does
// lives in ./tasks-cli.ts, where it can be tested without a process.

import { runTasksCommand } from "./tasks-cli.js";

process.exitCode = runTasksCommand({
  argv: process.argv.slice(2),
  env: process.env,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
