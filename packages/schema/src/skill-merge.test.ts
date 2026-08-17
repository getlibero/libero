import { describe, expect, it } from "vitest";
import {
  SKILL_MERGE_TOOL,
  SKILL_MERGE_TOOL_DEFINITION,
  SkillMergeArguments,
  SkillMergeFailure,
  parseSkillMerge
} from "./skill-merge.js";
import { SkillToolName } from "./skill-op.js";
import { SKILL_BODY_MAX_CHARS, SKILL_DESCRIPTION_MAX_CHARS } from "./skill.js";
import { MAX_TOOL_DESCRIPTION, ToolInputSchema } from "./tool-listing.js";

const PAIR = ["deploy-rollback", "deploy-runbook"] as const;

const ARGS = {
  keep: "deploy-runbook",
  description: "How to ship, and how to roll back when it goes wrong.",
  body: "1. `make deploy`\n2. If it fails, `make rollback` before anything else."
} as const;

const args = (over: Record<string, unknown> = {}) => ({ ...ARGS, ...over });

/** The published JSON Schema, read as the object a model is handed. */
const published = () =>
  SKILL_MERGE_TOOL_DEFINITION.inputSchema as unknown as {
    properties: Record<string, { minLength?: number; maxLength?: number }>;
    required: string[];
    additionalProperties: boolean;
  };

