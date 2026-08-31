// The signing key's backing on the default backend: a third encrypted file.
//
// `signing.enc` beside `vault.enc` and `tokens.enc` — same envelope byte for
// byte (./envelope.ts), two constants apart, as ./token-store.ts is from
// ./vault.ts: magic `LBSIGNK`, HKDF info `libero.signing.v1`, under the same
// master key, third subkey.
//
// **Why a third file rather than an entry in either of the first two, which is
// #504's whole question.** The promised sentence is "the exchange requires a
// key the store does not hold". A private key inside `tokens.enc` makes it
// vacuous — whoever stole the tokens stole the key that presents them — so the
// key is not in the token store. It is not in the vault either, and that half
// is the sharper one: the vault is the store the serving process may only
// *read*, so putting the key there would mean either an operator generating a
// private key and pasting it through `vault set`, or this process gaining a
// vault write path. The second is the one claim the whole custody design is
// built on, and it is not for sale to save a file.
//
// **What the third file buys on this backend, stated exactly.** Theft of
// `tokens.enc` plus the master key no longer yields presentable credentials;
// theft of the whole volume plus the master key still does, because everything
// on it is under one key. The property is therefore a real narrowing here and a
// strong separation on the managed backends, where the key is a secret with its
// own IAM and there is no master key at all. `packages/proxy/README.md` prices
// both, and #506 is where the stolen-store paragraph is re-worded.
//
// **The write is a create, never a replace.** `createFileExclusively` rather
// than `replaceFileAtomically`, and the difference is the point: a second
// process that got there first must win, because overwriting its key strands
// every grant bound to it. That is the same argument `libero init` makes for
// the master key it generates, which is why the recipe is already a function.

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFileExclusively } from "@getlibero/atomic-write";
import { CustodyError } from "./custody.js";
import type { CustodyFailure, SigningKeyStore } from "./custody.js";
import { EnvelopeError, type EnvelopeSpec, openEnvelope, sealEnvelope } from "./envelope.js";
import type { Logger } from "./log.js";
import { openSigningKeyStore } from "./signing-key.js";
import type { SigningKeyBacking } from "./signing-key.js";
import { MAX_VAULT_BYTES, isAbsence } from "./vault.js";
import type { VaultKey } from "./vault.js";

/**
 * The two constants that make a file a signing store. The separation the
 * vault's info string was written to anticipate, used a second time: a file
 * opened as the wrong one of the three fails on its magic before any key is
 * used, and even a forged header cannot decrypt one under another's subkey.
 */
const SIGNING_SPEC: EnvelopeSpec = {
  magic: Buffer.from("LBSIGNK", "ascii"),
  hkdfInfo: "libero.signing.v1"
};

/** The vault's cap, carried over: a hostile file never becomes a buffer here. */
export const MAX_SIGNING_STORE_BYTES = MAX_VAULT_BYTES;

/**
 * The vault's sibling, fixed for `tokenStorePathFor`'s reason: a second path
 * variable would be a second way to point two writers at different files.
 */
export function signingKeyPathFor(vaultFile: string): string {
  return join(dirname(vaultFile), "signing.enc");
}

/** The vault's failures, with this store's word for a file that is not one. */
export type SigningStoreFailure =
  | "unreadable"
  | "too_large"
  | "not_a_signing_store"
  | "truncated"
  | "unsupported_version"
  | "bad_key_or_tampered"
  | "malformed_plaintext";

const CUSTODY_FAILURE: Record<SigningStoreFailure, CustodyFailure> = {
  unreadable: "unreachable",
  too_large: "too_large",
  not_a_signing_store: "malformed",
  truncated: "malformed",
  unsupported_version: "malformed",
  bad_key_or_tampered: "bad_key_or_tampered",
  malformed_plaintext: "malformed"
};

/** No `cause`, for `VaultError`'s reason: nothing from OpenSSL is kept. */
export class SigningStoreError extends CustodyError {
  readonly reason: SigningStoreFailure;

  constructor(reason: SigningStoreFailure) {
    super(`proxy signing store: ${reason}`, CUSTODY_FAILURE[reason]);
    this.name = "SigningStoreError";
    this.reason = reason;
  }
}

