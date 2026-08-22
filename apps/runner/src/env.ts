// The runner's environment contract.
//
// Same shape as apps/proxy-server/src/env.ts and for the same reasons: every
// required value is required with no default, because a default here is a
// deployment that starts wrong and says nothing. The two files do not share
// code, because sharing would mean one of these services importing the other's
// package — which is exactly the edge the runner exists to avoid having.

export type Env = Record<string, string | undefined>;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8444;

/** The hop's port inside the per-run network. Not an operator setting: the runner sets both ends. */
export const DEFAULT_HOP_PORT = 8080;

/**
 * The Docker socket, as the runner sees it.
 *
 * Required rather than defaulted to `/var/run/docker.sock`, because the path
 * differs between hosts — Docker Desktop and OrbStack put it under the user's
 * home — and a default that is right on Linux and wrong on a developer's laptop
 * is a default that produces a confusing failure instead of a clear one.
 */
export const dockerSocketFromEnv = (env: Env): string => requiredEnv(env, "RUNNER_DOCKER_SOCKET");

export function requiredEnv(env: Env, name: string): string {
  const value = env[name];
  // Empty is absent. A compose file with `RUNNER_SANDBOX_IMAGE=` in it has not
  // set an image, and treating that as a value would start a process that fails
  // at the first call rather than at boot.
  if (value === undefined || value === "") throw new Error(`runner: ${name} is required and was not set`);
  return value;
}

/**
 * The sandbox image, which the operator pins and this process never chooses.
 *
 * **Refused unless it is pinned by digest.** #393 decided the image is a
 * deployment fact; a floating tag makes it a fact about whenever the daemon last
 * pulled, which is not the same thing and is not reviewable. The check is a
 * `@sha256:` suffix, which is the only spelling that names one image forever.
 */
export function sandboxImageFromEnv(env: Env): string {
  const value = requiredEnv(env, "RUNNER_SANDBOX_IMAGE");
  if (!/@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`runner: RUNNER_SANDBOX_IMAGE must be pinned by digest (name@sha256:...), and was ${value}`);
  }
  return value;
}

/**
 * The interpreter and its flags, as a JSON array. The code is appended to it.
 *
 * A JSON array rather than a string to split on spaces, because splitting is how
 * a flag containing a space becomes two flags and an operator spends an evening
 * on it.
 *
 * This is what keeps the tool language-neutral: `["python3","-c"]` and
 * `["node","-e"]` are the same amount of configuration, so which language the
 * sandbox has stays a property of the deployment rather than of the code. It is
 * also why the built-in is called `run_code` and not `run_python`.
 */
export function sandboxCommandFromEnv(env: Env): readonly string[] {
  const raw = requiredEnv(env, "RUNNER_SANDBOX_COMMAND");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`runner: RUNNER_SANDBOX_COMMAND is not JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(part => typeof part === "string" && part !== "")) {
    throw new Error(`runner: RUNNER_SANDBOX_COMMAND must be a non-empty JSON array of strings, and was ${raw}`);
  }
  return parsed as readonly string[];
}

/**
 * The one client fingerprint this runner serves.
 *
 * Required, with no "any peer the CA signed" fallback, because that fallback is
 * precisely the hole: the agent holds certificates this CA signed. Sixty-four
 * hex characters, colons optional, so either spelling an operator can copy out
 * of `openssl x509 -fingerprint -sha256` is accepted.
 */
export function clientPinFromEnv(env: Env): string {
  const value = requiredEnv(env, "RUNNER_CLIENT_PIN");
  const normalized = value.replaceAll(":", "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`runner: RUNNER_CLIENT_PIN is not a sha256 fingerprint: ${value}`);
  }
  return normalized;
}

export function hostFromEnv(env: Env): string {
  const value = env["RUNNER_HOST"];
  // Empty must fall back rather than pass through: Node binds every interface
  // on an empty host string, which is the opposite of what a blank means.
  return value === undefined || value === "" ? DEFAULT_HOST : value;
}

export function portFromEnv(env: Env): number {
  const raw = env["RUNNER_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  // Zero is allowed on purpose: a test harness asks the kernel for a free port
  // and reads the bound one back out of the listening log line.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`runner: RUNNER_PORT is not a port number: ${raw}`);
  }
  return port;
}

/**
 * The hop's allowlist, as a JSON array of `[egress]` patterns (#219).
 *
 * Passed by the runner when it creates the hop container, from the list that
 * rode in on the request — which came off the `Decision` that authorized the
 * call. The hop never resolves a sheet and has no idea which channel it serves.
 *
 * An empty list is refused rather than accepted. A hop with nothing allowed
 * permits nothing, which sounds safe and is actually a bug: the runner does not
 * start a hop at all in that case, it gives the sandbox no network. A hop that
 * booted with an empty list would mean the runner got the branch wrong, and it
 * should say so rather than run.
 */
export function hopAllowFromEnv(env: Env): readonly string[] {
  const raw = requiredEnv(env, "HOP_ALLOW");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`runner hop: HOP_ALLOW is not JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(p => typeof p === "string" && p !== "")) {
    throw new Error(`runner hop: HOP_ALLOW must be a non-empty JSON array of patterns, and was ${raw}`);
  }
  return parsed as readonly string[];
}

