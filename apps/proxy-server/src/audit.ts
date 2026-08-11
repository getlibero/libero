// The audit CLI's process shell. Composition only: everything it does lives in
// ./audit-cli.ts, where it can be tested without a process.

import { runAuditCommand } from "./audit-cli.js";

process.exitCode = runAuditCommand({
  argv: process.argv.slice(2),
  env: process.env,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
