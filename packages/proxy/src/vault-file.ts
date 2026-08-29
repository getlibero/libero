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

import { readFileSync } from "node:fs";
import { replaceFileAtomically } from "@getlibero/atomic-write";
import { sealEnvelope } from "./envelope.js";
import {
  MAX_SECRET_BYTES,
  VaultEntryError,
  credentialNameRejection,
  credentialValueRejection
} from "./custody.js";
import {
  MAX_VAULT_BYTES,
  VAULT_SPEC,
  VaultError,
  decodeVault,
  isAbsence,
  serializeEntries
} from "./vault.js";
import type { VaultKey } from "./vault.js";

export type VaultEntries = ReadonlyMap<string, string>;

// The cap on one value is the contract's (./custody.ts) — every writer holds
// it — and is re-exported here so `set`'s callers keep their import.
export { MAX_SECRET_BYTES };

// Why an entry was rejected, and the error carrying it, are the contract's
// (./custody.ts) since #483 — a second backend has to throw them, and reaching
// into the *file* backend for an error class would make the managed one depend
// on the store it replaces. Re-exported so every importer keeps its import.
export type { EntryRejection } from "./custody.js";
export { VaultEntryError } from "./custody.js";

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
  // Both checks are ./custody.ts's, so every writer in every backend refuses
  // the same names and the same values. A NUL in a credential is either a paste
  // accident or an attempt to truncate the value somewhere downstream that
  // hands it to a C library; the cap is `MAX_SECRET_BYTES`.
  const rejection = credentialNameRejection(name) ?? credentialValueRejection(value);
  if (rejection !== null) throw new VaultEntryError(rejection);

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
 * The envelope — fresh salt and iv per write, so nonce reuse across writes is
 * structurally impossible — is `sealEnvelope` in ./envelope.ts, and the
 * write sequence worth reviewing (exclusive-create temp, mode at open, fsync
 * before rename and the directory after) is `replaceFileAtomically` in
 * `@getlibero/atomic-write`. The envelope is shared with the token store and the
 * recipe with every writer in the deployment, which is the point: a recipe
 * implemented twice is one that eventually holds once, and #272 is the issue
 * that found out how right that was.
 *
 * Two operators writing at once is last-writer-wins. There is no lock: the
 * documented path is one admin running one command in one container, and a
 * lock file that outlives a killed process is a worse failure than the one it
 * would prevent.
 */
export function writeVaultEntries(file: string, key: VaultKey, entries: VaultEntries): void {
  const blob = sealEnvelope(VAULT_SPEC, key, serializeEntries(entries));
  if (blob.length > MAX_VAULT_BYTES) throw new VaultError("too_large");
  replaceFileAtomically(file, blob);
}
