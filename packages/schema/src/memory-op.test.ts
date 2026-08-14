import { describe, expect, it } from "vitest";
import {
  MEMORY_OP_MAX_TEXT_CHARS,
  MEMORY_TOOLS,
  MemoryAppendArguments,
  MemoryOpFailure,
  MemoryReplaceArguments,
  MemoryToolName,
  memoryOpMessage,
  parseMemoryOp
} from "./memory-op.js";
import type { MemoryOpResult } from "./memory-op.js";
import { MAX_TOOL_DESCRIPTION, ToolInputSchema } from "./tool-listing.js";

/** The published JSON Schema, read as the object a model is handed. */
const published = (tool: MemoryToolName) =>
  MEMORY_TOOLS[tool].inputSchema as unknown as {
    properties: Record<string, { minLength?: number; maxLength?: number }>;
    required: string[];
    additionalProperties: boolean;
  };

const codes = (result: { success: boolean; error?: { issues: readonly { path: PropertyKey[]; code: string }[] } }) =>
  result.error?.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`) ?? null;

describe("the memory tool definitions", () => {
  // The Record is keyed by the enum, so this cannot drift — but a missing member
  // is a type error at build time and nothing at review time, and a reviewer
  // adding an operation wants to be told which half they forgot.
  it("defines every name the schema declares", () => {
    expect(Object.keys(MEMORY_TOOLS).sort()).toEqual([...MemoryToolName.options].sort());
  });

  it.each(Object.entries(MEMORY_TOOLS))("publishes %s within the schema's bounds", (_tool, definition) => {
    expect(definition.description.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION);
    expect(ToolInputSchema.safeParse(definition.inputSchema).success).toBe(true);
  });

  // These operations never become built-ins, so nothing else asserts this for
  // them. The file is resolved from the channel the session already is; an
  // argument that could name one would be the whole isolation boundary in the
  // hands of the model.
  it.each(MemoryToolName.options)("gives %s no way to name a file or a channel", tool => {
    const keys = Object.keys(published(tool).properties);
    for (const forbidden of ["path", "file", "filename", "channel", "root"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // Ours, unchanging without a commit, and no tool-poisoning surface — so it is
  // bounded by review rather than at runtime. What it has to be is accurate, and
  // these are the clauses a model would otherwise assume the other way.
  it("says the things a model would otherwise get wrong", () => {
    expect(MEMORY_TOOLS.memory_append.description).toContain("nothing is deduplicated");
    // The store puts an appended fact on its own line, so the description must
    // not promise the text lands byte-for-byte at the end of the file (#225).
    expect(MEMORY_TOOLS.memory_append.description).toContain("on its own line");
    expect(MEMORY_TOOLS.memory_append.description).not.toContain(
      "end of the file exactly as written"
    );
    expect(MEMORY_TOOLS.memory_replace.description).toContain("must match exactly once");
    expect(MEMORY_TOOLS.memory_replace.description).toContain("not a regular expression");
    expect(MEMORY_TOOLS.memory_replace.description).toContain("no operation that rewrites the whole file");
    for (const tool of MemoryToolName.options) {
      expect(MEMORY_TOOLS[tool].description).not.toMatch(/[!😀-🿿]/u);
    }
  });
});

// Two spellings of one contract — a JSON Schema the model reads and a zod parser
// the store's caller enforces — so they are checked against each other rather
// than trusted to stay in step.
describe("memory_append's arguments", () => {
  const schema = published("memory_append");

  it("declares exactly the keys the parser accepts", () => {
    expect(Object.keys(schema.properties)).toEqual(["text"]);
    expect(schema.required).toEqual(["text"]);
    // Mirrors `.strict()`, so a well-behaved model is told the rule rather than
    // only punished for breaking it.
    expect(schema.additionalProperties).toBe(false);
  });

  it.each([
    ["a missing text", {}],
    ["an empty text", { text: "" }],
    ["a text that is not a string", { text: 42 }]
  ])("refuses %s", (_label, args) => {
    expect(MemoryAppendArguments.safeParse(args).success).toBe(false);
  });

  it("accepts text at the ceiling and refuses one character past it", () => {
    expect(MemoryAppendArguments.safeParse({ text: "x".repeat(MEMORY_OP_MAX_TEXT_CHARS) }).success).toBe(true);
    const over = MemoryAppendArguments.safeParse({ text: "x".repeat(MEMORY_OP_MAX_TEXT_CHARS + 1) });
    expect(codes(over)).toEqual(["text: too_big"]);
  });

  // The acceptance criterion at the layer that makes it structural: an unknown
  // key is a rejection naming the key, not one silently dropped, so an attempt
  // to reach another channel's file is visible in the transcript.
  it("refuses an unknown key rather than dropping it", () => {
    const parsed = MemoryAppendArguments.safeParse({ text: "x", path: "../other/MEMORY.md" });
    expect(codes(parsed)).toEqual([": unrecognized_keys"]);
  });

  it("states the same bounds in both spellings", () => {
    expect(schema.properties["text"]?.minLength).toBe(1);
    expect(schema.properties["text"]?.maxLength).toBe(MEMORY_OP_MAX_TEXT_CHARS);
  });
});

describe("memory_replace's arguments", () => {
  const schema = published("memory_replace");

  it("declares exactly the keys the parser accepts", () => {
    expect(Object.keys(schema.properties)).toEqual(["find", "replace"]);
    expect(schema.required).toEqual(["find", "replace"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it.each([
    ["a missing find", { replace: "x" }],
    ["a missing replace", { find: "x" }],
    ["an empty find", { find: "", replace: "x" }]
  ])("refuses %s", (_label, args) => {
    expect(MemoryReplaceArguments.safeParse(args).success).toBe(false);
  });

  // Deletion is replace-with-nothing and there is no other spelling of it, so
  // this is not an edge case — it is one of the two things the operation does.
  it("accepts an empty replace, because that is how a fact is retired", () => {
    expect(MemoryReplaceArguments.safeParse({ find: "stale", replace: "" }).success).toBe(true);
    expect(schema.properties["replace"]?.minLength).toBeUndefined();
  });

  it.each(["find", "replace"])("bounds %s by the same ceiling, in both spellings", field => {
    const at = { find: "x", replace: "x", [field]: "x".repeat(MEMORY_OP_MAX_TEXT_CHARS) };
    const over = { find: "x", replace: "x", [field]: "x".repeat(MEMORY_OP_MAX_TEXT_CHARS + 1) };
    expect(MemoryReplaceArguments.safeParse(at).success).toBe(true);
    expect(codes(MemoryReplaceArguments.safeParse(over))).toEqual([`${field}: too_big`]);
    expect(schema.properties[field]?.maxLength).toBe(MEMORY_OP_MAX_TEXT_CHARS);
  });

  it("refuses an unknown key rather than dropping it", () => {
    const parsed = MemoryReplaceArguments.safeParse({ find: "a", replace: "b", channel: "C0OTHER" });
    expect(codes(parsed)).toEqual([": unrecognized_keys"]);
  });
});

describe("parsing an operation the model emitted", () => {
  it("tags an append with the name it was called by", () => {
    const parsed = parseMemoryOp("memory_append", { text: "Deploys go out Thursdays." });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.op).toEqual({ op: "memory_append", text: "Deploys go out Thursdays." });
  });

  it("tags a replace with the name it was called by", () => {
    const parsed = parseMemoryOp("memory_replace", { find: "Tuesdays", replace: "Thursdays" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.op).toEqual({ op: "memory_replace", find: "Tuesdays", replace: "Thursdays" });
  });

  it.each([
    ["a built-in", "search_channel_history"],
    ["a tool from the sheet", "list_pull_requests"],
    ["nothing at all", ""]
  ])("refuses %s as a memory operation", (_label, name) => {
    const parsed = parseMemoryOp(name, { text: "x" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("unknown_tool");
  });

  // The one piece of cleverness in the module: length alone is read off zod's
  // issue codes. Pinned here rather than trusted, so a zod major that renames
  // `too_big` fails this suite instead of quietly telling every model it sent
  // the wrong keys.
  it("reports oversize text apart from other malformation", () => {
    const long = parseMemoryOp("memory_append", { text: "x".repeat(MEMORY_OP_MAX_TEXT_CHARS + 1) });
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.reason).toBe("text_too_long");

    const wrong = parseMemoryOp("memory_append", { text: 42 });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.reason).toBe("malformed_arguments");
  });

  // A model emitting nonsense is an ordinary outcome of asking a model for
  // something. A throw here would end a curation turn that was meant to be
  // unable to affect the reply it follows.
  it.each([
    ["null", null],
    ["a string", "text"],
    ["an array", []],
    ["a number", 0],
    ["undefined", undefined]
  ])("never throws on %s", (_label, args) => {
    expect(() => parseMemoryOp("memory_append", args)).not.toThrow();
    expect(parseMemoryOp("memory_append", args).ok).toBe(false);
  });
});

describe("what an operation reports back", () => {
  /** One well-formed result per failure, keyed so the totality test can check
   *  that the union covers every reason the enum declares. */
  const samples: Record<MemoryOpFailure, MemoryOpResult> = {
    unknown_tool: { outcome: "failed", reason: "unknown_tool" },
    malformed_arguments: { outcome: "failed", reason: "malformed_arguments" },
    text_too_long: { outcome: "failed", reason: "text_too_long" },
    file_cap_exceeded: { outcome: "failed", reason: "file_cap_exceeded", chars: 40_000, limit: 32_768 },
    find_not_found: { outcome: "failed", reason: "find_not_found" },
    find_ambiguous: { outcome: "failed", reason: "find_ambiguous", matches: 3 }
  };

  it("has a variant and a sentence for every declared failure", () => {
    for (const reason of MemoryOpFailure.options) {
      expect(memoryOpMessage(samples[reason]).length).toBeGreaterThan(0);
    }
    expect(memoryOpMessage({ outcome: "written", chars: 120, limit: 32_768 }).length).toBeGreaterThan(0);
  });

  it("gives each failure its own sentence", () => {
    const sentences = MemoryOpFailure.options.map(reason => memoryOpMessage(samples[reason]));
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  // The claim every one of them has to make. A model that thinks a refused
  // operation half-applied will spend its next turn repairing a file nothing
  // touched.
  it("says nothing was written, in every failure", () => {
    for (const reason of MemoryOpFailure.options) {
      expect(memoryOpMessage(samples[reason])).toContain("Nothing was written");
      expect(memoryOpMessage(samples[reason])).not.toMatch(/[!😀-🿿]/u);
    }
  });

  // `refusalMessage` quotes no figure because the number lives in the sheet and
  // the sentence is read in a channel. This one quotes them because they arrive
  // on the result from the store that just enforced them — so the test is that
  // the figure tracks the result rather than any second source.
  it("quotes the cap from the result and from nowhere else", () => {
    const at32k = memoryOpMessage(samples.file_cap_exceeded);
    expect(at32k).toContain("32768");
    expect(at32k).toContain("40000");
    const at64k = memoryOpMessage({
      outcome: "failed",
      reason: "file_cap_exceeded",
      chars: 70_000,
      limit: 65_536
    });
    expect(at64k).toContain("65536");
    expect(at64k).not.toBe(at32k);
  });

  it("tells the model how full the file is after a write", () => {
    expect(memoryOpMessage({ outcome: "written", chars: 1_204, limit: 32_768 })).toContain("1204 of 32768");
  });

  // `ToolRefusal`'s discipline, kept here for the same reason: a sentence cannot
  // disagree with the outcome if nothing in it was not enumerated on the result.
  // It is also what keeps a curated file's contents out of any log this reaches.
  it("carries no free text on any variant", () => {
    const variants: MemoryOpResult[] = [
      { outcome: "written", chars: 1, limit: 2 },
      ...MemoryOpFailure.options.map(reason => samples[reason])
    ];
    for (const variant of variants) {
      for (const [key, value] of Object.entries(variant)) {
        if (key === "outcome" || key === "reason") continue;
        expect(typeof value).toBe("number");
      }
    }
  });
});
