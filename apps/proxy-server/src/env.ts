// Environment parsing for the proxy process, apart from index.ts so the
// rules — and their failure modes — can be tested without starting a listener.

import { DEFAULT_UPSTREAM_RESPONSE_BYTES, VAULT_KEY_BYTES, parseVaultKey } from "@getlibero/proxy";
import type { VaultKey } from "@getlibero/proxy";

/**
 * Localhost by default.
 *
 * The proxy holds every tool credential in the deployment and has no business on a
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

/**
 * The vault file: `PROXY_VAULT_FILE`.
 *
 * Required with no default, on the same argument `channelsRootFromEnv` makes.
 * A defaulted path that happens to be empty is indistinguishable from a correct
 * one holding nothing, and the symptom — every credential unresolved — surfaces
 * at the far end of a Slack thread rather than at startup.
 */
export function vaultFileFromEnv(env: Env): string {
  return requiredEnv(env, "PROXY_VAULT_FILE");
}

/**
 * The budget meter's database: `PROXY_BUDGET_DB`.
 *
 * Required with no default, on the argument the two above make — but the
 * failure mode here is the worst of the three, which is why it is worth
 * restating rather than cross-referencing. An absent channels root refuses
 * every call and an absent vault resolves no credential; both fail closed. A
 * budget file the proxy invented under a path nobody meant fails *open*: the
 * counters are real, and they are in a file the operator will never reset and
 * a container will throw away, so every day is the first day and no hard limit
 * ever bites.
 *
 * SQLite writes `-wal` and `-shm` beside this path, so the directory has to be
 * writable and not just the file.
 */
export function budgetDbFromEnv(env: Env): string {
  return requiredEnv(env, "PROXY_BUDGET_DB");
}

/**
 * The audit log's database: `PROXY_AUDIT_DB`.
 *
 * Required with no default, and the failure mode is the budget's one turned
 * quiet. An audit file the proxy invented under a path nobody meant produces a
 * deployment that looks audited: every call is recorded, into a file no
 * operator will ever query and a container will throw away. Nothing
 * misbehaves — the symptom is an empty table, discovered by whoever goes
 * looking after an incident, which is the one moment it cannot be fixed
 * retroactively.
 *
 * SQLite writes `-wal` and `-shm` beside this path, so the directory has to be
 * writable and not just the file.
 *
 * The name is `PROXY_AUDIT_DB` and not the `AUDIT_DB` that sat in
 * deploy/docker-compose.yml unread until now: every variable this process reads
 * carries the prefix, and an unprefixed one was config nothing consumed.
 */
export function auditDbFromEnv(env: Env): string {
  return requiredEnv(env, "PROXY_AUDIT_DB");
}

/**
 * The vault master key: `PROXY_VAULT_KEY`, base64, 32 bytes.
 *
 * One name, prefixed like everything else this process reads. It replaces the
 * `LIBERO_VAULT_KEY`/`VAULT_KEY` pair that `deploy/docker-compose.yml` and
 * `.env.example` used to disagree about and that no code ever read.
 *
 * The failure messages name the variable and the shape expected, and carry
 * nothing of what was actually set. An error message is the one place a
 * rejected key would be printed, logged, and pasted into an issue.
 *
 * Passing the key by environment variable is the phase-1 form. It is readable
 * by anyone who can `docker inspect` the container — as `SLACK_APP_TOKEN` and
 * `ANTHROPIC_API_KEY` already are in the same compose file — and a file or KMS
 * source is the hardened path, documented in the proxy's README and not built.
 */
export function vaultKeyFromEnv(env: Env): VaultKey {
  const raw = requiredEnv(env, "PROXY_VAULT_KEY");
  const parsed = parseVaultKey(raw);
  if (!parsed.ok) {
    throw new Error(
      parsed.reason === "not_base64"
        ? "proxy: PROXY_VAULT_KEY is not base64 (generate with: openssl rand -base64 32)"
        : `proxy: PROXY_VAULT_KEY must decode to ${VAULT_KEY_BYTES} bytes (generate with: openssl rand -base64 32)`
    );
  }
  return parsed.key;
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

/**
 * The listening port: `PROXY_PORT`, defaulting to 8443.
 *
 * Zero is accepted and means what it means to `listen(2)`: the OS picks a free
 * port. Nothing in a deployment should want that — a port the agent's
 * `PROXY_URL` cannot be written against is useless — but a test harness that
 * spawns this process needs a port it did not have to guess, and picking one
 * itself is a race against everything else on the host. The `listening` log
 * line reports the bound port, so 0 is discoverable rather than lost.
 */
export function portFromEnv(env: Env): number {
  const raw = env.PROXY_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`proxy: PROXY_PORT is not a port number: ${raw}`);
  }
  return parsed;
}

/**
 * How many bytes of an upstream's answer the proxy will hold:
 * `PROXY_MAX_RESPONSE_BYTES`, defaulting to four megabytes.
 *
 * **A deployment setting rather than a team sheet field, and that split is the
 * decision rather than a filing preference.** The companion bound — how much of
 * a tool result reaches the model — *is* a sheet field, because it is charged
 * against the channel's own `max_tokens_per_task` and a channel raising it
 * spends only its own budget. This one buys memory in a process shared by every
 * channel the proxy serves, so a sheet able to raise it would be one channel
 * degrading service for all of them.
 *
 * It is not hardcoded either, on the argument this file already makes about
 * `PROXY_HOST` and `PROXY_PORT`: the operator who sized the container is the
 * one who should say how much of it a response may occupy, and an upstream
 * returning large catalogs is a deployment fact rather than something this repo
 * can know. No ceiling for the same reason — capping the one principal who owns
 * the heap would be advice, not a boundary.
 *
 * Optional with a default, unlike the four path variables above. Their argument
 * for being required is that a wrong value fails silently at the far end of a
 * Slack thread; this one fails loudly at the first oversized body, with a
 * `too_large` in the log and a sentence the model reads, and there is a correct
 * number to default to.
 */
export function maxResponseBytesFromEnv(env: Env): number {
  const raw = env.PROXY_MAX_RESPONSE_BYTES;
  // "" alongside undefined, per `hostFromEnv`: a blanked-out line in an env file
  // is a setting removed rather than a setting of zero, which here would refuse
  // every call.
  if (raw === undefined || raw === "") return DEFAULT_UPSTREAM_RESPONSE_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`proxy: PROXY_MAX_RESPONSE_BYTES is not a positive byte count: ${raw}`);
  }
  return parsed;
}
