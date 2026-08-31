// The custody contract — what a credential store is, with no idea what a file
// is.
//
// #254 specified the vault and the token store as *stores with a contract* —
// disjoint writer sets, provenance, keying by credential name, freshness,
// persist-before-use, replace-not-stack, values leaving only as `Secret` — and
// named the two encrypted files as the built form rather than the invariant.
// This file is that split, made a seam in code (#482): the operations, and
// ./vault.ts + ./token-store.ts as the default backend implementing them. The
// managed backends (#483 GCP, #484 AWS) implement the same declarations and
// inherit ./custody-conformance.ts rather than re-deriving what the file store
// happens to do.
//
// **The import list is the argument.** There is no `node:fs`, no `node:crypto`,
// no ./envelope.js — nothing here can name a path, a salt or a subkey, which is
// what makes "the files are the built form" checkable rather than asserted. The
// same style of claim ./vault.ts makes about never writing.
//
// What is *not* here, deliberately: envelope constants, and the write path for
// the vault, which is ./custody-admin.ts because the serving composition must
// not import it.
//
// What *is* here beyond the shapes, since #483 gave the contract a second
// implementation: the three rules a backend must not restate in its own words —
// what a value may weigh, whether a name is one, and which grant a binding
// serves. Two backends that each wrote the issuer comparison would be two
// chances to write it wrong, and the wrong one serves a refresh token to a
// server the operator never granted it to. `@getlibero/schema` is the one
// import, which is the shapes both services already agree on rather than
// anything that knows what a file is.

import { CredentialName } from "@getlibero/schema";

/**
 * `T` or a promise of it.
 *
 * The contract's one concession to backends that reach a network. A managed
 * store cannot answer synchronously; the file store can, and saying so in the
 * *implementation's* type rather than in the contract is what lets the file
 * backend's callers stay synchronous while a caller through the interface must
 * await. `Awaitable<T>` has none of `T`'s members, so forgetting the `await`
 * does not compile — the property `Vault.lookup`'s synchronous signature was
 * chosen for, kept by the type system rather than by the signature.
 */
export type Awaitable<T> = T | PromiseLike<T>;

/**
 * A credential value, wrapped so it has nowhere to leak to.
 *
 * The value is held in a closure — there is no data property on the object at
 * all — and every way JavaScript has of turning an object into text is
 * overridden to say `[redacted]`: `JSON.stringify`, string coercion, template
 * interpolation, `console.log`, and `util.inspect` even with `showHidden`. So a
 * credential that reaches a log line, an error message, or a response body by
 * accident arrives as `[redacted]` rather than as itself.
 *
 * `reveal()` is the deliberate act. It is the only way out, and it is called
 * in exactly one file — ./outbound.ts, at its two sites: spending a credential
 * on an upstream call, and spending a refresh token at its issuer. The grep
 * contract in outbound.test.ts is what keeps that count from drifting, and it
 * is why ./custody-conformance.ts takes the unwrap from its harness rather than
 * calling `reveal()` itself.
 */
export interface Secret {
  reveal(): string;
}

const REDACTED = "[redacted]";

/**
 * The one constructor. Every backend hands values out this way — wrapping is
 * the safe direction, and `reveal()` remains the guarded act the grep contract
 * counts.
 */
export function makeSecret(value: string): Secret {
  const secret = {
    reveal: () => value,
    toJSON: () => REDACTED,
    toString: () => REDACTED,
    [Symbol.toPrimitive]: () => REDACTED,
    // The registered symbol rather than `util.inspect.custom`, so this file
    // does not import node:util for one property.
    [Symbol.for("nodejs.util.inspect.custom")]: () => REDACTED
  };
  // Non-enumerable throughout: `Object.keys` is empty, `{...secret}` is empty,
  // and `structuredClone` yields nothing. Only `reveal` is reachable by name.
  for (const key of Reflect.ownKeys(secret)) {
    Object.defineProperty(secret, key, { enumerable: false });
  }
  return Object.freeze(secret) as Secret;
}

/**
 * A cap on one credential value.
 *
 * Generous enough for a PEM private key, and far short of anything that belongs
 * in a file rather than a vault. A value this size is an operator mistake — a
 * whole keyring pasted into one entry — and saying so at `set` time is better
 * than finding out when the proxy will not start.
 *
 * Contract-level rather than the file backend's, because every writer holds it:
 * the vault's admin path validates an operator's value against it, and the
 * token store validates a refresh token against it — one cap on what a stored
 * credential may weigh, wherever it is stored.
 */
export const MAX_SECRET_BYTES = 8_192;

export type CredentialLookup =
  | { readonly status: "found"; readonly secret: Secret }
  | { readonly status: "missing" };

