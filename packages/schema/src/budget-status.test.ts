import { describe, expect, it } from "vitest";
import { BudgetStatus } from "./budget-status.js";

describe("BudgetStatus", () => {
  it("parses a channel that may spend", () => {
    expect(BudgetStatus.parse({ spendable: true })).toEqual({ spendable: true });
  });

  it("parses a channel that may not, with the reason the tool gate would give", () => {
    const refused = {
      spendable: false,
      refusal: { reason: "budget_exhausted", limit: "daily_tokens" }
    };

    expect(BudgetStatus.parse(refused)).toEqual(refused);
  });

  it("carries the pricing faults, which are why the answer is not a boolean", () => {
    // A channel that cannot be priced is blocked for a reason an operator fixes
    // in the price table, not by raising a cap. Collapsing this to `false` would
    // send them to the wrong file.
    for (const refusal of [
      { reason: "model_not_priced", model: "some-vendor/some-model" },
      { reason: "model_unreported" }
    ]) {
      expect(BudgetStatus.parse({ spendable: false, refusal })).toEqual({
        spendable: false,
        refusal
      });
    }
  });

  it("carries the two sheet reasons", () => {
    for (const reason of ["no_team_sheet", "team_sheet_unreadable"]) {
      expect(BudgetStatus.parse({ spendable: false, refusal: { reason } })).toEqual({
        spendable: false,
        refusal: { reason }
      });
    }
  });

  it("refuses a spendable channel that also carries a reason", () => {
    // The union is what keeps "allowed" and "why not" from being present at
    // once. A nullable field would have made this shape representable.
    expect(
      BudgetStatus.safeParse({
        spendable: true,
        refusal: { reason: "budget_exhausted", limit: "daily_tokens" }
      }).success
    ).toBe(false);
  });

  it("refuses a refusal with no reason, and a reason that is not one", () => {
    expect(BudgetStatus.safeParse({ spendable: false }).success).toBe(false);
    expect(
      BudgetStatus.safeParse({ spendable: false, refusal: { reason: "too_expensive" } }).success
    ).toBe(false);
  });

  it("carries no counters, and a body asserting one fails", () => {
    // The figures are deliberately absent — see the header on who this is
    // addressed to. `.strict()` is what keeps a later "just add spent" from
    // being a silent widening.
    for (const extra of [{ spent: 900 }, { cap: 1_000 }, { remaining: 100 }]) {
      expect(BudgetStatus.safeParse({ spendable: true, ...extra }).success).toBe(false);
    }
  });

  it("refuses a status with no verdict at all", () => {
    expect(BudgetStatus.safeParse({}).success).toBe(false);
    expect(BudgetStatus.safeParse({ spendable: "yes" }).success).toBe(false);
  });
});
