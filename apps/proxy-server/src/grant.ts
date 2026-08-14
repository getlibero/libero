// The grant CLI's process shell. Composition only: everything it does lives in
// ./grant-cli.ts, where it can be tested without a process.
//
// `readLine` is readline over stdin with the prompt on stderr, so stdout stays
// exactly the lines the CLI means to print. It works on a TTY (`docker compose
// run` allocates one) and on a pipe, which is what the e2e suite drives; input
// closing before a line answers `null` rather than hanging.

import { createInterface } from "node:readline/promises";
import { runGrantCommand } from "./grant-cli.js";

process.exitCode = await runGrantCommand({
  argv: process.argv.slice(2),
  env: process.env,
  readLine: async prompt => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const closed = new Promise<null>(resolve => rl.once("close", () => resolve(null)));
      return await Promise.race([rl.question(prompt), closed]);
    } finally {
      rl.close();
    }
  },
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
