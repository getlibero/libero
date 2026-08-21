// One run: create, start, wait, read, remove.
//
// **This file is where the narrow endpoint is actually narrow.** ./docker.ts
// would send whatever spec it is handed; what makes a compromised proxy unable
// to ask for a privileged container mounting the host's root filesystem is that
// the spec below is built from two sources — this process's environment and the
// request's three numeric caps — and from nothing else. `SandboxRunRequest` has
// no field that reaches `Image`, `Cmd`, `Binds`, `Privileged` or a capability
// set, and the way to keep that true is to keep this function's inputs to what
// they are now.
//
// #393's argument for the whole shape is in packages/proxy/README.md under
// "Reaching a runtime". The short version: the socket did not come back, it
// moved to a process holding no credential.
//
// ## The timeout is not a refusal
//
// A run that outlives its cap is killed, and the caller is told. That is a
// resource fact — the request was served, and what it produced up to the kill is
// a real answer. It is deliberately not the shape an `[egress]` denial takes
// (#219), which *is* a governance decision and does refuse. Collapsing the two
// would make an operator reading the audit log unable to tell "this program
// looped" from "this program tried to reach a host the sheet forbids".

import type { SandboxCaps, SandboxRunRequest, SandboxRunResult } from "@getlibero/schema";
import { SANDBOX_MAX_OUTPUT_BYTES } from "@getlibero/schema";
import type { DockerClient } from "./docker.js";

/**
 * The scratch directory, and the only writable path in the container.
 *
 * A constant rather than configuration: the rootfs is read-only, so a program
 * needs somewhere to write, and letting the caller — or the operator — move it
 * buys nothing and adds a field that has to be validated as a path.
 */
export const SANDBOX_WORKDIR = "/work";

/**
 * How much scratch space the tmpfs gets, in bytes.
 *
 * Deliberately not a sheet field. tmpfs is *memory*, so a large workdir is a way
 * to spend the memory cap without appearing to, and a channel that could set
 * both would be setting one bound twice. Fixed here, and small.
 */
export const SANDBOX_TMPFS_BYTES = 64 * 1024 * 1024;

/**
 * The most processes a run may have.
 *
 * A fork bomb is the cheapest way to make a machine unusable, and neither the
 * cpu nor the memory cap stops one on its own. Not a sheet field for the reason
 * the tmpfs is not: nobody sizing a workload thinks in process counts, and the
 * number that matters is "enough for a normal program, far short of a bomb".
 */
export const SANDBOX_PIDS_LIMIT = 128;

export interface RunnerConfig {
  /** Digest-pinned, from the environment. Never from a request. */
  readonly image: string;
  /** The interpreter and its flags; the code is appended as the final argument. */
  readonly command: readonly string[];
}

export interface RunOptions {
  readonly docker: DockerClient;
  readonly config: RunnerConfig;
  /**
   * Where a failed removal goes.
   *
   * Optional, because the caller that has one is the server and the callers that
   * do not are tests. Not optional in spirit: a removal that fails silently is a
   * container holding a tmpfs full of whatever the last run wrote, and the
   * operator's first sign of it is a full disk.
   */
  readonly onRemoveFailed?: (reason: string) => void;
}

/** Docker counts cpu in billionths, and accepts fractions of one core that way. */
const nanoCpus = (cpus: number) => Math.round(cpus * 1_000_000_000);

export async function runInSandbox(
  request: SandboxRunRequest,
  options: RunOptions
): Promise<SandboxRunResult> {
  const caps: SandboxCaps = request.caps;
  const created = await options.docker.create({
    image: options.config.image,
    // The one place the caller's bytes enter the spec, and they enter as an
    // argument to a command this process chose — never as the command.
    command: [...options.config.command, request.code],
    workdir: SANDBOX_WORKDIR,
    memory: caps.memoryMb * 1024 * 1024,
    nanoCpus: nanoCpus(caps.cpus),
    tmpfsSize: SANDBOX_TMPFS_BYTES,
    pidsLimit: SANDBOX_PIDS_LIMIT
  });

  try {
    await options.docker.start(created.id);
    const status = await options.docker.wait(created.id, caps.timeoutSeconds * 1000);

    if (status === null) {
      // Killed first, then read. The other order races a program that is still
      // printing, and would return a transcript that keeps growing after the
      // deadline the channel set.
      await options.docker.kill(created.id);
      const logs = await options.docker.logs(created.id, SANDBOX_MAX_OUTPUT_BYTES);
      return { outcome: "timed_out", stdout: logs.stdout, stderr: logs.stderr, exitCode: null, truncated: logs.truncated };
    }

    const logs = await options.docker.logs(created.id, SANDBOX_MAX_OUTPUT_BYTES);
    return { outcome: "completed", stdout: logs.stdout, stderr: logs.stderr, exitCode: status, truncated: logs.truncated };
  } finally {
    // #395's second promise: the container is gone when the call returns,
    // success or failure. In a `finally` because "failure" includes this
    // function throwing, and a leaked container is a leaked tmpfs holding
    // whatever the last run wrote.
    //
    // A remove that itself fails must not mask the run's own error — letting it
    // throw out of a `finally` replaces a useful error with a less useful one —
    // so it is caught and *reported* rather than swallowed. The distinction
    // matters: the first version of this discarded the error while its comment
    // claimed the log had it, which is the kind of sentence that survives a
    // review because it sounds like it is describing something.
    await options.docker.remove(created.id).catch((error: Error) => {
      options.onRemoveFailed?.(error.message);
    });
  }
}
