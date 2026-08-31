// A DPoP proof: one JWS, made per request, worth nothing anywhere else.
//
// RFC 9449. The proof is what turns a bearer token — a password anyone holding
// it may spend — into a credential only the process holding the private key can
// present. ./signing-key.ts owns the key (#504); this owns what is signed with
// it, and the two are apart because a key outlives a deployment and a proof
// outlives nothing.
//
// **What a proof binds, and why each member is here.** The header carries the
// public key, so a verifier needs no registry to check the signature and can
// compare the key's thumbprint against what the token was bound to. The payload
// binds the proof to one request — `htm` the method, `htu` the URL — and to one
// moment, `iat` plus a `jti` the server may remember. `nonce` is the server's
// own challenge where it issues one, and `ath` binds the proof to the access
// token it accompanies, which is what stops a proof lifted off one request from
// carrying a different token on the next.
//
// **What this module deliberately does not do.** It does not verify proofs.
// The proxy is a client here: it makes them and an authorization server checks
// them, and the only verifier in this repository is ./fake-token-issuer.ts,
// which is a *test* server written to be as strict as a real one — #484's
// discipline, that a fake accepting anything proves nothing. A verifier in this
// module would be a second implementation for the fake to agree with by
// construction rather than by being checked.
//
// Nothing third-party. `node:crypto` is the whole cryptographic dependency, in
// keeping with the rule stated at the top of ./server.ts — and a JWS this
// narrow is a header, a payload and a signature over the two, which is less
// code than the wrapper for a JOSE library would be.

import { createHash, randomBytes } from "node:crypto";
import type { SigningKey } from "./custody.js";

/**
 * The `typ` every DPoP proof carries, and a verifier that skips it is one an
 * ordinary JWT can be replayed at. Fixed by RFC 9449 §4.2.
 */
export const DPOP_PROOF_TYPE = "dpop+jwt";

/**
 * How stale a proof may be before a strict server rejects it.
 *
 * Not enforced here — the maker cannot be late — and stated because it is the
 * number ./fake-token-issuer.ts enforces and the reason `iat` is minted per
 * request rather than per exchange. RFC 9449 leaves the window to the server;
 * this is the tightest one a client should assume it will meet.
 */
export const DPOP_PROOF_LIFETIME_SECONDS = 300;

export interface DpopProofRequest {
  readonly key: SigningKey;
  /** The request's method, uppercased by the caller's own constant. */
  readonly method: string;
  /**
   * The request URI, which the proof carries *without* query or fragment.
   *
   * RFC 9449 §4.2's rule, and it is not a simplification: a server recomputes
   * `htu` from the request it received, and a query string that any proxy or
   * redirect could reorder would make a correct proof fail on a good day.
   */
  readonly url: string;
  /** The server's challenge, where one was issued. */
  readonly nonce?: string;
  /**
   * The access token this proof accompanies, for the `ath` claim.
   *
   * Absent at the token endpoint, where there is no token yet, and present on
   * every call that spends one. Hashed, never carried: `ath` is the digest of
   * the token, so a proof discloses nothing about the credential it binds.
   */
  readonly accessToken?: string;
  /** Injected so a proof's own timestamp is a decision rather than a wait. */
  readonly now?: () => number;
}

/**
 * One proof, signed.
 *
 * Compact JWS: `base64url(header).base64url(payload).base64url(signature)`,
 * ES256 over the first two joined by a dot. The signature is the P-1363 pair
 * `SigningKey.sign` produces — DER here would be rejected as a bad signature
 * rather than as a malformed one, which is the failure that costs a day.
 *
 * `jti` is 16 random bytes rather than a counter: a server that remembers them
 * to catch replays must be able to hold two proxies' worth without collision,
 * and a counter restarts at one when this process does.
 */
export function createDpopProof(request: DpopProofRequest): string {
  const now = request.now ?? Date.now;
  const header = {
    typ: DPOP_PROOF_TYPE,
    alg: request.key.alg,
    jwk: request.key.publicJwk
  };
  const payload = {
    jti: randomBytes(16).toString("base64url"),
    htm: request.method,
    htu: htuOf(request.url),
    iat: Math.floor(now() / 1_000),
    ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
    ...(request.accessToken !== undefined ? { ath: accessTokenHash(request.accessToken) } : {})
  };

  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = request.key.sign(Buffer.from(signingInput, "utf8"));
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * RFC 9449 §4.2's `ath`: the base64url SHA-256 of the access token.
 *
 * Not exported, and ./fake-token-issuer.ts deliberately computes its own rather
 * than importing this one: a verifier that shares the maker's arithmetic agrees
 * with it by construction, which is #484's argument for why a fake has to be
 * written from the specification rather than from the code it checks.
 */
function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken, "utf8").digest("base64url");
}

/**
 * The `htu`: scheme, host and path, with query and fragment removed.
 *
 * Not exported, for `accessTokenHash`'s reason: the verifier computes this from
 * the request it received, and sharing the function would make the two agree
 * without either being checked.
 */
function htuOf(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * The `DPoP-Nonce` header a server issues a challenge in, and the error code it
 * pairs with.
 *
 * Named here rather than spelled at the call sites because the retry is the one
 * place a client must react to a *failure* by trying again, and a typo in
 * either string turns "retry once with the nonce" into "fail the exchange".
 */
export const DPOP_NONCE_HEADER = "dpop-nonce";
export const USE_DPOP_NONCE_ERROR = "use_dpop_nonce";

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
