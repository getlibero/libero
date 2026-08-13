import { describe, expect, it } from "vitest";
import { servedModel } from "./served-model.js";

// The one rule both adapters read a provider's echoed model id through (#62).
// Small enough to test directly, and worth testing directly: what it rejects is
// the difference between a turn metered as "unreported" and a turn whose counts
// never reached the meter at all.
describe("reading the model a provider echoed back", () => {
  it("carries the ids the providers in the wild actually send", () => {
    const real = [
      "claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "models/gemini-2.5-pro",
      "qwen2.5:7b"
    ];
    for (const id of real) expect(servedModel(id)).toEqual({ model: id });
  });

  // A provider that says nothing. Both SDKs type the field as a required
  // string, but that is a claim about a well-behaved server, and an
  // OpenAI-compatible gateway is not required to be one.
  it("answers with no property at all when the provider echoed nothing", () => {
    for (const nothing of [undefined, null, ""]) {
      expect(servedModel(nothing)).toEqual({});
      expect("model" in servedModel(nothing)).toBe(false);
    }
  });

  // The reason the check is here rather than at the wire. `SpendReport` is
  // strict, so an id it refuses would 400 the whole report — and the report is
  // what carries the *token counts*, which is the limit that catches a runaway
  // loop. Dropping the odd id degrades to "unreported"; passing it along
  // degrades to "unmetered", which fails open.
  it("drops an id the wire schema would refuse rather than passing it on", () => {
    const refused = ["a model with spaces", "x".repeat(129), "/leading-slash", "-leading-dash"];
    for (const id of refused) expect(servedModel(id)).toEqual({});
  });

  // Neither can arrive from a provider, and if one somehow did it would be a
  // report claiming to be the meter's own bookkeeping.
  it("drops the two ids the meter reserves for itself", () => {
    expect(servedModel("(legacy)")).toEqual({});
    expect(servedModel("(unreported)")).toEqual({});
  });
});
