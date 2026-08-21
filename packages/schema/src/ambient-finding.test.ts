import { describe, it } from "node:test";
import { expect } from "expect";
import {
  AMBIENT_FINDING_MAX_CHARS,
  AMBIENT_FINDING_TOOL,
  AMBIENT_FINDING_TOOL_DEFINITION,
  parseAmbientFinding
} from "./ambient-finding.js";

describe("parseAmbientFinding", () => {
  it("reads a well-formed finding", () => {
    expect(parseAmbientFinding(AMBIENT_FINDING_TOOL, { text: "Two questions have sat." })).toEqual({
      ok: true,
      finding: { text: "Two questions have sat." }
    });
  });

  it("refuses a tool it does not recognize, before looking at the arguments", () => {
    // The order is the contract: an invented tool name is reported as one even
    // when its arguments would also have failed.
    expect(parseAmbientFinding("post_to_slack", { nonsense: true })).toEqual({
      ok: false,
      reason: "unknown_tool"
    });
  });

  it("tells an over-long finding from a malformed one", () => {
    expect(
      parseAmbientFinding(AMBIENT_FINDING_TOOL, { text: "x".repeat(AMBIENT_FINDING_MAX_CHARS + 1) })
    ).toEqual({ ok: false, reason: "text_too_long" });

    for (const args of [{}, { text: "" }, { text: 42 }, null, "post it"]) {
      expect(parseAmbientFinding(AMBIENT_FINDING_TOOL, args)).toEqual({
        ok: false,
        reason: "malformed_arguments"
      });
    }
  });

  it("refuses an unknown key rather than stripping it", () => {
    // `.strict()`. This turn reads a channel's own messages, so an extra field
    // is something somebody in that channel talked the model into trying.
    expect(
      parseAmbientFinding(AMBIENT_FINDING_TOOL, { text: "hello", channel: "C0OTHER" })
    ).toEqual({ ok: false, reason: "malformed_arguments" });
  });

  it("accepts a finding exactly at the cap", () => {
    const text = "x".repeat(AMBIENT_FINDING_MAX_CHARS);

    expect(parseAmbientFinding(AMBIENT_FINDING_TOOL, { text })).toEqual({
      ok: true,
      finding: { text }
    });
  });

  it("never throws, whatever it is given", () => {
    for (const args of [undefined, [], Symbol.iterator, () => undefined]) {
      expect(() => parseAmbientFinding(AMBIENT_FINDING_TOOL, args)).not.toThrow();
    }
  });
});

describe("the tool the heartbeat is offered", () => {
  it("is one tool, and it is the one the parser accepts", () => {
    expect(AMBIENT_FINDING_TOOL_DEFINITION.name).toBe(AMBIENT_FINDING_TOOL);
  });

  // The three clauses the header calls load-bearing. A model would assume each
  // of them the other way, and none of them is enforced by anything else — the
  // rate limit is real but arrives as a refusal the model never sees.
  it("says that posting interrupts people, that silence is expected, and that it is rate limited", () => {
    const said = AMBIENT_FINDING_TOOL_DEFINITION.description.toLowerCase();

    expect(said).toContain("unprompted");
    expect(said).toContain("call no tool");
    expect(said).toContain("not a failure");
    expect(said).toMatch(/at most one/);
  });

  it("bounds the text it advertises at the same figure the parser enforces", () => {
    // Two spellings of one contract. A model told a larger number than the
    // parser accepts would be told to write findings that are then thrown away.
    expect(AMBIENT_FINDING_TOOL_DEFINITION.inputSchema.properties.text.maxLength).toBe(
      AMBIENT_FINDING_MAX_CHARS
    );
  });
});
