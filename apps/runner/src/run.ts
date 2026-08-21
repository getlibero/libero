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
import { DENIED_EVENT, HOP_LISTENING_EVENT } from "./hop-server.js";

/**
 * The scratch directory, and the only writable path in the container.
 *
 * A constant rather than configuration: the rootfs is read-only, so a program
 * needs somewhere to write, and letting the caller — or the operator — move it
 * buys nothing and adds a field that has to be validated as a path.
 */
export const SANDBOX_WORKDIR = "/work";

/**
 * How much scratch space the tmpfs gets: the channel's memory cap, exactly.
 *
 * Not a sheet field of its own, and the reason changed shape rather than going
 * away. The first version was a fixed 64 MiB, on the argument that tmpfs is
 * *memory* and a separate workdir size would be a way to spend the memory cap
 * without appearing to. That argument was right and the conclusion was wrong:
 * deriving the size from the cap is what actually makes it one bound instead of
 * two, because tmpfs pages are charged to the same cgroup — a program that fills
 * the workdir hits `memory_mb` and is killed for it, which is the behaviour
 * wanted and is what a fixed size could not give.
 *
 * 64 MiB was also simply too small for the thing people reach for first:
 * `pip install numpy` fails on it with "No space left on device". A channel that
 * wants to install packages raises `memory_mb`, which is the one number it
 * should have to think about.
 */
export const sandboxTmpfsBytes = (memoryMb: number): number => memoryMb * 1024 * 1024;

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
  /**
   * The hop's image and entrypoint, and the network that gives it a route out
   * (#219). Absent means this deployment cannot serve an `[egress]` grant.
   *
   * The hop runs the runner's *own* image with a different command, which is why
   * there is no second image to pin: it is this process's code, so if it were
   * substituted the runner would already be substituted.
   */
  readonly egress?: {
    readonly image: string;
    readonly command: readonly string[];
    /** A network with a default route. The hop joins it; the sandbox never does. */
    readonly network: string;
    readonly port: number;
    /** How long the hop gets to bind. Injected only so a test can shorten it. */
    readonly readyTimeoutMs?: number;
  };
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
  /**
   * Called when a sheet granted `[egress]` and this deployment has no hop
   * configured, so the run got no network at all.
   *
   * A log line rather than an error, and the run still happens. The alternative
   * — failing the call — would make a deployment that has not enabled egress
   * refuse a channel whose sheet is perfectly valid, which is a worse answer
   * than running it under a stricter rule and saying so.
   */
  readonly onEgressUnavailable?: () => void;
  /**
   * A fresh identifier per run, for naming the network and the hop.
   *
   * Injected rather than taken from `randomUUID` here so a test can make the
   * names it has to assert on predictable, and so this module has no clock and
   * no entropy of its own.
   */
  newRunId(): string;
}

/** Docker counts cpu in billionths, and accepts fractions of one core that way. */
const nanoCpus = (cpus: number) => Math.round(cpus * 1_000_000_000);

/** The hop's alias inside the per-run network. What the sandbox's proxy env names. */
export const HOP_ALIAS = "hop";

/** Where the runner image puts its code, and so where the hop has to run from. */
const HOP_WORKDIR = "/app";

/**
 * How long a hop gets to bind its port.
 *
 * Generous, because the cost of being wrong in each direction is asymmetric: a
 * few seconds of a slow start is invisible beside a container pull, and giving
 * up early turns a working deployment into one that reports connection failures
 * a channel cannot act on.
 */
const HOP_READY_TIMEOUT_MS = 30_000;

/**
 * Resolve when the hop says it is listening, or throw.
 *
 * Its own log stream, which is the same mechanism the denial watch uses and for
 * the same reason: it is the one channel the runner already has to a container
 * it started, and it needs no second network path between the two.
 */
