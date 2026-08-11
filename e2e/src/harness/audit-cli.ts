// The operator's path into the audit log, run as an operator runs it.
//
// Spawned rather than called, on ./budget-cli.ts's argument and for one reason
// more. The budget CLI is spawned because a reset is a claim about *processes*;
// this one is spawned because it is a claim about a *connection*: the reader
// opens the file read-only while the proxy still holds it open for writing, and
// calling `openAuditReader` from this worker would demonstrate neither the
// second process nor the entrypoint, the env contract, and the exit code an
// operator sees.
//
// The deployment's command is
//
//   docker compose run --rm proxy node dist/audit.js list --channel C024BE91L
//
// and this is that command with the paths filled in.
//
// The environment is built from nothing but `PATH` and the one variable the CLI
// reads, per proxy-process.ts — a suite whose subject inherits the developer's
// `PROXY_*` is not testing what it claims.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** What the operator saw: the exit status and both streams, whole. */
export interface AuditCliResult {
  /** `null` only if a signal killed it, which nothing here sends. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The built `audit.js`, beside the entrypoint the proxy is spawned from. */
function auditEntrypoint(): string {
  const require = createRequire(import.meta.url);
  let index: string;
  try {
    index = require.resolve("@getlibero/proxy-server");
  } catch {
    throw new Error("e2e: @getlibero/proxy-server does not resolve. Run `pnpm -r build` first.");
  }
  const audit = join(dirname(index), "audit.js");
  if (!existsSync(audit)) {
    throw new Error(`e2e: ${audit} does not exist. Run \`pnpm -r build\` first.`);
  }
  return audit;
}

/**
 * Runs one audit command against a rig's log and resolves with what it said.
 *
 * Never rejects on a non-zero exit, as `runBudgetCli` does not: the status is
 * part of what a case asserts.
 */
export function runAuditCli(auditDb: string, args: readonly string[]): Promise<AuditCliResult> {
  const child = spawn(process.execPath, [auditEntrypoint(), ...args], {
    env: { PATH: process.env.PATH ?? "", PROXY_AUDIT_DB: auditDb },
    stdio: ["ignore", "pipe", "pipe"]
  });

  return new Promise<AuditCliResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}
