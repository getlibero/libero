import { describe, expect, it } from "vitest";
import {
  MAX_REPORTED_TOKENS,
  SpendReport,
  SpendReportResponse,
  TurnId
} from "./spend-report.js";

const wire = {
  turn: "task_01.turn_3",
  usage: { inputTokens: 120, outputTokens: 8, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 }
};

describe("the token report", () => {
  it("parses what the agent sends", () => {
    expect(SpendReport.parse(wire)).toEqual(wire);
  });

  // Not reported means not spent, and a meter column cannot hold undefined.
  // The agent side keeps these optional, because there the distinction between
  // "the provider said nothing" and "the provider said zero" is worth keeping.
  it("defaults the cache counts to zero", () => {
    const report = SpendReport.parse({ turn: "t1", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(report.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    });
  });

  // The one that matters, and the same rule ToolCall makes. The channel comes
  // from the client certificate; the day is the proxy's own clock. A body
  // asserting either must fail loudly rather than have the field dropped.
  it("rejects a body that asserts a channel or a day", () => {
    expect(SpendReport.safeParse({ ...wire, channel: "C123" }).success).toBe(false);
    expect(SpendReport.safeParse({ ...wire, day: "2026-08-04" }).success).toBe(false);
  });

  // Four counts, not a total: the proxy decides what a cached token is worth,
  // from the channel's team sheet. A total would move that into the agent.
  it("rejects a pre-totalled report", () => {
    expect(SpendReport.safeParse({ turn: "t1", usage: { totalTokens: 248 } }).success).toBe(false);
    expect(SpendReport.safeParse({ ...wire, tokens: 248 }).success).toBe(false);
  });

  it("rejects any unknown field, inside the usage block as well as outside it", () => {
    expect(SpendReport.safeParse({ ...wire, authorization: "Bearer sk-live-abc" }).success).toBe(false);
    expect(
      SpendReport.safeParse({ ...wire, usage: { ...wire.usage, reasoningTokens: 4 } }).success
    ).toBe(false);
  });

  it("requires the turn id and the two counts every provider reports", () => {
    expect(SpendReport.safeParse({ usage: wire.usage }).success).toBe(false);
    expect(SpendReport.safeParse({ turn: "t1", usage: { inputTokens: 5 } }).success).toBe(false);
    expect(SpendReport.safeParse({ turn: "t1", usage: { outputTokens: 5 } }).success).toBe(false);
  });

  it("rejects a count that is negative, fractional, or past the ceiling", () => {
    for (const inputTokens of [-1, 1.5, MAX_REPORTED_TOKENS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(SpendReport.safeParse({ turn: "t1", usage: { inputTokens, outputTokens: 0 } }).success).toBe(
        false
      );
    }
  });

  it("accepts a count at the ceiling", () => {
    const at = { turn: "t1", usage: { inputTokens: MAX_REPORTED_TOKENS, outputTokens: 0 } };
    expect(SpendReport.safeParse(at).success).toBe(true);
  });
});

// Which model spent them (#62). A sibling of `usage` rather than a field inside
// it, because that block promises a field-for-field correspondence with the
// agent's own `TokenUsage` and a model id is not one of the counts.
describe("the model that served the turn", () => {
  it("carries the id the provider echoed back", () => {
    const report = SpendReport.parse({ ...wire, model: "claude-sonnet-4-6" });
    expect(report.model).toBe("claude-sonnet-4-6");
  });

  // Optional, and it has to stay that way. A required field would make every
  // report from a provider that echoes nothing a 400 — which loses the counts
  // and fails *open* on `daily_tokens`, the limit that catches a runaway loop.
  // What an absent model costs a channel is the proxy's answer, not the wire's:
  // the tokens land in a bucket no price table can name.
  it("parses a report that names no model", () => {
    const report = SpendReport.parse(wire);
    expect(report.model).toBeUndefined();
  });

  it("stays outside the usage block, where an unknown field is still refused", () => {
    expect(
      SpendReport.safeParse({ ...wire, usage: { ...wire.usage, model: "claude-sonnet-4-6" } }).success
    ).toBe(false);
  });

  // The meter writes two model ids of its own and neither can arrive on the
  // wire, which is what makes the reservation structural rather than a check.
  it("refuses the two ids the meter reserves for itself", () => {
    for (const reserved of ["(legacy)", "(unreported)"]) {
      expect(SpendReport.safeParse({ ...wire, model: reserved }).success).toBe(false);
    }
  });

  it("refuses a model id that is empty, unbounded, or carries whitespace", () => {
    for (const model of ["", "x".repeat(129), "claude sonnet", "/leading"]) {
      expect(SpendReport.safeParse({ ...wire, model }).success).toBe(false);
    }
  });
});

describe("the turn id", () => {
  // The whole idempotency story rests on this value, and it lands in a SQLite
  // key and in log lines, so it is bounded like every other name that crosses.
  it("rejects anything that is not a short identifier", () => {
    for (const turn of ["", "has space", "a/b", ".hidden", "-leading", "x".repeat(129)]) {
      expect(TurnId.safeParse(turn).success).toBe(false);
    }
  });

  it("accepts the shapes an agent would generate", () => {
    for (const turn of ["t1", "task_01.turn_3", "01JBQ7F8-ZK9", "5f2c1e9a4b"]) {
      expect(TurnId.safeParse(turn).success).toBe(true);
    }
  });
});

describe("the meter's answer to a report", () => {
  // A duplicate is a success, not a refusal: it means the turn was already
  // counted, which is the right answer to a retry. Nothing was denied.
  it("parses both outcomes", () => {
    expect(SpendReportResponse.parse({ outcome: "recorded" })).toEqual({ outcome: "recorded" });
    expect(SpendReportResponse.parse({ outcome: "duplicate" })).toEqual({ outcome: "duplicate" });
  });

  // Nothing about the channel's remaining budget comes back. The report route
  // makes no enforcement decision, so it has no verdict to relay — and a
  // remaining-budget field is how one would arrive.
  it("carries no counters and no verdict", () => {
    for (const extra of [{ remaining: 900 }, { tokens: 248 }, { exhausted: false }]) {
      expect(SpendReportResponse.safeParse({ outcome: "recorded", ...extra }).success).toBe(false);
    }
  });
});