/**
 * What the proxy process holds.
 *
 * No iteration, no listing, no export — `size` is a count, which is what a
 * startup log line needs and the most an outside caller ever gets. A name in,
 * at most one secret out.
 *
 * **`lookup` is synchronous, and that is a freshness rule rather than a
 * signature preference.** The vault answers every lookup from state it acquired
 * at open, with no I/O on the serving path. ./vault.ts defends the two halves
 * separately — a synchronous signature makes a floating promise holding a
 * credential impossible to write, and a stale vault cannot widen what a channel
 * may do because nothing is permitted *because* a credential exists — and
 * behind the seam they are one clause. A managed backend is not burdened by it;
 * it is the thing a managed backend most wants, since Secret Manager charges
 * per access and this runs per tool call.
 */
export interface Vault {
  lookup(name: string): CredentialLookup;
  readonly size: number;
}

/**
 * One grant, as stored. The refresh token is the only secret in it; issuer
 * and scopes are the record's teeth (checked in `read`), and the client
 * identity is the Client ID Metadata Document URL the grant was made under,
 * which the exchange presents as `client_id`.
 */
export interface GrantRecord {
  readonly issuer: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly obtainedAt: number;
  readonly rotatedAt?: number;
}

/** What a sheet asks with: the auth block's declarations, never a value. */
export interface GrantBinding {
  readonly issuer: string;
  readonly scopes: readonly string[];
}

/**
 * Why a grant was not returned. `issuer_mismatch` and `scopes_exceeded` are
 * deliberately distinguishable from `absent`: all three fail closed the same
 * way, but the operator's remedy differs — re-run the grant flow against the
 * new issuer or the wider scopes, versus run it for the first time.
 */
export type GrantRead =
  | { readonly status: "found"; readonly refreshToken: Secret; readonly clientId: string }
  | {
      readonly status: "missing";
      readonly reason: "absent" | "issuer_mismatch" | "scopes_exceeded";
    };

/**
 * The store the serving process writes.
 *
 * **`read` is `Awaitable` where `Vault.lookup` is not**, and the asymmetry is
 * the two freshness rules rather than an inconsistency. The token store is
 * re-read per use, so a grant completed while the proxy runs takes effect at
 * the next mint with no restart, and #254 rules out a watcher — its I/O is
 * genuinely on the read path, where the vault has none. The file backend gets
 * away with a synchronous read only because it is a file. What keeps `read` off
 * the *serving* path is ./token-engine.ts, which calls it at mint and refresh
 * and never while a live access token is in memory.
 *
 * **Two writers, no `set`.** `rotate` is the serving proxy persisting what an
 * authorization server just issued; `putGrant` is what the grant entrypoint
 * composes. There is no operator write — a value an operator holds is by
 * definition a vault value — and no method that prints a token back.
 */
export interface TokenStore {
  read(name: string, binding: GrantBinding): Awaitable<GrantRead>;

  /**
   * Persist a rotated refresh token, replacing the named record's.
   *
   * Durable before it resolves, which is what lets the exchange hold the access
   * token back until the successor that arrived with it is safe. If the record
   * was replaced or re-bound while the exchange was in flight, the rotation is
   * dropped rather than merged: the successor belongs to the old grant's
   * lineage, and overwriting a fresh grant with it would lose the newer one.
   */
  rotate(name: string, binding: GrantBinding, rotatedRefreshToken: string): Promise<void>;

  /** Store a whole grant, replacing any predecessor. One name is one grant. */
  putGrant(name: string, record: GrantRecord): Promise<void>;

  /** Release whatever the store retained. Reads and writes fail after this. */
  close(): void;

  readonly size: number;
}

/**
 * The public half of the proxy's signing key, as JWK members.
 *
 * Exactly the three RFC 7638 requires for a P-256 key, spelled here so the
 * contract can carry a thumbprint without importing anything that knows what a
 * curve is. `alg` is not among them, deliberately: the thumbprint is computed
 * over these members and no others, and a fourth would change it.
 */
export interface PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

/**
 * A key the process can sign with and cannot export.
 *
 * `Secret`'s shape one turn further: where a credential leaves through the one
 * guarded `reveal()`, this leaves through nothing at all. The private half is
 * held in a closure as a `KeyObject` — there is no member that returns it, no
 * PEM on a property, and `sign` is the whole of what a caller can do with it.
 * That is what makes #260's promised sentence, "the exchange requires a key the
 * store does not hold", a claim about this object as well as about storage: a
 * process that has the key can present a proof, and a copy of the store cannot.
 *
 * `sign` is synchronous because a proof is minted per upstream call and the
 * key is already in memory — the vault's freshness rule, arrived at from the
 * other side. The signature is JWS ES256: the P-1363 pair, 64 bytes, not DER.
 */
