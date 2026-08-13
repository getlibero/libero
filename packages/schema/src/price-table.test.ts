import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ModelId } from "./names.js";
import { parsePriceTable } from "./parse-price-table.js";
import {
  LEGACY_MODEL,
  MAX_PRICE_MICRO_USD,
  type ModelPrice,
  PriceTable,
  UNREPORTED_MODEL,
  costMicroUsd,
  priceFor,
  usdToMicroUsd
} from "./price-table.js";

const sonnet: ModelPrice = {
  id: "claude-sonnet-4-6",
  input: 3_000_000,
  output: 15_000_000,
  cache_write: 3_750_000,
  cache_read: 300_000
};

const ONE_MILLION_OF_EACH = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000
};

const table = (...entries: ModelPrice[]): PriceTable => {
  const parsed = PriceTable.safeParse({ model: entries });
  if (!parsed.success) throw new Error("fixture does not parse");
  return parsed.data;
};

// The alphabet is load-bearing twice over: it has to admit what providers
// actually echo, and it has to exclude the two values the meter writes itself.
// Both halves are asserted here rather than in names.test.ts, because it is this
// module that depends on them.
describe("a model id", () => {
  it("accepts the ids real providers echo back", () => {
    const real = [
      "claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "models/gemini-2.5-pro",
      "qwen2.5:7b",
      "gpt-4o-2024-08-06"
    ];
    for (const id of real) expect(ModelId.safeParse(id).success).toBe(true);
  });

  // The reservation is structural rather than a check somewhere: a table cannot
  // spell an entry for either sentinel, so nothing can override the zero the
  // migration depends on or price the bucket that must fail closed.
  it("cannot spell either of the meter's sentinels", () => {
    for (const reserved of [LEGACY_MODEL, UNREPORTED_MODEL]) {
      expect(ModelId.safeParse(reserved).success).toBe(false);
    }
  });

  it("rejects a leading separator, whitespace, and anything unbounded", () => {
    for (const id of ["", "/leading", ".hidden", "-lead", "a b", "a\nb", "x".repeat(129)]) {
      expect(ModelId.safeParse(id).success).toBe(false);
    }
  });
});

