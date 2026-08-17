// The token store — the one credential file the serving process writes.
//
// The custody decision in the package README ("Two credential stores, and
// which process writes which", #254) is the design of record; this file is its
// built form. Grant material for OAuth upstreams lives in `tokens.enc` beside
// `vault.enc`: same envelope byte for byte (./envelope.ts), two constants
// apart — magic `LBTOKEN`, HKDF info `libero.tokens.v1` — under the same
// master key, second subkey.
//
// What makes this store's narrowness reviewable, in the vault's style of
// import-list claims:
//
// **Two writers, no `tokens set`.** `rotate` is the serving proxy persisting
// what an authorization server just issued; `putGrant` is the seam the grant
// entrypoint (#257) composes. There is no operator write — a value an operator
// holds is by definition a vault value — and no command prints a token back.
//
// **There is still no `get`.** A refresh token leaves only as a `Secret`, and
// only ./outbound.ts ever unwraps one. The write paths handle plaintext
// strings for the reason ./vault-file.ts does — their whole job is putting a
// value in — and like it they never print, return, or log one.
//
// **The store is not the authorization source.** Nothing is permitted because
// a grant exists, so a stale read can fail a refresh and can never widen a
// call. That is why `read` re-reads the file per call — a grant completed
// while the proxy runs takes effect at the next mint, no restart — and why
// there is no watcher.
//
// **The key outlives startup here, and only here.** A fresh salt per write
// needs the master key at write time, so the parsed key is retained in this
// module's closure — the same buffer, not a second copy — reachable only by
// `read`, `rotate` and `putGrant`, and zeroed on `close()`. That is the
// heap-dump concession ./vault.ts already makes, held longer.

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CredentialName } from "@getlibero/schema";
import { replaceFileAtomically } from "@getlibero/atomic-write";
import { EnvelopeError, type EnvelopeSpec, openEnvelope, sealEnvelope } from "./envelope.js";
import type { Logger } from "./log.js";
import { MAX_SECRET_BYTES, MAX_VAULT_BYTES, isAbsence, makeSecret } from "./vault.js";
import type { Secret, VaultKey } from "./vault.js";

/**
 * The two constants that make a file a token store rather than a vault. The
 * separation the vault's info string was written to anticipate: a token store
 * opened as a vault fails `not_a_vault` before any key is used, and even a
 * forged header cannot decrypt one file under the other's subkey.
 */
const TOKEN_SPEC: EnvelopeSpec = {
  magic: Buffer.from("LBTOKEN", "ascii"),
  hkdfInfo: "libero.tokens.v1"
};

const VERSION = 1;

/** The vault's cap, carried over: a hostile file never becomes a buffer here. */
export const MAX_TOKEN_STORE_BYTES = MAX_VAULT_BYTES;

/**
 * The path is fixed as the vault's sibling, deliberately not configurable: a
 * second path variable would be a second way to point the two writers at
 * different files.
 */
export function tokenStorePathFor(vaultFile: string): string {
  return join(dirname(vaultFile), "tokens.enc");
}

/**
 * One grant, as stored. The refresh token is the only secret in it; issuer
 * and scopes are the record's teeth (checked in `read`, below), and the
 * client identity is the Client ID Metadata Document URL the grant was made
 * under, which the exchange presents as `client_id`.
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
  | { readonly status: "missing"; readonly reason: "absent" | "issuer_mismatch" | "scopes_exceeded" };

/**
 * Why a token store that exists could not be used. The envelope reasons are
 * the vault's, translated; `not_a_token_store` is this store's word for a file
 * whose magic says it is something else — a vault, most likely.
 */
export type TokenStoreFailure =
  | "unreadable"
  | "too_large"
  | "not_a_token_store"
  | "truncated"
  | "unsupported_version"
  | "bad_key_or_tampered"
  | "malformed_plaintext";

/** No `cause`, for VaultError's reason: nothing from OpenSSL is kept. */
export class TokenStoreError extends Error {
  readonly reason: TokenStoreFailure;

  constructor(reason: TokenStoreFailure) {
    super(`proxy token store: ${reason}`);
    this.name = "TokenStoreError";
    this.reason = reason;
  }
}

/** Why a grant was rejected on the way in. Names and sizes, never a value. */
export type GrantRejection = "invalid_name" | "empty_value" | "value_too_large" | "value_has_nul";

export class GrantEntryError extends Error {
  readonly reason: GrantRejection;

  constructor(reason: GrantRejection) {
    super(`proxy token store: ${reason}`);
    this.name = "GrantEntryError";
    this.reason = reason;
  }
}

export interface TokenStore {
  /**
   * The grant under a name, bound to what the sheet declares.
   *
   * The bindings are enforced here rather than by the caller so no caller can
   * skip them: a refresh token is only ever handed out against the issuer its
   * record names, byte for byte, and against scopes the grant covers. A sheet
   * asking otherwise finds no grant — fail closed, re-grant.
   *
   * Re-reads the file per call. The engine is what keeps this off the serving
   * path: it calls only at mint and refresh, never while a live access token
   * is in memory.
   */
  read(name: string, binding: GrantBinding): GrantRead;