async function waitForHop(options: RunOptions, hop: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const follow = options.docker.followLogs(hop, line => {
      try {
        if ((JSON.parse(line) as { event?: unknown }).event !== HOP_LISTENING_EVENT) return;
      } catch {
        return;
      }
      clearTimeout(timer);
      follow.stop();
      resolve();
    });
    const timer = setTimeout(() => {
      follow.stop();
      reject(new Error(`runner: the egress hop did not listen within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Everything one run created, so a `finally` can undo it in the right order.
 *
 * Containers before the network: Docker refuses to remove a network something
 * is still attached to, and a leaked network is a leaked bridge interface on the
 * host that nothing will ever clean up.
 */
interface Scaffolding {
  readonly sandbox: string;
  readonly hop?: string;
  readonly network?: string;
}

export async function runInSandbox(
  request: SandboxRunRequest,
  options: RunOptions
): Promise<SandboxRunResult> {
  const caps: SandboxCaps = request.caps;
  const wantsEgress = request.egressAllow.length > 0;

  if (wantsEgress && options.config.egress === undefined) {
    // A sheet granted hosts and this deployment cannot enforce the grant. The
    // safe reading is the narrow one: no network, and the caller is told the run
    // completed under a stricter rule than its sheet asked for. Quietly giving
    // it a route out would be the opposite.
    options.onEgressUnavailable?.();
  }
  const egress = wantsEgress ? options.config.egress : undefined;

  const scaffolding = await build(request, options, caps, egress);
  let denied: string | null = null;
  const follow =
    scaffolding.hop === undefined
      ? undefined
      : options.docker.followLogs(scaffolding.hop, line => {
          if (denied !== null) return;
          const host = deniedHostOf(line);
          if (host === null) return;
          denied = host;
          // Killed on the line rather than at the end of the run. This is what
          // makes the denial terminal (#393): the program loses the rest of its
          // work, which is the fail-closed direction and the stated cost.
          void options.docker.kill(scaffolding.sandbox).catch(() => undefined);
        });

  try {
    await options.docker.start(scaffolding.sandbox);
    const status = await options.docker.wait(scaffolding.sandbox, caps.timeoutSeconds * 1000);
    const logs = await readAfter(options, scaffolding.sandbox, status);

    // Checked before the timeout branch, because a killed sandbox stops
    // reporting a status and both paths arrive here with `status === null`. The
    // two are not the same answer: a timeout is a resource fact and this is a
    // governance decision, and the proxy turns only one of them into a refusal.
    if (denied !== null) {
      return { outcome: "egress_denied", stdout: logs.stdout, stderr: logs.stderr, exitCode: null, truncated: logs.truncated, deniedHost: denied };
    }

    if (status === null) {
      return { outcome: "timed_out", stdout: logs.stdout, stderr: logs.stderr, exitCode: null, truncated: logs.truncated, deniedHost: null };
    }

    return { outcome: "completed", stdout: logs.stdout, stderr: logs.stderr, exitCode: status, truncated: logs.truncated, deniedHost: null };
  } finally {
    follow?.stop();
    await teardown(options, scaffolding);
  }
}

/** Kill a run that outlived its cap, then read — the other order races a printer. */
async function readAfter(options: RunOptions, sandbox: string, status: number | null) {
  if (status === null) await options.docker.kill(sandbox).catch(() => undefined);
  return await options.docker.logs(sandbox, SANDBOX_MAX_OUTPUT_BYTES);
}

/** The hop's one line, or null for any other output it produced. */
function deniedHostOf(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { event?: unknown; host?: unknown };
    return parsed.event === DENIED_EVENT && typeof parsed.host === "string" ? parsed.host : null;
  } catch {
    return null;
  }
}

async function build(
  request: SandboxRunRequest,
  options: RunOptions,
  caps: SandboxCaps,
  egress: RunnerConfig["egress"]
): Promise<Scaffolding> {
  const sandboxSpec = {
    image: options.config.image,
    // The one place the caller's bytes enter the spec, and they enter as an
    // argument to a command this process chose — never as the command.
    command: [...options.config.command, request.code],
    workdir: SANDBOX_WORKDIR,
    tmpfs: SANDBOX_WORKDIR,
    memory: caps.memoryMb * 1024 * 1024,
    nanoCpus: nanoCpus(caps.cpus),
    tmpfsSize: sandboxTmpfsBytes(caps.memoryMb),
    pidsLimit: SANDBOX_PIDS_LIMIT
  } as const;

  if (egress === undefined) {
    const sandbox = await options.docker.create(sandboxSpec);
    return { sandbox: sandbox.id };
  }

  const runId = options.newRunId();
  const network = await options.docker.createNetwork(`libero-sandbox-${runId}`);
  try {
    const hop = await options.docker.create({
      image: egress.image,
      command: [...egress.command],
      // The runner image's own working directory, because the hop *is* the
      // runner image with another entrypoint and its code lives there. Its
      // scratch space goes somewhere else entirely — see `tmpfs` on the spec.
      workdir: HOP_WORKDIR,
      tmpfs: "/tmp",
      // The hop holds a socket table and nothing else. Its caps are this
      // module's rather than the sheet's: a channel sizing its own enforcement
      // point would be a channel deciding how hard its enforcement is to
      // exhaust.
      memory: 128 * 1024 * 1024,
      nanoCpus: nanoCpus(0.5),
      tmpfsSize: 1024 * 1024,
      pidsLimit: 64,
      network: { name: `libero-sandbox-${runId}`, alias: HOP_ALIAS },
      name: `libero-hop-${runId}`,
      env: [`HOP_ALLOW=${JSON.stringify([...request.egressAllow])}`, `HOP_PORT=${egress.port}`]
    });
    // The hop's second network, and the only route out of this run. The sandbox
    // never joins it, which is what stops an allowed host from becoming a path
    // back to anything else in the deployment.
    await options.docker.connectNetwork(egress.network, hop.id);
    await options.docker.start(hop.id);
    // **Wait for it to bind before the sandbox can dial it**, and this is a
    // correctness fix rather than a nicety. Starting a container returns when
    // the daemon has started it, not when the process inside has a listening
    // socket — so without this the sandbox races a hop that is still booting,
    // gets a connection refused, and reports a program that failed rather than
    // a destination that was denied. It passed on a fast machine and failed on
    // a loaded CI runner, which is the shape of every race.
    await waitForHop(options, hop.id, egress.readyTimeoutMs ?? HOP_READY_TIMEOUT_MS);

    const proxy = `http://${HOP_ALIAS}:${egress.port}`;
    const sandbox = await options.docker.create({
      ...sandboxSpec,
      network: { name: `libero-sandbox-${runId}` },
      // Both spellings, because clients disagree about which they read, and the
      // lowercase pair is what most of them actually check. NO_PROXY is empty on
      // purpose: there is no destination this run may reach directly.
      env: [
        `HTTP_PROXY=${proxy}`,
        `HTTPS_PROXY=${proxy}`,
        `http_proxy=${proxy}`,
        `https_proxy=${proxy}`,
        "NO_PROXY=",
        "no_proxy="
      ]
    });
    return { sandbox: sandbox.id, hop: hop.id, network };
  } catch (error) {
    await options.docker.removeNetwork(network).catch(() => undefined);
    throw error;
  }
}

/**
 * Undo everything, in the order Docker requires and none of it optional.
 *
 * #395's promise is that the container is gone when the call returns; #219 adds
 * two more things to that. A leaked network is a bridge interface nothing will
 * clean up, and the daemon refuses to remove one while a container is still
 * attached — so containers first, and the network last.
 */
async function teardown(options: RunOptions, scaffolding: Scaffolding): Promise<void> {
  const report = (reason: string) => options.onRemoveFailed?.(reason);
  await options.docker.remove(scaffolding.sandbox).catch((error: Error) => report(error.message));
  if (scaffolding.hop !== undefined) {
    await options.docker.remove(scaffolding.hop).catch((error: Error) => report(error.message));
  }
  if (scaffolding.network !== undefined) {
    await options.docker.removeNetwork(scaffolding.network).catch((error: Error) => report(error.message));
  }
}
