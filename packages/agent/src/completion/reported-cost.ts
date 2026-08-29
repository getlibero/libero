// One rule for reading the cost a gateway reports (#239), shared by the
// completion and embedding adapters so the two cannot answer differently — the
// same reason ./served-model.ts is one function rather than two copies.
//
// **This is a second opinion, not a meter.** The tool proxy service prices a
// channel's spend from the token counts and the operator's price table, and
// that figure is the one a dollar cap enforces on. What this reads is what the
// router computed for the same call from its own price map. The two are
// compared so a stale price table is visible before the provider's invoice
// arrives; nothing here is ever enforced on, and a call that reports no cost is
// metered exactly as it was before this existed.
//
// **Only LiteLLM sends one**, so only LiteLLM's header is read. There is no
// standard for this — a direct provider call reports no cost at all, which is a
// property of the deployment shape rather than a gap. Naming the header for
// what sends it, rather than inventing a vendor-neutral name for a field one
// vendor emits, keeps that honest.

import { MAX_REPORTED_COST_NANO_USD, NANO_USD_PER_USD } from "@getlibero/schema";

/**
 * The header LiteLLM puts a call's cost in, as US dollars.
 *
 * **The bare header, and never its siblings.** Measured against `main-stable`:
 * a model LiteLLM can price answers `x-litellm-response-cost: 0.00011385`, and
 * a model it *cannot* price omits this header entirely — while
 * `x-litellm-response-cost-input` and `-output` are still sent, reading `0.0`.
 * Reading those would turn "nobody priced this" into "priced at nothing", which
 * is the one distinction this field exists to carry: the drift record would
 * then show a deployment being over-charged by its own price table on every
 * model the gateway has never heard of.
 */
const COST_HEADER = "x-litellm-response-cost";

/**
 * The `{ costNanoUsd }` fragment to spread into a response, or nothing.
 *
 * A fragment for `servedModel`'s reason: `exactOptionalPropertyTypes` is on, so
 * an explicit `costNanoUsd: undefined` does not satisfy `costNanoUsd?: number`
 * and the absent case has to be an absent *property*.
 *
 * **Nano-USD, because dollars here go small.** A nine-token embedding through
 * LiteLLM costs `1.8e-07` USD; at the price table's micro-USD that rounds to
 * zero, and zero is a figure that means something else. Rounded rather than
 * truncated, so a sub-nano figure lands on the nearest nano rather than
 * disappearing into a value that reads as "priced, and free".
 *
 * **Anything not understood is dropped rather than guessed at.** A header that
 * is empty, not a number, negative, or above the wire's ceiling yields no cost,
 * because every one of those is a gateway saying something this does not know
 * how to compare — and a wrong figure in the drift record is worse than no
 * figure, which is merely a call the comparison does not cover. None of them is
 * an error: a turn's token counts must never be lost over a second opinion.
 */
export function reportedCost(headers: Headers | undefined): { costNanoUsd?: number } {
  const raw = headers?.get(COST_HEADER);
  // `Number("")` is 0, which is exactly the value that must not be invented
  // here, so the empty string is rejected before the conversion rather than
  // after it.
  if (raw === null || raw === undefined || raw.trim() === "") return {};

  // `Number` rather than `parseFloat`: this is a wire value, and a header
  // reading "0.001 (estimated)" is a gateway saying something this does not
  // understand. parseFloat would take the prefix and call it a measurement.
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) return {};

  const nano = Math.round(usd * NANO_USD_PER_USD);
  // Clamping would invent a figure the gateway did not report, and the
  // comparison is only worth making on figures both sides actually stated.
  if (nano > MAX_REPORTED_COST_NANO_USD) return {};

  return { costNanoUsd: nano };
}
