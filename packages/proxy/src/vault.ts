// The credential vault — the read path.
//
// This process holds every credential in the deployment, and this is the file
// that holds them. Two rules govern it.
//
// **It never writes.** There is no code path here that creates, truncates, or
// chmods the vault file; the write path is ./vault-file.ts, reached only by the
// operator's CLI. So the process serving requests cannot corrupt the store it
// depends on, and the import list below is the proof — no `writeFileSync`, no
// `renameSync`.
//
// **There is no `get`.** A value leaves the vault only through `Secret.reveal()`,
// which means every site that takes a credential out is one grep. Adding a
// method that returns a value by name, or an endpoint that does, is the failure
// this file exists to prevent.
//
// Since #482 this file is the *default backend* rather than the whole story:
// the contract both rules belong to is ./custody.ts, and each is proved three
// ways at three levels. "It never writes" is an import list here, the serving
// `Vault` having no write member at the seam, and IAM in a managed backend;
// "there is no `get`" is this file's surface here, and a structural walk over
// the interface in ./custody-conformance.ts. The first proof is the one this
// file owns.
//
// What this is not: heap-dump resistance. Node strings are immutable and the
// garbage collector copies them, so a decrypted credential cannot be scrubbed
// from memory once it is a `string`. The derived key and the decrypted
// plaintext buffer are zeroed because they are `Buffer`s and it is cheap, but a
// core dump of this process discloses its secrets. Run it without `--inspect`
// and with core dumps off; neither is enforceable from in here.
//
// Nothing third-party. `node:crypto` is the whole cryptographic dependency, in
// keeping with the rule stated at the top of ./server.ts.

import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { CredentialName } from "@getlibero/schema";
import {
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_IV_BYTES,
  ENVELOPE_SALT_BYTES,
  ENVELOPE_VERSION,
  EnvelopeError,
  type EnvelopeSpec,
  buildEnvelopeHeader,
  deriveEnvelopeKey,
  envelopeAad,
  openEnvelope
} from "./envelope.js";
import type { VaultKey } from "./envelope.js";
import { CustodyError, credentialNameRejection, makeSecret } from "./custody.js";
import type { CredentialLookup, CustodyFailure, Vault } from "./custody.js";
import type { Logger } from "./log.js";

// The master key is the envelope's, shared with the token store — one key for
// every store, separated by HKDF info rather than by a second secret for an
// operator to manage. Re-exported so this file stays where the rest of the
// tree learns what a key is.
export { VAULT_KEY_BYTES, parseVaultKey } from "./envelope.js";
export type { VaultKey, VaultKeyParse } from "./envelope.js";

// The contract this file implements, re-exported for the same reason: an
// importer that has always taken `Secret` and `Vault` from here keeps doing so,
// and the seam is a place to read rather than a migration. ./custody.ts is
// where they are argued.
export { MAX_SECRET_BYTES, makeSecret } from "./custody.js";
export type { CredentialLookup, Secret, Vault } from "./custody.js";

/**
 * The vault's two envelope constants. The byte layout, the AAD binding, and
 * both directions through AES-GCM live in ./envelope.ts, shared with the token
 * store; what makes a file a *vault* is this magic and this HKDF info. The
 * info separates this subkey from any other artifact the same master key
 * encrypts — the token store's `libero.tokens.v1` is the separation it was
 * written to anticipate — and carries the format version, so a v2 file cannot
 * be opened under a v1 subkey even if every other check were bypassed.
 */
export const VAULT_SPEC: EnvelopeSpec = {
  magic: Buffer.from("LBVAULT", "ascii"),
  hkdfInfo: "libero.vault.v1"
};

const VERSION = ENVELOPE_VERSION;

export const VAULT_HEADER_BYTES = ENVELOPE_HEADER_BYTES;

/** A hostile or corrupt file should not be able to make this process allocate. */
export const MAX_VAULT_BYTES = 262_144;

/**
 * Why a vault that exists could not be opened.
 *
 * `bad_key_or_tampered` is deliberately one reason covering both. With AES-GCM
 * there is nothing to tell them apart — a wrong key and a flipped ciphertext
 * bit both fail the same tag check — and splitting them would imply an oracle
 * this does not have.
 *
 * The others are structural, decided before any key is used. They disclose
 * nothing about the contents, which is what makes them safe to report
 * precisely: an operator who pointed the proxy at the wrong file learns that,
 * rather than being told their key is wrong.
 */
export type VaultFailure =
  | "unreadable"
  | "too_large"
  | "not_a_vault"
  | "truncated"
  | "unsupported_version"
  | "bad_key_or_tampered"
  | "malformed_plaintext";

/**
 * The backend's word for each of the above, in the contract's vocabulary.
 *
 * Total on purpose: a new `VaultFailure` does not compile until someone has
 * decided what a caller who does not know this is a file should be told. The
 * four envelope facts all land on `malformed` — an operator reading the log
 * still gets the precise word, and only a caller branching across backends sees
 * the coarse one.
 */
