import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { MEMORY_OP_MAX_TEXT_CHARS } from "@getlibero/schema";
import type { MemoryOpResult } from "@getlibero/schema";
import { openMemoryFile } from "./memory-file.js";
import type { MemoryFile } from "./memory-file.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";

/** Above the floor, and small enough that a test can fill it. */
const CAP = 8_192;

let root: string;
let file: string;
let memory: MemoryFile;

/** The file as a second process would read it, or null when there is none. */
const onDisk = (): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** Appends and returns the result, which is what most cases below assert on. */
const append = (text: string): MemoryOpResult => memory.apply({ op: "memory_append", text });

/** Replaces and returns the result. */
const replace = (find: string, to: string): MemoryOpResult =>
  memory.apply({ op: "memory_replace", find, replace: to });

/** Writes behind the store's back. The team's text editor, and the operator's. */
const handWrite = (text: string): void => writeFileSync(file, text, "utf8");

/** Everything in the channel's directory. A leftover temporary file is what this catches. */
const entries = (): string[] => readdirSync(join(root, CHANNEL)).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-memory-"));
  // The store does not create this — that is a tested property below, so here
  // the test does the operator's job of declaring the channel exists.
  mkdirSync(join(root, CHANNEL));
  file = join(root, CHANNEL, "MEMORY.md");
  memory = openMemoryFile({ channel: CHANNEL, root, maxFileChars: CAP });
});

afterEach(() => {
  // No close: there is no handle. See "the interface" below.
  rmSync(root, { recursive: true, force: true });
});

describe("the file", () => {
  it("lands in the channel's own directory", () => {
    append("Deploys go out Thursdays.");

    expect(existsSync(file)).toBe(true);
  });

  // An opener that touched the file would make every provisioned channel look
  // curated, and would leave one behind for a channel whose first operation was
  // refused.
  it("creates nothing until the first successful write", () => {
    expect(existsSync(file)).toBe(false);
    expect(memory.read()).toBe("");
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a channel directory that does not exist", () => {
    expect(() => openMemoryFile({ channel: "C0NOSUCH", root, maxFileChars: CAP })).toThrow(
      /has no state directory/
    );
  });

  each([
    ["a parent traversal", ".."],
    ["a separator", "a/b"],
    ["empty", ""],
    ["a leading dot", ".hidden"]
  ])("refuses %s as a channel id", (_name, channel) => {
    expect(() => openMemoryFile({ channel, root, maxFileChars: CAP })).toThrow(
      /not a valid channel id/
    );
  });

  // The file is the channel, so there is no argument that could name another.
  // Two files under one root cannot see each other.
  it("cannot reach another channel's file", () => {
    mkdirSync(join(root, OTHER));
    const other = openMemoryFile({ channel: OTHER, root, maxFileChars: CAP });

    append("ours");
    other.apply({ op: "memory_append", text: "theirs" });

    expect(memory.read()).toBe("ours\n");
    expect(other.read()).toBe("theirs\n");
  });
});

describe("the interface", () => {
  // A structural regression test on the surface. Two claims at once: no
  // operation can name a channel, and there is no `close` because there is no
  // handle to close — a no-op one would be a method whose omission no test could
  // detect.
  it("exposes reading and applying, and nothing else", () => {
    expect(Object.keys(memory).sort()).toEqual(["apply", "read"]);
  });
});

describe("the cap at open", () => {
  it("refuses a cap below one operation's ceiling", () => {
    expect(() =>
      openMemoryFile({ channel: CHANNEL, root, maxFileChars: MEMORY_OP_MAX_TEXT_CHARS - 1 })
    ).toThrow(new RegExp(`one operation may carry ${MEMORY_OP_MAX_TEXT_CHARS}`));
  });

  it("accepts a cap of exactly one operation", () => {
    expect(() =>
      openMemoryFile({ channel: CHANNEL, root, maxFileChars: MEMORY_OP_MAX_TEXT_CHARS })
    ).not.toThrow();
  });

  each([
    ["fractional", 8_192.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -1]
  ])("refuses %s as a cap", (_name, maxFileChars) => {
    expect(() => openMemoryFile({ channel: CHANNEL, root, maxFileChars })).toThrow(/a cap of/);
  });

  // The schema puts a roof on `[memory] max_file_chars`; this module does not
  // restate it. An over-large cap breaks no invariant here — it costs the
  // caller's context budget, which is the caller's to defend.
  it("accepts a cap above the team sheet's own roof", () => {
    expect(() =>
      openMemoryFile({ channel: CHANNEL, root, maxFileChars: 1_000_000 })
    ).not.toThrow();
  });
});

