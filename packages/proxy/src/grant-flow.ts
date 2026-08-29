// The authorization-code grant, orchestrated for a headless proxy.
//
// The operator's browser is on a laptop; the proxy is on a VM with no
// published ports. So the redirect lands nowhere: the flow's redirect URI is
// a loopback address nothing listens on, the browser fails to load it with
// the code still in the address bar, and the operator pastes the full URL
// back into the waiting entrypoint. What protects the code on that trip is
// not the channel but the protocol — PKCE binds it to a verifier that never
// leaves this process, `state` binds the paste to this run, and the code is
// single-use at the issuer. A listener would buy nothing but two forwarding
// hops to document and a hang when either is missing.
//
// The refresh token this flow obtains never leaves the package: the
// orchestrator writes the store itself rather than returning the value for a
// caller to write, which is what keeps "no command prints a token back"
// structural rather than a discipline the entrypoint has to keep.
//
// `GRANT_REDIRECT_URI` must stay in lockstep with `redirect_uris` in the
// published Client ID Metadata Document (site/public/client.json) — the
// authorization server matches the request's redirect URI against that
// document, and the JSON can carry no comment pointing back here.

import { createHash, randomBytes } from "node:crypto";
import { discoverAuthorizationServer, exchangeAuthorizationCode } from "./outbound.js";
import type { TokenStore } from "./custody.js";

export const GRANT_REDIRECT_URI = "http://127.0.0.1/callback";

/** The paste is one URL; anything past this is not one. */
const MAX_CALLBACK_BYTES = 16 * 1024;

/**
 * Why a grant did not complete, phrased for an operator's terminal. A closed
 * set for the reason the exchange's is: the flow holds the code, the verifier
 * and eventually the refresh token, so what it throws must be safe to print
 * by construction — no member ever carries a byte of the paste.
 */
export type GrantFlowFailure =
  | "no_authorization_endpoint"
  | "pkce_unsupported"
  | "callback_not_a_url"
  | "state_mismatch"
  | "authorization_denied"
  | "code_missing"
  | "no_refresh_token"
  | "input_closed";

/** RFC 6749 §4.1.2.1's error codes — the only words `deniedAs` may carry. */
const AUTHORIZATION_ERROR_CODES = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable"
]);

export class GrantFlowError extends Error {
  readonly failure: GrantFlowFailure;
  /** Only ever a word from RFC 6749 §4.1.2.1's closed set; anything else was dropped. */
  readonly deniedAs?: string;

  constructor(failure: GrantFlowFailure, deniedAs?: string) {
    super(`grant flow: ${failure}`);
    this.name = "GrantFlowError";
    this.failure = failure;
    if (deniedAs !== undefined) this.deniedAs = deniedAs;
  }
}

/**
 * The two moments the flow needs a human: showing the URL to authorize at,
 * and collecting the URL the browser failed to load. `null` from the prompt
 * is stdin closing — a pipe that ended, an operator who gave up.
 */
export interface GrantFlowIo {
  showAuthorizationUrl(url: string): void;
  promptCallbackUrl(): Promise<string | null>;
}

export interface GrantFlowRequest {
  /** The credential name the sheets bind the grant to. */
  readonly credential: string;
  /** The issuer, byte for byte as the sheets declare it. */
  readonly issuer: string;
  /** The union of the declaring sheets' scopes. */
  readonly scopes: readonly string[];
  /** The Client ID Metadata Document URL to make the grant under. */
  readonly clientId: string;
  readonly store: TokenStore;
  readonly io: GrantFlowIo;
  /** Per network phase; the human in the middle has no timeout. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/**
 * Run the grant end to end: discover, authorize, exchange, store.
 *
 * Throws GrantFlowError, TokenExchangeError, TokenStoreError or
 * GrantEntryError — all closed-set, all safe to print. `replaced` reports
 * whether a predecessor existed under the name, which the store overwrote
 * (replace-not-stack, `putGrant`'s contract).
 */
export async function performAuthorizationGrant(request: GrantFlowRequest): Promise<{ replaced: boolean }> {
  const send = request.fetch ?? globalThis.fetch;
  const now = request.now ?? Date.now;

  // PKCE and state, generated here and nowhere else. The verifier is 32
  // random bytes base64url'd (43 chars, within RFC 7636's 43..128); only its
  // S256 hash goes over the front channel.
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  // Discovery for the authorization endpoint. The exchange will discover
  // again for the token endpoint — two round trips rather than a trust seam
  // where a caller hands the exchange an endpoint it must believe was pinned,
  // and a human paste separates the two anyway.
  const issuerOrigin = new URL(request.issuer).origin;
  const signal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_GRANT_PHASE_TIMEOUT_MS);
  const metadata = await discoverAuthorizationServer(send, request.issuer, issuerOrigin, signal);

