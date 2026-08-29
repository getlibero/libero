// Google Secret Manager, spoken over its REST API with no client library.
//
// **That is the decision rather than the shortcut**, and it is this
// repository's fourth instance of one argument. apps/runner/src/docker.ts made
// it about the socket that is equivalent to root on the host; ./server.ts's
// header states the general rule — "a framework, a logger, a TOML parser, or a
// *second* HTTP client this process pulls in directly are all still things a
// reviewer should reject"; packages/agent/src/proxy/transport.ts made it about
// the mTLS client. Here it is about the process that holds every tool
// credential: `@google-cloud/secret-manager` brings google-gax, gRPC and
// protobufjs — some thirty to fifty transitive packages — into that image, and
// each future bump would land there as a security review rather than a diff.
//
// **What is *not* an argument for hand-rolling: distrusting Google.** An
// operator running on GCP already trusts the service, and packages/agent takes
// `@anthropic-ai/sdk` and `openai` directly for exactly that reason. The
// difference is which process: the agent holds the model key and no tool
// credentials, and the design already assumes it can be compromised. This one
// must not be. The dependency question here is npm supply chain, not Google.
//
// **The condition for revisiting, stated so the next person has one.** What is
// needed is five calls: an access token from the metadata server, and list,
// access, add-version and destroy against Secret Manager. Auth is one GET
// because #483 settled on VM-attached service accounts alone, which is where
// the SDK's largest advantage — Application Default Credentials across every
// credential source — would have been. **If the scope grows past those calls —
// CMEK, rotation schedules, IAM managed from inside the proxy, or a second
// credential source — take the SDK** and argue it the way #185/#188 argued the
// MCP SDK: a dependency audit, a licence check, and a standing review
// obligation on every bump. That is a stated trigger, not a taboo.
//
// **The five disciplines, hand-applied**, from ./outbound.ts's exchange rather
// than from its guarded fetch — that one injects a vault credential and scrubs
// the reply, and neither is right here:
//
//   1. Every URL is built from a configured origin. Nothing in a response body
//      becomes a URL: Secret Manager returns resource *names*, and this module
//      turns a name into a path itself.
//   2. `redirect: "manual"`, and any 3xx is `redirected`. A redirected access
//      is a bearer token sent to a host neither endpoint names.
//   3. One `AbortSignal.timeout` over each operation, so a slow token fetch
//      cannot grant the call that needed it more time than the caller offered.
//   4. Bodies bounded before they are parsed.
//   5. A closed failure set, no `cause`, and no response body in any message.
//      A `TypeError` out of `fetch` can carry the request in it, and the
//      request is where the bearer token is.
//
// The access token is held in a closure and never interpolated into anything.
// It is deliberately **not** a `Secret`: `reveal()` has exactly two call sites,
// both in ./outbound.ts, and outbound.test.ts's grep contract is what keeps
// that true. This token is the proxy's own identity rather than a tool
// credential, and it never leaves this module.

import { CustodyError } from "./custody.js";
import type { CustodyFailure } from "./custody.js";
import type { Logger } from "./log.js";

/** Where the two APIs live. Overridden only by tests — see `GcpClientOptions`. */
export interface GcpEndpoints {
  /** Origin only, no path. */
  readonly secretManager: string;
  /** Origin only, no path. The metadata server is plain HTTP on a link-local
   *  address; that is how GCP works, and the token never leaves the host. */
  readonly metadata: string;
}

export const DEFAULT_GCP_ENDPOINTS: GcpEndpoints = {
  secretManager: "https://secretmanager.googleapis.com",
  metadata: "http://metadata.google.internal"
};

/** The bound ./outbound.ts and apps/runner/src/docker.ts both take. */
const MAX_CONTROL_BODY_BYTES = 65_536;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How early to replace the access token. The token engine's margin, for its
 * reason: a token that expires between the check and the call is a failure
 * with no cause an operator can act on.
 */
const TOKEN_MARGIN_MS = 60_000;

