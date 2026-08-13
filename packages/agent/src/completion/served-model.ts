// One rule for reading the model id a provider echoed back (#62), shared by both
// adapters so the two cannot answer differently.
//
// **Validated here rather than at the wire.** The spend report is a strict
// schema, so a model id that does not satisfy `ModelId` would fail the whole
// report — and that costs the turn's *token counts*, which is the limit that
// catches a runaway loop. Checking where provider output is already being
// normalised, beside `toUsage` and `toStopReason`, means `CompletionResponse`
// carries either a well-formed id or nothing, and an odd gateway degrades to
// "unreported" instead of "unmetered".
//
// **There is no fallback to the requested model, deliberately.** See
// `CompletionResponse.model` for the argument: the requested id is the sheet's,
// and the whole reason this field exists is that under a router the two differ.
// A provider that echoes nothing is an unpriced deployment, and the tool proxy
// service fails closed on that rather than pricing it as something it was not.

import { ModelId } from "@getlibero/schema";

/**
 * The `{ model }` fragment to spread into a `CompletionResponse`, or nothing.
 *
 * A fragment rather than a `string | undefined`, because `exactOptionalPropertyTypes`
 * is on: an explicit `model: undefined` does not satisfy `model?: string`, so
 * the absent case has to be an absent *property* and spreading is how a call
 * site expresses that in one expression.
 */
export function servedModel(echoed: string | null | undefined): { model?: string } {
  if (typeof echoed !== "string") return {};
  return ModelId.safeParse(echoed).success ? { model: echoed } : {};
}
