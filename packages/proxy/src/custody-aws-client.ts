// AWS Secrets Manager, spoken over its JSON API with no client library.
//
// ./custody-gcp-client.ts's sibling, and the argument is that file's whole:
// `packages/agent` takes vendor SDKs directly because it holds the model key
// and no tool credentials, and this process holds all of them, so a second HTTP
// client here is the edge ./server.ts's header tells a reviewer to reject.
// `@aws-sdk/client-secrets-manager` is modular and still fifty to eighty
// `@smithy/*` packages into that image.
//
// **What is different from the GCP one, and it is the thing to review.** Google
// takes a bearer token; AWS takes a signature over the request. So this file
// implements SigV4 — a four-step HMAC chain producing a signing key, then one
// more HMAC over a canonicalized request. It is a hundred lines of `node:crypto`
// against a published specification, and the reason it is an acceptable hundred
// lines is the direction it fails in: **a signing mistake is a 403, not a
// disclosure.** AWS rejects the request, the call fails closed as `denied`, and
// the first test catches it. There is no partial-credit failure where a wrong
// signature still moves a secret.
//
// **The condition for revisiting is ./custody-gcp-client.ts's, unchanged.** If
// the scope grows past these calls — KMS keys, rotation Lambdas, IAM managed
// from inside the proxy, or a second credential source — take the SDK and argue
// it the way #185 argued the MCP SDK.
//
// **Credentials come from the instance role over IMDSv2 and nowhere else**,
// which is #483's VM-attached service account with an AWS spelling. Two GETs
// behind a PUT-issued token, temporary credentials with an expiry, cached and
// single-flighted. No access-key environment variables and no shared-credentials
// file: a long-lived key pair sitting in the environment of the process that
// holds every tool credential is the thing this design spends its whole budget
// avoiding, and IMDSv2's hop-limited, token-gated shape is what replaced it.
//
// The five disciplines are ./custody-gcp-client.ts's, applied the same way:
// URLs built from a configured origin, `redirect: "manual"` with any 3xx
// refused, one `AbortSignal.timeout` per operation, bodies bounded before
// parsing, and a closed failure set with no `cause` and no response body in any
// message. The secret access key and the session token live in a closure and are
// never interpolated into anything but a signature.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { CustodyError } from "./custody.js";
import type { CustodyFailure } from "./custody.js";
import type { Logger } from "./log.js";

/** Where the two APIs live. Overridden only by tests — see `AwsClientOptions`. */
export interface AwsEndpoints {
  /** Origin only, no path. Defaulted per region when absent. */
  readonly secretsManager?: string;
  /** Origin only. The link-local IMDS address; the token never leaves the host. */
  readonly metadata: string;
}

export const DEFAULT_IMDS_ENDPOINT = "http://169.254.169.254";

/** The bound ./outbound.ts, apps/runner/src/docker.ts and the GCP client take. */
const MAX_CONTROL_BODY_BYTES = 65_536;

const DEFAULT_TIMEOUT_MS = 30_000;

/** How early to replace credentials, the GCP client's margin and its reason. */
const CREDENTIAL_MARGIN_MS = 60_000;

const SERVICE = "secretsmanager";
const ALGORITHM = "AWS4-HMAC-SHA256";
const IMDS_TOKEN_TTL_SECONDS = 21_600;

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * Why a call failed, in this backend's own words.
 *
 * `denied` covers both halves of "AWS would not do this for you": an IAM policy
 * that does not allow the action, and a signature it would not accept. They are
 * one word on purpose — an operator's next step is the same either way, which is
 * to look at what this process is running as — and splitting them would imply
 * this code can tell a rejected policy from a rejected signature, which it
 * cannot without trusting the message it is refusing to read.
 */
export type AwsFailure =
  | "unreachable"
  | "timed_out"
  | "denied"
  | "redirected"
  | "too_large"
  | "malformed_response";

const CUSTODY_FAILURE: Record<AwsFailure, CustodyFailure> = {
  unreachable: "unreachable",
  timed_out: "unreachable",
  denied: "unauthorized",
  redirected: "unreachable",
  too_large: "too_large",
  malformed_response: "malformed"
};