const CUSTODY_FAILURE: Record<VaultFailure, CustodyFailure> = {
  unreadable: "unreachable",
  too_large: "too_large",
  not_a_vault: "malformed",
  truncated: "malformed",
  unsupported_version: "malformed",
  bad_key_or_tampered: "bad_key_or_tampered",
  malformed_plaintext: "malformed"
};

/**
 * An error carrying a reason from the closed set above and nothing else.
 *
 * No `cause`. `util.inspect` prints the cause chain, and an error thrown out of
 * OpenSSL can carry buffer contents in it — so the original is read for its
 * reason and then discarded.
 */
export class VaultError extends CustodyError {
  readonly reason: VaultFailure;

  constructor(reason: VaultFailure) {
    super(`proxy vault: ${reason}`, CUSTODY_FAILURE[reason]);
    this.name = "VaultError";
    this.reason = reason;
  }
}

export interface VaultOptions {
  /** The vault file. Read once, at construction. Never written by this module. */
  file: string;
  key: VaultKey;
  logger?: Logger;
}

/**
 * Decrypt the whole entry set into memory.
 *
 * One AEAD blob over every entry, so the names are encrypted too. A per-entry
 * envelope would leave them in the clear, and a list of names — `stripe_live`,
 * `prod_db_password` — is an inventory of what the deployment reaches. It also
 * means one tag covers the whole set, so entries cannot be deleted or reordered
 * by anyone without the key.
 *
 * Synchronous, and loaded once. `lookup` is then a map read with no I/O on the
 * call path, and a synchronous signature makes a floating promise holding a
 * credential impossible to write. There is no watcher: unlike a team sheet, the
 * vault is not the authorization source — nothing is permitted because a
 * credential exists — so a stale vault cannot widen what a channel may do.
 * `vault set` takes effect on restart.
 *
 * Throws on a vault that exists and cannot be opened. This runs at startup,
 * before anything binds, which is the one place in the proxy where a throw is
 * the right shape: no request is in flight and nothing has been decrypted.
 * `lookup` never throws, because it runs mid-request.
 */
export function openVault(options: VaultOptions): Vault {
  const { file, key, logger } = options;
  const entries = readEntries(file, key, logger);
  return {
    lookup: name => lookupIn(entries, name),
    get size() {
      return entries.size;
    }
  };
}

/**
 * A `Map`, not an object literal, and the reason is `lookup("__proto__")`.
 *
 * The name reaching here comes out of a team sheet, so it is an operator's
 * word rather than a model's — but the same is true of the tool names
 * `enforce.ts` scans arrays for rather than indexing, and one prototype hit on
 * this path returns a function where a credential belongs.
 */
function lookupIn(entries: ReadonlyMap<string, string>, name: string): CredentialLookup {
  // Validated before the map is touched. A name that could not have come from
  // a team sheet is not looked up at all, so a caller that skipped its own
  // validation cannot reach the store with a path segment or an empty string.
  if (credentialNameRejection(name) !== null) {
    return { status: "missing" };
  }
  const value = entries.get(name);
  if (value === undefined) {
    return { status: "missing" };
  }
  return { status: "found", secret: makeSecret(value) };
}

function readEntries(
  file: string,
  key: VaultKey,
  logger: Logger | undefined
): ReadonlyMap<string, string> {
  let stat: Stats;
  try {
    stat = statSync(file);
  } catch (error) {
    if (isAbsence(error)) {
      // Absent is not a failure: a deployment that has loaded no credentials
      // yet is a valid one, and it is distinguishable from an empty vault,
      // which is a file that decrypts to nothing. Neither creates the file —
      // the read path does not write.
      logger?.log("warn", { event: "vault_absent", file });
      return new Map();
    }
    // ENOENT and nothing else means absent. EACCES on the volume, EISDIR,
    // a symlink loop — those are a vault that exists and cannot be reached,
    // and starting up as though no credentials were loaded would turn a
    // permissions regression into `credential_unresolved` at the far end of
    // a Slack thread instead of a startup failure here.
    throw fail(logger, file, "unreadable");
  }

  if (stat.size > MAX_VAULT_BYTES) {
    // Before the read, not after: the point of the cap is that a hostile file
    // never becomes a buffer in this process.
    throw fail(logger, file, "too_large");
  }

  // Group- or world-readable is a warning, not a refusal, and this is the one
  // place the proxy's usual "refuse to start" posture does not apply. What
  // keeps the contents secret here is the key, not the mode bit — a
  // world-readable ciphertext file discloses nothing — so refusing to start
  // over a container volume's umask would be a failure with no security in it.
  if ((stat.mode & 0o077) !== 0) {
    logger?.log("warn", { event: "vault_permissive", file, reason: "group_or_world_readable" });
  }

  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    throw fail(logger, file, "unreadable");
  }

  try {
    return decodeVault(raw, key);
  } catch (error) {
    // `decodeVault` throws bare — it is also the CLI's decoder, where there is
    // no logger — so the log line is added at this one call site.
    throw fail(logger, file, error instanceof VaultError ? error.reason : "malformed_plaintext");
  }
}