export interface SigningKey {
  /** The one algorithm, so a proof header quotes this rather than a literal. */
  readonly alg: "ES256";
  readonly publicJwk: PublicJwk;
  /** RFC 7638 thumbprint, base64url. Computed once, at load. */
  readonly thumbprint: string;
  sign(input: Buffer): Buffer;
}

/**
 * Where the deployment's DPoP signing key lives (#504).
 *
 * **A third store rather than a field of the second, and that decision is the
 * whole point of the sub-issue.** A private key kept in the token store under
 * the same master key makes the property vacuous — theft of the store yields
 * the key that presents its tokens — so it is stored apart: its own file under
 * its own subkey on the default backend, its own secret under its own IAM on a
 * managed one. `packages/proxy/README.md` carries the argument and, more
 * importantly, what that does and does not buy on each backend.
 *
 * **One key per deployment, not per grant.** The private half never leaves this
 * process, so an attacker who can use one key can use fifty; per-grant keys
 * would buy nothing against that and would cost one more secret per grant on
 * the managed backends, where #483 already priced what a secret per name costs.
 * What it costs instead is stated rather than hidden: authorization servers
 * that collude can correlate this deployment across upstreams by its
 * thumbprint.
 *
 * **Minted lazily, adopted rather than replaced.** A deployment with no OAuth
 * upstream never creates one; the first exchange that needs a proof does. A
 * backing that already holds a key is loaded, never written over — which is why
 * there is no `set`, no `rotate` and no second key: rotating this key kills
 * every live grant, so it is an operator act (remove the backing, re-grant)
 * rather than a method the serving process holds.
 *
 * `Awaitable` for `TokenStore.read`'s reason — a managed backend reaches a
 * network to answer the first call. Every call after it is served from what the
 * process already holds, and #505 calls it at the exchange rather than on the
 * serving path.
 */
export interface SigningKeyStore {
  signingKey(): Awaitable<SigningKey>;

  /** Release the key this retained. Calls fail afterwards. */
  close(): void;
}

/**
 * What the serving composition holds: the three stores and one shutdown.
 *
 * Three since #504: the vault, the token store, and the DPoP signing key —
 * which is a store rather than a field of the second one for the reason
 * `SigningKeyStore` gives.
 *
 * There is no admin here. `VaultAdmin` is reached through ./custody-admin.ts,
 * which ./custody-backend.ts does not import — the ./vault.ts / ./vault-file.ts
 * split, one level up, so "the serving process holds no vault writer" stays
 * readable as an import list at both levels.
 */
export interface Custody {
  readonly vault: Vault;
  readonly tokens: TokenStore;
  /** The DPoP signing key's store — see `SigningKeyStore`, and #504. */
  readonly signing: SigningKeyStore;
  close(): void;
}

/**
 * What went wrong, in words every backend can say.
 *
 * The coarse half of a two-level vocabulary. A backend keeps its own closed set
 * — `VaultFailure`'s `not_a_vault` and `truncated` are envelope facts, and an
 * operator who pointed the proxy at the wrong file deserves to be told that
 * rather than that their key is wrong — and maps it onto these, so a caller
 * that must branch without knowing the backend has five words rather than a
 * union that grows with every backend.
 *
 * `unauthorized` has no producer today, deliberately. #483's first real failure
 * is a service account missing `secretmanager.versions.access`; without the
 * word it lands on `unreachable`, which tells an operator to check the network
 * when the answer is IAM. Adding a member later means widening a set
 * ./custody-conformance.ts pins, which is the thing the seam exists to prevent.
 */
export type CustodyFailure =
  | "unreachable"
  | "unauthorized"
  | "bad_key_or_tampered"
  | "malformed"
  | "too_large";

/**
 * The base every store's error extends.
 *
 * `reason` is the backend's own word, narrowed by each subclass to a closed
 * union; `failure` is the contract's. `reason: string` here is the one place
 * free text could enter, and the conformance suite closes it — a harness
 * declares its `failureWords` up front and every error the suite can provoke
 * must carry one of them. This is @getlibero/schema's refusal.ts's discipline one level up: a
 * closed vocabulary at the boundary, a narrower closed vocabulary inside.
 *
 * No `cause`, for `VaultError`'s reason: `util.inspect` prints the cause chain,
 * and an error thrown out of OpenSSL can carry buffer contents in it. Subclasses
 * must not add one.
 */
export abstract class CustodyError extends Error {
  abstract readonly reason: string;
  readonly failure: CustodyFailure;

  constructor(message: string, failure: CustodyFailure) {
    super(message);
    this.name = "CustodyError";
    this.failure = failure;
  }
}

/**
 * Why a name or a value was rejected on the way in. Names and sizes, never a
 * value.
 *
 * Declared here rather than by each backend since #483, because it is the same
 * four words wherever a credential is stored. The two error classes stay where
 * they are — `VaultEntryError` in ./vault-file.ts, `GrantEntryError` in
 * ./token-store.ts — and a backend wraps the word this returns in whichever
 * fits its path.
 */
