import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, hashArguments, openAuditWriter } from "./audit-log.js";

describe("canonicalJson", () => {
  // The property the hash rests on: the same call hashes the same however its
  // arguments happened to be serialised.
  it("is stable under key reordering", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts at every depth, including inside arrays", () => {
    expect(canonicalJson({ outer: { z: 1, a: [{ y: 1, x: 2 }] } })).toBe('{"outer":{"a":[{"x":2,"y":1}],"z":1}}');
  });

  // Array order is the tool's business. Two orders are two different calls.
  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
  });

  it("emits no whitespace", () => {
    expect(canonicalJson({ a: { b: [1, 2] } })).not.toMatch(/\s/);
  });

  it("handles the scalars a parsed body can hold", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(7)).toBe("7");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("escapes keys rather than concatenating them raw", () => {
    expect(canonicalJson({ 'a"b': 1 })).toBe('{"a\\"b":1}');
  });
});

describe("hashArguments", () => {
  it("is 64 lowercase hex characters", () => {
    expect(hashArguments({ title: "hello" })).toMatch(/^[0-9a-f]{64}$/);
  });

  // `ToolCall.arguments` defaults to `{}`, so these are the same call.
  it("hashes an empty argument object the same however it arrived", () => {
    expect(hashArguments({})).toBe(hashArguments({}));
  });

  it("agrees for two orderings of the same arguments", () => {
    expect(hashArguments({ repo: "libero", title: "x" })).toBe(hashArguments({ title: "x", repo: "libero" }));
  });

  it("differs when the arguments differ", () => {
    expect(hashArguments({ title: "a" })).not.toBe(hashArguments({ title: "b" }));
    expect(hashArguments({ title: "a" })).not.toBe(hashArguments({ titl: "ea" }));
  });

  // The whole reason the preimage is the entire object rather than a field.
  it("does not contain the value it hashed", () => {
    expect(hashArguments({ token: "ghp_secretsecret" })).not.toContain("ghp_");
  });
});

describe("openAuditWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libero-audit-writer-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends through the writer and leaves the handle able to close", () => {
    const file = join(dir, "audit.db");
    const { writer, db } = openAuditWriter({ file });

    writer.append({
      at: 1,
      channel: "C0ENGINEERING",
      requestingUser: "U0ALICE",
      task: "t-1",
      requestId: "r-1",
      callId: "toolu_01",
      server: "github",
      tool: "create_issue",
      argumentsSha256: hashArguments({ title: "x" }),
      outcome: "ran",
      resultBytes: 4,
      resultIsError: false
    });
    db.close();

    const raw = new DatabaseSync(file);
    try {
      expect(raw.prepare("SELECT COUNT(*) AS n FROM tool_call_audit").get()).toEqual({ n: 1 });
    } finally {
      raw.close();
    }
  });

  // The narrowing that is the reason `AuditWriter` exists at all: the serving
  // process appends, and cannot close the file it is being audited into.
  it("hands the server a writer that can only append", () => {
    const { writer, db } = openAuditWriter({ file: join(dir, "surface.db") });
    try {
      expect(Object.keys(writer)).toEqual(["append"]);
    } finally {
      db.close();
    }
  });
});
