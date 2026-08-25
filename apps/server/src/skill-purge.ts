// The skill-purge CLI's process shell. Composition only: everything it does
// lives in ./skill-purge-cli.ts, where it can be tested without a process.
//
// Shorter than ./rebuild.ts's shell because there is less to supply. This command
// reaches no provider and no proxy — it calls no model, spends nothing, and so
// has nothing to report to a meter. That absence is the same fact from both
// sides as the lifecycle job's: a command with nothing to spend with is a command
// no budget has an opinion about.

import { runSkillPurgeCommand } from "./skill-purge-cli.js";

process.exitCode = runSkillPurgeCommand({
  argv: process.argv.slice(2),
  env: process.env,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
