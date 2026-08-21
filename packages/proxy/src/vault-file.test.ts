import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { VaultError, openVault, parseVaultKey } from "./vault.js";
import type { VaultKey } from "./vault.js";
import {
  MAX_SECRET_BYTES,
  VaultEntryError,
  readVaultEntries,
  removeEntry,
  setEntry,
  writeVaultEntries
} from "./vault-file.js";

const VALUE = "ghp_leaked_value_16C7e42F292c6912E7710c838347Ae178B4a";
const NAME = "github_service_account";

function key(): VaultKey {
  const parsed = parseVaultKey(randomBytes(32).toString("base64"));
  if (!parsed.ok) throw new Error("test key did not parse");
  return parsed.key;
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-vault-file-"));
  file = join(dir, "vault.enc");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("editing an entry set", () => {
  it("adds an entry", () => {
    expect([...setEntry(new Map(), NAME, VALUE)]).toEqual([[NAME, VALUE]]);
  });

  it("replaces an entry rather than duplicating it", () => {
    const once = setEntry(new Map(), NAME, VALUE);
    expect([...setEntry(once, NAME, "second")]).toEqual([[NAME, "second"]]);
  });

  it("does not mutate the set it was given", () => {
    const before = new Map([[NAME, VALUE]]);
    setEntry(before, "other", "value");
    expect(before.size).toBe(1);
  });

  it("removes an entry", () => {
    const removed = removeEntry(new Map([[NAME, VALUE]]), NAME);
    expect(removed && [...removed]).toEqual([]);
  });

  it("reports a name that was not there rather than pretending", () => {
    expect(removeEntry(new Map([[NAME, VALUE]]), "not_loaded")).toBeNull();
  });

  each([
    ["empty", "", "invalid_name"],
    ["too long", "a".repeat(65), "invalid_name"],
    ["a traversal", "../etc/passwd", "invalid_name"],
    ["a separator", "a/b", "invalid_name"],
    ["a leading dot", ".hidden", "invalid_name"],
    ["a space", "github token", "invalid_name"]
  ])("refuses %s as a name", (_label, name, reason) => {
    expect(() => setEntry(new Map(), name, VALUE)).toThrow(
      expect.objectContaining({ reason })
    );
  });

  each([
    ["an empty value", "", "empty_value"],
    ["a value with a NUL", "abc\0def", "value_has_nul"],
    ["a value over the cap", "a".repeat(MAX_SECRET_BYTES + 1), "value_too_large"]
  ])("refuses %s", (_label, value, reason) => {
    expect(() => setEntry(new Map(), NAME, value)).toThrow(
      expect.objectContaining({ reason })
    );
  });

  it("accepts a value at exactly the cap", () => {
    expect(setEntry(new Map(), NAME, "a".repeat(MAX_SECRET_BYTES)).size).toBe(1);
  });

  // A PEM key is the realistic large credential, and it is multi-line.
  it("accepts a multi-line value", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`;
    const entries = setEntry(new Map(), "deploy_key", pem);
    expect(entries.get("deploy_key")).toBe(pem);
  });

  it("keeps the value out of a rejection", () => {
    let thrown: unknown;
    try {
      setEntry(new Map(), NAME, `${VALUE}\0`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VaultEntryError);
    expect(`${String(thrown)}${(thrown as Error).stack}`).not.toContain("ghp_");
  });
});

describe("reading a vault for editing", () => {
  it("reads back what was written", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    expect([...readVaultEntries(file, k)]).toEqual([[NAME, VALUE]]);
  });

  // The first `vault set` on a fresh deployment has nothing to read.
  it("treats an absent vault as empty", () => {
    expect(readVaultEntries(file, key()).size).toBe(0);
  });

  // Overwriting a vault this could not read would silently discard it.
  it("refuses to read a vault under the wrong key rather than returning empty", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    expect(() => readVaultEntries(file, key())).toThrow(
      expect.objectContaining({ reason: "bad_key_or_tampered" })
    );
  });

  it("refuses an oversized file", () => {
    writeFileSync(file, Buffer.alloc(300_000));
    expect(() => readVaultEntries(file, key())).toThrow(
      expect.objectContaining({ reason: "too_large" })
    );
  });

  // The failure this guards against is total: a vault owned by another user,
  // read as empty and then written back, is every stored credential gone.
  // Root reads through mode 000, so the test is meaningless there.
  it(
    "refuses a vault it cannot read rather than treating it as empty",
    { skip: process.getuid?.() === 0 },
    () => {
      const k = key();
      writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
      chmodSync(file, 0o000);
      expect(() => readVaultEntries(file, k)).toThrow(
        expect.objectContaining({ reason: "unreadable" })
      );
    }
  );

  it("agrees with the proxy's own reader", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE], ["slack_bot", "xoxb-abc"]]));
    const vault = openVault({ file, key: k });
    const entries = readVaultEntries(file, k);

    expect(vault.size).toBe(entries.size);
    for (const [name, value] of entries) {
      const found = vault.lookup(name);
      expect(found.status).toBe("found");
      if (found.status === "found") expect(found.secret.reveal()).toBe(value);
    }
  });
});

describe("the write", () => {
  it("creates the vault owner-only", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    expect(readdirSync(dir)).toEqual(["vault.enc"]);
  });

  it("writes an empty vault rather than deleting the file", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    const emptied = removeEntry(readVaultEntries(file, k), NAME);
    writeVaultEntries(file, k, emptied ?? new Map());

    // "Absent" and "empty" have to stay distinguishable: one means nothing has
    // been loaded, the other means everything was removed.
    expect(existsSync(file)).toBe(true);
    expect(readVaultEntries(file, k).size).toBe(0);
  });

  it("replaces the contents rather than appending", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE], ["second", "value"]]));
    const large = statSync(file).size;
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    expect(statSync(file).size).toBeLessThan(large);
  });

  // `rename` over a symlink replaces the symlink, not its target. A vault path
  // aimed at something else does not overwrite it.
  it("does not write through a symlinked vault path", () => {
    const decoy = join(dir, "decoy");
    writeFileSync(decoy, "not the vault");
    const link = join(dir, "linked.enc");
    symlinkSync(decoy, link);

    writeVaultEntries(link, key(), new Map([[NAME, VALUE]]));

    expect(readFileSync(decoy, "utf8")).toBe("not the vault");
    // lstat, not stat: stat follows the link, so it could never observe one.
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link).subarray(0, 7).toString("ascii")).toBe("LBVAULT");
  });

  it("fails rather than writing into a directory that does not exist", () => {
    const missing = join(dir, "no-such-dir", "vault.enc");
    expect(() => writeVaultEntries(missing, key(), new Map([[NAME, VALUE]]))).toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  // Last-writer-wins is documented rather than prevented; what must never
  // happen is a file that does not parse.
  it("leaves a cleanly readable vault after interleaved writes", () => {
    const k = key();
    for (let round = 0; round < 20; round += 1) {
      writeVaultEntries(file, k, new Map([[NAME, `${VALUE}-${round}`]]));
      const entries = readVaultEntries(file, k);
      expect(entries.get(NAME)).toBe(`${VALUE}-${round}`);
    }
    expect(readdirSync(dir)).toEqual(["vault.enc"]);
  });

  it("round-trips many entries", () => {
    const k = key();
    const entries = new Map<string, string>();
    for (let index = 0; index < 100; index += 1) entries.set(`cred_${index}`, `${VALUE}-${index}`);
    writeVaultEntries(file, k, entries);

    const read = readVaultEntries(file, k);
    expect(read.size).toBe(100);
    expect(read.get("cred_42")).toBe(`${VALUE}-42`);
  });

  it("refuses to write more than the reader would accept", () => {
    const entries = new Map<string, string>();
    for (let index = 0; index < 64; index += 1) {
      entries.set(`cred_${index}`, "a".repeat(MAX_SECRET_BYTES));
    }
    expect(() => writeVaultEntries(file, key(), entries)).toThrow(VaultError);
  });

  it("keeps a value out of a write failure", () => {
    const readOnly = join(dir, "read-only");
    mkdirSync(readOnly, { mode: 0o500 });
    let thrown: unknown;
    try {
      writeVaultEntries(join(readOnly, "vault.enc"), key(), new Map([[NAME, VALUE]]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(`${String(thrown)}${(thrown as Error).stack}`).not.toContain("ghp_");
  });
});