/** Where the hop listens. Fixed by the runner, which also sets the sandbox's proxy env. */
export function hopPortFromEnv(env: Env): number {
  const raw = env["HOP_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_HOP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`runner hop: HOP_PORT is not a port number: ${raw}`);
  }
  return port;
}

/**
 * The network that gives a hop its route out, or absent (#219).
 *
 * **Absent is a supported deployment and the default one.** Without it a run
 * gets no network whatever its sheet's `[egress]` block says — which is a
 * stricter rule than the sheet asked for, applied in the safe direction, and
 * logged so the operator can see their channel is asking for something the
 * deployment has not turned on.
 *
 * It names a network the compose file created, not one this process makes: the
 * per-run networks are ephemeral and internal, and this is the one with a
 * default route. Keeping them apart is what stops a sandbox from ever being on
 * a network that can reach anything.
 */
export function egressNetworkFromEnv(env: Env): string | undefined {
  const raw = env["RUNNER_EGRESS_NETWORK"];
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * This process's own image, which the hop runs with a different entrypoint.
 *
 * Required when egress is on, and there is nothing clever to do instead: a
 * container cannot reliably learn its own image from inside itself, and
 * guessing would mean starting the hop from something other than the code that
 * asked for it. The compose file sets it beside the image it names.
 */
export function runnerImageFromEnv(env: Env): string {
  return requiredEnv(env, "RUNNER_IMAGE");
}

/**
 * The operator's ceiling over what any sheet may ask for (#405).
 *
 * Every member optional, and an absent member means **no ceiling on that
 * field** — today's behaviour, preserved deliberately. This is the one place
 * the runner's "required with no default" rule does not apply, and the reason
 * is that the two failure modes are not symmetric. A missing socket path or
 * image is a deployment that cannot work at all, so failing at boot is the
 * kind answer. A missing ceiling is a deployment that works exactly as it did
 * before this landed, and defaulting one in would silently shrink runs on
 * every existing deployment whose sheets ask for more than whatever number
 * this file guessed. `deploy/docker-compose.yml` ships real values, so the
 * shipped deployment is bounded without a hand-rolled one being changed under
 * its operator.
 *
 * What makes that safe rather than quiet is `index.ts` logging the ceiling in
 * force at boot, including when there is none.
 */
export interface SandboxCeiling {
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly timeoutSeconds?: number;
}

/**
 * Read the three ceilings, refusing anything that is not a bound.
 *
 * Deliberately **not** checked against `SandboxCaps`'s own maxima. A ceiling
 * above them clamps nothing and is harmless, and refusing it would be this file
 * having an opinion about a number that only ever makes a run smaller. What is
 * refused is a value that is not a positive number at all, because
 * `RUNNER_MAX_MEMORY_MB=0` and `RUNNER_MAX_MEMORY_MB=none` are both an operator
 * trying to say something, and neither means what silently ignoring them would
 * do.
 */
export function sandboxCeilingFromEnv(env: Env): SandboxCeiling {
  return {
    ...present("cpus", positiveNumber(env, "RUNNER_MAX_CPUS")),
    ...present("memoryMb", positiveInteger(env, "RUNNER_MAX_MEMORY_MB")),
    ...present("timeoutSeconds", positiveInteger(env, "RUNNER_MAX_TIMEOUT_SECONDS"))
  };
}

/**
 * A one-key object, or none at all.
 *
 * Spread rather than assigned because `exactOptionalPropertyTypes` is on:
 * `{ cpus: undefined }` is not assignable to an optional `cpus`, and writing it
 * that way would make "the operator set no ceiling" and "the operator set a
 * ceiling of undefined" the same object.
 */
function present<K extends string>(key: K, value: number | undefined): Record<K, number> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

/** Whether a ceiling bounds anything at all, for the boot log. */
export const ceilingIsEmpty = (ceiling: SandboxCeiling): boolean =>
  ceiling.cpus === undefined && ceiling.memoryMb === undefined && ceiling.timeoutSeconds === undefined;

function positiveNumber(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`runner: ${name} is not a positive number: ${raw}`);
  }
  return value;
}

function positiveInteger(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`runner: ${name} is not a positive whole number: ${raw}`);
  }
  return value;
}