describe("reading", () => {
  it("reads an absent file as empty", () => {
    expect(memory.read()).toBe("");
  });

  // The same value as absent, deliberately: the difference is a fact about the
  // filesystem rather than about what the channel remembers.
  it("reads an empty file as empty", () => {
    handWrite("");

    expect(memory.read()).toBe("");
  });

  it("reads back exactly what was written, with no normalization", () => {
    handWrite("alpha\r\n\tbeta");

    expect(memory.read()).toBe("alpha\r\n\tbeta");
  });

  // No cache and no watcher. A person editing MEMORY.md is a first-class writer
  // here, and this is what makes a `find` taken from a read still meaningful.
  it("sees an edit made behind its back", () => {
    append("first");
    handWrite("rewritten by hand");

    expect(memory.read()).toBe("rewritten by hand");
  });

  // Absence is ENOENT and nothing else. Answering empty to a file we could not
  // read would compute a replacement from content we never saw, and replace a
  // whole channel's memory with one appended line. EACCES is the live case;
  // EISDIR is the portable stand-in that needs no uid.
  it("throws rather than answering empty when the file cannot be read", () => {
    mkdirSync(file);

    expect(() => memory.read()).toThrow();
    expect(() => append("anything")).toThrow();
  });
});

describe("appending", () => {
  it("writes into an empty channel", () => {
    const result = append("Deploys go out Thursdays.");

    expect(result).toEqual({ outcome: "written", chars: 26, limit: CAP });
    expect(onDisk()).toBe("Deploys go out Thursdays.\n");
  });

  it("puts the text on its own line when the file does not end in one", () => {
    handWrite("alpha");

    append("beta");

    expect(onDisk()).toBe("alpha\nbeta\n");
  });

  it("adds no second newline when the file already ends in one", () => {
    handWrite("alpha\n");

    append("beta\n");

    expect(onDisk()).toBe("alpha\nbeta\n");
  });

  it("leaves a multi-line block otherwise exactly as written", () => {
    append("## Deploys\n\n- Thursdays\n- Priya signs off");

    expect(onDisk()).toBe("## Deploys\n\n- Thursdays\n- Priya signs off\n");
  });

  // Pins the promise the published tool description makes.
  it("does not deduplicate", () => {
    append("the same fact");
    append("the same fact");

    expect(onDisk()).toBe("the same fact\nthe same fact\n");
  });

  it("reports the file's new size, measured rather than estimated", () => {
    append("alpha");
    const result = append("beta");

    expect(result).toEqual({ outcome: "written", chars: onDisk()?.length, limit: CAP });
  });
});

