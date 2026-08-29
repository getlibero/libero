import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { Logger } from "./log.js";
import { openTokenStore, tokenStorePathFor } from "./token-store.js";
import type { FileTokenStore, GrantRecord } from "./token-store.js";
import { parseVaultKey } from "./vault.js";
import type { VaultKey } from "./vault.js";
import { writeVaultEntries } from "./vault-file.js";

const VALUE = "rt_live_refresh_token_2F292c6912E7710c838347Ae178B4a";
const NAME = "notion_grant";
const ISSUER = "https://as.example";

const record = (extra: Partial<GrantRecord> = {}): GrantRecord => ({
  issuer: ISSUER,
  clientId: "https://getlibero.com/client.json",
  refreshToken: VALUE,
  scopes: ["mcp.read"],
  obtainedAt: 1_700_000_000_000,
  ...extra
});

const BINDING = { issuer: ISSUER, scopes: ["mcp.read"] };

function key(): VaultKey {
  const parsed = parseVaultKey(randomBytes(32).toString("base64"));
  if (!parsed.ok) throw new Error("fixture key failed to parse");
  return parsed.key;
}

function recordingLogger(): { logger: Logger; lines: object[]; text: () => string } {
  const lines: object[] = [];
  return {
    logger: { log: (level, fields) => lines.push({ level, fields }) },
    lines,
    text: () => JSON.stringify(lines)
  };
}

let dir: string;
let vaultFile: string;
let store: FileTokenStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-token-store-"));
  vaultFile = join(dir, "vault.enc");
  store = undefined;
});

afterEach(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the path", () => {
  // Fixed as the vault's sibling, not configurable: a second path variable
  // would be a second way to point the two writers at different files.
  it("is the vault's sibling, always", () => {
    expect(tokenStorePathFor("/data/vault.enc")).toBe("/data/tokens.enc");
    expect(tokenStorePathFor("vault.enc")).toBe("tokens.enc");
  });
});

