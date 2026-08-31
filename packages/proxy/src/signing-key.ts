// The DPoP signing key: minted here, loaded here, and never leaving here.
//
// ./custody.ts declares `SigningKey` and `SigningKeyStore` and cannot implement
// them — its import list holds no `node:crypto`, which is the argument that
// makes "the files are the built form" checkable. This is the other half: every
// backend's signing store is *this* module's logic over four small methods, so
// there is one place that decides what a key is, one that mints it, and one
// that turns stored bytes back into something that can sign.
//
// **Why that split rather than three implementations.** The two mistakes
// available here are silent. A backend that minted a second key where one was
// already stored would strand every grant bound to the first; a backend that
// serialized the material its own way would hand the next release a store it
// cannot read. Both look like working code, and `parseGrantRecord`'s reasoning
// applies unchanged: one implementation is one thing to review.
//
// **What a backing owes, and what it does not.** Four methods — read the stored
// material, create it if none is stored, say this backend's word for material
// that is not a key, and close. Everything else is here: minting, adoption,
// the thumbprint, the cache, and the refusal after close. A backend that holds
// a string under a name already knows how to do all four.
//
// Nothing third-party. `node:crypto` is the whole cryptographic dependency, in
// keeping with the rule stated at the top of ./server.ts.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signWith
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { credentialValueRejection } from "./custody.js";
import type { Awaitable, PublicJwk, SigningKey, SigningKeyStore } from "./custody.js";
import type { Logger } from "./log.js";

/**
 * The one algorithm, and the one curve.
 *
 * RFC 9449 leaves the choice open; ES256 is what every authorization server
 * that speaks DPoP accepts, and a second alg would be a negotiation this proxy
 * has no reason to hold. The store rejects material that is anything else
 * rather than widening to fit it — a key of another shape in the backing is a
 * store written by something that is not this code.
 */
export const SIGNING_ALG = "ES256";
const CURVE = "P-256";

/** The stored plaintext's version, ./token-store.ts's `v` and its purpose. */
const VERSION = 1;

/**
 * What a store holds a key in.
 *
 * One string, so a backend that can hold a credential can hold this: the file
 * backend seals it in an envelope, and a managed backend makes it a secret's
 * value. PKCS#8 PEM rather than a JWK because it is what `node:crypto` reads
 * back without a branch, and the `alg` beside it is what a future second
 * algorithm would be selected by — read, checked, and never guessed from the
 * key's own shape.
 */
export interface SigningKeyBacking {
  /** The stored material, or `null` when the backing holds none. */
  read(): Awaitable<string | null>;

  /**
   * Store this material if the backing holds none, and return whatever it
   * holds afterwards.
   *
   * Create-if-absent, and the return is the adoption: a second process that got
   * there first wins, and this one loads the winner rather than overwriting it.
   * A backing that cannot create atomically says so in its own header and
   * prices the race there — it is ./custody-gcp.ts's residual one, and it costs
   * a re-grant rather than a wrong answer.
   */
  create(material: string): Promise<string>;

  /** This backend's error for material that is not a signing key. */
  malformed(): Error;

  /** Release what the backing retained. `read` and `create` fail afterwards. */
  close(): void;
}

export interface SigningKeyDeps {
  readonly logger?: Logger;
}

/**
 * A fresh keypair, as stored material.
 *
 * Called once in the life of a deployment — the first exchange that needs a
 * proof — and never on a path a request waits on twice.
 */
export function mintSigningKeyMaterial(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return JSON.stringify({ v: VERSION, alg: SIGNING_ALG, key: pem.toString() });
}

/**
 * Stored material to a usable key, or `null` when it is not one.
 *
 * `null` rather than a throw, `parseGrantRecord`'s convention: the backend
 * decides which of its own words carries it, so an operator still meets the
 * precise one.
 *
 * Everything is checked rather than assumed — the version, the algorithm, that
 * the key is EC, and that the curve is the one `ES256` names. A P-384 key
 * loaded under an `ES256` header would sign happily and be rejected by every
 * authorization server, which is a failure at the far end of an exchange
 * instead of at the store.
 */
export function parseSigningKeyMaterial(material: string): SigningKey | null {
  // The contract's cap, for the reason every writer holds it: this is a stored
  // credential like any other, and a backing that somehow holds a megabyte
  // should be refused before `createPrivateKey` is asked to parse it.
  if (credentialValueRejection(material) !== null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(material);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as { v?: unknown; alg?: unknown; key?: unknown };
  if (body.v !== VERSION || body.alg !== SIGNING_ALG) return null;
  if (typeof body.key !== "string" || body.key.length === 0) return null;

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(body.key);
  } catch {
    // Nothing from the error is kept — `VaultError`'s no-`cause` argument, at
    // the one place in this module where OpenSSL speaks.
    return null;
  }
  if (privateKey.asymmetricKeyType !== "ec") return null;

  const publicJwk = publicJwkOf(privateKey);
  if (publicJwk === null) return null;
  return signingKeyOver(privateKey, publicJwk);
}