  /**
   * Persist a rotated refresh token, replacing the named record's.
   *
   * Read-merge-write under the store's one mutex, `replaceFileAtomically`'s
   * recipe, fsynced before this resolves — which is what lets the exchange
   * hold the access token back until the successor that arrived with it is
   * durable. If the record was replaced or re-bound while the exchange was in
   * flight (a grant run racing a rotation), the rotation is dropped rather
   * than merged: the successor belongs to the old grant's lineage, and
   * overwriting a fresh grant with it would lose the newer one. That is the
   * race the README prices at one loud re-grant.
   */
  rotate(name: string, binding: GrantBinding, rotatedRefreshToken: string): Promise<void>;

  /**
   * Store a whole grant, replacing any predecessor under the name.
   *
   * The seam the grant entrypoint (#257) composes, and what the tests seed
   * with. Same mutex, same recipe. Replace-not-stack: one name is one grant.
   */
  putGrant(name: string, record: GrantRecord): Promise<void>;

  /** Zero the retained master key. Reads and writes fail after this. */
  close(): void;

  readonly size: number;
}

export interface TokenStoreOptions {
  /** The *vault's* path; the store lives beside it. See `tokenStorePathFor`. */
  readonly vaultFile: string;
  readonly key: VaultKey;
  readonly logger?: Logger;
  /** Injected so `rotatedAt` can be tested without waiting. */
  readonly now?: () => number;
}

/**
 * Open the store, failing fast where failing is cheap.
 *
 * The file is read once here so that a wrong key or a corrupt store surfaces
 * at startup — before anything binds, the one place a throw is the right
 * shape — and again on every `read`, which is the freshness rule above.
 * Absent is not a failure: a deployment with no OAuth upstream has no store,
 * and nothing here creates the file until the first write.
 */
