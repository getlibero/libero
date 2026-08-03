// The vault CLI's process shell. Composition only: everything it does lives in
// ./vault-cli.ts, where it can be tested without a process.

import { runVaultCommand } from "./vault-cli.js";

process.exitCode = await runVaultCommand({
  argv: process.argv.slice(2),
  env: process.env,
  readStdin: async () => {
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  },
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
