// Environment parsing for the proxy process, apart from index.ts so the
// rules — and their failure modes — can be tested without starting a listener.

/**
 * Localhost by default.
 *
 * The proxy holds every credential in the deployment and has no business on a
 * routable interface. Under compose it is set to 0.0.0.0 so the agent
 * container can reach it over the private bridge network, which publishes no
 * ports; anywhere else, binding it wider is a decision an operator has to make
 * deliberately.
 */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8443;

/** The slice of process.env the proxy reads. */
export type Env = Record<string, string | undefined>;

export function requiredEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    // Loud, and at startup. A proxy that came up without mutual TLS would be
    // the worst available outcome: reachable, unauthenticated, and holding
    // every secret. Refusing to start is the only safe failure.
    throw new Error(`proxy: ${name} is required and was not set`);
  }
  return value;
}

/**
 * Where per-channel team sheets live:
 * `<PROXY_CHANNELS_ROOT>/<channel id>/channel.toml`.
 *
 * Prefixed like every other variable this process reads, and deliberately not
 * the `CHANNELS_DIR` that `deploy/docker-compose.yml` used to declare. Both
 * services mount the same directory, but they do not read it the same way: for
 * the proxy this path is the authorization source — what it resolves here
 * decides what every channel may do — and naming it as the proxy's own setting
 * keeps that from reading as a shared convenience path. The compose file sets
 * both services from one anchor.
 *
 * Required, with no default. A default would be a path that might happen to be
 * empty, and an empty root is indistinguishable from a correct one that has no
 * sheets: every channel resolves to `no_team_sheet` and every call is refused.
 * That fails safe, but it fails safe *silently*, at the far end of a Slack
 * thread. Making the operator name the directory turns a misconfiguration into
 * a startup error instead.
 */
export function channelsRootFromEnv(env: Env): string {
  return requiredEnv(env, "PROXY_CHANNELS_ROOT");
}

export function hostFromEnv(env: Env): string {
  const raw = env.PROXY_HOST;
  // "" falls back alongside undefined, and the distinction is not cosmetic:
  // Node binds every interface when handed an empty host string, so passing
  // it through would turn a blanked-out PROXY_HOST= line in an env file into
  // the widest possible listener.
  if (raw === undefined || raw === "") return DEFAULT_HOST;
  return raw;
}

export function portFromEnv(env: Env): number {
  const raw = env.PROXY_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`proxy: PROXY_PORT is not a port number: ${raw}`);
  }
  return parsed;
}
