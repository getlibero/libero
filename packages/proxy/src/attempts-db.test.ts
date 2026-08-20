import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPT_BYTES, openAttemptStore } from "./attempts-db.js";
import type { AttemptStore } from "./attempts-db.js";
import { hashArguments } from "./audit-log.js";

let dir: string;
let file: string;
let store: AttemptStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-attempts-"));
  file = join(dir, "attempts.db");
  store = openAttemptStore({ file });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the attempt store", () => {
  it("records under the audit row's own digest, and reads back verified", () => {
    const digest = store.record({ branch: "main", force: true }, 1_000);

    // The whole join between the two files: the key this store mints is
    // byte-for-byte the hash the chained row carries.
    expect(digest).toBe(hashArguments({ branch: "main", force: true }));

    const stored = store.read(digest);
    expect(stored).toEqual({
      argumentsSha256: digest,
      argumentsJson: '{"branch":"main","force":true}',
      firstSeenAt: 1_000,
      verified: true
    });
  });

  it("is idempotent by content, keeping the first sight's stamp", () => {
    const digest = store.record({ a: 1 }, 1_000);
    expect(store.record({ a: 1 }, 9_000)).toBe(digest);

    expect(store.read(digest)?.firstSeenAt).toBe(1_000);
  });

  it("answers nothing for a hash it never saw", () => {
    expect(store.read("0".repeat(64))).toBeUndefined();
  });

  it("deletes one record, and says whether there was one", () => {
    const digest = store.record({ secret: "hunter2" }, 1_000);

    expect(store.delete(digest)).toBe(true);
    expect(store.read(digest)).toBeUndefined();
    expect(store.delete(digest)).toBe(false);
  });

  // The read path's verification is the whole tamper-evidence story: the
  // store is not chained, so an altered record is caught by the digest it is
  // keyed under, which is the digest the chained audit row commits to.
  it("says so when a record was altered under it", () => {
    const digest = store.record({ branch: "main" }, 1_000);
    store.close();

    const raw = new DatabaseSync(file);
    raw.prepare(`UPDATE attempt SET arguments = ? WHERE arguments_sha256 = ?`).run(
      '{"branch":"innocent"}',
      digest
    );
    raw.close();
    store = openAttemptStore({ file });

    const stored = store.read(digest);
    expect(stored?.verified).toBe(false);
    expect(stored?.argumentsJson).toBe('{"branch":"innocent"}');
  });

  // Unreachable through the listener, whose body cap is the same number; a
  // caller that got here bypassed it, and a truncated record would fail its
  // own verification forever — so it throws rather than stores.
  it("refuses a record over the cap rather than truncating it", () => {
    expect(() => store.record({ big: "x".repeat(MAX_ATTEMPT_BYTES) }, 1_000)).toThrow(/cap/);
  });
});
