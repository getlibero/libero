// Environment parsing for the proxy process, apart from index.ts so the
// rules — and their failure modes — can be tested without starting a listener.

import {
  DEFAULT_UPSTREAM_CONCURRENCY,
  DEFAULT_SANDBOX_CONCURRENCY,
  DEFAULT_UPSTREAM_RESPONSE_BYTES,
  VAULT_KEY_BYTES,
  parseVaultKey
} from "@getlibero/proxy";
import type { CustodyConfig, VaultKey } from "@getlibero/proxy";

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
 * The attempt store: `PROXY_ATTEMPTS_DB`. **Optional**, on the price table's
 * argument (#364): not having one is a legitimate deployment — capture
 * switched off is the design's own off switch — and absence must not invent a
 * path. The hazard optionality carries here is the audit variable's one turned
 * quieter: an operator who meant to capture and mistyped the name gets no
 * records, discovered at the incident. What answers it is the startup line —
 * the composition says once, loudly, that capture is off — and the compose
 * file shipping the variable set, which makes "on" the deployment default and
 * "off" an explicit edit.
 *
 * SQLite writes `-wal` and `-shm` beside this path, so the directory has to be
 * writable and not just the file.
 */
export function attemptsDbFromEnv(env: Env): string | undefined {
  const value = env["PROXY_ATTEMPTS_DB"];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The price-drift record: `PROXY_DRIFT_DB`. **Optional**, on the attempt
 * store's argument and one of its own (#239).
 *
 * Not having one is a legitimate deployment twice over. A deployment that calls
 * providers directly has nothing to record — no gateway reports a cost — so the
 * file would stay empty however carefully it was configured. And a deployment
 * that caps nothing in dollars has no price table to check against, which is the
 * only question this record answers.
 *
 * The hazard optionality carries is the attempt store's, quieter still: an
 * operator who mistyped the name loses an observation rather than a record they
 * will want at an incident. What answers it is the same pair — the composition
 * says once at startup that the record is off, and the compose file ships the
 * variable set, which makes "on" the deployment default and "off" an explicit
 * edit.
 *
 * SQLite writes `-wal` and `-shm` beside this path, so the directory has to be
 * writable and not just the file.
 */
export function driftDbFromEnv(env: Env): string | undefined {
  const value = env["PROXY_DRIFT_DB"];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The price table: `PROXY_PRICE_TABLE`. **Optional**, and the only optional path
 * this file reads (#62).
 *
 * Every other path here is required with no default, on the argument that a
 * path the proxy invented is worse than a startup failure. This one is
 * different because *not having one is a legitimate deployment*: a workspace
 * that caps its channels in tokens and tool calls needs no prices, and requiring
 * a file it would leave empty would be requiring ceremony rather than
 * configuration.
 *
 * The failure mode that argument has to survive is the one the others fail on —
 * an absent file quietly meaning "no limits". It does not, because it fails
 * *closed*: with no table every model is unpriced, and a channel whose sheet
 * sets `budget.daily_usd` is refused rather than metered at zero. The
 * deployments that need this variable are exactly the ones that stop working
 * without it, which is what makes optional safe here and nowhere else in this
 * file.
 *
 * Read-only to this process. Unlike the three above, nothing writes beside it,
 * so the file may be mounted `:ro` and its directory need not be writable — it
 * belongs with the team sheets, on the operator's side of the line.
 */
export function priceTableFromEnv(env: Env): string | undefined {
  const value = env["PROXY_PRICE_TABLE"];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * The per-channel message stores: `PROXY_STORE_ROOT`.
 *
 * The directory the gateway writes a channel's conversation into, mounted into
 * this service as well so `search_channel_history` can read it (#64). The file
 * is `<root>/<channel>/store.db` and this process opens every one of them
 * `readOnly`.
 *
 * **Two variables for one directory, deliberately.** The gateway names it
 * `AGENT_STORE_ROOT` and this process names it `PROXY_STORE_ROOT`, because the
 * two services are configured separately and a shared name would imply a shared
 * setting they could not disagree about — which is exactly the thing an operator
 * running them on different hosts needs to notice. `deploy/docker-compose.yml`
 * points both at the same volume.
 *
 * **Not `PROXY_CHANNELS_ROOT`, and that separation is the security decision
 * #176 made.** Team sheets are what this process reads its authorization from,
 * and the agent must not be able to write there — so the store got its own root
 * on the agent's writable side. Reading it from here does not undo that: the
 * channels mount stays `:ro` on both services and this one is a different path.
 *
 * Required with no default, on the same argument as the three paths above. The
 * quiet alternative is a proxy that starts, publishes `search_channel_history`
 * to every channel whose sheet grants it, and answers each call with "no
 * messages have been stored for this channel yet" — a tool that is present,
 * permitted, metered, audited, and silently useless. A missing variable should
 * be a container that will not start.
 *
 * The *mount* has to be read-write even though every open is read-only: a SQLite
 * WAL reader creates the `-shm` and `-wal` sidecars beside the file, so a `:ro`
 * mount fails at the first search. The read-only-ness is `{ readOnly: true }` on
 * the connection, which is the posture `openAuditReader` already takes.
 */
export function storeRootFromEnv(env: Env): string {
  return requiredEnv(env, "PROXY_STORE_ROOT");
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

/**
 * Which custody backend this deployment runs: `PROXY_CUSTODY_BACKEND`.
 *
 * Absent means `files`, which is the whole deployment today, so nothing an
 * operator already runs gains a variable. What the check buys is the other
 * direction: a typo — or a name from a version that has one this build does
 * not — is a container that will not start, rather than a silent fall back to
 * files while the operator believes their secrets manager is in use. That is
 * `portFromEnv`'s posture of validating rather than ignoring, applied where
 * being wrong is a credential question.
 *
 * **This is where `PROXY_VAULT_KEY` is demanded, and it is demanded by a
 * branch.** `vaultKeyFromEnv` stays the deployment's single key-acquisition
 * seam — moving it to KMS is a change to that function's body and to nothing
 * else — and a managed backend that needs no master key simply never reaches
 * the call. So the variable stays required for the default shape without ever
 * becoming optional for it, which is the trap an options bag would have set.
 */
const CUSTODY_BACKENDS = ["files", "gcp", "aws"] as const;

/** This deployment's slice of a project or account, and the lead of every name. */
const DEFAULT_SECRET_PREFIX = "libero";

export function custodyFromEnv(env: Env): CustodyConfig {
  const named = env.PROXY_CUSTODY_BACKEND;
  const backend = named === undefined || named === "" ? "files" : named;
  if (!(CUSTODY_BACKENDS as readonly string[]).includes(backend)) {
    throw new Error(
      `proxy: PROXY_CUSTODY_BACKEND must be one of: ${CUSTODY_BACKENDS.join(", ")}`
    );
  }

  // Each branch demands its own material and nothing else's. `PROXY_VAULT_KEY`
  // is required below and unreached here, which is #482's point: a managed
  // backend needing no master key does not make the variable optional for the
  // shape that does. Secret Manager holds the plaintext and encrypts at rest,
  // so there is no key for this branch to acquire — #261's "the KMS question
  // becomes moot for the entries the backend holds."
  //
  // No endpoint is read from the environment, deliberately, and
  // `custodyFromEnv` returning exactly these three fields is asserted in
  // env.test.ts: a settable API endpoint in the process that holds every
  // credential is a switch for sending them somewhere else.
  if (backend === "gcp") {
    const prefix = env.PROXY_GCP_SECRET_PREFIX;
    return {
      backend: "gcp-secret-manager",
      project: requiredEnv(env, "PROXY_GCP_PROJECT"),
      prefix: prefix === undefined || prefix === "" ? DEFAULT_SECRET_PREFIX : prefix
    };
  }

  if (backend === "aws") {
    const prefix = env.PROXY_AWS_SECRET_PREFIX;
    return {
      backend: "aws-secrets-manager",
      region: requiredEnv(env, "PROXY_AWS_REGION"),
      prefix: prefix === undefined || prefix === "" ? DEFAULT_SECRET_PREFIX : prefix
    };
  }

  return { backend: "encrypted-files", vaultFile: vaultFileFromEnv(env), key: vaultKeyFromEnv(env) };
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

/**
 * How many calls the proxy will run against one upstream at once:
 * `PROXY_MAX_UPSTREAM_CONCURRENCY`, defaulting to eight.
 *
 * A deployment setting on the same argument as the bound above, and the two
 * multiply: what one bad upstream can cost this process is the response cap
 * times its three-to-five-fold decoding overhead times *this*. Until this
 * landed the last factor was unbounded, so the product was not a number an
 * operator could compute.
 *
 * **It is also not a team sheet field, and here the reason is sharper than
 * "shared heap".** There is nowhere in a sheet to put it. An upstream is a
 * `(transport, url, credential)` tuple that any number of channels may name,
 * and a limit on it is a claim about the far end rather than about a channel —
 * so two sheets could disagree, and whichever one loaded first would win. The
 * `max_result_chars` split is the model to follow: a channel says what reaches
 * its own model, the deployment says what this process spends on its behalf.
 *
 * Optional with a default, per `maxResponseBytesFromEnv`, and this one fails
 * loudly too: a saturated wait puts `upstream_saturated` in the log and a
 * sentence naming this variable in front of the model.
 *
 * No ceiling, and no floor beyond "positive". One is a legitimate setting — an
 * upstream that permits a single concurrent call is a real thing, and serialising
 * against it is what an operator would be asking for.
 */
export function maxUpstreamConcurrencyFromEnv(env: Env): number {
  const raw = env.PROXY_MAX_UPSTREAM_CONCURRENCY;
  // "" alongside undefined, per `maxResponseBytesFromEnv`: a blanked-out line is
  // a setting removed, not a limit of zero, which here would refuse every call.
  if (raw === undefined || raw === "") return DEFAULT_UPSTREAM_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`proxy: PROXY_MAX_UPSTREAM_CONCURRENCY is not a positive count: ${raw}`);
  }
  return parsed;
}

/**
 * How many sandbox runs the deployment will have in flight at once:
 * `PROXY_MAX_SANDBOX_CONCURRENCY`, defaulting to the package's two (#405).
 *
 * A second concurrency setting and not a widening of the one above, because
 * they bound different things and their units are not comparable. That one
 * counts sockets against one upstream; this one counts *containers* — each run
 * is a sandbox plus a per-run egress hop, with a memory cgroup each — against
 * the host this process shares with them. An operator raising one has said
 * nothing about the other.
 *
 * Not a sheet field, on `maxUpstreamConcurrencyFromEnv`'s argument in its
 * sharper form: a channel's `[[builtin]]` block already sizes one run, and how
 * many runs the *host* can hold at once is a fact about the deployment that no
 * channel is in a position to know. Two sheets could disagree, and the host
 * would lose.
 *
 * One is a legitimate setting, and on a small host it is the right one: it
 * serialises `run_code` across the deployment, which is what an operator with
 * 2 vCPU is asking for.
 */
export function maxSandboxConcurrencyFromEnv(env: Env): number {
  const raw = env.PROXY_MAX_SANDBOX_CONCURRENCY;
  // "" alongside undefined, per the two above: a blanked-out line is a setting
  // removed, not a limit of zero, which here would refuse every run.
  if (raw === undefined || raw === "") return DEFAULT_SANDBOX_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`proxy: PROXY_MAX_SANDBOX_CONCURRENCY is not a positive count: ${raw}`);
  }
  return parsed;
}

/**
 * How long the proxy waits on any one outbound request:
 * `PROXY_UPSTREAM_TIMEOUT_MS`, defaulting to the package's thirty seconds.
 *
 * One budget over all outbound I/O — each MCP call, and each token exchange
 * (discovery plus the token POST share a single window). A deployment setting
 * on the two arguments the bounds above make: sockets held open are a cost of
 * the shared process, and how long a given upstream deserves is a deployment
 * fact rather than something this repo can know.
 *
 * Optional with a default, per `maxResponseBytesFromEnv`, and lowering it
 * fails closed: a token endpoint that cannot answer inside the window is
 * `timed_out`, which surfaces as `unavailable` — never as a served call. No
 * ceiling and no floor beyond "positive", for the reasons its neighbours give.
 *
 * `undefined` means "the package's default applies", so the dispatcher option
 * is spread in conditionally rather than passed as `undefined` —
 * `exactOptionalPropertyTypes` makes those two different statements.
 */
export function upstreamTimeoutMsFromEnv(env: Env): number | undefined {
  const raw = env.PROXY_UPSTREAM_TIMEOUT_MS;
  // "" alongside undefined, per `maxResponseBytesFromEnv`: a blanked-out line is
  // a setting removed, not a timeout of zero, which here would fail every call.
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`proxy: PROXY_UPSTREAM_TIMEOUT_MS is not a positive millisecond count: ${raw}`);
  }
  return parsed;
}

/**
 * Where the sandbox runner listens, or absent (#395).
 *
 * **Optional, and absent is a supported deployment.** A deployment whose
 * channels never grant `run_code` has no reason to run a runner, and requiring
 * the variable would make the sandbox a thing every operator has to opt out of.
 * Absent composes the unavailable arm, so a channel that does grant it gets
 * `not_implemented` — the sheet is right and this deployment did not build the
 * service — rather than a refusal, which would say the channel was denied.
 *
 * The `https:` check is in `createSandboxDispatcher` rather than here, because
 * it is a property of what that module will do with the value.
 */
export function runnerUrlFromEnv(env: Env): string | undefined {
  const raw = env.RUNNER_URL;
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * The client certificate the proxy presents to the runner.
 *
 * Required **only when `RUNNER_URL` is set**, which is why these are three
 * separate reads rather than one bundle with defaults: a deployment that named
 * a runner and forgot its client material should fail at boot, and one that
 * named no runner should not be asked for material it will never use.
 *
 * This is the proxy's *second* certificate and its only client one. It is not
 * an agent channel certificate and must not be pointed at one: the runner
 * authorizes on this file's exact fingerprint, which is what stops a compromised
 * agent — holding certificates the same CA signed — from calling the runner
 * itself. See scripts/dev-certs.sh, which prints the pin when it mints this.
 */
export function runnerTlsFromEnv(env: Env): { cert: string; key: string; ca: string } {
  return {
    cert: requiredEnv(env, "RUNNER_CLIENT_CERT"),
    key: requiredEnv(env, "RUNNER_CLIENT_KEY"),
    ca: requiredEnv(env, "RUNNER_CLIENT_CA")
  };
}
