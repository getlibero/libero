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
