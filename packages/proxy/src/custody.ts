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
// What is *not* here, deliberately: name validation (a backend's own gate — the
// file backend runs `CredentialName` on both the way in and the way out),
// envelope constants, and the write path for the vault, which is
// ./custody-admin.ts because the serving composition must not import it.

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
 * What the serving composition holds: both stores and one shutdown.
 *
 * There is no admin here. `VaultAdmin` is reached through ./custody-admin.ts,
 * which ./custody-backend.ts does not import — the ./vault.ts / ./vault-file.ts
 * split, one level up, so "the serving process holds no vault writer" stays
 * readable as an import list at both levels.
 */
export interface Custody {
  readonly vault: Vault;
  readonly tokens: TokenStore;
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