  // The URL we print is where the operator will type a password, so the
  // authorization endpoint is pinned to the issuer's origin exactly as the
  // token endpoint is — stricter than the RFC asks, deliberately.
  if (metadata.authorizationEndpoint === undefined || !sameOrigin(metadata.authorizationEndpoint, issuerOrigin)) {
    throw new GrantFlowError("no_authorization_endpoint");
  }
  // S256 or nothing: a methods list without it is a refusal, an absent list
  // is an old server that may still take it — proceed and let the exchange
  // fail. Never downgrade to `plain`.
  if (
    metadata.codeChallengeMethodsSupported !== undefined &&
    !metadata.codeChallengeMethodsSupported.includes("S256")
  ) {
    throw new GrantFlowError("pkce_unsupported");
  }

  const authorizationUrl = new URL(metadata.authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", request.clientId);
  authorizationUrl.searchParams.set("redirect_uri", GRANT_REDIRECT_URI);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (request.scopes.length > 0) authorizationUrl.searchParams.set("scope", request.scopes.join(" "));

  request.io.showAuthorizationUrl(authorizationUrl.toString());

  const pasted = await request.io.promptCallbackUrl();
  if (pasted === null) throw new GrantFlowError("input_closed");
  const code = parseCallback(pasted.trim(), state);

  const granted = await exchangeAuthorizationCode({
    issuer: request.issuer,
    clientId: request.clientId,
    redirectUri: GRANT_REDIRECT_URI,
    code,
    codeVerifier,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    fetch: send
  });
  if (granted.refreshToken === undefined) {
    // A headless proxy cannot hold a grant on an access token that dies with
    // this process. The store is untouched: a predecessor, if any, survives.
    throw new GrantFlowError("no_refresh_token");
  }

  // What the record holds is what was *granted*: an issuer may narrow the
  // asked scopes, and storing the request's union would let the sheet⊆grant
  // check pass on scopes the grant does not hold — every call then failing at
  // the upstream instead of failing closed here as `scopes_exceeded`.
  const scopes = granted.grantedScope !== undefined ? splitScope(granted.grantedScope) : request.scopes;

  // A probe, not a read-back: only the answer's shape is looked at, and the
  // `Secret` inside a `found` is dropped unopened. The empty binding scopes
  // make the subset check vacuous, so any record under the name answers —
  // `issuer_mismatch` included, because a predecessor under another issuer is
  // still a predecessor this write replaces.
  const before = await request.store.read(request.credential, { issuer: request.issuer, scopes: [] });
  const replaced = !(before.status === "missing" && before.reason === "absent");

  await request.store.putGrant(request.credential, {
    issuer: request.issuer,
    clientId: request.clientId,
    refreshToken: granted.refreshToken,
    scopes,
    obtainedAt: now()
  });

  return { replaced };
}

/** The default per-phase budget: generous for a control-plane round trip. */
const DEFAULT_GRANT_PHASE_TIMEOUT_MS = 30_000;

/**
 * The code off the pasted redirect, or a throw whose message is a closed
 * word. `state` is ruled on first: a stale or foreign paste is that fact
 * regardless of what else the URL carries.
 */
function parseCallback(pasted: string, expectedState: string): string {
  if (pasted.length === 0 || Buffer.byteLength(pasted, "utf8") > MAX_CALLBACK_BYTES) {
    throw new GrantFlowError("callback_not_a_url");
  }
  let url: URL;
  try {
    url = new URL(pasted);
  } catch {
    throw new GrantFlowError("callback_not_a_url");
  }

  if (url.searchParams.get("state") !== expectedState) throw new GrantFlowError("state_mismatch");

  const error = url.searchParams.get("error");
  if (error !== null) {
    throw new GrantFlowError("authorization_denied", AUTHORIZATION_ERROR_CODES.has(error) ? error : undefined);
  }

  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) throw new GrantFlowError("code_missing");
  return code;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** RFC 6749's scope member: space-delimited, order meaningless. */
function splitScope(scope: string): readonly string[] {
  return scope.split(" ").filter(member => member.length > 0);
}
