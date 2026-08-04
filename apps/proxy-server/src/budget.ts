// The budget CLI's process shell. Composition only: everything it does lives in
// ./budget-cli.ts, where it can be tested without a process.

import { runBudgetCommand } from "./budget-cli.js";

process.exitCode = runBudgetCommand({
  argv: process.argv.slice(2),
  env: process.env,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