/** No `cause`, and no response body: both can carry a signature or a value. */
export class AwsCustodyError extends CustodyError {
  readonly reason: AwsFailure;

  constructor(reason: AwsFailure) {
    super(`proxy aws secrets manager: ${reason}`, CUSTODY_FAILURE[reason]);
    this.name = "AwsCustodyError";
    this.reason = reason;
  }
}

export interface AwsClientOptions {
  readonly region: string;
  /**
   * Test-only. `custodyFromEnv` never sets one, and there is no environment
   * variable that can: an operator-settable API endpoint inside the process
   * that holds every credential is a switch for redirecting them somewhere
   * else. `env.test.ts` asserts the config it builds carries no endpoint.
   */
  readonly endpoints?: AwsEndpoints;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/** One secret, as the list returns it. Names and tags — never a value. */
export interface SecretSummary {
  readonly name: string;
}

export interface SecretsManagerClient {
  /** Every secret whose name starts with this, walked across pages. */
  list(namePrefix: string): Promise<readonly SecretSummary[]>;
  /** The `AWSCURRENT` value, or `null` when the secret is not there. */
  get(name: string): Promise<string | null>;
  /** Create with tags and a first value. `false` when it already existed. */
  create(name: string, value: string, tags: Readonly<Record<string, string>>): Promise<boolean>;
  /** Put a new value and strip `AWSPREVIOUS` — replace-not-stack. */
  put(name: string, value: string): Promise<void>;
  /** `false` when the secret was not there. Irreversible; see the backend. */
  remove(name: string): Promise<boolean>;
  /** Drop the cached credentials. Calls fail afterwards. */
  close(): void;
}

interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | undefined;
  readonly expiresAt: number;
}