/**
 * ENOENT and nothing else.
 *
 * Every other filesystem error is a file that exists and could not be read,
 * and the two callers — here and ./vault-file.ts — must not treat one as an
 * empty vault: the reader would come up with no credentials, and the editor
 * would clobber a store it never saw.
 */
export function isAbsence(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function fail(logger: Logger | undefined, file: string, reason: VaultFailure): VaultError {
  logger?.log("error", { event: "vault_unreadable", file, reason });
  return new VaultError(reason);
}

/**
 * Bytes to entries. The whole decode, in one place.
 *
 * Both the proxy and the operator's CLI come through here, so there is one
 * answer to "is this a vault, and what is in it" rather than two that can
 * drift. Throws a bare `VaultError`; the caller decides whether that gets
 * logged.
 */
export function decodeVault(raw: Buffer, key: VaultKey): ReadonlyMap<string, string> {
  let plaintext: Buffer;
  try {
    plaintext = openEnvelope(VAULT_SPEC, raw, key);
  } catch (error) {
    if (!(error instanceof EnvelopeError)) throw error;
    // The envelope speaks structurally — `wrong_magic` — and this store owns
    // the operator-facing word for it: the file is not a vault.
    throw new VaultError(error.reason === "wrong_magic" ? "not_a_vault" : error.reason);
  }

  try {
    return parseEntries(plaintext);
  } finally {
    // Cheap, and it shortens the window in which the decrypted bytes sit in a
    // buffer. It does nothing for the strings `JSON.parse` produced — see the
    // note at the top of this file.
    plaintext.fill(0);
  }
}

/**
 * The per-file encryption key.
 *
 * Exported because ./vault-file.ts derives the same key on the way in, and two
 * copies of a key schedule is how a format quietly forks. The schedule itself
 * lives in ./envelope.ts now; this is it bound to the vault's spec.
 */
export function deriveKey(key: VaultKey, salt: Buffer): Buffer {
  return deriveEnvelopeKey(VAULT_SPEC, key, salt);
}

/**
 * The plaintext: `{"v":1,"entries":[["name","value"],...]}`.
 *
 * Pairs rather than an object, because a JSON object collapses duplicate keys
 * silently and last-wins. An operator whose vault somehow holds the same name
 * twice should be told, not quietly served one of them.
 *
 * Names are re-validated; values are not — no size cap, no emptiness check.
 * That asymmetry is deliberate: a name is an identifier the rest of the proxy
 * indexes with, while a value's constraints exist to catch operator mistakes
 * at `set` time, and a file that decrypts under the key is already inside the
 * trust boundary those checks guard the entrance to.
 */
export function parseEntries(plaintext: Buffer): ReadonlyMap<string, string> {
  const malformed = (): VaultError => new VaultError("malformed_plaintext");

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw malformed();
  }

  if (typeof parsed !== "object" || parsed === null) throw malformed();
  const body = parsed as { v?: unknown; entries?: unknown };
  if (body.v !== VERSION || !Array.isArray(body.entries)) throw malformed();

  const entries = new Map<string, string>();
  for (const pair of body.entries) {
    if (!Array.isArray(pair) || pair.length !== 2) throw malformed();
    const [name, value] = pair as [unknown, unknown];
    if (typeof name !== "string" || typeof value !== "string") throw malformed();
    // Re-validated on the way in as well as on lookup. A file written by
    // something other than ./vault-file.ts, or hand-edited, does not get to put
    // a name in this map that the rest of the proxy would treat as a name.
    if (!CredentialName.safeParse(name).success) throw malformed();
    if (entries.has(name)) throw malformed();
    entries.set(name, value);
  }
  return entries;
}

/** Serialize an entry set for encryption. The inverse of `parseEntries`. */
export function serializeEntries(entries: ReadonlyMap<string, string>): Buffer {
  return Buffer.from(
    JSON.stringify({ v: VERSION, entries: [...entries].map(([name, value]) => [name, value]) }),
    "utf8"
  );
}

/** The header a writer emits, given a fresh salt and iv. Filled in by the caller's tag. */
export function buildHeader(salt: Buffer, iv: Buffer, tag: Buffer): Buffer {
  return buildEnvelopeHeader(VAULT_SPEC, salt, iv, tag);
}

/** The bytes a writer authenticates: the header up to the tag. */
export function aadOf(header: Buffer): Buffer {
  return envelopeAad(header);
}

export const VAULT_SALT_BYTES = ENVELOPE_SALT_BYTES;
export const VAULT_IV_BYTES = ENVELOPE_IV_BYTES;
