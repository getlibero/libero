import { describe, expect, it } from "vitest";
import { AuditOutcome } from "./audit.js";
import { ToolCallResponse } from "./tool-call.js";

describe("AuditOutcome", () => {
  it("accepts exactly the four things that can happen to a call", () => {
    for (const outcome of ["ran", "held", "refused", "unavailable"]) {
      expect(AuditOutcome.parse(outcome)).toBe(outcome);
    }
    expect(AuditOutcome.options).toHaveLength(4);
  });

  it("rejects anything else, including the tool's own error flag", () => {
    for (const nope of ["error", "failed", "ok", "RAN", ""]) {
      expect(AuditOutcome.safeParse(nope).success).toBe(false);
    }
  });

  // The property that keeps a log line, the answer the agent got, and the row
  // saying the same word. `unavailable` is deliberately the one that has no
  // response variant: it is a 501, not a served refusal.
  it("covers ToolCallResponse's discriminator, plus unavailable", () => {
    const served: string[] = ToolCallResponse.options.map(option => option.shape.outcome.value);

    expect(served.every(outcome => AuditOutcome.safeParse(outcome).success)).toBe(true);
    expect(AuditOutcome.options.filter(outcome => !served.includes(outcome))).toEqual(["unavailable"]);
  });
});
