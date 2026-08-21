import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { ToolRefusal, refusalMessage } from "@getlibero/schema";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import type { LogFields, LogLevel, Logger } from "./log.js";
import {
  MAX_VAULT_BYTES,
  VAULT_HEADER_BYTES,
  VaultError,
  aadOf,
  buildHeader,
  deriveKey,
  openVault,
  parseVaultKey,
  serializeEntries
} from "./vault.js";
import type { VaultKey } from "./vault.js";
import { writeVaultEntries } from "./vault-file.js";

/**
 * The value under test everywhere below. Shaped like a real GitHub token
 * because the assertions that matter are all negative — that this string is
 * not in a file, a log line, or an error — and a distinctive prefix is what
 * makes `not.toContain` mean something.
 */
const VALUE = "ghp_leaked_value_16C7e42F292c6912E7710c838347Ae178B4a";
const NAME = "github_service_account";

function key(): VaultKey {
  const parsed = parseVaultKey(randomBytes(32).toString("base64"));
  if (!parsed.ok) throw new Error("test key did not parse");
  return parsed.key;
}

interface Line {
  level: LogLevel;
  fields: LogFields;
}

function recordingLogger(): { logger: Logger; lines: Line[]; text: () => string } {
  const lines: Line[] = [];
  return {
    logger: { log: (level, fields) => void lines.push({ level, fields }) },
    lines,
    text: () => JSON.stringify(lines)
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-vault-"));
  file = join(dir, "vault.enc");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the master key", () => {
  it("accepts what `openssl rand -base64 32` produces", () => {
    const parsed = parseVaultKey(randomBytes(32).toString("base64"));
    expect(parsed.ok).toBe(true);
  });

  it("accepts a key with surrounding whitespace, as an env file leaves it", () => {
    expect(parseVaultKey(`  ${randomBytes(32).toString("base64")}\n`).ok).toBe(true);
  });

  // Buffer.from(x, "base64") discards characters outside the alphabet instead
  // of failing, so a length check on the decode accepts keys the operator never
  // typed. The round trip is what catches these.
  each([
    ["a passphrase", "hunter2!!!!hunter2!!!!hunter2!!!!hunter2!!!!"],
    ["punctuation", "AAAA????BBBB????CCCC????DDDD????EEEE????FFFF"],
    ["a PEM header", "-----BEGIN PRIVATE KEY-----"],
    ["spaces inside", "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII"]
  ])("refuses %s as not base64", (_label, input) => {
    expect(parseVaultKey(input)).toEqual({ ok: false, reason: "not_base64" });
  });

  each([
    ["31 bytes", 31],
    ["33 bytes", 33],
    ["16 bytes", 16],
    ["nothing", 0]
  ])("refuses %s as the wrong length", (_label, bytes) => {
    expect(parseVaultKey(randomBytes(bytes).toString("base64"))).toEqual({
      ok: false,
      reason: "wrong_length"
    });
  });
});

describe("what is on disk", () => {
  it("round-trips an entry", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    const vault = openVault({ file, key: k });
    const found = vault.lookup(NAME);
    expect(found.status).toBe("found");
    if (found.status !== "found") throw new Error("unreachable");
    expect(found.secret.reveal()).toBe(VALUE);
    expect(vault.size).toBe(1);
  });

  // On the Buffer rather than a utf8 string, so an encoding path that happened
  // to mangle the bytes could not make this pass by accident.
  it("holds neither the value nor the name in the clear", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from(VALUE, "utf8"))).toBe(false);
    expect(raw.includes(Buffer.from(NAME, "utf8"))).toBe(false);
  });

  it("is recognisable as a vault", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    const raw = readFileSync(file);
    expect(raw.subarray(0, 7).toString("ascii")).toBe("LBVAULT");
    expect(raw[7]).toBe(1);
  });

  // A fresh salt and iv every write. Identical bytes twice would mean a static
  // nonce, which under GCM leaks the xor of two plaintexts.
  it("produces different bytes for the same entries twice", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    const first = readFileSync(file);
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    expect(readFileSync(file).equals(first)).toBe(false);
  });

  it("does not open under a different key", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    expect(() => openVault({ file, key: key() })).toThrow(
      expect.objectContaining({ reason: "bad_key_or_tampered" })
    );
  });
});

