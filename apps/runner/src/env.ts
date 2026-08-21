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