describe("replacing", () => {
  beforeEach(() => {
    handWrite("- Deploys go out Tuesdays.\n- Rollbacks need Priya's sign-off.\n");
  });

  it("replaces the one match", () => {
    const result = replace("Tuesdays", "Thursdays");

    expect(result).toEqual({ outcome: "written", chars: onDisk()?.length, limit: CAP });
    expect(onDisk()).toBe("- Deploys go out Thursdays.\n- Rollbacks need Priya's sign-off.\n");
  });

  // Deletion is replace-with-nothing and there is no other spelling of it.
  it("deletes with an empty replacement", () => {
    replace("- Deploys go out Tuesdays.\n", "");

    expect(onDisk()).toBe("- Rollbacks need Priya's sign-off.\n");
  });

  it("frames nothing, unlike an append", () => {
    handWrite("alpha");

    replace("alpha", "beta");

    expect(onDisk()).toBe("beta");
  });

  it("leaves the file byte-identical when nothing matches", () => {
    const before = onDisk();

    expect(replace("Wednesdays", "Thursdays")).toEqual({
      outcome: "failed",
      reason: "find_not_found"
    });
    expect(onDisk()).toBe(before);
  });

  it("carries the count and writes nothing when more than one matches", () => {
    const before = onDisk();

    expect(replace("- ", "* ")).toEqual({
      outcome: "failed",
      reason: "find_ambiguous",
      matches: 2
    });
    expect(onDisk()).toBe(before);
  });

  it("counts non-overlapping occurrences", () => {
    handWrite("aaaa");

    expect(replace("aa", "b")).toEqual({
      outcome: "failed",
      reason: "find_ambiguous",
      matches: 2
    });
  });

  // Literal, never a pattern — the promise the tool description makes.
  it("treats find as literal text and not as a pattern", () => {
    handWrite("abc");

    expect(replace(".*", "everything")).toEqual({ outcome: "failed", reason: "find_not_found" });
    expect(onDisk()).toBe("abc");

    handWrite("a.c");
    expect(replace("a.c", "found")).toMatchObject({ outcome: "written" });
    expect(onDisk()).toBe("found");
  });

  // `String.prototype.replace` would read these as substitutions. A fact
  // containing `$&` has to land as those two characters.
  it("treats the replacement as literal text too", () => {
    handWrite("placeholder");

    replace("placeholder", "costs $& and $1 and $'");

    expect(onDisk()).toBe("costs $& and $1 and $'");
  });

  it("matches across lines", () => {
    replace("Tuesdays.\n- Rollbacks", "Thursdays.\n- Rollbacks");

    expect(onDisk()).toContain("Thursdays.\n- Rollbacks");
  });
});

describe("the per-operation ceiling", () => {
  const oversize = "x".repeat(MEMORY_OP_MAX_TEXT_CHARS + 1);

  // Re-checked here even though `parseMemoryOp` already bounds it, because
  // `MemoryOp` is a plain type with no zod object — nothing structurally forces
  // a caller through the parser. The file has room; the operation still cannot.
  it("refuses an oversize append even when the file has room", () => {
    expect(append(oversize)).toEqual({ outcome: "failed", reason: "text_too_long" });
    expect(onDisk()).toBeNull();
  });

  each([
    ["find", { op: "memory_replace" as const, find: oversize, replace: "x" }],
    ["replace", { op: "memory_replace" as const, find: "x", replace: oversize }]
  ])("refuses an oversize %s", (_name, op) => {
    handWrite("x");

    expect(memory.apply(op)).toEqual({ outcome: "failed", reason: "text_too_long" });
    expect(onDisk()).toBe("x");
  });

  each([
    ["an empty append", { op: "memory_append" as const, text: "" }],
    ["an empty find", { op: "memory_replace" as const, find: "", replace: "x" }]
  ])("refuses %s as malformed", (_name, op) => {
    expect(memory.apply(op)).toEqual({ outcome: "failed", reason: "malformed_arguments" });
  });
});

describe("the cap", () => {
  // Built by hand rather than by appending: one operation may carry only
  // MEMORY_OP_MAX_TEXT_CHARS, so no single append can fill a file this size.
  it("refuses an append that would exceed it and leaves the file unchanged", () => {
    handWrite(`${"x".repeat(CAP - 1)}\n`);
    const before = onDisk();

    const result = append("y");

    // CAP, plus the "y", plus the newline the store adds after it.
    expect(result).toEqual({
      outcome: "failed",
      reason: "file_cap_exceeded",
      chars: CAP + 2,
      limit: CAP
    });
    expect(onDisk()).toBe(before);
  });

  // The boundary, so a `>=` cannot creep in. The newline the store adds counts.
  it("writes an append that lands exactly on the cap", () => {
    handWrite(`${"x".repeat(CAP - 3)}\n`);

    const result = append("y");

    expect(result).toEqual({ outcome: "written", chars: CAP, limit: CAP });
    expect(onDisk()?.length).toBe(CAP);
  });

  it("refuses a replace that would grow the file past it", () => {
    handWrite(`${"x".repeat(CAP - 1)}z`);
    const before = onDisk();

    expect(replace("z", "zz")).toMatchObject({ outcome: "failed", reason: "file_cap_exceeded" });
    expect(onDisk()).toBe(before);
  });

  // The escape hatch, and the test that keeps a shipped sentence honest:
  // `memoryOpMessage` tells the model to "replace something already in the file
  // with a shorter version of itself to make room". Under a bare
  // `next.length > limit` that is advice this store would refuse to honour,
  // because every intermediate state of a shrinking rewrite is also over the cap.
  it("lets a shorter replace compact a file that is already over the cap", () => {
    handWrite(`${"x".repeat(CAP)}\nstale section\n`);

    expect(replace("stale section\n", "")).toMatchObject({ outcome: "written" });
    expect(onDisk()).toBe(`${"x".repeat(CAP)}\n`);
  });

  it("lets a same-size replace through on an over-cap file", () => {
    handWrite(`${"x".repeat(CAP)}\nabc\n`);

    expect(replace("abc", "xyz")).toMatchObject({ outcome: "written" });
    expect(onDisk()).toBe(`${"x".repeat(CAP)}\nxyz\n`);
  });

  // An append always grows the file, so the relaxation above never admits one.
  it("still refuses every append on an over-cap file", () => {
    handWrite(`${"x".repeat(CAP + 10)}\n`);
    const before = onDisk();

    expect(append("one more")).toMatchObject({ outcome: "failed", reason: "file_cap_exceeded" });
    expect(onDisk()).toBe(before);
  });
});

