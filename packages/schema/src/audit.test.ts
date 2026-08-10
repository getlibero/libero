import { describe, expect, it } from "vitest";
import { AuditOutcome } from "./audit.js";
import { ToolCallResponse } from "./tool-call.js";

describe("AuditOutcome", () => {
  it("accepts exactly the things that can happen to a call", () => {
    for (const outcome of [
      "ran",
      "held",
      "refused",
      "unavailable",
      "unanswered",
      "approved",
      "denied",
      "expired"
    ]) {
      expect(AuditOutcome.parse(outcome)).toBe(outcome);
    }
    expect(AuditOutcome.options).toHaveLength(8);
  });

  it("rejects anything else, including the tool's own error flag", () => {
    for (const nope of ["error", "failed", "ok", "RAN", ""]) {
      expect(AuditOutcome.safeParse(nope).success).toBe(false);
    }
  });

  // The property that keeps a log line, the answer the agent got, and the row
  // saying the same word — for the outcomes a tool call can be answered with.
  // The rest are named here rather than counted, so adding one is a decision
  // about what it is: `unavailable` is a 501 rather than a served refusal,
  // `unanswered` is a call the proxy decided and then failed to answer at all,
  // and the last three are a human's decision about a call rather than a call.
  it("covers ToolCallResponse's discriminator, and names what it does not", () => {
    const served: string[] = ToolCallResponse.options.map(option => option.shape.outcome.value);

    expect(served.every(outcome => AuditOutcome.safeParse(outcome).success)).toBe(true);
    expect(AuditOutcome.options.filter(outcome => !served.includes(outcome))).toEqual([
      "unavailable",
      "unanswered",
      "approved",
      "denied",
      "expired"
    ]);
  });
});