/**
 * The public members, from the private key.
 *
 * Exported from a *public* handle rather than from the private one, which is
 * the difference between a JWK with a `d` member and a JWK without: the private
 * scalar must not reach an object that gets serialized into a proof header.
 */
function publicJwkOf(privateKey: KeyObject): PublicJwk | null {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as Record<string, unknown>;
  if (jwk["kty"] !== "EC" || jwk["crv"] !== CURVE) return null;
  const { x, y } = jwk;
  if (typeof x !== "string" || typeof y !== "string") return null;
  return { kty: "EC", crv: CURVE, x, y };
}

/**
 * RFC 7638 §3.2: SHA-256 over the required members, lexicographic, no
 * whitespace, base64url.
 *
 * Written out rather than `JSON.stringify`ed from the JWK object, because the
 * canonical form is a wire format an authorization server recomputes: a member
 * order that happened to match today's `export({format:"jwk"})` would be a
 * thumbprint that changes under Node. The three members are P-256's required
 * set and `PublicJwk` holds exactly them.
 */
export function jwkThumbprint(jwk: PublicJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/**
 * The object the rest of the proxy gets: a public half, a thumbprint, and one
 * verb.
 *
 * The `KeyObject` is a closure variable and nothing else — no property holds
 * it, so `util.inspect`, `JSON.stringify` and a spread all render an object
 * with a function on it. `makeSecret`'s posture without needing `makeSecret`'s
 * overrides, since there is no string here to render in the first place.
 *
 * Frozen, so `sign` cannot be swapped for something that keeps what it signed.
 */
function signingKeyOver(privateKey: KeyObject, publicJwk: PublicJwk): SigningKey {
  const thumbprint = jwkThumbprint(publicJwk);
  return Object.freeze({
    alg: SIGNING_ALG,
    publicJwk: Object.freeze(publicJwk),
    thumbprint,
    // `ieee-p1363` rather than the default DER: JWS wants the raw R‖S pair, and
    // a DER signature in a proof is rejected by every verifier as a bad
    // signature rather than as a malformed one — which is a day lost to the
    // wrong question.
    sign: (input: Buffer): Buffer =>
      signWith("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" })
  });
}

/**
 * The store every backend gets, over a backing that holds one string.
 *
 * Lazy: nothing is read or written until the first `signingKey()`, so a
 * deployment with no OAuth upstream never creates a key and a backend's suite
 * never pays for one it does not use.
 *
 * Single-flight, ./token-engine.ts's shape and its reason: two exchanges
 * starting at once must not mint two keys, and the second would strand what the
 * first had already bound. Concurrent callers await one acquisition.
 *
 * Cached after the first: `sign` runs per upstream call, and the contract's
 * `Awaitable` is there for the acquisition rather than for every proof.
 */
export function openSigningKeyStore(
  backing: SigningKeyBacking,
  deps: SigningKeyDeps = {}
): SigningKeyStore {
  const { logger } = deps;
  let closed = false;
  let held: SigningKey | undefined;
  let acquiring: Promise<SigningKey> | undefined;

  const load = (material: string): SigningKey => {
    const key = parseSigningKeyMaterial(material);
    if (key === null) throw backing.malformed();
    return key;
  };

  const acquire = async (): Promise<SigningKey> => {
    const stored = await backing.read();
    if (stored !== null) {
      const key = load(stored);
      logger?.log("info", { event: "signing_key_opened", thumbprint: key.thumbprint });
      return key;
    }
    // The material is minted before the backing is asked to hold it and is
    // discarded if the backing already had one — the adoption `create` returns.
    // A thumbprint is public: it is what the authorization server is told, so
    // logging it discloses nothing and is what makes a stranded grant legible.
    const key = load(await backing.create(mintSigningKeyMaterial()));
    logger?.log("info", { event: "signing_key_minted", thumbprint: key.thumbprint });
    return key;
  };

  return {
    signingKey(): Awaitable<SigningKey> {
      // Not served from the cache once closed: `close` means closed, rather
      // than "closed unless someone asked earlier". What refuses is the
      // backing — `unreadable` on the files, `unreachable` on a managed
      // backend — so the word an operator meets is one their backend's
      // vocabulary already holds rather than one this module invented. Every
      // backing owes that refusal, and the conformance suite is where each is
      // held to it.
      if (closed) return acquire();
      if (held !== undefined) return held;
      acquiring ??= acquire().then(
        key => {
          held = key;
          acquiring = undefined;
          return key;
        },
        error => {
          // A failed acquisition is not remembered: an unreachable backing at
          // the first exchange must not make every later one fail from a cache.
          acquiring = undefined;
          throw error;
        }
      );
      return acquiring;
    },

    close(): void {
      if (closed) return;
      closed = true;
      held = undefined;
      acquiring = undefined;
      backing.close();
    }
  };
}