describe("the merge tool definition", () => {
  it("publishes within the schema's bounds", () => {
    expect(SKILL_MERGE_TOOL_DEFINITION.description.length).toBeLessThanOrEqual(
      MAX_TOOL_DESCRIPTION
    );
    expect(ToolInputSchema.safeParse(SKILL_MERGE_TOOL_DEFINITION.inputSchema).success).toBe(true);
  });

  // The load-bearing clause. Every other tool a model here is handed does
  // something when called; one that believes this one merges files will write a
  // body meant to be applied silently rather than read by a person.
  it("tells the model it writes nothing", () => {
    expect(SKILL_MERGE_TOOL_DEFINITION.description).toContain("WRITES NOTHING");
  });

  // The pair is the closest two in the library, which on a small library is the
  // closest two of three. A model asked to merge will merge unless told.
  it("tells the model that declining is the ordinary answer", () => {
    expect(SKILL_MERGE_TOOL_DEFINITION.description).toContain("call no tool at all");
  });

  // A merged body carrying only the differences leaves a playbook with its
  // middle removed, and a person applying it would not necessarily notice.
  it("tells the model the body replaces the kept skill outright", () => {
    expect(published().properties["body"]?.maxLength).toBe(SKILL_BODY_MAX_CHARS);
    expect(SKILL_MERGE_TOOL_DEFINITION.inputSchema).toMatchObject({
      properties: { body: { description: expect.stringContaining("BOTH") } }
    });
  });

  // The header's rule, asserted rather than trusted: this operation has no path,
  // no filename and no channel, so the only thing it can carry is three strings.
  it("gives the model no way to name a file, a channel, or a deletion", () => {
    const keys = Object.keys(published().properties);
    expect(keys.sort()).toEqual(["body", "description", "keep"]);
    for (const forbidden of ["path", "file", "channel", "root", "directory", "delete", "drop"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("mirrors the parser's bounds and its strictness", () => {
    const schema = published();
    expect(schema.properties["description"]?.maxLength).toBe(SKILL_DESCRIPTION_MAX_CHARS);
    expect(schema.required.sort()).toEqual(["body", "description", "keep"]);
    expect(schema.additionalProperties).toBe(false);
  });

  // The decision this file exists to keep: a third member of `SkillToolName`
  // would hand the *author* turn a tool that writes nothing and names a pair it
  // was never given, because `skillToolDefinitions()` maps over that enum.
  it("is not one of the author turn's operations", () => {
    expect([...SkillToolName.options]).toEqual(["skill_create", "skill_revise"]);
    expect(SkillToolName.options).not.toContain(SKILL_MERGE_TOOL);
  });
});

describe("what a merge call may carry", () => {
  it("accepts a well-formed draft", () => {
    expect(SkillMergeArguments.safeParse(ARGS).success).toBe(true);
  });

  it.each([
    ["a description at the cap", { description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS) }, true],
    ["a description over it", { description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) }, false],
    ["a body at the cap", { body: "b".repeat(SKILL_BODY_MAX_CHARS) }, true],
    ["a body over it", { body: "b".repeat(SKILL_BODY_MAX_CHARS + 1) }, false],
    ["an empty description", { description: "" }, false],
    ["an empty body", { body: "" }, false]
  ])("%s", (_label, over, ok) => {
    expect(SkillMergeArguments.safeParse(args(over)).success).toBe(ok);
  });

  it("refuses an unknown key rather than stripping it", () => {
    expect(SkillMergeArguments.safeParse(args({ channel: "C0OTHER" })).success).toBe(false);
  });
});

describe("parsing a merge call", () => {
  it("answers the draft, deriving the one to drop", () => {
    expect(parseSkillMerge(SKILL_MERGE_TOOL, ARGS, PAIR)).toEqual({
      ok: true,
      draft: {
        keep: "deploy-runbook",
        drop: "deploy-rollback",
        description: ARGS.description,
        body: ARGS.body
      }
    });
  });

  it("derives the other one whichever of the two was kept", () => {
    const parsed = parseSkillMerge(SKILL_MERGE_TOOL, args({ keep: "deploy-rollback" }), PAIR);
    expect(parsed).toMatchObject({ ok: true, draft: { drop: "deploy-runbook" } });
  });

  it("refuses a tool it does not offer", () => {
    expect(parseSkillMerge("skill_create", ARGS, PAIR)).toEqual({
      ok: false,
      reason: "unknown_tool"
    });
  });

  it.each([
    ["a missing field", { body: undefined }, "malformed_arguments"],
    ["a wrong type", { body: 42 }, "malformed_arguments"],
    ["an unknown key", { channel: "C0OTHER" }, "malformed_arguments"],
    ["an oversize description", { description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) }, "description_too_long"],
    ["an oversize body", { body: "b".repeat(SKILL_BODY_MAX_CHARS + 1) }, "body_too_long"]
  ])("names %s", (_label, over, reason) => {
    expect(parseSkillMerge(SKILL_MERGE_TOOL, args(over), PAIR)).toEqual({ ok: false, reason });
  });

  // The choice this operation is allowed to make, and the only one.
  it("refuses a name that is neither of the two", () => {
    expect(parseSkillMerge(SKILL_MERGE_TOOL, args({ keep: "something-else" }), PAIR)).toEqual({
      ok: false,
      reason: "keep_not_nominated"
    });
  });

  // `skill-op.ts`'s rule, inherited: anything wrong with the name field reports
  // as the name, because it is the most specific fix available and the one a
  // model is least likely to guess.
  it("reports an absent name as a bad name", () => {
    expect(parseSkillMerge(SKILL_MERGE_TOOL, args({ keep: undefined }), PAIR)).toEqual({
      ok: false,
      reason: "name_invalid"
    });
  });

  // Gate order: "that is not a name" is the more specific and more actionable of
  // the two true statements, and it is also what keeps the alphabet check ahead
  // of everything downstream.
  it.each([
    ["a traversal", "../../etc/passwd"],
    ["a separator", "deploy/runbook"],
    ["an absolute path", "/etc/shadow"],
    ["a capital", "Deploy-Runbook"]
  ])("reports %s as a bad name rather than a bad choice", (_label, keep) => {
    expect(parseSkillMerge(SKILL_MERGE_TOOL, args({ keep }), PAIR)).toEqual({
      ok: false,
      reason: "name_invalid"
    });
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [null, undefined, 42, "text", [], { keep: {} }]) {
      expect(() => parseSkillMerge(SKILL_MERGE_TOOL, value, PAIR)).not.toThrow();
    }
  });

  it("answers only reasons the vocabulary declares", () => {
    const parsed = parseSkillMerge(SKILL_MERGE_TOOL, args({ keep: "something-else" }), PAIR);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(SkillMergeFailure.safeParse(parsed.reason).success).toBe(true);
  });
});