export type EntryRejection = "invalid_name" | "empty_value" | "value_too_large" | "value_has_nul";

/**
 * The two rejections, as errors.
 *
 * Here rather than in ./vault-file.ts and ./token-store.ts since #483, for one
 * reason: a second backend needs to throw them, and reaching into the *file*
 * backend for an error class would make the managed one depend on the store it
 * replaces. Both keep their names, their messages and their exports from the
 * modules that used to declare them, so nothing importing them changes.
 *
 * Two classes rather than one, because the paths are two: an operator setting a
 * vault value and the serving process persisting grant material are different
 * acts with different writers, and an entrypoint that catches one should not
 * silently catch the other.
 */
export class VaultEntryError extends Error {
  readonly reason: EntryRejection;

  constructor(reason: EntryRejection) {
    super(`proxy vault: ${reason}`);
    this.name = "VaultEntryError";
    this.reason = reason;
  }
}

export class GrantEntryError extends Error {
  readonly reason: EntryRejection;

  constructor(reason: EntryRejection) {
    super(`proxy token store: ${reason}`);
    this.name = "GrantEntryError";
    this.reason = reason;
  }
}

/**
 * What a stored credential may weigh, checked once for every writer.
 *
 * Returns the word rather than throwing, so the caller decides which of its own
 * errors carries it and whether that is a throw or a rejection. `null` is
 * acceptable.
 */
/**
 * Whether a name is a credential name at all, asked once for every store.
 *
 * Through the real schema, so no backend gets to have its own opinion about
 * what an operator may write in a team sheet. Every read path runs it before
 * touching the store, so a caller that skipped its own validation cannot reach
 * a backing with a path segment, an empty string, or a NUL.
 */
export function credentialNameRejection(name: string): EntryRejection | null {
  return CredentialName.safeParse(name).success ? null : "invalid_name";
}

export function credentialValueRejection(value: string): EntryRejection | null {
  if (value.length === 0) return "empty_value";
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) return "value_too_large";
  if (value.includes("\0")) return "value_has_nul";
  return null;
}

/**
 * The grant's teeth, applied once for every backend.
 *
 * **Here rather than in each store, and that is a security decision rather than
 * tidiness.** A backend that compared issuers with its own normalization, or
 * got the direction of the scope subset backwards, would serve a refresh token
 * to an authorization server the operator never granted it to — and the two
 * mistakes look like working code. There is one implementation, so there is one
 * thing to review.
 *
 * A refresh token is only ever handed out against the issuer its record names,
 * byte for byte and never normalized (a trailing slash is a different issuer),
 * and against scopes the grant covers. A sheet asking otherwise finds no grant
 * — fail closed, re-grant. The three misses stay distinguishable because the
 * operator's remedy differs: re-run the flow against the new issuer, against
 * the wider scopes, or for the first time.
 *
 * `undefined` in means `absent` out, so a backend that found nothing does not
 * have to spell the answer itself.
 */
export function readGrant(
  record: GrantRecord | undefined,
  binding: GrantBinding
): GrantRead {
  if (record === undefined) return { status: "missing", reason: "absent" };
  if (record.issuer !== binding.issuer) return { status: "missing", reason: "issuer_mismatch" };
  if (!binding.scopes.every(scope => record.scopes.includes(scope))) {
    return { status: "missing", reason: "scopes_exceeded" };
  }
  return { status: "found", refreshToken: makeSecret(record.refreshToken), clientId: record.clientId };
}

/** Whether a record still binds — `rotate`'s question, asked the same way. */
export function grantBindingHolds(record: GrantRecord, binding: GrantBinding): boolean {
  return record.issuer === binding.issuer && binding.scopes.every(scope => record.scopes.includes(scope));
}

/**
 * A stored grant, checked field by field. `null` when it is not one.
 *
 * Shared for `readGrant`'s reason. This store has a shape where the vault has a
 * string, and a shapeless record would put `undefined` where the exchange
 * expects an issuer to pin — which is the same failure as comparing issuers
 * wrongly, reached from the other side. A backend that wrote its own check
 * would be a second chance to forget one field.
 */
export function parseGrantRecord(value: unknown): GrantRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const { issuer, clientId, refreshToken, scopes, obtainedAt, rotatedAt } = body;
  if (typeof issuer !== "string" || issuer.length === 0) return null;
  if (typeof clientId !== "string") return null;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return null;
  if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === "string")) return null;
  if (typeof obtainedAt !== "number") return null;
  if (rotatedAt !== undefined && typeof rotatedAt !== "number") return null;
  return {
    issuer,
    clientId,
    refreshToken,
    scopes: scopes as readonly string[],
    obtainedAt,
    ...(rotatedAt !== undefined ? { rotatedAt } : {})
  };
}
