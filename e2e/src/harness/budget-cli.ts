// The operator's path into the meter, run as an operator runs it.
//
// `budget reset` is the one verb that makes a hard limit soft again, and
// budget-cli.ts's header is a claim about *processes*: the proxy has no admin
// principal, so a reset is a second process against the same file, and WAL plus
// an uncached meter is what makes it take effect on the running proxy's next
// call with no restart and no signal. Calling `resetChannel` from this worker
// would demonstrate the file-sharing half and skip the entrypoint, the env
// contract, and the exit code an operator actually sees.
//
// So it is spawned, for the reason the proxy is: the deployment's command is
//
//   docker compose run --rm proxy node dist/budget.js reset C024BE91L
//
// and this is that command with the paths filled in.
//
// The environment is built from nothing but `PATH` and the one variable the CLI
// reads, per proxy-process.ts. A security suite whose subject inherits the
// developer's `PROXY_*` is not testing what it claims — and here it would be
// worse than usual, since a stray `PROXY_BUDGET_DB` would reset a database no
// case is looking at and the assertion would fail somewhere else entirely.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** What the operator saw: the exit status and both streams, whole. */
export interface BudgetCliResult {
  /** `null` only if a signal killed it, which nothing here sends. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The built `budget.js`, beside the entrypoint the proxy is spawned from.
 *
 * Resolved through the package rather than by walking up from `import.meta.url`
 * so it survives this file moving, and checked for existence with the same
 * message proxy-process.ts uses — a missing build should say so once, in the
 * words the README repeats, rather than as a node loader error.
 */
function budgetEntrypoint(): string {
  const require = createRequire(import.meta.url);
  let index: string;
  try {
    index = require.resolve("@getlibero/proxy-server");
  } catch {
    throw new Error("e2e: @getlibero/proxy-server does not resolve. Run `pnpm -r build` first.");
  }
  const budget = join(dirname(index), "budget.js");
  if (!existsSync(budget)) {
    throw new Error(`e2e: ${budget} does not exist. Run \`pnpm -r build\` first.`);
  }
  return budget;
}

/**
 * Runs one budget command against a rig's meter and resolves with what it said.
 *
 * Never rejects on a non-zero exit: the status is part of what a case asserts,
 * and a usage error should read as `status: 2` beside the stderr that explains
 * it rather than as a thrown string a test has to parse.
 */
export function runBudgetCli(budgetDb: string, args: readonly string[]): Promise<BudgetCliResult> {
  const child = spawn(process.execPath, [budgetEntrypoint(), ...args], {
    env: { PATH: process.env.PATH ?? "", PROXY_BUDGET_DB: budgetDb },
    stdio: ["ignore", "pipe", "pipe"]
  });

  return new Promise<BudgetCliResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // No cleanup entry: the process is awaited here and is gone before the case
    // continues, so there is nothing for a teardown stack to hold.
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}
