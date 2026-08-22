// The sandbox runner, spawned as its built entrypoint (#396).
//
// The same shape ./proxy-process.ts uses and for the same reason: the suite's
// claim is that the *shipped* code agrees with itself, and a runner composed
// in-process would be this file's opinion about how `apps/runner/src/index.ts`
// wires itself rather than that file doing it.
//
// **It needs a Docker daemon**, which nothing else in this suite does. That is
// what makes it opt-in per case rather than part of every rig: a machine with no
// daemon still runs every other file, and the cases here say so out loud rather
// than skipping quietly. `isDaemonAvailable` is the probe, and the gate is
// two-sided in `sandbox-attack.test.ts` — no daemon and not CI skips, no daemon
// and CI fails.
//
// ## What this deliberately does not fake
//
// Nothing. #396's acceptance is that the positive controls fail if the runner is
// stubbed out, and a stub is exactly what would make the exfiltration case
// vacuous: "the unlisted host reached nothing" is true of a runner that reaches
// nothing at all. So the runner is the real process, it starts real containers,
// and the allowed host is a real listener the case can read.

import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cleanup } from "./cleanup.js";

const READY_TIMEOUT_MS = 20_000;
const TERM_GRACE_MS = 5_000;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The image a sandbox run executes. Tagged rather than digest-pinned — see `sandboxImageFromEnv`. */
export const SANDBOX_IMAGE = "python:3.13-alpine";

/** The runner's own image, which the egress hop runs with a second entrypoint. */
export const RUNNER_IMAGE = process.env["RUNNER_IMAGE"] ?? "ghcr.io/getlibero/runner:latest";

/**
 * The network a hop joins for its route out, and the one the allowed listener
 * sits on so a sandbox can reach it by name.
 *
 * Docker's default bridge would do for the route, but not for the name: the
 * default bridge has no embedded DNS, so a container on it is not resolvable by
 * name and the hop could not dial the listener the case stood up. A
 * user-defined network gets both.
 */
export const EGRESS_NETWORK = "libero-e2e-egress";

export interface RunnerEnv {
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly tlsCa: string;
  /** The one client certificate this runner serves — the proxy's. */
  readonly clientPin: string;
  /** Absent gives every run `network: none`, whatever a sheet's `[egress]` says. */
  readonly egressNetwork?: string;
  /**
   * The deployment's ceiling over a sheet's caps (#405), or absent for none.
   *
   * Absent everywhere but the one case that is about it, which is the same rule
   * `egressNetwork` follows: a fixture that quietly bounded every run would
   * make the other sandbox cases assert against numbers they never asked for.
   */
  readonly maxMemoryMb?: number;
}

export interface RunnerProcess {
  /** `https://127.0.0.1:<bound port>` — what `RUNNER_URL` is set to. */
  readonly url: string;
  readonly lines: readonly string[];
}

/** Where this host's Docker socket is, or `null` if there is none. */
export function dockerSocketPath(): string | null {
  const named = process.env["RUNNER_DOCKER_SOCKET"];
  const home = process.env["HOME"] ?? "";
  const candidates =
    named === undefined || named === ""
      ? ["/var/run/docker.sock", `${home}/.orbstack/run/docker.sock`, `${home}/.docker/run/docker.sock`]
      : [named];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isSocket()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function entrypoint(): string {
  const require = createRequire(import.meta.url);
  let resolved: string;
  try {
    resolved = require.resolve("@getlibero/runner");
  } catch {
    throw new Error("e2e: @getlibero/runner does not resolve. Run `pnpm -r build` first.");
  }
  if (!existsSync(resolved)) {
    throw new Error(`e2e: ${resolved} does not exist. Run \`pnpm -r build\` first.`);
  }
  return resolved;
}

/**
 * Make sure the images and the network a sandbox case needs are there.
 *
 * The runner image is built rather than assumed, for the reason
 * `apps/runner/src/sandbox.docker.test.ts` builds it: depending on another CI
 * job's side effect works until somebody reorders a workflow.
 *
 * A bind mount of `dist` would be faster and is the thing to refuse — the
 * runner's `ContainerSpec` has no `Binds` because a spec field reaching the host
 * filesystem is what the request shape was designed to make impossible, and a
 * test is not a reason to add one.
 */
export function prepareSandboxFixtures(): void {
  execFileSync("docker", ["pull", "--quiet", SANDBOX_IMAGE], { stdio: "pipe", timeout: 600_000 });

  try {
    execFileSync("docker", ["image", "inspect", RUNNER_IMAGE], { stdio: "pipe" });
  } catch {
    execFileSync("docker", ["build", "-f", "apps/runner/Dockerfile", "-t", RUNNER_IMAGE, "."], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 900_000
    });
  }

  try {
    execFileSync("docker", ["network", "inspect", EGRESS_NETWORK], { stdio: "pipe" });
  } catch {
    // Not `internal`: this is the network that has a route out, and the per-run
    // ones the runner creates are the internal half. Left in place between runs
    // rather than removed — it holds nothing, and removing it would race a
    // parallel file that is still using it.
    execFileSync("docker", ["network", "create", EGRESS_NETWORK], { stdio: "pipe" });
  }
}

