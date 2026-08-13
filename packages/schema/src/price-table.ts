import { z } from "zod";
import { ModelId } from "./names.js";

/**
 * What a model's tokens cost, as the operator writes it down (#62).
 *
 * The proxy's budget meter stores raw token counts keyed by the model that spent
 * them, and this is the table it joins them against to answer
 * `budget.daily_usd`. Cost is never accumulated: it is computed fresh from the
 * counts on every decision, which is the property `cache_read_weight` already
 * has — correcting a mistyped price re-prices spend already recorded today, on
 * the channel's next call, rather than only what comes after the edit. A price
 * table is operator-authored config and will eventually contain a typo; under a
 * stored total the only remedy would be `budget reset`, which also discards the
 * spend that was right.
 *
 * **The table lives here rather than in the proxy** for `parseTeamSheet`'s
 * reason: it is TOML *and* a shape, it is keyed by `ModelId` — which is already
 * on the wire in `SpendReport` — and defining it beside the process that reads
 * it would make "is this a valid model id" two answers that can disagree.
 *
 * **There is no shipped default table.** A price list baked into a released
 * image goes stale on the provider's schedule and is then trusted, which is the
 * failure this issue exists to fix. A deployment that caps no channel in dollars
 * needs no file at all; one that does, writes it and reviews it as it reviews a
 * team sheet.
 */

/**
 * The two model ids the meter writes itself, which no provider can produce.
 *
 * Both begin with a parenthesis, and `ModelId`'s alphabet has none — so the
 * reservation holds at parse rather than by convention, the way
 * `BUILTIN_SERVER`'s does. They look alike and behave oppositely, which is why
 * there are two of them rather than one "unknown".
 *
 * `LEGACY_MODEL` is written once, by the migration that gave the meter its model
 * dimension, over counts recorded before the dimension existed. It is **priced
 * at zero** and counted in full against `daily_tokens`: `daily_usd` did not
 * exist when those tokens were spent, so no sheet asked for them to be capped,
 * and charging them would refuse a channel on the first day after an upgrade for
 * spend its operator never opted into. It can only appear on rows dated on or
 * before the migration, so it ages out with one UTC day.
 *
 * `UNREPORTED_MODEL` is written by the running meter whenever a spend report
 * names no model — an agent older than the field, a provider that echoes
 * nothing, an adapter that dropped it. It is **deliberately unpriced**, so a
 * channel capped in dollars is refused rather than metered at zero. The remedies
 * are completely different from the other kind of unpriced model ("upgrade or
 * diagnose the agent" against "add a price"), which is the whole reason the two
 * are not one value.
 */
export const LEGACY_MODEL = "(legacy)";
export const UNREPORTED_MODEL = "(unreported)";

/**
 * The ceiling on any one price, in micro-USD per million tokens.
 *
 * A thousand dollars per million tokens — far above anything billed, and here to
 * bound the arithmetic rather than to judge the number. A price this large is
 * almost certainly a units mistake, and one that fails at load is better than
 * one that refuses a channel at breakfast.
 */
export const MAX_PRICE_MICRO_USD = 1_000_000_000;

const price = (): z.ZodNumber => z.number().int().nonnegative().max(MAX_PRICE_MICRO_USD);

/**
 * One model's four tiers.
 *
 * **Four, not one.** Cache reads run about a tenth of input price and cache
 * writes above it, so a table that collapsed the tiers would be wrong by an
 * order of magnitude on a cache-heavy agent, which is every agent here. The
 * meter keeps the four counts apart all the way to the decision precisely so
 * this can.
 *
 * **Micro-USD per million tokens, as integers.** Money is not a float: a budget
 * that accumulates `0.000003` per token drifts, and the drift is invisible until
 * an operator disputes a refusal. Per *million* rather than per token because a
 * per-token price in micro-USD would be zero for every model on the market, and
 * a table whose entries are all `0` is a table nobody can review. So Anthropic's
 * three dollars per million input tokens is `input = 3_000_000`.
 *
 * `0` is legal and means free — a self-hosted model with a real dollar cost of
 * nothing, priced honestly rather than left out. Leaving it out is the different
 * statement that its spend cannot be capped.
 */
export const ModelPrice = z
  .object({
    id: ModelId,
    input: price(),
    output: price(),
    cache_write: price(),
    cache_read: price()
  })
  .strict();