describe("the price table", () => {
  it("parses the documented example", () => {
    const path = new URL("../../../prices/example/prices.toml", import.meta.url);

    const result = parsePriceTable(readFileSync(path, "utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.model.map(entry => entry.id)).toContain("claude-sonnet-4-6");
    // The zero-priced entry is in the example on purpose: it is how an operator
    // says a self-hosted model is free, which is a different statement from
    // leaving it out.
    expect(priceFor(result.table, "qwen2.5:7b")?.output).toBe(0);
  });

  it("defaults to no models rather than failing on an empty file", () => {
    const parsed = PriceTable.safeParse({});
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.model).toEqual([]);
  });

  // Two prices for one model is a file that says two things about one number,
  // and no resolution rule would make it mean what its author intended. This is
  // where it departs from the team sheet, whose duplicate entries are a grouping
  // idiom resolved most-restrictively.
  it("rejects a duplicate model id", () => {
    expect(PriceTable.safeParse({ model: [sonnet, sonnet] }).success).toBe(false);
  });

  it("rejects a fractional price, a negative one, and one past the ceiling", () => {
    for (const input of [0.5, -1, MAX_PRICE_MICRO_USD + 1]) {
      expect(PriceTable.safeParse({ model: [{ ...sonnet, input }] }).success).toBe(false);
    }
  });

  it("requires all four tiers", () => {
    for (const tier of ["input", "output", "cache_write", "cache_read"]) {
      const missing: Record<string, unknown> = { ...sonnet };
      delete missing[tier];
      expect(PriceTable.safeParse({ model: [missing] }).success).toBe(false);
    }
  });
});

describe("looking a price up", () => {
  const prices = table(sonnet);

  it("answers undefined for a model the table has never heard of", () => {
    expect(priceFor(prices, "claude-opus-4-6")).toBeUndefined();
  });

  // The fail-closed signal and an operator's zero must not be spelled the same
  // way, or "this costs nothing" and "this cannot be priced" collapse into one
  // answer and the cap silently stops working.
  it("tells a zero price apart from an absent one", () => {
    const free = table({ ...sonnet, id: "local-model", input: 0, output: 0, cache_write: 0, cache_read: 0 });
    expect(priceFor(free, "local-model")).toBeDefined();
    expect(priceFor(free, "local-model")?.input).toBe(0);
    expect(priceFor(free, "absent")).toBeUndefined();
  });

  // Answered by the module rather than branched on at the decision, so
  // enforcement stays a plain sum with one `undefined` to handle.
  it("prices the legacy bucket at zero without the table saying so", () => {
    const legacy = priceFor(prices, LEGACY_MODEL);
    expect(legacy).toBeDefined();
    if (legacy === undefined) return;
    expect(costMicroUsd(legacy, ONE_MILLION_OF_EACH)).toBe(0n);
  });

  // The other sentinel is the opposite answer, and this is the pair that makes
  // the two-sentinel design do anything.
  it("cannot price the unreported bucket at all", () => {
    expect(priceFor(prices, UNREPORTED_MODEL)).toBeUndefined();
  });

  it("finds nothing on Object.prototype", () => {
    expect(priceFor(prices, "constructor")).toBeUndefined();
    expect(priceFor(prices, "toString")).toBeUndefined();
  });
});

describe("what a bucket costs", () => {
  it("prices a million of each tier at that tier's own rate", () => {
    // 3.00 + 15.00 + 0.30 + 3.75 = 22.05 USD, in micro-USD.
    expect(costMicroUsd(sonnet, ONE_MILLION_OF_EACH)).toBe(22_050_000n);
  });

  // The whole reason the meter keeps four counts apart. Collapsing the tiers
  // would price these identically, and they differ by an order of magnitude.
  it("does not price a cache read as an input token", () => {
    const cached = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
    const plain = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costMicroUsd(sonnet, cached)).toBe(300_000n);
    expect(costMicroUsd(sonnet, plain)).toBe(3_000_000n);
  });

  // The reason this path is BigInt. A count times a price at the table's ceiling
  // passes 2^53, and float64 would answer a number that is merely nearby — a cap
  // whose exactness depends on how large the day got.
  it("stays exact past what a float64 can hold", () => {
    const dear: ModelPrice = { ...sonnet, input: MAX_PRICE_MICRO_USD };
    const tokens = { inputTokens: 50_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    // Fifty thousand dollars, which is not the interesting part. The product
    // before the divide is 5e16, and that is: it is past 2^53, so a float64
    // would answer a number that is merely nearby.
    expect(costMicroUsd(dear, tokens)).toBe(50_000_000_000n);
    expect(50_000_000 * MAX_PRICE_MICRO_USD).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  // Summed then divided once, so the truncation is a single micro-USD for the
  // whole evaluation rather than one per tier.
  it("truncates once, below any figure an operator wrote", () => {
    const tokens = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 };
    expect(costMicroUsd(sonnet, tokens)).toBe(22n);
  });

  it("costs nothing when nothing was spent", () => {
    const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costMicroUsd(sonnet, none)).toBe(0n);
  });
});

describe("a sheet's daily_usd in micro-units", () => {
  it("converts the figures an operator writes", () => {
    expect(usdToMicroUsd(25)).toBe(25_000_000n);
    expect(usdToMicroUsd(25.0)).toBe(25_000_000n);
    expect(usdToMicroUsd(0.05)).toBe(50_000n);
  });

  // The one float in the path, rounded where it is authored rather than carried
  // forward. `0.07 * 1e6` is 70000.00000000001 in float64.
  it("rounds the authored number rather than accumulating its error", () => {
    expect(usdToMicroUsd(0.07)).toBe(70_000n);
    expect(usdToMicroUsd(1.1)).toBe(1_100_000n);
  });
});