/** How many secrets one page asks for, and how many pages are ever walked. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * Why a call failed, in this backend's own words.
 *
 * `denied` is the one worth naming: it is `unauthorized`'s first producer, the
 * word ./custody.ts reserved before anything could say it. A service account
 * missing `secretmanager.versions.access` is the likeliest thing to go wrong in
 * a first deployment, and telling an operator "unreachable" would send them to
 * the network when the answer is IAM.
 */
export type GcpFailure =
  | "unreachable"
  | "timed_out"
  | "denied"
  | "redirected"
  | "too_large"
  | "malformed_response";

const CUSTODY_FAILURE: Record<GcpFailure, CustodyFailure> = {
  unreachable: "unreachable",
  timed_out: "unreachable",
  denied: "unauthorized",
  redirected: "unreachable",
  too_large: "too_large",
  malformed_response: "malformed"
};

/** No `cause`, and no response body: both can carry the bearer token. */
export class GcpCustodyError extends CustodyError {
  readonly reason: GcpFailure;

  constructor(reason: GcpFailure) {
    super(`proxy gcp secret manager: ${reason}`, CUSTODY_FAILURE[reason]);
    this.name = "GcpCustodyError";
    this.reason = reason;
  }
}

export interface GcpClientOptions {
  readonly project: string;
  /**
   * Test-only. `custodyFromEnv` never sets one, and there is no environment
   * variable that can: an operator-settable API endpoint inside the process
   * that holds every credential is a switch for redirecting them somewhere
   * else. `env.test.ts` asserts the config it builds carries no endpoint.
   */
  readonly endpoints?: GcpEndpoints;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/** One secret, as the list returns it. Ids and labels — never a value. */
export interface SecretSummary {
  readonly secretId: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface SecretManagerClient {
  /** Every secret carrying these labels, walked across pages. Ids only. */
  list(labels: Readonly<Record<string, string>>): Promise<readonly SecretSummary[]>;
  /** The latest enabled version's payload, or `null` when there is none. */
  access(secretId: string): Promise<string | null>;
  /** Create with labels. `false` when it already existed. */
  create(secretId: string, labels: Readonly<Record<string, string>>): Promise<boolean>;
  /** Add a version and destroy its predecessor — replace-not-stack. */
  addVersion(secretId: string, value: string): Promise<void>;
  /** `false` when the secret was not there. */
  deleteSecret(secretId: string): Promise<boolean>;
  /** Drop the cached access token. Calls fail afterwards. */
  close(): void;
}

export function createSecretManagerClient(options: GcpClientOptions): SecretManagerClient {
  const endpoints = options.endpoints ?? DEFAULT_GCP_ENDPOINTS;
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger;
  const parent = `projects/${options.project}`;

  let closed = false;
  let token: { value: string; expiresAt: number } | undefined;
  // One token fetch however many calls arrive during it, the shape
  // ./token-engine.ts's single flight takes.
  let fetching: Promise<string> | undefined;

  const requireOpen = (): void => {
    if (closed) throw new GcpCustodyError("unreachable");
  };

  /**
   * A bearer token from the VM's attached service account.
   *
   * The only credential source this backend has, and #483 settled that
   * deliberately: a service-account JSON key mounted into the container that
   * holds every tool credential is a long-lived private key on disk, which is
   * worse than the master key it would be replacing. Workload identity on
   * GCE, GKE or Cloud Run is where anyone would run this.
   */
  const accessToken = async (signal: AbortSignal): Promise<string> => {
    if (token !== undefined && now() < token.expiresAt - TOKEN_MARGIN_MS) return token.value;
    if (fetching !== undefined) return fetching;

    const started = (async (): Promise<string> => {
      const body = await request(
        signal,
        `${endpoints.metadata}/computeMetadata/v1/instance/service-accounts/default/token`,
        { method: "GET", headers: { "Metadata-Flavor": "Google" } },
        [200]
      );
      const parsed = parseJson(body);
      const fields = parsed as { access_token?: unknown; expires_in?: unknown };
      if (typeof fields.access_token !== "string" || fields.access_token === "") {
        throw new GcpCustodyError("malformed_response");
      }
      const lifetime = typeof fields.expires_in === "number" ? fields.expires_in : 0;
      token = { value: fields.access_token, expiresAt: now() + lifetime * 1_000 };
      return token.value;
    })().finally(() => {
      fetching = undefined;
    });

    fetching = started;
    return started;
  };

  /**
   * One HTTP round trip, with the five disciplines applied and an explicit
   * allowlist of acceptable statuses — apps/runner/src/docker.ts's `expect`,
   * which is what keeps "404 here means absent, 404 there means broken" a
   * decision at each call site rather than a guess in one handler.
   */
  const request = async (
    signal: AbortSignal,
    url: string,
    init: RequestInit,
    ok: readonly number[]
  ): Promise<string> => {
    let response: Response;
    try {
      response = await send(url, { ...init, redirect: "manual", signal });
    } catch (error) {
      throw new GcpCustodyError(wasTimeout(error) ? "timed_out" : "unreachable");
    }

    // A redirected request is a bearer token sent to a host neither endpoint
    // names. Never followed, and never reported as anything softer.
    if (response.status >= 300 && response.status < 400) {
      throw new GcpCustodyError("redirected");
    }

    const body = await readBounded(response, MAX_CONTROL_BODY_BYTES);
    if (body === null) throw new GcpCustodyError("too_large");

    if (ok.includes(response.status)) return body;
    if (response.status === 401 || response.status === 403) {
      throw new GcpCustodyError("denied");
    }
    // Everything else — 429, 5xx, an unexpected 2xx — is the backend not
    // answering the question that was asked. The body is not carried.
    throw new GcpCustodyError("unreachable");
  };

  const authorized = async (
    signal: AbortSignal,
    path: string,
    init: RequestInit,
    ok: readonly number[]
  ): Promise<string> => {
    const bearer = await accessToken(signal);
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${bearer}`
    };
    return request(signal, `${endpoints.secretManager}${path}`, { ...init, headers }, ok);
  };

  const json = (value: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });

  return {
    async list(labels): Promise<readonly SecretSummary[]> {
      requireOpen();
      const signal = AbortSignal.timeout(timeoutMs);
      const filter = Object.entries(labels)
        .map(([key, value]) => `labels.${key}=${value}`)
        .join(" AND ");

      const found: SecretSummary[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ pageSize: String(PAGE_SIZE), filter });
        if (pageToken !== undefined) query.set("pageToken", pageToken);
        const body = await authorized(
          signal,
          `/v1/${parent}/secrets?${query.toString()}`,
          { method: "GET" },
          [200]
        );
        const parsed = parseJson(body) as { secrets?: unknown; nextPageToken?: unknown };
        if (parsed.secrets !== undefined) {
          if (!Array.isArray(parsed.secrets)) throw new GcpCustodyError("malformed_response");
          for (const entry of parsed.secrets) found.push(summaryOf(entry));
        }
        if (typeof parsed.nextPageToken !== "string" || parsed.nextPageToken === "") {
          return found;
        }
        pageToken = parsed.nextPageToken;
      }
      // A project holding more than this is not a deployment's credential set,
      // and walking it forever is how a startup hangs rather than fails.
      // No count in the line: `LogFields` is a closed set on purpose, and the
      // cap is a constant in this file rather than a fact about the project.
      logger?.log("error", { event: "gcp_secret_list_truncated" });
      throw new GcpCustodyError("too_large");
    },

    async access(secretId): Promise<string | null> {
      requireOpen();
      const signal = AbortSignal.timeout(timeoutMs);
      // 404 is a secret that is not there; 400 is one whose every version has
      // been destroyed, which `remove` and `addVersion` both leave behind. Both
      // are "no value under this name" rather than a failure.
      const body = await authorized(
        signal,
        `/v1/${parent}/secrets/${encodeURIComponent(secretId)}/versions/latest:access`,
        { method: "GET" },
        [200, 400, 404]
      );
      const parsed = parseJson(body) as { payload?: { data?: unknown }; error?: unknown };
      if (parsed.error !== undefined) return null;
      const data = parsed.payload?.data;
      if (data === undefined) return null;
      if (typeof data !== "string") throw new GcpCustodyError("malformed_response");
      return decodeBase64(data);
    },

    async create(secretId, labels): Promise<boolean> {
      requireOpen();
      const signal = AbortSignal.timeout(timeoutMs);
      const query = new URLSearchParams({ secretId });
      const body = await authorized(
        signal,
        `/v1/${parent}/secrets?${query.toString()}`,
        json({ replication: { automatic: {} }, labels }),
        [200, 409]
      );
      // 409 is already-exists, which every `set` after the first hits. A race
      // we won, in docker.ts's sense.
      return !(parseJson(body) as { error?: unknown }).error;
    },

    async addVersion(secretId, value): Promise<void> {
      requireOpen();
      const signal = AbortSignal.timeout(timeoutMs);
      const secret = `/v1/${parent}/secrets/${encodeURIComponent(secretId)}`;
      const body = await authorized(
        signal,
        `${secret}:addVersion`,
        json({ payload: { data: Buffer.from(value, "utf8").toString("base64") } }),
        [200]
      );
      const name = (parseJson(body) as { name?: unknown }).name;
      if (typeof name !== "string") throw new GcpCustodyError("malformed_response");

      // Replace-not-stack, as add-version / destroy-old. Only the predecessor
      // needs destroying: every version before it was destroyed by its own
      // successor, so the enabled set is never longer than two and only ever
      // while this line is in flight. A version already destroyed answers 400,
      // which is accepted rather than retried.
      const version = Number(name.slice(name.lastIndexOf("/") + 1));
      if (!Number.isInteger(version) || version < 2) return;
      await authorized(
        signal,
        `${secret}/versions/${version - 1}:destroy`,
        json({}),
        [200, 400, 404]
      );
    },

    async deleteSecret(secretId): Promise<boolean> {
      requireOpen();
      const signal = AbortSignal.timeout(timeoutMs);
      const body = await authorized(
        signal,
        `/v1/${parent}/secrets/${encodeURIComponent(secretId)}`,
        { method: "DELETE" },
        [200, 404]
      );
      return !(parseJson(body) as { error?: unknown }).error;
    },

    close(): void {
      if (closed) return;
      closed = true;
      // A JavaScript string cannot be zeroed the way ./token-store.ts zeroes a
      // key buffer — ./vault.ts's heap-dump concession, again. Dropping the
      // reference is what there is.
      token = undefined;
    }
  };
}

function summaryOf(entry: unknown): SecretSummary {
  if (typeof entry !== "object" || entry === null) throw new GcpCustodyError("malformed_response");
  const name = (entry as { name?: unknown }).name;
  if (typeof name !== "string" || name === "") throw new GcpCustodyError("malformed_response");
  const labels = (entry as { labels?: unknown }).labels;
  if (labels !== undefined && (typeof labels !== "object" || labels === null)) {
    throw new GcpCustodyError("malformed_response");
  }
  return {
    secretId: name.slice(name.lastIndexOf("/") + 1),
    labels: (labels ?? {}) as Readonly<Record<string, string>>
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new GcpCustodyError("malformed_response");
  }
}

/**
 * Base64 in, a value out — and a size check on the way, so a backing holding
 * more than a credential may weigh is refused rather than held.
 */
function decodeBase64(data: string): string {
  const raw = Buffer.from(data, "base64");
  if (raw.length > MAX_CONTROL_BODY_BYTES) throw new GcpCustodyError("too_large");
  return raw.toString("utf8");
}

/**
 * The body, or `null` past the bound.
 *
 * A value rather than a throw, ./outbound.ts's shape: a caller's `catch` must
 * not report a bound as a transport failure.
 */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function wasTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
