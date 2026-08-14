// The encrypted-file envelope both credential stores share.
//
// Extracted from ./vault.ts when the token store arrived (#256), because the
// custody decision (#254) fixed the two stores as "same envelope byte for
// byte, two constants apart: magic and HKDF info" — and the only way that
// sentence stays true is if there is one implementation taking the two
// constants as a parameter. A second copy of the recipe is how a format
// quietly forks.
//
// This module knows nothing about what the plaintext means. Entry sets,
// grants, their parsing and their caps belong to the store that owns the file;
// what lives here is bytes-to-bytes: the header layout, the AAD binding, the
// key schedule, and the two directions through AES-GCM.
//
// Nothing third-party. `node:crypto` is the whole cryptographic dependency, in
// keeping with the rule stated at the top of ./server.ts.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * What distinguishes one store's file from another's.
 *
 * The magic separates the files structurally — a token store opened as a vault
 * fails before any key is used — and the HKDF info separates them
 * cryptographically: even a forged header cannot decrypt one file under the
 * other's subkey, because the subkey never existed.
 */
export interface EnvelopeSpec {
  /** Exactly 7 ASCII bytes, so every envelope shares one header layout. */
  readonly magic: Buffer;
  readonly hkdfInfo: string;
}

/**
 * The on-disk format. A 52-byte header, then the ciphertext.
 *
 * ```
 *  0    7   magic
 *  7    1   version  0x01          \
 *  8   16   salt                    } AAD — bytes [0, 36)
 * 24   12   iv                     /
 * 36   16   tag
 * 52   ..   ciphertext
 * ```
 *
 * The salt and the iv are authenticated rather than merely present. Without the
 * AAD binding, an attacker holding two files could swap one's salt for the
 * other's, or roll the version byte back, and the tag would still verify over
 * the ciphertext alone. With it, any edit to the header is a tag failure.
 *
 * The tag lives in the header instead of being appended so that a truncated
 * file fails a length check — a distinct, honest `truncated` — rather than
 * arriving at the decipher and coming back indistinguishable from a wrong key.
 */
export const ENVELOPE_VERSION = 1;

const MAGIC_LEN = 7;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

const OFFSET_VERSION = MAGIC_LEN;
const OFFSET_SALT = OFFSET_VERSION + 1;
const OFFSET_IV = OFFSET_SALT + SALT_LEN;
const OFFSET_TAG = OFFSET_IV + IV_LEN;

/** Everything the tag authenticates beyond the ciphertext: magic, version, salt, iv. */
const AAD_LEN = OFFSET_TAG;
export const ENVELOPE_HEADER_BYTES = OFFSET_TAG + TAG_LEN;

export const ENVELOPE_SALT_BYTES = SALT_LEN;
export const ENVELOPE_IV_BYTES = IV_LEN;

/** The master key's length, in bytes. AES-256. */
export const VAULT_KEY_BYTES = 32;

declare const KEY_BRAND: unique symbol;

/**
 * A validated master key: exactly 32 bytes.
 *
 * Branded, so a `Buffer` that happens to be the right length cannot be passed
 * where a key belongs without going through `parseVaultKey` first. The brand
 * exists only in the type system and costs nothing at runtime.
 *
 * One master key for every store — the separation between them is the HKDF
 * info in the spec, not a second key for an operator to manage.
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
 * Why an envelope could not be opened. Structural reasons are decided before
 * any key is used; `bad_key_or_tampered` is deliberately one reason covering
 * both, because with AES-GCM there is nothing to tell them apart and splitting
 * them would imply an oracle this does not have.
 *
 * `wrong_magic` rather than a per-store name: the store that owns the file
 * translates it into its own vocabulary (`not_a_vault`, `not_a_token_store`),
 * which is where the operator-facing word belongs.
 */
export type EnvelopeFailure = "wrong_magic" | "truncated" | "unsupported_version" | "bad_key_or_tampered";

/**
 * An error carrying a reason from the closed set above and nothing else.
 *
 * No `cause`. `util.inspect` prints the cause chain, and an error thrown out of
 * OpenSSL can carry buffer contents in it — so the original is read for its
 * reason and then discarded.
 */
export class EnvelopeError extends Error {
  readonly reason: EnvelopeFailure;

  constructor(reason: EnvelopeFailure) {
    super(`envelope: ${reason}`);
    this.name = "EnvelopeError";
    this.reason = reason;
  }
}

