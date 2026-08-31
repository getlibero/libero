// What is true of an *envelope on a disk*, for the third file.
//
// ./vault.test.ts and ./token-store.test.ts's scope, and the same division:
// what the contract asks of every backend lives in ./custody-conformance.ts,
// and the magic bytes, the bit flips, the file mode and the store-opened-as-
// something-else confusion live here, where a managed backend has no business
// inheriting them.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { openFileSigningKeyStore, signingKeyPathFor } from "./signing-store.js";
import type { SigningKeyStore } from "./custody.js";
import { openTokenStore, tokenStorePathFor } from "./token-store.js";
import { openVault, parseVaultKey } from "./vault.js";
import type { VaultKey } from "./vault.js";
import { writeVaultEntries } from "./vault-file.js";

function key(): VaultKey {
  const parsed = parseVaultKey(randomBytes(32).toString("base64"));
  if (!parsed.ok) throw new Error("fixture key failed to parse");
  return parsed.key;
}

let dir: string;
let vaultFile: string;
let store: SigningKeyStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-signing-store-"));
  vaultFile = join(dir, "vault.enc");
  store = undefined;
});

afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the file", () => {
  // Fixed as the vault's sibling for `tokenStorePathFor`'s reason: a second
  // path variable is a second way to point two writers at different files.
  it("is signing.enc beside the vault", () => {
    expect(signingKeyPathFor("/srv/libero/vault.enc")).toBe("/srv/libero/signing.enc");
  });

  // Lazy. A deployment with no OAuth upstream never makes a proof, and a file
  // that appears anyway is a key nobody asked for in a backup nobody expected.
  it("is not created by opening the store", () => {
    store = openFileSigningKeyStore({ vaultFile, key: key() });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is created by the first key, owner-only", async () => {
    store = openFileSigningKeyStore({ vaultFile, key: key() });
    await store.signingKey();

    const file = signingKeyPathFor(vaultFile);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Encrypted, so the material is not in the bytes on the volume.
    expect(readFileSync(file).toString("latin1")).not.toContain("PRIVATE KEY");
  });

  it("carries this store's magic and not another's", async () => {
    store = openFileSigningKeyStore({ vaultFile, key: key() });
    await store.signingKey();
    expect(readFileSync(signingKeyPathFor(vaultFile)).subarray(0, 7).toString("ascii")).toBe(
      "LBSIGNK"
    );
  });
});

describe("a file that is not this store's", () => {
  const material = async (shared: VaultKey): Promise<void> => {
    const held = openFileSigningKeyStore({ vaultFile, key: shared });
    await held.signingKey();
    held.close();
  };

  // The separation the vault's info string was written to anticipate, used a
  // third time. Structural, so it is decided before any key is used.
  it("is refused when a vault is put in its place", async () => {
    const shared = key();
    writeVaultEntries(signingKeyPathFor(vaultFile), shared, new Map([["github_token", "ghp_x"]]));

    store = openFileSigningKeyStore({ vaultFile, key: shared });
    await expect(async () => store?.signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "not_a_signing_store", failure: "malformed" })
    );
  });

  // And the other direction: neither of the other two stores will open it.
  it("is refused by the vault and the token store", async () => {
    const shared = key();
    await material(shared);
    const file = signingKeyPathFor(vaultFile);

    expect(() => openVault({ file, key: parseKeyOf(shared) })).toThrow(
      expect.objectContaining({ reason: "not_a_vault" })
    );
    // The token store opens the path's sibling rather than the path, so the
    // bytes are put where it looks. What it finds is not a token store.
    writeFileSync(tokenStorePathFor(vaultFile), readFileSync(file));
    expect(() => openTokenStore({ vaultFile, key: parseKeyOf(shared) })).toThrow(
      expect.objectContaining({ reason: "not_a_token_store" })
    );
  });

  it("is refused under a different master key", async () => {
    await material(key());
    store = openFileSigningKeyStore({ vaultFile, key: key() });
    await expect(async () => store?.signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "bad_key_or_tampered", failure: "bad_key_or_tampered" })
    );
  });

  it("is refused after a bit flip in the ciphertext", async () => {
    const shared = key();
    await material(shared);
    const file = signingKeyPathFor(vaultFile);
    const raw = readFileSync(file);
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0x01, raw.length - 1);
    writeFileSync(file, raw);

    store = openFileSigningKeyStore({ vaultFile, key: shared });
    await expect(async () => store?.signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "bad_key_or_tampered" })
    );
  });

  it("is refused when truncated, before any key is used", async () => {
    const shared = key();
    await material(shared);
    const file = signingKeyPathFor(vaultFile);
    writeFileSync(file, readFileSync(file).subarray(0, 20));

    store = openFileSigningKeyStore({ vaultFile, key: shared });
    await expect(async () => store?.signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "truncated", failure: "malformed" })
    );
  });

  // The cap's point is that a hostile file never becomes a buffer in this
  // process, so the size is checked before the read rather than after.
  it("is refused when it is larger than any signing store could be", () => {
    writeFileSync(signingKeyPathFor(vaultFile), Buffer.alloc(262_145));
    store = openFileSigningKeyStore({ vaultFile, key: key() });
    return expect(async () => store?.signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "too_large", failure: "too_large" })
    );
  });
});

describe("the write", () => {
  // `createFileExclusively`, not a replace: a key already on the volume is the
  // one this deployment has, and overwriting it strands every grant bound to
  // it. The second store adopts rather than clobbers.
  it("never replaces a key already on the volume", async () => {
    const shared = key();
    const first = openFileSigningKeyStore({ vaultFile, key: shared });
    const minted = await first.signingKey();
    const bytes = readFileSync(signingKeyPathFor(vaultFile));
    first.close();

    store = openFileSigningKeyStore({ vaultFile, key: shared });
    const loaded = await store.signingKey();

    expect(loaded.thumbprint).toBe(minted.thumbprint);
    expect(readFileSync(signingKeyPathFor(vaultFile))).toEqual(bytes);
  });
});

describe("close", () => {
  // Said rather than inferred: a read under a zeroed key is
  // `bad_key_or_tampered`, which is true and tells an operator the wrong thing.
  it("refuses in the word for what happened", async () => {
    store = openFileSigningKeyStore({ vaultFile, key: key() });
    await store.signingKey();
    store.close();

    await expect(async () => store?.signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "unreadable", failure: "unreachable" })
    );
  });
});

/** A second parse of the same bytes, so one handle's `close` cannot zero another's. */
function parseKeyOf(existing: VaultKey): VaultKey {
  const parsed = parseVaultKey(Buffer.from(existing).toString("base64"));
  if (!parsed.ok) throw new Error("fixture key failed to parse");
  return parsed.key;
}