export function createSecretsManagerClient(options: AwsClientOptions): SecretsManagerClient {
  const region = options.region;
  const metadata = options.endpoints?.metadata ?? DEFAULT_IMDS_ENDPOINT;
  const origin =
    options.endpoints?.secretsManager ?? `https://${SERVICE}.${region}.amazonaws.com`;
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger;

  let closed = false;
  let credentials: AwsCredentials | undefined;
  let fetching: Promise<AwsCredentials> | undefined;

  const requireOpen = (): void => {
    if (closed) throw new AwsCustodyError("unreachable");
  };

  /**
   * One round trip, with the five disciplines and an explicit allowlist of
   * acceptable statuses — apps/runner/src/docker.ts's `expect`, so "400 here
   * means absent, 400 there means broken" stays a decision at each call site.
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
      throw new AwsCustodyError(wasTimeout(error) ? "timed_out" : "unreachable");
    }

    if (response.status >= 300 && response.status < 400) {
      throw new AwsCustodyError("redirected");
    }

    const body = await readBounded(response, MAX_CONTROL_BODY_BYTES);
    if (body === null) throw new AwsCustodyError("too_large");

    if (ok.includes(response.status)) return body;
    if (response.status === 401 || response.status === 403) throw new AwsCustodyError("denied");
    throw new AwsCustodyError("unreachable");
  };

  /**
   * Temporary credentials from the instance role, over IMDSv2.
   *
   * Three round trips the first time — a PUT for the session token, a GET for
   * the role name, a GET for the credentials — then cached until they are within
   * a minute of expiring. Single-flighted, so a startup that opens N secrets
   * asks once.
   */
  const acquire = async (signal: AbortSignal): Promise<AwsCredentials> => {
    if (credentials !== undefined && now() < credentials.expiresAt - CREDENTIAL_MARGIN_MS) {
      return credentials;
    }
    if (fetching !== undefined) return fetching;

    const started = (async (): Promise<AwsCredentials> => {
      // IMDSv2: unauthenticated GETs are refused, so a request forged through
      // a server-side request forgery in some other process cannot read the
      // role's credentials without first doing a PUT it cannot do.
      const token = (
        await request(
          signal,
          `${metadata}/latest/api/token`,
          {
            method: "PUT",
            headers: { "x-aws-ec2-metadata-token-ttl-seconds": String(IMDS_TOKEN_TTL_SECONDS) }
          },
          [200]
        )
      ).trim();
      const headers = { "x-aws-ec2-metadata-token": token };

      const role = (
        await request(
          signal,
          `${metadata}/latest/meta-data/iam/security-credentials/`,
          { method: "GET", headers },
          [200]
        )
      ).trim();
      if (role === "") throw new AwsCustodyError("denied");

      const body = await request(
        signal,
        `${metadata}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
        { method: "GET", headers },
        [200]
      );
      const fields = parseJson(body) as {
        AccessKeyId?: unknown;
        SecretAccessKey?: unknown;
        Token?: unknown;
        Expiration?: unknown;
      };
      if (typeof fields.AccessKeyId !== "string" || fields.AccessKeyId === "") {
        throw new AwsCustodyError("malformed_response");
      }
      if (typeof fields.SecretAccessKey !== "string" || fields.SecretAccessKey === "") {
        throw new AwsCustodyError("malformed_response");
      }
      const expiry =
        typeof fields.Expiration === "string" ? Date.parse(fields.Expiration) : Number.NaN;

      credentials = {
        accessKeyId: fields.AccessKeyId,
        secretAccessKey: fields.SecretAccessKey,
        sessionToken: typeof fields.Token === "string" ? fields.Token : undefined,
        // An unparseable expiry is treated as "expires now plus the margin",
        // which costs a re-fetch per call rather than serving on credentials
        // whose lifetime this process cannot reason about.
        expiresAt: Number.isNaN(expiry) ? now() + CREDENTIAL_MARGIN_MS : expiry
      };
      return credentials;
    })().finally(() => {
      fetching = undefined;
    });

    fetching = started;
    return started;
  };

  /** One Secrets Manager action: a signed POST carrying a JSON body. */
  const call = async (
    action: string,
    payload: Record<string, unknown>,
    tolerated: readonly string[] = []
  ): Promise<Record<string, unknown>> => {
    requireOpen();
    const signal = AbortSignal.timeout(timeoutMs);
    const held = await acquire(signal);
    const body = JSON.stringify(payload);
    const host = new URL(origin).host;
    const stamp = amazonDate(new Date(now()));

    const headers: Record<string, string> = {
      "content-type": "application/x-amz-json-1.1",
      host,
      "x-amz-date": stamp.full,
      "x-amz-target": `secretsmanager.${action}`,
      ...(held.sessionToken !== undefined ? { "x-amz-security-token": held.sessionToken } : {})
    };
    headers["authorization"] = authorizationHeader({
      credentials: held,
      region,
      stamp,
      headers,
      body
    });

    // AWS answers a client error as 400 with a `__type`. Which of those are
    // "this question has no answer" rather than "this call failed" is the
    // caller's decision, passed in as `tolerated`.
    const raw = await request(signal, origin, { method: "POST", headers, body }, [200, 400]);
    const parsed = parseJson(raw) as Record<string, unknown>;
    const type = errorTypeOf(parsed);
    if (type === null) return parsed;
    if (tolerated.includes(type)) return { __tolerated: type };
    // A refused signature and a refused policy are one word: an operator's next
    // step is the same, and this code cannot tell them apart without trusting
    // the message it is declining to read.
    if (DENIED_TYPES.has(type)) throw new AwsCustodyError("denied");
    throw new AwsCustodyError("unreachable");
  };

  const tolerated = (reply: Record<string, unknown>): string | null =>
    typeof reply["__tolerated"] === "string" ? reply["__tolerated"] : null;

  return {
    async list(namePrefix): Promise<readonly SecretSummary[]> {
      const found: SecretSummary[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const reply = await call("ListSecrets", {
          MaxResults: PAGE_SIZE,
          Filters: [{ Key: "name", Values: [namePrefix] }],
          ...(nextToken !== undefined ? { NextToken: nextToken } : {})
        });
        const list = reply["SecretList"];
        if (list !== undefined) {
          if (!Array.isArray(list)) throw new AwsCustodyError("malformed_response");
          for (const entry of list) {
            const name = (entry as { Name?: unknown }).Name;
            if (typeof name !== "string") throw new AwsCustodyError("malformed_response");
            // The `name` filter is a prefix match on AWS, but LocalStack and a
            // future API revision are two reasons not to take that on trust.
            if (name.startsWith(namePrefix)) found.push({ name });
          }
        }
        const token = reply["NextToken"];
        if (typeof token !== "string" || token === "") return found;
        nextToken = token;
      }
      logger?.log("error", { event: "aws_secret_list_truncated" });
      throw new AwsCustodyError("too_large");
    },

    async get(name): Promise<string | null> {
      // A secret that is not there, and one scheduled for deletion, are both
      // "no value under this name" rather than a failure.
      const reply = await call("GetSecretValue", { SecretId: name }, [
        "ResourceNotFoundException",
        "InvalidRequestException"
      ]);
      if (tolerated(reply) !== null) return null;
      const value = reply["SecretString"];
      if (value === undefined) return null;
      if (typeof value !== "string") throw new AwsCustodyError("malformed_response");
      return value;
    },

    async create(name, value, tags): Promise<boolean> {
      // **`ClientRequestToken` is required on the raw API and optional through
      // an SDK**, which is the shape of mistake hand-rolling is exposed to and
      // the reason `packages/aws-conformance` exists: the SDKs generate one, the
      // documentation says so in a sentence about the SDKs, and a client written
      // from the request reference alone omits it and gets an
      // `InvalidRequestException`. LocalStack caught this on the first run.
      //
      // It is also an idempotency token: a retried create with the same token
      // and the same value succeeds rather than colliding. Fresh per call here,
      // because nothing retries at this level.
      const reply = await call(
        "CreateSecret",
        {
          Name: name,
          SecretString: value,
          ClientRequestToken: randomUUID(),
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
        },
        ["ResourceExistsException"]
      );
      return tolerated(reply) === null;
    },

    async put(name, value): Promise<void> {
      await call("PutSecretValue", {
        SecretId: name,
        SecretString: value,
        ClientRequestToken: randomUUID()
      });

      // **Replace-not-stack, and AWS does not do it by default.** `AWSPREVIOUS`
      // keeps the superseded value readable to anyone with `GetSecretValue`,
      // which for a rotated refresh token means the dead one is still there.
      // The GCP backend destroys the predecessor; this makes the two agree.
      // A version left with no staging label is deprecated and AWS removes it.
      //
      // The `DescribeSecret` is what costs the extra call: `PutSecretValue`
      // reports the stages of the version it just wrote and not of the one it
      // displaced. Writes are an operator action or a token rotation, so the
      // call is paid where there is time for it.
      const described = await call("DescribeSecret", { SecretId: name });
      const stages = described["VersionIdsToStages"];
      if (typeof stages !== "object" || stages === null) return;
      for (const [versionId, labels] of Object.entries(stages as Record<string, unknown>)) {
        if (Array.isArray(labels) && labels.includes("AWSPREVIOUS")) {
          await call(
            "UpdateSecretVersionStage",
            { SecretId: name, VersionStage: "AWSPREVIOUS", RemoveFromVersionId: versionId },
            ["InvalidParameterException", "ResourceNotFoundException"]
          );
        }
      }
    },

    async remove(name): Promise<boolean> {
      // **Asked before it is told, and the reason is a divergence LocalStack
      // found.** AWS documents `DeleteSecret` as answering
      // `ResourceNotFoundException` for a name it does not hold; LocalStack
      // answers success. Deriving "was it there" from the delete's own reply
      // therefore gives a different answer on the two implementations, and the
      // caller — the operator's CLI, deciding whether to print "no credential
      // named x" — would be told wrong on one of them.
      //
      // `DescribeSecret` rather than `GetSecretValue`, which would answer the
      // same question: this path has no use for the value, and fetching a
      // credential into the process in order to delete it is a read that should
      // not happen. The check-then-act window is real and costs nothing —
      // both outcomes end with the name gone, and only the reported boolean
      // could be stale.
      const described = await call("DescribeSecret", { SecretId: name }, [
        "ResourceNotFoundException",
        "InvalidRequestException"
      ]);
      if (tolerated(described) !== null) return false;

      // `ForceDeleteWithoutRecovery`, so the name is reusable immediately.
      // The recovery window would reserve it for up to thirty days, which turns
      // `vault remove x` followed by `vault set x` into a failure an operator
      // cannot work around. Removal was always paired with revoking the
      // credential at the issuing service, which is the act that is not undoable
      // anyway.
      await call(
        "DeleteSecret",
        { SecretId: name, ForceDeleteWithoutRecovery: true },
        ["ResourceNotFoundException", "InvalidRequestException"]
      );
      return true;
    },

    close(): void {
      if (closed) return;
      closed = true;
      // A JavaScript string cannot be zeroed — ./vault.ts's heap-dump
      // concession, again. Dropping the reference is what there is.
      credentials = undefined;
    }
  };
}

/**
 * What AWS refuses to do for you, in one set.
 *
 * `InvalidSignatureException` is in it deliberately: a mistake in the signing
 * below arrives here rather than anywhere quieter, which is the property that
 * makes hand-rolled SigV4 an acceptable hundred lines.
 */
const DENIED_TYPES = new Set([
  "AccessDeniedException",
  "AccessDenied",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "IncompleteSignature",
  "MissingAuthenticationToken",
  "ExpiredTokenException",
  "InvalidClientTokenId"
]);

/**
 * The `__type` of an AWS error reply, or `null` when it is not one.
 *
 * AWS prefixes it with a namespace in some services (`com.amazonaws...#Name`)
 * and not others; the last segment is the name either way. The `message` is
 * deliberately never read: it is free text from outside this process, and the
 * one thing this module must not do is put such a thing into an error.
 */
function errorTypeOf(reply: Record<string, unknown>): string | null {
  const raw = reply["__type"] ?? reply["code"];
  if (typeof raw !== "string" || raw === "") return null;
  const hash = raw.lastIndexOf("#");
  return hash === -1 ? raw : raw.slice(hash + 1);
}

interface AmazonDate {
  readonly full: string;
  readonly day: string;
}

/** `20260829T110700Z` and `20260829`, the two forms a signature needs. */
function amazonDate(at: Date): AmazonDate {
  const full = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { full, day: full.slice(0, 8) };
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

/**
 * SigV4, in the four steps the specification names.
 *
 * A canonical request, a string to sign over its digest, a signing key derived
 * from the secret through date, region and service, and one HMAC. The scoping
 * is what makes a leaked signature worth little: it is valid for one day, one
 * region and one service, and only over the exact headers it names.
 *
 * The body is hashed rather than sent unsigned. `UNSIGNED-PAYLOAD` is a legal
 * choice AWS offers and the wrong one here — every one of these requests either
 * carries a credential value or asks for one, and a signature that does not
 * cover the body would let a proxy in the path change which secret was written.
 */
function authorizationHeader(input: {
  credentials: AwsCredentials;
  region: string;
  stamp: AmazonDate;
  headers: Readonly<Record<string, string>>;
  body: string;
}): string {
  const { credentials, region, stamp, headers, body } = input;

  const canonicalNames = Object.keys(headers)
    .map(name => name.toLowerCase())
    .sort();
  const lookup = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonicalHeaders = canonicalNames
    .map(name => `${name}:${(lookup.get(name) ?? "").trim()}\n`)
    .join("");
  const signedHeaders = canonicalNames.join(";");

  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(body)
  ].join("\n");

  const scope = `${stamp.day}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp.full, scope, sha256(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, stamp.day), region), SERVICE),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new AwsCustodyError("malformed_response");
  }
}

/** The body, or `null` past the bound. A value rather than a throw. */
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