/**
 * The file.
 *
 * **A duplicate id is rejected**, which is where this departs from the team
 * sheet's handling of duplicate entries. There, two blocks naming one tool are
 * how a sheet groups by approval and the most restrictive wins; here, two prices
 * for one model is a file that says two things about one number and no
 * resolution rule would make it mean what its author intended. Loud at load is
 * the answer, as it is for a sheet whose blocks disagree about an upstream.
 *
 * The reserved ids are rejected for the same reason they are reserved: a table
 * that priced `(legacy)` would override the zero the meter depends on, and one
 * that priced `(unreported)` would turn the fail-closed case into a silent
 * meter-at-whatever-was-written. `ModelId` already refuses them, so this is the
 * type system's answer rather than a check — the entry cannot be spelled.
 */
export const PriceTable = z
  .object({
    model: z.array(ModelPrice).default([])
  })
  .strict()
  .refine(
    table => new Set(table.model.map(entry => entry.id)).size === table.model.length,
    { error: "a model id appears more than once", path: ["model"] }
  );

export type ModelPrice = z.infer<typeof ModelPrice>;
export type PriceTable = z.infer<typeof PriceTable>;

/** The four raw counts a price is applied to. Structurally the meter's bucket. */
export interface PricedTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Micro-USD in one US dollar, and tokens in one unit of a table's prices. */
export const MICRO_USD_PER_USD = 1_000_000n;
const TOKENS_PER_PRICE_UNIT = 1_000_000n;

/** Everything at this model's price is free. See `LEGACY_MODEL`. */
const FREE: ModelPrice = { id: LEGACY_MODEL, input: 0, output: 0, cache_write: 0, cache_read: 0 };

/**
 * This model's price, or `undefined` when the table cannot answer.
 *
 * `undefined` is the fail-closed signal and the only one: a caller enforcing
 * `daily_usd` refuses on it rather than treating an unknown model as free. The
 * two answers are deliberately not spelled the same way — a model priced at zero
 * is an operator's statement, and a model the table has never heard of is the
 * absence of one.
 *
 * `LEGACY_MODEL` is answered here rather than branched on at the decision, so
 * enforcement stays a plain sum over buckets with one `undefined` to handle.
 */
export function priceFor(table: PriceTable, model: string): ModelPrice | undefined {
  if (model === LEGACY_MODEL) return FREE;
  // Scanning rather than indexing a lookup object, for `serversNamed`'s reason
  // in the proxy: a model literally named `constructor` must not find something
  // on `Object.prototype`. Tables are a few dozen entries against an HTTP call.
  return table.model.find(entry => entry.id === model);
}

/**
 * What these counts cost at this price, in micro-USD.
 *
 * **BigInt, and not as a flourish.** A count times a price at the table's
 * ceiling passes 2^53 above about nine million tokens, which a day with a raised
 * `daily_tokens` reaches — and a cap whose exactness depends on how large the
 * day got is precisely the kind of "true until it isn't" this codebase refuses.
 * Four multiplies per model against an HTTP call costs nothing worth measuring.
 *
 * The four products are summed and divided **once**, so the truncation is a
 * single micro-USD across the whole evaluation rather than one per tier. It
 * truncates rather than rounding up: a millionth of a cent is below any figure
 * an operator wrote, and rounding it away from the channel would be inventing a
 * fraction of a cent to charge for.
 */
export function costMicroUsd(price: ModelPrice, tokens: PricedTokens): bigint {
  const total =
    BigInt(tokens.inputTokens) * BigInt(price.input) +
    BigInt(tokens.outputTokens) * BigInt(price.output) +
    BigInt(tokens.cacheReadTokens) * BigInt(price.cache_read) +
    BigInt(tokens.cacheWriteTokens) * BigInt(price.cache_write);
  return total / TOKENS_PER_PRICE_UNIT;
}

/**
 * A team sheet's `daily_usd` as micro-USD.
 *
 * The one float in the cost path, converted once at the boundary. It is an
 * authored number rather than an accumulation, so rounding it is rounding what
 * the operator typed — `25.00` is twenty-five million micro-USD and nothing is
 * carried forward that could drift.
 */
export function usdToMicroUsd(usd: number): bigint {
  return BigInt(Math.round(usd * Number(MICRO_USD_PER_USD)));
}