export interface SigningStoreOptions {
  /** The *vault's* path; the store lives beside it. See `signingKeyPathFor`. */
  readonly vaultFile: string;
  readonly key: VaultKey;
  readonly logger?: Logger;
}

/**
 * Open the signing store over the encrypted file.
 *
 * Nothing is read here, which is where this store differs from the other two:
 * they open at startup so a wrong key fails before anything binds, and this one
 * is lazy so a deployment with no OAuth upstream never creates a key it will
 * not use. The startup failure the other two provide is not lost — they are
 * opened under the same key, so a wrong one is already a startup throw.
 *
 * The master key is retained in this closure for ./token-store.ts's reason: a
 * fresh salt per write needs it at write time. It is the same buffer, not a
 * copy — the token store's `close()` is what zeroes it — so this store's
 * `close()` only stops answering.
 */
export function openFileSigningKeyStore(options: SigningStoreOptions): SigningKeyStore {
  const { vaultFile, key, logger } = options;
  const file = signingKeyPathFor(vaultFile);

  let closed = false;
  const requireOpen = (): void => {
    // After close the key bytes may be zeros, and a read under a zeroed key is
    // `bad_key_or_tampered` — true, and misleading in a log. Say what happened.
    // ./token-store.ts's `requireOpen`, for its reason.
    if (closed) throw new SigningStoreError("unreadable");
  };

  const read = (): string | null => {
    requireOpen();
    let stat;
    try {
      stat = statSync(file);
    } catch (error) {
      // Absent is not a failure: a deployment that has never made a proof has
      // no key, and nothing here creates the file until `create`.
      if (isAbsence(error)) return null;
      throw fail(logger, file, "unreadable");
    }
    // Before the read, not after: the point of the cap is that a hostile file
    // never becomes a buffer in this process.
    if (stat.size > MAX_SIGNING_STORE_BYTES) throw fail(logger, file, "too_large");

    let raw: Buffer;
    try {
      raw = readFileSync(file);
    } catch (error) {
      if (isAbsence(error)) return null;
      throw fail(logger, file, "unreadable");
    }

    let plaintext: Buffer;
    try {
      plaintext = openEnvelope(SIGNING_SPEC, raw, key);
    } catch (error) {
      if (!(error instanceof EnvelopeError)) throw error;
      throw fail(logger, file, error.reason === "wrong_magic" ? "not_a_signing_store" : error.reason);
    }
    try {
      return plaintext.toString("utf8");
    } finally {
      // Cheap, and it shortens the window in which the decrypted key sits in a
      // buffer. It does nothing for the string — see ./vault.ts's header.
      plaintext.fill(0);
    }
  };

  const backing: SigningKeyBacking = {
    read,

    create(material: string): Promise<string> {
      try {
        requireOpen();
        const blob = sealEnvelope(SIGNING_SPEC, key, Buffer.from(material, "utf8"));
        if (blob.length > MAX_SIGNING_STORE_BYTES) throw new SigningStoreError("too_large");
        try {
          createFileExclusively(file, blob);
        } catch (error) {
          // Somebody else created it between the read and here. Theirs is the
          // key this deployment has, so it is read back and adopted rather than
          // replaced — see the header. Any other error is this write failing.
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = read();
          if (existing === null) throw fail(logger, file, "unreadable");
          return Promise.resolve(existing);
        }
        return Promise.resolve(material);
      } catch (error) {
        // Rejected rather than thrown, ./token-store.ts's rule for its writes:
        // a caller awaiting one sees every failure the same way.
        return Promise.reject(error);
      }
    },

    malformed: () => new SigningStoreError("malformed_plaintext"),

    close(): void {
      closed = true;
    }
  };

  return openSigningKeyStore(backing, logger !== undefined ? { logger } : {});
}

function fail(logger: Logger | undefined, file: string, reason: SigningStoreFailure): SigningStoreError {
  logger?.log("error", { event: "signing_store_unreadable", file, reason });
  return new SigningStoreError(reason);
}