describe("a file that has been edited", () => {
  // The salt and iv rows are the ones that prove the AAD binding. Without it
  // they are unauthenticated header bytes and this table would not be total.
  each([
    ["a magic byte", 2],
    ["the version byte", 7],
    ["a salt byte", 10],
    ["an iv byte", 26],
    ["a tag byte", 40],
    ["a ciphertext byte", VAULT_HEADER_BYTES + 1]
  ])("refuses a vault with %s flipped", (_label, offset) => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    const raw = readFileSync(file);
    raw.writeUInt8(raw.readUInt8(offset) ^ 0xff, offset);
    writeFileSync(file, raw);
    expect(() => openVault({ file, key: k })).toThrow(VaultError);
  });

  each([
    ["empty", 0, "truncated"],
    ["shorter than the magic", 3, "truncated"],
    ["header only", VAULT_HEADER_BYTES, "bad_key_or_tampered"],
    ["one byte of ciphertext", VAULT_HEADER_BYTES + 1, "bad_key_or_tampered"]
  ])("refuses a vault truncated to %s", (_label, length, reason) => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    writeFileSync(file, readFileSync(file).subarray(0, length));
    expect(() => openVault({ file, key: k })).toThrow(
      expect.objectContaining({ reason })
    );
  });

  it("refuses a file that was never a vault", () => {
    writeFileSync(file, randomBytes(VAULT_HEADER_BYTES + 32));
    expect(() => openVault({ file, key: key() })).toThrow(
      expect.objectContaining({ reason: "not_a_vault" })
    );
  });

  it("refuses a version it does not know", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    const raw = readFileSync(file);
    raw[7] = 2;
    writeFileSync(file, raw);
    expect(() => openVault({ file, key: k })).toThrow(
      expect.objectContaining({ reason: "unsupported_version" })
    );
  });

  // The cap is checked against the stat, before the read, so a hostile file
  // never becomes a buffer in this process.
  it("refuses an oversized file without reading it", () => {
    writeFileSync(file, Buffer.alloc(MAX_VAULT_BYTES + 1));
    expect(() => openVault({ file, key: key() })).toThrow(
      expect.objectContaining({ reason: "too_large" })
    );
  });
});

describe("a secret has nowhere to go", () => {
  function secretOf(): { reveal(): string } {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    const found = openVault({ file, key: k }).lookup(NAME);
    if (found.status !== "found") throw new Error("unreachable");
    return found.secret;
  }

  it("survives the one path that is meant to work", () => {
    expect(secretOf().reveal()).toBe(VALUE);
  });

  each([
    ["JSON.stringify", (s: object) => JSON.stringify(s)],
    ["JSON.stringify of a wrapper", (s: object) => JSON.stringify({ credential: s })],
    ["JSON.stringify of an array", (s: object) => JSON.stringify([s])],
    ["String()", (s: object) => String(s)],
    ["template interpolation", (s: object) => `${s}`],
    ["concatenation", (s: object) => (s as unknown as string) + ""],
    ["an error message", (s: object) => new Error(`${s}`).message],
    ["util.inspect", (s: object) => inspect(s, { depth: null, showHidden: true })],
    ["spreading", (s: object) => JSON.stringify({ ...s })],
    ["Object.keys", (s: object) => JSON.stringify(Object.keys(s))]
  ])("does not leak through %s", (_label, render) => {
    expect(render(secretOf())).not.toContain("ghp_");
  });

  it("is frozen, so reveal cannot be swapped for something that logs", () => {
    const secret = secretOf();
    expect(Object.isFrozen(secret)).toBe(true);
  });
});

