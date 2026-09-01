// The other side of a DPoP proof, for the servers that are not one.
//
// ./dpop.ts makes proofs; this checks them. Both fakes need the check — the
// authorization server at the token endpoint (#505) and the resource server at
// every call that spends a token (#506) — and one implementation between them
// is the point: two verifiers would be two chances to be lenient in a different
// place, and a test suite passing against a lenient one proves nothing about the
// proofs it was written to prove something about.
//
// **Written from RFC 9449, not from ./dpop.ts, and it imports nothing from it.**
// The thumbprint, the `htu` and the `ath` digest are computed here from the
// request that arrived and from the JWK that came with it. A verifier sharing
// the maker's arithmetic agrees with it by construction; this one can disagree,
// and a disagreement is a test failure rather than something nobody learns until
// a real server refuses a proof in production. That is #484's argument for the
// conformance suites, applied to a protocol.
//
// **Nothing in the serving path imports this.** It is the fakes' verifier: the
// proxy is a DPoP *client*, and a verifier reachable from ./server.ts would be a
// second thing to keep correct with no caller that needs it.
//
// The failure vocabulary is closed and every refusal names one word, because a
// fake that rejects a replay by mis-parsing the header would make a replay test
// green for the wrong reason. The tests assert the word, not the status.

import { createHash, createPublicKey, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

/** Why a proof was refused. One word per check, in the order they run. */
export type DpopRefusal =
  | "missing_proof"
  | "not_a_jws"
  | "not_json"
  | "wrong_typ"
  | "wrong_alg"
  | "no_jwk"
  | "private_key_in_header"
  | "wrong_key_type"
  | "malformed_jwk"
  | "bad_signature"
  | "wrong_htm"
  | "wrong_htu"
  | "no_iat"
  | "stale_iat"
  | "no_jti"
  | "replayed_jti"
  | "wrong_nonce"
  | "missing_ath"
  | "wrong_ath";

export type DpopCheck =
  | { readonly ok: true; readonly thumbprint: string }
  | { readonly ok: false; readonly refusal: DpopRefusal };

/** How far from now a proof's `iat` may sit. RFC 9449 leaves it to the server. */
const IAT_WINDOW_SECONDS = 300;

export interface DpopCheckRequest {
  /** The `DPoP` header, or `undefined` when the request carried none. */
  readonly proof: string | undefined;
  /** The method the request actually used, not the one it claims. */
  readonly method: string;
  /** The URL it actually arrived at; the `htu` is recomputed from this. */
  readonly url: string;
  /** The nonce this server issued, where it has issued one. */
  readonly nonce?: string;
  /**
   * The access token the request presented, where it presented one.
   *
   * A resource server checks `ath` and an authorization server has no token to
   * check against — which is the one real difference between the two callers,
   * and the reason this is a field rather than two functions. Present here means
   * the proof must carry a matching `ath`; absent means it must not be asked
   * for.
   */
  readonly accessToken?: string;
}

/**
 * Check one proof against the request it arrived on.
 *
 * `seenJti` is the caller's, because replay memory belongs to the server rather
 * than to the check: two fakes in one test are two servers, and a `jti` accepted
 * by one says nothing about the other. Mutated on success only — a proof that
 * failed for another reason has not been spent.
 */
export function checkDpopProof(request: DpopCheckRequest, seenJti: Set<string>): DpopCheck {
  const no = (refusal: DpopRefusal): DpopCheck => ({ ok: false, refusal });
  if (request.proof === undefined) return no("missing_proof");

  const parts = request.proof.split(".");
  if (parts.length !== 3) return no("not_a_jws");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return no("not_json");
  }

  if (header["typ"] !== "dpop+jwt") return no("wrong_typ");
  if (header["alg"] !== "ES256") return no("wrong_alg");
  const jwk = header["jwk"];
  if (typeof jwk !== "object" || jwk === null) return no("no_jwk");
  const members = jwk as Record<string, unknown>;
  // A private key in a proof header is a client leaking its own key. The RFC
  // forbids it, and a verifier that accepted one would never tell anybody.
  if (members["d"] !== undefined) return no("private_key_in_header");
  if (members["kty"] !== "EC" || members["crv"] !== "P-256") return no("wrong_key_type");
  if (typeof members["x"] !== "string" || typeof members["y"] !== "string") return no("malformed_jwk");

  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  } catch {
    return no("malformed_jwk");
  }
  const signed = verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(encodedSignature, "base64url")
  );
  if (!signed) return no("bad_signature");

  if (payload["htm"] !== request.method) return no("wrong_htm");
  const arrivedAt = new URL(request.url);
  arrivedAt.search = "";
  arrivedAt.hash = "";
  if (payload["htu"] !== arrivedAt.toString()) return no("wrong_htu");

  const iat = payload["iat"];
  if (typeof iat !== "number") return no("no_iat");
  if (Math.abs(Math.floor(Date.now() / 1_000) - iat) > IAT_WINDOW_SECONDS) return no("stale_iat");

  const jti = payload["jti"];
  if (typeof jti !== "string" || jti.length === 0) return no("no_jti");
  if (seenJti.has(jti)) return no("replayed_jti");

  if (request.nonce !== undefined && payload["nonce"] !== request.nonce) return no("wrong_nonce");

  // `ath` is what stops a proof lifted off one request from carrying a
  // different token on the next — checked by recomputing the digest here rather
  // than by believing the claim.
  if (request.accessToken !== undefined) {
    const ath = payload["ath"];
    if (typeof ath !== "string") return no("missing_ath");
    const expected = createHash("sha256").update(request.accessToken, "utf8").digest("base64url");
    if (ath !== expected) return no("wrong_ath");
  }

  seenJti.add(jti);
  return { ok: true, thumbprint: thumbprintOf(members) };
}

/**
 * RFC 7638 §3.2 over the required members, in the order the RFC fixes.
 *
 * Spelled out rather than shared with ./signing-key.ts: this is the computation
 * a real server makes, and the whole value of it here is that it is able to
 * disagree with the one the proxy makes.
 */
function thumbprintOf(members: Record<string, unknown>): string {
  const canonical = `{"crv":"P-256","kty":"EC","x":"${String(members["x"])}","y":"${String(members["y"])}"}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}
