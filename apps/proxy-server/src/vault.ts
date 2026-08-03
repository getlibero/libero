// The vault CLI's process shell. Composition only: everything it does lives in
// ./vault-cli.ts, where it can be tested without a process.

import { MAX_SECRET_BYTES } from "@getlibero/proxy";
import { runVaultCommand } from "./vault-cli.js";

process.exitCode = await runVaultCommand({
  argv: process.argv.slice(2),
  env: process.env,
  readStdin: async () => {
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      // Just past the cap is enough to fail the size check — `vault set
      // <name> < /dev/zero` should exit with value_too_large, not buffer the
      // pipe until the process dies.
      if (total > MAX_SECRET_BYTES) break;
    }
    return Buffer.concat(chunks);
  },
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`)
});