describe("what is on disk", () => {
  it("round-trips a grant through the file", async () => {
    const k = key();
    store = openTokenStore({ vaultFile, key: k });
    await store.putGrant(NAME, record());

    const again = openTokenStore({ vaultFile, key: k });
    const read = again.read(NAME, BINDING);
    expect(read.status).toBe("found");
    expect(read.status === "found" && read.refreshToken.reveal()).toBe(VALUE);
    expect(read.status === "found" && read.clientId).toBe("https://getlibero.com/client.json");
    again.close();
  });

  it("keeps the refresh token out of the raw bytes", async () => {
    store = openTokenStore({ vaultFile, key: key() });
    await store.putGrant(NAME, record());

    const raw = readFileSync(tokenStorePathFor(vaultFile));
    expect(raw.includes(Buffer.from(VALUE, "utf8"))).toBe(false);
    // The names are encrypted too — a list of grant names is an inventory of
    // what the deployment reaches, the vault's own argument.
    expect(raw.includes(Buffer.from(NAME, "utf8"))).toBe(false);
  });

  it("carries the token magic, not the vault's", async () => {
    store = openTokenStore({ vaultFile, key: key() });
    await store.putGrant(NAME, record());

    const raw = readFileSync(tokenStorePathFor(vaultFile));
    expect(raw.subarray(0, 7).toString("ascii")).toBe("LBTOKEN");
  });

  it("is written 0600 with no temporary left behind", async () => {
    store = openTokenStore({ vaultFile, key: key() });
    await store.putGrant(NAME, record());

    expect(statSync(tokenStorePathFor(vaultFile)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["tokens.enc"]);
  });

  it("refuses a wrong key as bad_key_or_tampered", async () => {
    store = openTokenStore({ vaultFile, key: key() });
    await store.putGrant(NAME, record());
    store.close();
    store = undefined;

    expect(() => openTokenStore({ vaultFile, key: key() })).toThrow(
      expect.objectContaining({ name: "TokenStoreError", reason: "bad_key_or_tampered" })
    );
  });
});

// The two stores must refuse each other's files before any key is used, and
// under one master key the HKDF info is what keeps a forged magic from
// decrypting anyway — but the magic check comes first, so the operator is told
// "wrong kind of file" rather than "wrong key".
describe("a store and a vault cannot be confused", () => {
  it("refuses a vault file as not_a_token_store", () => {
    const k = key();
    // A real vault, written by the real writer — at the token store's path.
    writeVaultEntries(tokenStorePathFor(vaultFile), k, new Map([["github_token", "ghp_x"]]));

    expect(() => openTokenStore({ vaultFile, key: k })).toThrow(
      expect.objectContaining({ name: "TokenStoreError", reason: "not_a_token_store" })
    );
  });

  it("refuses a file that never was a store", () => {
    writeFileSync(tokenStorePathFor(vaultFile), Buffer.from("PDF-1.7 not a store at all"));
    expect(() => openTokenStore({ vaultFile, key: key() })).toThrow(
      expect.objectContaining({ reason: "not_a_token_store" })
    );
  });

  it("refuses a truncated file as truncated, not as a key failure", () => {
    writeFileSync(tokenStorePathFor(vaultFile), Buffer.from("LBT"));
    expect(() => openTokenStore({ vaultFile, key: key() })).toThrow(
      expect.objectContaining({ reason: "truncated" })
    );
  });
});

describe("absence and freshness", () => {
  it("opens with nothing when the file does not exist, and creates nothing", () => {
    const { logger, lines } = recordingLogger();
    store = openTokenStore({ vaultFile, key: key(), logger });

    expect(store.size).toBe(0);
    expect(store.read(NAME, BINDING)).toEqual({ status: "missing", reason: "absent" });
    expect(() => statSync(tokenStorePathFor(vaultFile))).toThrow();
    expect(lines).toEqual([
      { level: "info", fields: { event: "token_store_absent", file: tokenStorePathFor(vaultFile) } }
    ]);
  });
});

// The record's teeth — issuer byte for byte, scopes as grant-time facts, and
// all three misses distinguishable — are the contract's, in
// ./custody-conformance.ts. So is the freshness rule this store is the far side
// of: a grant another writer stored after open is visible without a restart.

describe("rotation", () => {
  // The residual race the README prices: a grant run racing a rotation. The
  // rotation belongs to the old grant's lineage, so it is dropped rather than
  // merged over the fresh grant — one loud line, never a lost fresh grant.
  it("drops a rotation whose record was replaced mid-flight", async () => {
    const { logger, lines } = recordingLogger();
    const k = key();
    store = openTokenStore({ vaultFile, key: k, logger });
    await store.putGrant(NAME, record());

    // The grant entrypoint replaces the grant under a new issuer while an
    // exchange is in flight.
    const granting = openTokenStore({ vaultFile, key: k });
    await granting.putGrant(NAME, record({ issuer: "https://new.example", refreshToken: "rt_fresh" }));

    await store.rotate(NAME, BINDING, "rt_stale_successor");

    const read = store.read(NAME, { issuer: "https://new.example", scopes: ["mcp.read"] });
    expect(read.status === "found" && read.refreshToken.reveal()).toBe("rt_fresh");
    expect(
      lines.some(
        line => (line as { fields: { event: string } }).fields.event === "token_rotation_superseded"
      )
    ).toBe(true);
  });

});

// Replace-not-stack, the interleaved writers, a refused write not wedging the
// next, what a value may weigh, and the ten renderings of a `Secret` are the
// contract's, in ./custody-conformance.ts. What stays here is the failure only
// a filesystem has.

describe("a secret has nowhere to go", () => {
  it("keeps the value out of a write failure", async () => {
    store = openTokenStore({ vaultFile: join(dir, "missing", "vault.enc"), key: key() });
    let thrown: unknown;
    try {
      await store.putGrant(NAME, record());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const seen = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))}`;
    expect(seen).not.toContain("rt_live");
  });
});

describe("close", () => {
  it("zeroes the key it was given", async () => {
    const k = key();
    const copy = Buffer.from(k);
    store = openTokenStore({ vaultFile, key: k });
    await store.putGrant(NAME, record());

    store.close();
    expect(k.equals(Buffer.alloc(32))).toBe(true);
    expect(k.equals(copy)).toBe(false);
  });

  // That a closed store refuses reads and writes is the contract's, in
  // ./custody-conformance.ts. What only this backend can say is what `close`
  // is *for*: the master key it was handed goes to zeros.
});