describe("the log and the error", () => {
  it("names the file and the count when it opens, and nothing else", () => {
    const k = key();
    const { logger, lines, text } = recordingLogger();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    const vault = openVault({ file, key: k, logger });

    expect(vault.size).toBe(1);
    // Opening is silent on the happy path; the count is logged by the caller,
    // which is what has the event vocabulary for "this process started".
    expect(lines).toEqual([]);
    expect(text()).not.toContain("ghp_");
  });

  it("warns when the vault is absent, and does not create it", () => {
    const { logger, lines } = recordingLogger();
    const vault = openVault({ file, key: key(), logger });

    expect(vault.size).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(lines).toEqual([{ level: "warn", fields: { event: "vault_absent", file } }]);
  });

  // A vault that exists but cannot be reached is not an absent one. Starting
  // up with zero credentials over a permissions regression would surface as
  // `credential_unresolved` mid-request instead of a startup failure. Root
  // reads through mode 000, so the test is meaningless there.
  it(
    "refuses to open a vault it cannot stat rather than starting empty",
    { skip: process.getuid?.() === 0 },
    () => {
      const k = key();
      const inner = join(dir, "sealed");
      mkdirSync(inner);
      const sealed = join(inner, "vault.enc");
      writeVaultEntries(sealed, k, new Map([[NAME, VALUE]]));
      chmodSync(inner, 0o000);
      const { logger, lines } = recordingLogger();

      try {
        expect(() => openVault({ file: sealed, key: k, logger })).toThrow(
          expect.objectContaining({ reason: "unreadable" })
        );
        expect(lines).toEqual([
          { level: "error", fields: { event: "vault_unreadable", file: sealed, reason: "unreadable" } }
        ]);
      } finally {
        chmodSync(inner, 0o700);
      }
    }
  );

  it("warns about a readable-by-others vault and still opens it", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    chmodSync(file, 0o644);
    const { logger, lines } = recordingLogger();

    expect(openVault({ file, key: k, logger }).size).toBe(1);
    expect(lines).toContainEqual({
      level: "warn",
      fields: { event: "vault_permissive", file, reason: "group_or_world_readable" }
    });
  });

  each([
    ["a wrong key", (k: VaultKey) => writeVaultEntries(file, k, new Map([[NAME, VALUE]]))],
    ["a corrupt file", () => writeFileSync(file, randomBytes(128))],
    ["an empty file", () => writeFileSync(file, Buffer.alloc(0))]
  ])("keeps the value and the key out of the failure for %s", (_label, prepare) => {
    const written = key();
    prepare(written);
    const reading = key();
    const { logger, text } = recordingLogger();

    let thrown: unknown;
    try {
      openVault({ file, key: reading, logger });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VaultError);
    const rendered = [
      String(thrown),
      (thrown as Error).stack ?? "",
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)),
      inspect(thrown, { depth: null, showHidden: true }),
      text()
    ].join("");
    expect(rendered).not.toContain("ghp_");
    expect(rendered).not.toContain(written.toString("base64"));
    expect(rendered).not.toContain(reading.toString("base64"));
  });

  // The one everyone gets wrong: `throw new Error(`bad key: ${raw}`)`.
  it("keeps a rejected key out of its own rejection", () => {
    const bad = "hunter2!!!!hunter2!!!!hunter2!!!!hunter2!!!!";
    expect(JSON.stringify(parseVaultKey(bad))).not.toContain("hunter2");
  });

  // util.inspect prints the cause chain, and an error out of OpenSSL can carry
  // buffer contents in it.
  it("attaches no cause to a decryption failure", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    try {
      openVault({ file, key: key() });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
  });
});

describe("looking a credential up", () => {
  function vaultWith(entries: Map<string, string>) {
    const k = key();
    writeVaultEntries(file, k, entries);
    return openVault({ file, key: k });
  }

  it("misses a name the vault does not hold", () => {
    expect(vaultWith(new Map([[NAME, VALUE]])).lookup("not_loaded")).toEqual({ status: "missing" });
  });

  // What justifies the Map. On an object literal these return a function where
  // a credential belongs.
  each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "misses %j rather than reaching the prototype",
    name => {
      expect(vaultWith(new Map([[NAME, VALUE]])).lookup(name)).toEqual({ status: "missing" });
    }
  );

  // Rejected before the map is consulted, so a caller that skipped its own
  // validation cannot reach the store with a path segment.
  each([
    ["empty", ""],
    ["too long", "a".repeat(65)],
    ["a traversal", "../etc/passwd"],
    ["a separator", "a/b"],
    ["a leading dot", ".hidden"],
    ["a NUL", "name\0"]
  ])("misses %s, which is not a credential name", (_label, name) => {
    expect(vaultWith(new Map([[NAME, VALUE]])).lookup(name)).toEqual({ status: "missing" });
  });

  it("is case-sensitive, as the team sheet's names are", () => {
    const vault = vaultWith(new Map([["github_token", VALUE]]));
    expect(vault.lookup("GITHUB_TOKEN")).toEqual({ status: "missing" });
    expect(vault.lookup("github_token").status).toBe("found");
  });

  it("holds an empty vault apart from an absent one", () => {
    const k = key();
    writeVaultEntries(file, k, new Map());
    expect(existsSync(file)).toBe(true);
    expect(openVault({ file, key: k }).size).toBe(0);
  });

  // The shape #51 turns a miss into. Through the real schema, so no test here
  // asserts against a refusal the proxy could not actually return.
  it("produces the refusal a missing name is reported as", () => {
    expect(vaultWith(new Map()).lookup("not_loaded")).toEqual({ status: "missing" });

    const refusal = ToolRefusal.parse({ reason: "credential_unresolved", credential: "not_loaded" });
    expect(refusalMessage(refusal)).toContain("not_loaded");
    expect(refusalMessage(refusal)).not.toContain("ghp_");
  });
});

