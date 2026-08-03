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
// What this is not: heap-dump resistance. Node strings are immutable and the
// garbage collector copies them, so a decrypted credential cannot be scrubbed
// from memory once it is a `string`. The derived key and the decrypted
// plaintext buffer are zeroed because they are `Buffer`s and it is cheap, but a
// core dump of this process discloses its secrets. Run it without `--inspect`
// and with core dumps off; neither is enforceable from in here.
//
// Nothing third-party. `node:crypto` is the whole cryptographic dependency, in
// keeping with the rule stated at the top of ./server.ts.

import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { CredentialName } from "@getlibero/schema";
import type { Logger } from "./log.js";

/**
 * The on-disk format. A 52-byte header, then the ciphertext.
 *
 * ```
 *  0    7   magic    "LBVAULT"
 *  7    1   version  0x01          \
 *  8   16   salt                    } AAD — bytes [0, 36)
 * 24   12   iv                     /
 * 36   16   tag
 * 52   ..   ciphertext
 * ```
 *
 * The salt and the iv are authenticated rather than merely present. Without the
 * AAD binding, an attacker holding two vault files could swap one's salt for
 * the other's, or roll the version byte back, and the tag would still verify
 * over the ciphertext alone. With it, any edit to the header is a tag failure.
 *
 * The tag lives in the header instead of being appended so that a truncated
 * file fails a length check — a distinct, honest `truncated` — rather than
 * arriving at the decipher and coming back indistinguishable from a wrong key.
 */
const MAGIC = Buffer.from("LBVAULT", "ascii");
const VERSION = 1;

const MAGIC_LEN = MAGIC.length;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

const OFFSET_VERSION = MAGIC_LEN;
const OFFSET_SALT = OFFSET_VERSION + 1;
const OFFSET_IV = OFFSET_SALT + SALT_LEN;
const OFFSET_TAG = OFFSET_IV + IV_LEN;

/** Everything the tag authenticates beyond the ciphertext: magic, version, salt, iv. */
const AAD_LEN = OFFSET_TAG;
export const VAULT_HEADER_BYTES = OFFSET_TAG + TAG_LEN;

/**
 * HKDF's `info`. Two jobs: it separates this key from any other artifact the
 * same master key might one day encrypt (the audit database, the memory store),
 * and it carries the format version, so a v2 file cannot be opened under a v1
 * subkey even if every other check were bypassed.
 */
const HKDF_INFO = "libero.vault.v1";

/** A hostile or corrupt file should not be able to make this process allocate. */
export const MAX_VAULT_BYTES = 262_144;

/** The master key's length, in bytes. AES-256. */
export const VAULT_KEY_BYTES = 32;

declare const KEY_BRAND: unique symbol;

/**
 * A validated master key: exactly 32 bytes.
 *
 * Branded, so a `Buffer` that happens to be the right length cannot be passed
 * where a key belongs without going through `parseVaultKey` first. The brand
 * exists only in the type system and costs nothing at runtime.
 */
export type VaultKey = Buffer & { readonly [KEY_BRAND]: true };

export type VaultKeyParse =
  | { readonly ok: true; readonly key: VaultKey }
  | { readonly ok: false; readonly reason: "not_base64" | "wrong_length" };

/**
 * Decode a base64 master key — the output of `openssl rand -base64 32`.
 *
 * There is no key-derivation function here, deliberately. A KDF exists to
 * stretch a low-entropy passphrase; a key from `openssl rand` is already 256
 * uniform bits, so scrypt over it would buy nothing and add a parameter set to
 * get wrong. The failure a KDF would paper over — an operator pasting a
 * passphrase — is better refused outright, which is what `wrong_length` does.
 *
 * The validation is a round trip rather than a length check on the decode,
 * because `Buffer.from(x, "base64")` silently discards characters outside the
 * alphabet: `Buffer.from("hunter2!!!!", "base64")` returns bytes rather than
 * failing, and a naive implementation accepts a key the operator never typed.
 * Re-encoding and comparing is the only way to learn that the input was
 * actually base64.
 *
 * A result rather than a throw, and neither reason carries the input: this is
 * called with the contents of an environment variable, and the one thing that
 * must never appear in the resulting error message is the thing that was wrong.
 */
