// The credential vault — the write path.
//
// Apart from ./vault.ts so that file's import list can be read as a claim: the
// process that serves tool calls opens the vault and never writes it. Only the
// operator's CLI reaches this module.
//
// This one handles plaintext `string`s, on purpose. Its whole job is putting a
// value in, so wrapping the argument in a `Secret` would be theatre — the
// caller has the value in hand either way. What it does not do is print one,
// return one, or log one.

import { createCipheriv, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CredentialName } from "@getlibero/schema";
import {
  MAX_VAULT_BYTES,
  VAULT_IV_BYTES,
  VAULT_SALT_BYTES,
  VaultError,
  aadOf,
  buildHeader,
  decodeVault,
  deriveKey,
  isAbsence,
  serializeEntries
} from "./vault.js";
import type { VaultKey } from "./vault.js";

export type VaultEntries = ReadonlyMap<string, string>;

/**
 * A cap on one credential.
 *
 * Generous enough for a PEM private key, and far short of anything that belongs
 * in a file rather than a vault. A value this size is an operator mistake — a
 * whole keyring pasted into one entry — and saying so at `set` time is better
 * than finding out when the proxy will not start.
 */
export const MAX_SECRET_BYTES = 8_192;

/** Why an entry was rejected. Names and sizes, never a value. */
export type EntryRejection = "invalid_name" | "empty_value" | "value_too_large" | "value_has_nul";

export class VaultEntryError extends Error {
  readonly reason: EntryRejection;

  constructor(reason: EntryRejection) {
    super(`proxy vault: ${reason}`);
    this.name = "VaultEntryError";
    this.reason = reason;
  }
}

/**
 * Read the entry set for editing.
 *
 * An absent file — ENOENT, and only ENOENT — is an empty set rather than a
 * failure: the first `vault set` on a fresh deployment has nothing to read.
 * Every other failure — a file that exists but cannot be read, a wrong key, a
 * corrupt file — throws, because overwriting a vault this process could not
 * read would silently discard whatever was in it. EACCES is the live case: a
 * vault owned by another user, read as empty and then replaced, is every
 * stored credential gone without a warning.
 */
export function readVaultEntries(file: string, key: VaultKey): VaultEntries {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (error) {
    if (isAbsence(error)) return new Map();
    throw new VaultError("unreadable");
  }
  if (raw.length > MAX_VAULT_BYTES) throw new VaultError("too_large");
  return decodeVault(raw, key);
}

/**
 * Add or replace one entry.
 *
 * Pure — a new set rather than a mutation, so nothing reaches the disk until
 * `writeVaultEntries` is called with a value the caller has seen validated.
 */
export function setEntry(entries: VaultEntries, name: string, value: string): VaultEntries {
  if (!CredentialName.safeParse(name).success) throw new VaultEntryError("invalid_name");
  if (value.length === 0) throw new VaultEntryError("empty_value");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new VaultEntryError("value_too_large");
  }
  // A NUL in a credential is either a paste accident or an attempt to truncate
  // the value somewhere downstream that hands it to a C library.
  if (value.includes("\0")) throw new VaultEntryError("value_has_nul");

  const next = new Map(entries);
  next.set(name, value);
  return next;
}

/** Remove one entry. `null` when the name was not there — the caller reports it. */
export function removeEntry(entries: VaultEntries, name: string): VaultEntries | null {
  if (!entries.has(name)) return null;
  const next = new Map(entries);
  next.delete(name);
  return next;
}

/**
 * Encrypt and replace the vault file, atomically.
 *
 * A fresh 16-byte salt and 12-byte iv on every write. The salt means each write
 * is under a distinct HKDF subkey, so nonce reuse across writes is structurally
 * impossible rather than merely improbable.
 *
 * The sequence is the part worth reviewing:
 *
 * - The temporary file is opened `wx` — exclusive create — in the *same*
 *   directory as the target. Exclusive create fails rather than following a
 *   symlink someone planted at the temp name, and same-directory is what makes
 *   the rename atomic rather than a copy across filesystems.
 * - Mode `0o600` is passed to `open`, not applied by a later `chmod`. A chmod
 *   after the fact is a window in which the file exists world-readable.
 * - `fsync` on the file before the rename and on the directory after it, so a
 *   power loss leaves either the old vault or the new one, never a
 *   half-written file under the real name.
 * - `rename` over a symlinked vault path replaces the *symlink* and leaves
 *   whatever it pointed at untouched. That is the right outcome and it is
 *   tested: a vault path aimed at something else does not overwrite it.
 *
 * Two operators writing at once is last-writer-wins. There is no lock: the
 * documented path is one admin running one command in one container, and a
 * lock file that outlives a killed process is a worse failure than the one it
 * would prevent.
 */
export function writeVaultEntries(file: string, key: VaultKey, entries: VaultEntries): void {
  const blob = encodeVault(key, entries);
  if (blob.length > MAX_VAULT_BYTES) throw new VaultError("too_large");

  const directory = dirname(file);
  const temp = join(
    directory,
    `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
  );

  let handle: number | undefined;
  try {
    handle = openSync(temp, "wx", 0o600);
    writeSync(handle, blob);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temp, file);
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    try {
      unlinkSync(temp);
    } catch {
      // Already gone, or never created. Either way there is nothing to clean.
    }
    throw error;
  }

  // The rename itself has to reach the disk, which means fsyncing the
  // directory rather than the file.
  const directoryHandle = openSync(directory, "r");
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

function encodeVault(key: VaultKey, entries: VaultEntries): Buffer {
  const plaintext = serializeEntries(entries);
  const salt = randomBytes(VAULT_SALT_BYTES);
  const iv = randomBytes(VAULT_IV_BYTES);
  const subkey = deriveKey(key, salt);

  try {
    // The tag is not known until the ciphertext is complete, so the AAD is
    // taken from a header with the tag zeroed — which is exactly what the
    // reader authenticates, since the AAD stops short of the tag field.
    const draft = buildHeader(salt, iv, Buffer.alloc(16));
    const cipher = createCipheriv("aes-256-gcm", subkey, iv);
    cipher.setAAD(aadOf(draft));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([buildHeader(salt, iv, cipher.getAuthTag()), body]);
  } finally {
    subkey.fill(0);
    plaintext.fill(0);
  }
}
