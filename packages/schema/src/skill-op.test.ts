import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  SKILL_TOOLS,
  SkillOpArguments,
  SkillOpFailure,
  SkillToolName,
  parseSkillOp,
  skillOpMessage
} from "./skill-op.js";
import type { SkillOpResult } from "./skill-op.js";
import { SKILL_BODY_MAX_CHARS, SKILL_DESCRIPTION_MAX_CHARS } from "./skill.js";
import { MAX_TOOL_DESCRIPTION, ToolInputSchema } from "./tool-listing.js";

/** The published JSON Schema, read as the object a model is handed. */
const published = (tool: SkillToolName) =>
  SKILL_TOOLS[tool].inputSchema as unknown as {
    properties: Record<string, { minLength?: number; maxLength?: number }>;
    required: string[];
    additionalProperties: boolean;
  };

const ARGS = {
  name: "rotate-a-channel-certificate",
  description: "Two pins live across the overlap, so neither service restarts.",
  body: "1. `scripts/dev-certs.sh --rotate <channel>`\n2. Pin the staged fingerprint."
} as const;

const args = (over: Record<string, unknown> = {}) => ({ ...ARGS, ...over });

describe("the skill tool definitions", () => {
  // The Record is keyed by the enum, so this cannot drift — but a missing member
  // is a type error at build time and nothing at review time, and a reviewer
  // adding an operation wants to be told which half they forgot.
  it("defines every name the schema declares", () => {
    expect(Object.keys(SKILL_TOOLS).sort()).toEqual([...SkillToolName.options].sort());
  });

  each(Object.entries(SKILL_TOOLS))(
    "publishes %s within the schema's bounds",
    (_tool, definition) => {
      expect(definition.description.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION);
      expect(ToolInputSchema.safeParse(definition.inputSchema).success).toBe(true);
    }
  );

  // These operations never become built-ins, so nothing else asserts this for
  // them. The directory is resolved from the channel the session already is; an
  // argument that could name one would be the isolation boundary in the hands of
  // the model.
  each(SkillToolName.options)("gives %s no way to name a file or a channel", tool => {
    const keys = Object.keys(published(tool).properties);
    for (const forbidden of ["path", "file", "filename", "channel", "root", "directory"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // The split ./skill.ts argues for, enforced rather than conventional: a model
  // cannot stamp a date, set a status, or move a clock, because there is no
  // field for any of it.
  each(SkillToolName.options)("gives %s no way to write a clock or a status", tool => {
    const keys = Object.keys(published(tool).properties);
    expect(keys).toEqual(["name", "description", "body"]);
    for (const forbidden of ["uses", "created", "status", "last_used"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // Ours, unchanging without a commit, and no tool-poisoning surface — so it is
  // bounded by review rather than at runtime. What it has to be is accurate, and
  // these are the clauses a model would otherwise assume the other way.
  it("says the things a model would otherwise get wrong", () => {
    expect(SKILL_TOOLS.skill_create.description).toContain("fails rather than");
    expect(SKILL_TOOLS.skill_create.description).toContain("skill_revise");
    expect(SKILL_TOOLS.skill_create.description).toContain("no argument names a file");
    // The whole point of the author turn: most tasks leave no playbook.
    expect(SKILL_TOOLS.skill_create.description).toContain("Writing nothing at all");
    expect(SKILL_TOOLS.skill_revise.description).toContain("cannot rename");
    expect(SKILL_TOOLS.skill_revise.description).toContain("no merging");
    expect(SKILL_TOOLS.skill_revise.description).toContain("read it before");
    for (const tool of SkillToolName.options) {
      expect(SKILL_TOOLS[tool].description).not.toMatch(/[!😀-🿿]/u);
    }
  });

  // Two spellings of one contract — a JSON Schema the model reads and a zod
  // parser the store's caller enforces — so they are checked against each other
  // rather than trusted to stay in step.
  each(SkillToolName.options)("declares on %s exactly the keys the parser accepts", tool => {
    const schema = published(tool);
    expect(Object.keys(schema.properties)).toEqual(["name", "description", "body"]);
    expect(schema.required).toEqual(["name", "description", "body"]);
    // Mirrors `.strict()`, so a well-behaved model is told the rule rather than
    // only punished for breaking it.
    expect(schema.additionalProperties).toBe(false);
  });

  each(SkillToolName.options)("states on %s the same bounds the parser enforces", tool => {
    const schema = published(tool);
    expect(schema.properties.description?.maxLength).toBe(SKILL_DESCRIPTION_MAX_CHARS);
    expect(schema.properties.description?.minLength).toBe(1);
    expect(schema.properties.body?.maxLength).toBe(SKILL_BODY_MAX_CHARS);
    expect(schema.properties.body?.minLength).toBe(1);
    expect(schema.properties.name?.maxLength).toBe(64);
    expect(schema.properties.name?.minLength).toBe(1);
  });
});

describe("a skill operation's arguments", () => {
  it("accepts what the two operations carry", () => {
    expect(SkillOpArguments.safeParse(args()).success).toBe(true);
  });

  each([["name"], ["description"], ["body"]])("requires %s", field => {
    const without: Record<string, unknown> = args();
    delete without[field];
    expect(SkillOpArguments.safeParse(without).success).toBe(false);
  });

  each([
    ["a path", { path: "../other/skills/x.md" }],
    ["a channel", { channel: "C123" }],
    ["a status", { status: "archived" }],
    ["a use count", { uses: 99 }],
    ["a created date", { created: "2026-08-15" }]
  ])("refuses %s as an extra key", (_label, extra) => {
    expect(SkillOpArguments.safeParse(args(extra)).success).toBe(false);
  });

  it("accepts a body at the cap and refuses one past it", () => {
    expect(SkillOpArguments.safeParse(args({ body: "b".repeat(SKILL_BODY_MAX_CHARS) })).success).toBe(
      true
    );
    expect(
      SkillOpArguments.safeParse(args({ body: "b".repeat(SKILL_BODY_MAX_CHARS + 1) })).success
    ).toBe(false);
  });

  it("accepts a description at the cap and refuses one past it", () => {
    expect(
      SkillOpArguments.safeParse(args({ description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS) }))
        .success
    ).toBe(true);
    expect(
      SkillOpArguments.safeParse(args({ description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) }))
        .success
    ).toBe(false);
  });

  it("refuses an empty body and an empty description", () => {
    expect(SkillOpArguments.safeParse(args({ body: "" })).success).toBe(false);
    expect(SkillOpArguments.safeParse(args({ description: "" })).success).toBe(false);
  });
});

describe("parsing an operation", () => {
  each(SkillToolName.options)("turns %s into a tagged operation", tool => {
    const parsed = parseSkillOp(tool, args());
    expect(parsed.ok && parsed.op).toEqual({ op: tool, ...ARGS });
  });

  each([
    ["a memory operation", "memory_append"],
    ["a proxied tool", "merge_pull_request"],
    ["a built-in", "search_channel_history"],
    ["a name that is nearly right", "skill_write"],
    ["empty", ""]
  ])("refuses %s", (_label, name) => {
    const parsed = parseSkillOp(name, args());
    expect(!parsed.ok && parsed.reason).toBe("unknown_tool");
  });

  // The four failures send a model to four different fixes, so the distinction
  // is asserted directly rather than trusted: a zod major that renames `too_big`
  // or `invalid_format` fails here instead of quietly telling every model it
  // sent the wrong keys.
  it("separates a bad name from a bad shape", () => {
    const parsed = parseSkillOp("skill_create", args({ name: "Deploy Runbook" }));
    expect(!parsed.ok && parsed.reason).toBe("name_invalid");
  });

  it("separates an oversize body from an oversize description", () => {
    const long = parseSkillOp("skill_create", args({ body: "b".repeat(SKILL_BODY_MAX_CHARS + 1) }));
    expect(!long.ok && long.reason).toBe("body_too_long");

    const wordy = parseSkillOp(
      "skill_create",
      args({ description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) })
    );
    expect(!wordy.ok && wordy.reason).toBe("description_too_long");
  });

  it("reports an unknown key as the shape problem it is", () => {
    const parsed = parseSkillOp("skill_create", args({ path: "/etc/passwd" }));
    expect(!parsed.ok && parsed.reason).toBe("malformed_arguments");
  });

  // A length failure is only a length failure when that is all that went wrong.
  // An oversize body sent alongside a missing description is a model that sent
  // the wrong shape, and telling it to shorten something would waste the turn.
  it("reports a mixed failure as the shape problem", () => {
    const parsed = parseSkillOp("skill_create", {
      name: ARGS.name,
      body: "b".repeat(SKILL_BODY_MAX_CHARS + 1)
    });
    expect(!parsed.ok && parsed.reason).toBe("malformed_arguments");
  });

  // A bad name reports as a bad name even when something else is also wrong: it
  // is the most specific fix available and the one a model is least likely to
  // guess from an alphabet it has never been told.
  it("reports a bad name ahead of anything else", () => {
    const parsed = parseSkillOp(
      "skill_create",
      args({ name: "Deploy Runbook", body: "b".repeat(SKILL_BODY_MAX_CHARS + 1) })
    );
    expect(!parsed.ok && parsed.reason).toBe("name_invalid");
  });

  it("never throws", () => {
    for (const value of [null, undefined, 0, "", [], { name: 1 }, { body: {} }]) {
      expect(() => parseSkillOp("skill_create", value)).not.toThrow();
    }
  });
});

describe("what an operation is told about itself", () => {
  const failures: readonly SkillOpResult[] = [
    { outcome: "failed", reason: "unknown_tool" },
    { outcome: "failed", reason: "malformed_arguments" },
    { outcome: "failed", reason: "name_invalid" },
    { outcome: "failed", reason: "description_too_long" },
    { outcome: "failed", reason: "body_too_long" },
    { outcome: "failed", reason: "name_taken", name: "deploy" },
    { outcome: "failed", reason: "skill_not_found", name: "deploy" },
    { outcome: "failed", reason: "library_full", skills: 100, limit: 100 }
  ];

  it("has a sentence for every failure the vocabulary declares", () => {
    expect(failures.map(f => f.outcome === "failed" && f.reason).sort()).toEqual(
      [...SkillOpFailure.options].sort()
    );
  });

  each(failures)("says nothing was written for $reason", failure => {
    expect(skillOpMessage(failure)).toContain("Nothing was written.");
  });

  it("says how much room is left when something was written", () => {
    expect(skillOpMessage({ outcome: "written", skills: 7, limit: 100 })).toBe(
      "Written. This channel now holds 7 of 100 skills."
    );
  });

  // The load-bearing clause. A model told only that the name exists tries again
  // as `deploy-runbook-2`, which is the near-duplicate proliferation the design
  // exists to prevent, arriving through the failure path.
  it("sends a taken name to a revision rather than to a second name", () => {
    const message = skillOpMessage({ outcome: "failed", reason: "name_taken", name: "deploy" });
    expect(message).toContain("deploy");
    expect(message).toContain("skill_revise");
    expect(message).toContain("rather than writing a second skill");
  });

  it("quotes the cap it hit", () => {
    expect(skillOpMessage({ outcome: "failed", reason: "body_too_long" })).toContain(
      String(SKILL_BODY_MAX_CHARS)
    );
    expect(skillOpMessage({ outcome: "failed", reason: "description_too_long" })).toContain(
      String(SKILL_DESCRIPTION_MAX_CHARS)
    );
    expect(
      skillOpMessage({ outcome: "failed", reason: "library_full", skills: 100, limit: 100 })
    ).toContain("100");
  });

  it("tells a bad name what a name looks like", () => {
    expect(skillOpMessage({ outcome: "failed", reason: "name_invalid" })).toContain(
      "lowercase words joined by single dashes"
    );
  });

  each([...failures, { outcome: "written", skills: 1, limit: 100 } as const])(
    "keeps $reason$outcome free of exclamation and emoji",
    result => {
      expect(skillOpMessage(result)).not.toMatch(/[!😀-🿿]/u);
    }
  );
});