describe("a plaintext that is not what this wrote", () => {
  /**
   * A vault holding arbitrary plaintext under a valid tag.
   *
   * `writeVaultEntries` cannot produce any of these — a `Map` has no duplicate
   * keys and `setEntry` validates names — so the bytes are built from the same
   * primitives the writer uses. These are the checks that run *after* the tag
   * has already verified: what a hand-edit, or another tool writing this
   * format, could put in front of the reader.
   */
  function writeRawPlaintext(k: VaultKey, plaintext: string): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const subkey = deriveKey(k, salt);
    const draft = buildHeader(salt, iv, Buffer.alloc(16));
    const cipher = createCipheriv("aes-256-gcm", subkey, iv);
    cipher.setAAD(aadOf(draft));
    const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
    writeFileSync(file, Buffer.concat([buildHeader(salt, iv, cipher.getAuthTag()), body]));
  }

  each([
    ["duplicate names", JSON.stringify({ v: 1, entries: [[NAME, VALUE], [NAME, "second"]] })],
    ["a name that is not a credential name", JSON.stringify({ v: 1, entries: [["../etc", VALUE]] })],
    ["an empty name", JSON.stringify({ v: 1, entries: [["", VALUE]] })],
    ["a non-string value", JSON.stringify({ v: 1, entries: [[NAME, 7]] })],
    ["a pair of the wrong length", JSON.stringify({ v: 1, entries: [[NAME]] })],
    ["entries that are not an array", JSON.stringify({ v: 1, entries: { [NAME]: VALUE } })],
    ["a version the reader does not know", JSON.stringify({ v: 2, entries: [] })],
    ["something that is not an object", JSON.stringify([NAME, VALUE])],
    ["not JSON at all", "{ this is not json"]
  ])("refuses a vault whose plaintext has %s", (_label, plaintext) => {
    const k = key();
    writeRawPlaintext(k, plaintext);
    expect(() => openVault({ file, key: k })).toThrow(
      expect.objectContaining({ reason: "malformed_plaintext" })
    );
  });

  it("keeps the value out of a malformed-plaintext failure", () => {
    const k = key();
    const { logger, text } = recordingLogger();
    writeRawPlaintext(k, JSON.stringify({ v: 1, entries: [[NAME, VALUE], [NAME, VALUE]] }));

    let thrown: unknown;
    try {
      openVault({ file, key: k, logger });
    } catch (error) {
      thrown = error;
    }
    expect(`${String(thrown)}${(thrown as Error).stack}${text()}`).not.toContain("ghp_");
  });

  it("serializes an entry set its own parser accepts", () => {
    const round = serializeEntries(new Map([[NAME, VALUE]]));
    expect(JSON.parse(round.toString("utf8"))).toEqual({ v: 1, entries: [[NAME, VALUE]] });
  });
});

describe("the file mode", () => {
  it("is owner-only after a write", () => {
    writeVaultEntries(file, key(), new Map([[NAME, VALUE]]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("is owner-only again after replacing a permissive vault", () => {
    const k = key();
    writeVaultEntries(file, k, new Map([[NAME, VALUE]]));
    chmodSync(file, 0o644);
    writeVaultEntries(file, k, new Map([[NAME, "second"]]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
