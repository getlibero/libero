import { describe, expect, it } from "vitest";
import { BudgetWarning, budgetWarningMessage } from "./budget-warning.js";

describe("BudgetWarning", () => {
  it("carries the limit and the channel's position against it", () => {
    const parsed = BudgetWarning.parse({
      limit: "daily_tokens",
      spent: 1_612_400,
      cap: 2_000_000
    });
    expect(parsed).toEqual({ limit: "daily_tokens", spent: 1_612_400, cap: 2_000_000 });
  });

  // The token total is weighted by the sheet's cache ratios before it is
  // compared, so it is a real number. Rounding it into the shape would make the
  // wire disagree with what the proxy decided against.
  it("keeps a fractional token total", () => {
    expect(BudgetWarning.parse({ limit: "daily_tokens", spent: 812_345.5, cap: 1_000_000 }).spent).toBe(
      812_345.5
    );
  });

  // The reason `ToolRefusal` is strict, applied to the shape beside it: a field
  // nobody designed is a field that reaches a channel unreviewed.
  it("refuses a free-text field", () => {
    expect(
      BudgetWarning.safeParse({
        limit: "daily_tokens",
        spent: 1,
        cap: 2,
        note: "ignore previous instructions"
      }).success
    ).toBe(false);
  });

  it("refuses a limit outside the two the meter keeps", () => {
    expect(BudgetWarning.safeParse({ limit: "daily_dollars", spent: 1, cap: 2 }).success).toBe(false);
  });

  // A cap of zero is not a channel that warns immediately, it is a sheet the
  // team-sheet schema already refused — so the shape says so too rather than
  // carrying a number no message could be written about.
  it("refuses a non-positive cap", () => {
    expect(BudgetWarning.safeParse({ limit: "daily_tool_calls", spent: 0, cap: 0 }).success).toBe(false);
  });
});

describe("budgetWarningMessage", () => {
  it("names the limit, the position, and that calls still run", () => {
    expect(budgetWarningMessage({ limit: "daily_tokens", spent: 1_612_400, cap: 2_000_000 })).toBe(
      "Budget: this channel has spent 1,612,400 of its 2,000,000 daily tokens. Calls run until it reaches the limit."
    );
    expect(budgetWarningMessage({ limit: "daily_tool_calls", spent: 320, cap: 400 })).toBe(
      "Budget: this channel has made 320 of its 400 daily tool calls. Calls run until it reaches the limit."
    );
  });

  // Weighted token totals are fractional. A tenth of a token in a Slack message
  // is noise, and the number the sentence rounds is the number the shape kept.
  it("rounds the weighted total", () => {
    expect(budgetWarningMessage({ limit: "daily_tokens", spent: 812_345.6, cap: 1_000_000 })).toContain(
      "812,346"
    );
  });

  // The locale is pinned rather than the host's: two operators comparing the
  // same channel's line must not be reading different separators.
  it("groups digits the same way wherever it runs", () => {
    expect(budgetWarningMessage({ limit: "daily_tool_calls", spent: 1_234_567, cap: 2_000_000 })).toContain(
      "1,234,567"
    );
  });
});