/**
 * Spawns the runner and resolves once it is listening.
 *
 * Readiness is the process's own `listening` line carrying the bound port, for
 * ./proxy-process.ts's reason: `RUNNER_PORT` is 0, so the OS chooses and nothing
 * here reserves a port and races the rest of the host.
 */
export async function spawnRunner(cleanup: Cleanup, env: RunnerEnv): Promise<RunnerProcess> {
  const socketPath = dockerSocketPath();
  if (socketPath === null) throw new Error("e2e: no Docker socket. A sandbox case cannot run without one.");

  const lines: string[] = [];
  // Built from nothing but PATH, exactly as the proxy's is: a developer's own
  // RUNNER_* must not reach the process under test.
  const child: ChildProcess & { stdout: NonNullable<ChildProcess["stdout"]> } = spawn(
    process.execPath,
    [entrypoint()],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        RUNNER_HOST: "127.0.0.1",
        RUNNER_PORT: "0",
        RUNNER_DOCKER_SOCKET: socketPath,
        // A digest, because the runner refuses a floating tag at boot. Resolved
        // from the local daemon rather than written down: a digest in this file
        // would pin a published layer and rot when it is collected.
        RUNNER_SANDBOX_IMAGE: `${SANDBOX_IMAGE}@${localDigest(SANDBOX_IMAGE)}`,
        RUNNER_SANDBOX_COMMAND: JSON.stringify(["python3", "-c"]),
        RUNNER_IMAGE,
        RUNNER_TLS_CERT: env.tlsCert,
        RUNNER_TLS_KEY: env.tlsKey,
        RUNNER_TLS_CA: env.tlsCa,
        RUNNER_CLIENT_PIN: env.clientPin,
        ...(env.egressNetwork === undefined ? {} : { RUNNER_EGRESS_NETWORK: env.egressNetwork }),
        ...(env.maxMemoryMb === undefined ? {} : { RUNNER_MAX_MEMORY_MB: String(env.maxMemoryMb) })
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  ) as ChildProcess & { stdout: NonNullable<ChildProcess["stdout"]> };

  const killOnExit = (): void => {
    child.kill("SIGKILL");
  };
  process.once("exit", killOnExit);
  cleanup.add("runner process", async () => {
    process.removeListener("exit", killOnExit);
    await stop(child);
  });

  const waiters = new Set<() => void>();
  let buffered = "";
  const consume = (chunk: Buffer): void => {
    buffered += chunk.toString();
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at < 0) break;
      lines.push(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
    }
    for (const wake of [...waiters]) wake();
  };
  child.stdout.on("data", consume);
  child.stderr?.on("data", consume);

  const port = await new Promise<number>((resolve, reject) => {
    const fail = (why: string): void => {
      clearTimeout(timer);
      reject(new Error(`e2e: the runner ${why}. Output:\n${lines.join("\n") || "(none)"}`));
    };
    const timer = setTimeout(() => fail(`did not listen within ${READY_TIMEOUT_MS}ms`), READY_TIMEOUT_MS);

    const look = (): void => {
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const fields = parsed as Record<string, unknown>;
        if (fields["event"] === "listening" && typeof fields["port"] === "number") {
          clearTimeout(timer);
          waiters.delete(look);
          resolve(fields["port"]);
          return;
        }
      }
    };
    waiters.add(look);
    child.once("exit", code => fail(`exited with code ${code ?? "null"} before listening`));
    look();
  });

  return { url: `https://127.0.0.1:${port}`, lines };
}

/** The local image's digest, which is what the runner's boot check demands. */
function localDigest(image: string): string {
  const out = execFileSync("docker", ["image", "inspect", image, "--format", "{{index .RepoDigests 0}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  const at = out.lastIndexOf("@");
  if (at === -1) throw new Error(`e2e: ${image} has no repo digest locally. Pull it rather than building it.`);
  return out.slice(at + 1);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, TERM_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