// Acceptance criterion 3. A torn read cannot be sampled by racing in a
// single-threaded runtime, so these assert the mechanism it follows from: the
// file is replaced whole, never written in place.
describe("a reader never sees a torn file", () => {
  it("replaces the file rather than writing into it", () => {
    append("alpha");
    const before = statSync(file).ino;

    append("beta");

    // The observable signature of write-temp-then-rename. It fails for
    // writeFileSync, appendFileSync, and anything opening O_TRUNC — which are
    // exactly the three simplifications a later reader reaches for.
    expect(statSync(file).ino).not.toBe(before);
  });

  it("leaves a handle opened before a write reading the whole old file", () => {
    append("the old content, which is long enough to notice being truncated");
    const expected = onDisk() ?? "";

    const handle = openSync(file, "r");
    try {
      append("the new content");

      const buffer = Buffer.alloc(expected.length);
      const read = readSync(handle, buffer, 0, buffer.length, 0);
      expect(buffer.subarray(0, read).toString("utf8")).toBe(expected);
    } finally {
      closeSync(handle);
    }
  });

  it("leaves no temporary file behind a successful write", () => {
    append("alpha");

    expect(entries()).toEqual(["MEMORY.md"]);
  });

  it("leaves no temporary file behind a refused operation", () => {
    append("alpha");

    expect(append("x".repeat(CAP))).toMatchObject({ outcome: "failed" });
    expect(entries()).toEqual(["MEMORY.md"]);
  });

  // Root ignores the directory mode, and a test that silently passed as root
  // would be one that proved nothing in the environment where it ran.
  it("leaves the old file intact when a write fails", { skip: process.getuid?.() === 0 }, () => {
    append("alpha");
    const before = onDisk();
    const directory = join(root, CHANNEL);
    chmodSync(directory, 0o555);

    try {
      expect(() => append("beta")).toThrow();
      expect(onDisk()).toBe(before);
    } finally {
      chmodSync(directory, 0o755);
    }
  });
});

// Acceptance criterion 1.
describe("two writers", () => {
  // The property that matters is that no writer holds a stale view, because no
  // writer holds a view at all — every operation reads the file first. Two
  // handles over one channel therefore interleave without either losing the
  // other's work.
  //
  // What is deliberately not written here is a `Promise.all` over these calls.
  // `apply` is synchronous and never awaits, so such a test would run them to
  // completion one after another and prove nothing about concurrency while
  // looking exactly like a test that did — and a test that encodes a gap is
  // worse than no test.
  //
  // What cannot be tested in this process at all is two OS processes. Rename
  // guarantees no torn file and no interleaved bytes; it does not guarantee no
  // lost update, and the answer to that one is a deployment property rather
  // than a code property. The README states it.
  it("interleave without losing a write", () => {
    const other = openMemoryFile({ channel: CHANNEL, root, maxFileChars: CAP });

    append("first");
    other.apply({ op: "memory_append", text: "second" });
    append("third");

    expect(onDisk()).toBe("first\nsecond\nthird\n");
    expect(other.read()).toBe("first\nsecond\nthird\n");
  });
});
