// The operator's path into the price-drift record, run as an operator runs it
// (#239).
//
// ./budget-cli.ts's shape and its argument. The deployment's command is
//
//   docker compose run --rm proxy node dist/drift.js show
//
// and this is that command with the paths filled in. Calling `runDriftCommand`
// from this worker would demonstrate the arithmetic and skip the entrypoint, the
// two environment variables, and the exit code — and the exit code is part of
// what a case here claims: there is no failing status for a large difference,
// because nothing about this record enforces anything.
//
// The environment is built from nothing but `PATH` and the two variables the
// command reads, per proxy-process.ts.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** What the operator saw: the exit status and both streams, whole. */
export interface DriftCliResult {
  /** `null` only if a signal killed it, which nothing here sends. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The built `drift.js`, beside the entrypoint the proxy is spawned from. */
function driftEntrypoint(): string {
  const require = createRequire(import.meta.url);
  let index: string;
  try {
    index = require.resolve("@getlibero/proxy-server");
  } catch {
    throw new Error("e2e: @getlibero/proxy-server does not resolve. Run `pnpm -r build` first.");
  }
  const drift = join(dirname(index), "drift.js");
  if (!existsSync(drift)) {
    throw new Error(`e2e: ${drift} does not exist. Run \`pnpm -r build\` first.`);
  }
  return drift;
}

/**
 * Runs one drift command against a rig's record and resolves with what it said.
 *
 * Never rejects on a non-zero exit, per `runBudgetCli`: the status is part of
 * what a case asserts.
 */
export function runDriftCli(
  driftDb: string,
  priceTable: string | undefined,
  args: readonly string[]
): Promise<DriftCliResult> {
  const child = spawn(process.execPath, [driftEntrypoint(), ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      PROXY_DRIFT_DB: driftDb,
      // Absent rather than empty when the rig has no table, per
      // proxy-process.ts: the command's own "there is nothing to compare
      // against" path is a case worth being able to reach.
      ...(priceTable === undefined ? {} : { PROXY_PRICE_TABLE: priceTable })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  return new Promise<DriftCliResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}