export function parseVaultKey(encoded: string): VaultKeyParse {
  const trimmed = encoded.trim();
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.toString("base64") !== trimmed) {
    return { ok: false, reason: "not_base64" };
  }
  if (decoded.length !== VAULT_KEY_BYTES) {
    return { ok: false, reason: "wrong_length" };
  }
  return { ok: true, key: decoded as VaultKey };
}

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
 * `reveal()` is the deliberate act. It is the only way out, and #51 will call
 * it in exactly one place.
 */
export interface Secret {
  reveal(): string;
}

const REDACTED = "[redacted]";

function makeSecret(value: string): Secret {
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

export type CredentialLookup =
  | { readonly status: "found"; readonly secret: Secret }
  | { readonly status: "missing" };

/**
 * What the proxy process holds.
 *
 * No iteration, no listing, no export — `size` is a count, which is what a
 * startup log line needs and the most an outside caller ever gets. A name in,
 * at most one secret out.
 */
export interface Vault {
  lookup(name: string): CredentialLookup;
  readonly size: number;
}

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
 * An error carrying a reason from the closed set above and nothing else.
 *
 * No `cause`. `util.inspect` prints the cause chain, and an error thrown out of
 * OpenSSL can carry buffer contents in it — so the original is read for its
 * reason and then discarded.
 */
export class VaultError extends Error {
  readonly reason: VaultFailure;

  constructor(reason: VaultFailure) {
    super(`proxy vault: ${reason}`);
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
  if (!CredentialName.safeParse(name).success) {
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
  // A plain comparison: the magic is a constant in this file, not a secret, so
  // there is nothing here for a timing side channel to disclose.
  if (raw.length < MAGIC_LEN || !raw.subarray(0, MAGIC_LEN).equals(MAGIC)) {
    // Length before magic: a file too short to hold the magic is not a vault
    // either, and this way an operator who pointed the proxy at an empty file
    // is told it was truncated rather than that their key is wrong.
    throw new VaultError(raw.length < MAGIC_LEN ? "truncated" : "not_a_vault");
  }
  if (raw.length < VAULT_HEADER_BYTES) throw new VaultError("truncated");
  if (raw[OFFSET_VERSION] !== VERSION) throw new VaultError("unsupported_version");

  const salt = raw.subarray(OFFSET_SALT, OFFSET_SALT + SALT_LEN);
  const iv = raw.subarray(OFFSET_IV, OFFSET_IV + IV_LEN);
  const tag = raw.subarray(OFFSET_TAG, OFFSET_TAG + TAG_LEN);

  const subkey = deriveKey(key, salt);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", subkey, iv);
    decipher.setAAD(raw.subarray(0, AAD_LEN));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(raw.subarray(VAULT_HEADER_BYTES)),
      decipher.final()
    ]);
  } catch {
    // The thrown value is not inspected and not attached. It came out of
    // OpenSSL, and this is the process that holds every credential.
    throw new VaultError("bad_key_or_tampered");
  } finally {
    subkey.fill(0);
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
 * copies of a key schedule is how a format quietly forks.
 */
export function deriveKey(key: VaultKey, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", key, salt, HKDF_INFO, VAULT_KEY_BYTES));
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
  const header = Buffer.alloc(VAULT_HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[OFFSET_VERSION] = VERSION;
  salt.copy(header, OFFSET_SALT);
  iv.copy(header, OFFSET_IV);
  tag.copy(header, OFFSET_TAG);
  return header;
}

/** The bytes a writer authenticates: the header up to the tag. */
export function aadOf(header: Buffer): Buffer {
  return header.subarray(0, AAD_LEN);
}

export const VAULT_SALT_BYTES = SALT_LEN;
export const VAULT_IV_BYTES = IV_LEN;