/**
 * The per-file encryption key.
 *
 * One derivation for readers and writers of a given spec — two copies of a key
 * schedule is how a format quietly forks. The caller zeroes the returned
 * buffer when it is done; `openEnvelope` and `sealEnvelope` below do.
 */
export function deriveEnvelopeKey(spec: EnvelopeSpec, key: VaultKey, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", key, salt, spec.hkdfInfo, VAULT_KEY_BYTES));
}

/**
 * Bytes to plaintext. Throws `EnvelopeError`; never inspects what it decrypts.
 *
 * The check order is part of the contract. Length before magic: a file too
 * short to hold the magic is not "the wrong kind of file", and an operator who
 * pointed a store at an empty file is told it was truncated rather than that
 * their key is wrong. Magic before version, version before any key use.
 *
 * The caller zeroes the returned buffer once it has parsed it — cheap, and it
 * shortens the window the decrypted bytes sit in a heap the GC will not scrub.
 */
export function openEnvelope(spec: EnvelopeSpec, raw: Buffer, key: VaultKey): Buffer {
  // A plain comparison: the magic is a constant, not a secret, so there is
  // nothing here for a timing side channel to disclose.
  if (raw.length < MAGIC_LEN || !raw.subarray(0, MAGIC_LEN).equals(spec.magic)) {
    throw new EnvelopeError(raw.length < MAGIC_LEN ? "truncated" : "wrong_magic");
  }
  if (raw.length < ENVELOPE_HEADER_BYTES) throw new EnvelopeError("truncated");
  if (raw[OFFSET_VERSION] !== ENVELOPE_VERSION) throw new EnvelopeError("unsupported_version");

  const salt = raw.subarray(OFFSET_SALT, OFFSET_SALT + SALT_LEN);
  const iv = raw.subarray(OFFSET_IV, OFFSET_IV + IV_LEN);
  const tag = raw.subarray(OFFSET_TAG, OFFSET_TAG + TAG_LEN);

  const subkey = deriveEnvelopeKey(spec, key, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", subkey, iv);
    decipher.setAAD(raw.subarray(0, AAD_LEN));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(raw.subarray(ENVELOPE_HEADER_BYTES)), decipher.final()]);
  } catch {
    // The thrown value is not inspected and not attached. It came out of
    // OpenSSL, and this is the process that holds every credential.
    throw new EnvelopeError("bad_key_or_tampered");
  } finally {
    subkey.fill(0);
  }
}

/**
 * Plaintext to bytes. **Consumes the plaintext**: the buffer is zeroed before
 * this returns, success or failure, so a serialized entry set cannot outlive
 * the one call that needed it.
 *
 * A fresh salt and iv on every seal. The salt means each write is under a
 * distinct HKDF subkey, so nonce reuse across writes is structurally
 * impossible rather than merely improbable.
 */
export function sealEnvelope(spec: EnvelopeSpec, key: VaultKey, plaintext: Buffer): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const subkey = deriveEnvelopeKey(spec, key, salt);

  try {
    // The tag is not known until the ciphertext is complete, so the AAD is
    // taken from a header with the tag zeroed — which is exactly what the
    // reader authenticates, since the AAD stops short of the tag field.
    const draft = buildEnvelopeHeader(spec, salt, iv, Buffer.alloc(TAG_LEN));
    const cipher = createCipheriv("aes-256-gcm", subkey, iv);
    cipher.setAAD(envelopeAad(draft));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([buildEnvelopeHeader(spec, salt, iv, cipher.getAuthTag()), body]);
  } finally {
    subkey.fill(0);
    plaintext.fill(0);
  }
}

/** The header a writer emits, given a fresh salt and iv. Filled in by the caller's tag. */
export function buildEnvelopeHeader(spec: EnvelopeSpec, salt: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const header = Buffer.alloc(ENVELOPE_HEADER_BYTES);
  spec.magic.copy(header, 0);
  header[OFFSET_VERSION] = ENVELOPE_VERSION;
  salt.copy(header, OFFSET_SALT);
  iv.copy(header, OFFSET_IV);
  tag.copy(header, OFFSET_TAG);
  return header;
}

/** The bytes a writer authenticates: the header up to the tag. */
export function envelopeAad(header: Buffer): Buffer {
  return header.subarray(0, AAD_LEN);
}