export function openTokenStore(options: TokenStoreOptions): TokenStore {
  const { vaultFile, key, logger } = options;
  const now = options.now ?? Date.now;
  const file = tokenStorePathFor(vaultFile);

  let closed = false;
  // Writes serialize behind this chain — the store's one mutex. Each caller
  // awaits its own job; a failed write must not wedge the chain, so the tail
  // swallows what the caller already received.
  let writing: Promise<void> = Promise.resolve();

  let grants = readGrants(file, key, logger);
  logger?.log("info", grants.size === 0 && !storeExists(file)
    ? { event: "token_store_absent", file }
    : { event: "token_store_opened", file, count: grants.size });

  const requireOpen = (): void => {
    // After close() the key bytes are zeros, and a read under a zeroed key is
    // `bad_key_or_tampered` — true, but misleading in a log. Say what happened.
    if (closed) throw new TokenStoreError("unreadable");
  };

  const write = (mutate: (current: Map<string, GrantRecord>) => boolean): Promise<void> => {
    const job = writing.then(() => {
      requireOpen();
      // Fresh read inside the mutex: the other writer (#257's grant
      // entrypoint) may have replaced the file since this process last looked,
      // and merging one entry into a stale set would drop its work.
      const current = new Map(readGrants(file, key, logger));
      if (!mutate(current)) return;
      const blob = sealEnvelope(TOKEN_SPEC, key, serializeGrants(current));
      if (blob.length > MAX_TOKEN_STORE_BYTES) throw new TokenStoreError("too_large");
      replaceFileAtomically(file, blob);
      grants = current;
    });
    writing = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  };

  return {
    read(name, binding): GrantRead {
      requireOpen();
      grants = readGrants(file, key, logger);
      return readFrom(grants, name, binding);
    },

    rotate(name, binding, rotatedRefreshToken): Promise<void> {
      // Rejected rather than thrown, so a caller awaiting a write sees every
      // failure the same way, validation included.
      try {
        validateValue(rotatedRefreshToken);
      } catch (error) {
        return Promise.reject(error);
      }
      return write(current => {
        const record = current.get(name);
        // Dropped, not merged — see the interface doc. The `read` that fed the
        // exchange enforced the binding; if it no longer holds, the record was
        // replaced mid-flight and the rotation belongs to a dead lineage.
        if (record === undefined || !bindingHolds(record, binding)) {
          logger?.log("warn", { event: "token_rotation_superseded", credential: name, file });
          return false;
        }
        current.set(name, { ...record, refreshToken: rotatedRefreshToken, rotatedAt: now() });
        return true;
      });
    },

    putGrant(name, record): Promise<void> {
      try {
        if (!CredentialName.safeParse(name).success) throw new GrantEntryError("invalid_name");
        validateValue(record.refreshToken);
      } catch (error) {
        return Promise.reject(error);
      }
      return write(current => {
        current.set(name, record);
        return true;
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      // The same buffer the composition root parsed, not a copy — so this is
      // the deployment's one in-memory master key going to zeros.
      key.fill(0);
    },

    get size() {
      return grants.size;
    }
  };
}

function storeExists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

function validateValue(value: string): void {
  if (value.length === 0) throw new GrantEntryError("empty_value");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new GrantEntryError("value_too_large");
  if (value.includes("\0")) throw new GrantEntryError("value_has_nul");
}

function bindingHolds(record: GrantRecord, binding: GrantBinding): boolean {
  // Byte-for-byte on the issuer — no normalization, the schema's own rule —
  // and subset on scopes: a sheet may narrow what it uses of a grant, and
  // widening is a re-grant.
  return record.issuer === binding.issuer && binding.scopes.every(scope => record.scopes.includes(scope));
}

function readFrom(grants: ReadonlyMap<string, GrantRecord>, name: string, binding: GrantBinding): GrantRead {
  if (!CredentialName.safeParse(name).success) return { status: "missing", reason: "absent" };
  const record = grants.get(name);
  if (record === undefined) return { status: "missing", reason: "absent" };
  if (record.issuer !== binding.issuer) return { status: "missing", reason: "issuer_mismatch" };
  if (!binding.scopes.every(scope => record.scopes.includes(scope))) {
    return { status: "missing", reason: "scopes_exceeded" };
  }
  return { status: "found", refreshToken: makeSecret(record.refreshToken), clientId: record.clientId };
}

function readGrants(file: string, key: VaultKey, logger: Logger | undefined): ReadonlyMap<string, GrantRecord> {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (error) {
    if (isAbsence(error)) return new Map();
    throw fail(logger, file, "unreadable");
  }
  if (raw.length > MAX_TOKEN_STORE_BYTES) throw fail(logger, file, "too_large");

  let plaintext: Buffer;
  try {
    plaintext = openEnvelope(TOKEN_SPEC, raw, key);
  } catch (error) {
    if (!(error instanceof EnvelopeError)) throw error;
    throw fail(logger, file, error.reason === "wrong_magic" ? "not_a_token_store" : error.reason);
  }

  try {
    return parseGrants(plaintext);
  } catch (error) {
    throw fail(logger, file, error instanceof TokenStoreError ? error.reason : "malformed_plaintext");
  } finally {
    plaintext.fill(0);
  }
}

function fail(logger: Logger | undefined, file: string, reason: TokenStoreFailure): TokenStoreError {
  logger?.log("error", { event: "token_store_unreadable", file, reason });
  return new TokenStoreError(reason);
}

/**
 * The plaintext: `{"v":1,"grants":[["name",{...record}],...]}`.
 *
 * Pairs rather than an object and names re-validated on the way in, for
 * `parseEntries`'s reasons: duplicates are told rather than served last-wins,
 * and a file written by something else does not get to put a non-name in this
 * map. Records are checked field by field — this store has a shape where the
 * vault has a string, and a shapeless record would put `undefined` where the
 * exchange expects an issuer to pin.
 */
function parseGrants(plaintext: Buffer): ReadonlyMap<string, GrantRecord> {
  const malformed = (): TokenStoreError => new TokenStoreError("malformed_plaintext");

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw malformed();
  }

  if (typeof parsed !== "object" || parsed === null) throw malformed();
  const body = parsed as { v?: unknown; grants?: unknown };
  if (body.v !== VERSION || !Array.isArray(body.grants)) throw malformed();

  const grants = new Map<string, GrantRecord>();
  for (const pair of body.grants) {
    if (!Array.isArray(pair) || pair.length !== 2) throw malformed();
    const [name, record] = pair as [unknown, unknown];
    if (typeof name !== "string" || !CredentialName.safeParse(name).success) throw malformed();
    if (grants.has(name)) throw malformed();
    grants.set(name, parseRecord(record, malformed));
  }
  return grants;
}

function parseRecord(record: unknown, malformed: () => TokenStoreError): GrantRecord {
  if (typeof record !== "object" || record === null) throw malformed();
  const body = record as Record<string, unknown>;
  const { issuer, clientId, refreshToken, scopes, obtainedAt, rotatedAt } = body;
  if (typeof issuer !== "string" || issuer.length === 0) throw malformed();
  if (typeof clientId !== "string") throw malformed();
  if (typeof refreshToken !== "string" || refreshToken.length === 0) throw malformed();
  if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === "string")) throw malformed();
  if (typeof obtainedAt !== "number") throw malformed();
  if (rotatedAt !== undefined && typeof rotatedAt !== "number") throw malformed();
  return {
    issuer,
    clientId,
    refreshToken,
    scopes,
    obtainedAt,
    ...(rotatedAt !== undefined ? { rotatedAt } : {})
  };
}

function serializeGrants(grants: ReadonlyMap<string, GrantRecord>): Buffer {
  return Buffer.from(
    JSON.stringify({ v: VERSION, grants: [...grants].map(([name, record]) => [name, record]) }),
    "utf8"
  );
}
