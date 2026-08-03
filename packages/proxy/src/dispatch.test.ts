import { describe, expect, it } from "vitest";
import type { ResolvedToolCall } from "@getlibero/schema";
import {
  type Dispatch,
  type SpendMeter,
  type ToolDispatcher,
  assertServableComposition,
  createUnavailableDispatcher,
  createUnmeteredSpend
} from "./dispatch.js";

/** What #38 will supply: a meter that reads real counters from somewhere. */
const realMeter: SpendMeter = { read: () => ({ tokens: 12, toolCalls: 3 }) };

/** What #51 will supply: a dispatcher that actually serves a call. */
const realDispatcher: ToolDispatcher = {
  dispatch: (): Dispatch => ({ outcome: "ran", result: { content: "", isError: false } })
};

describe("the provisional stand-ins", () => {
  it("reports nothing spent, which is the permissive direction", () => {
    expect(createUnmeteredSpend().read("C024BE91L")).toEqual({ tokens: 0, toolCalls: 0 });
  });

  it("serves no call at all", () => {
    const call = { id: "1", server: "github", tool: "list_prs", arguments: {}, channel: "C1" };
    expect(createUnavailableDispatcher().dispatch(call as ResolvedToolCall)).toEqual({
      outcome: "unavailable"
    });
  });
});

describe("assertServableComposition", () => {
  // The combination that must not exist: real calls, no meter. It is the one
  // that fails silently — an unmetered proxy does not misbehave, it just never
  // refuses, so the failure surfaces as a bill rather than as an error.
  it("refuses a real dispatcher paired with the unmetered stand-in", () => {
    expect(() => assertServableComposition(createUnmeteredSpend(), realDispatcher)).toThrow(
      /needs a real spend meter/
    );
  });

  it("allows both stand-ins together, which is what ships today", () => {
    expect(() =>
      assertServableComposition(createUnmeteredSpend(), createUnavailableDispatcher())
    ).not.toThrow();
  });

  it("allows a real meter with either dispatcher", () => {
    expect(() => assertServableComposition(realMeter, createUnavailableDispatcher())).not.toThrow();
    expect(() => assertServableComposition(realMeter, realDispatcher)).not.toThrow();
  });

  // The mark is a module-private symbol, so nothing can wear it by resembling
  // the stand-in. A meter that returns zeros of its own accord is somebody's
  // deliberate choice and not this check's business.
  it("does not mistake a look-alike meter for the stand-in", () => {
    const zeroesButReal: SpendMeter = { read: () => ({ tokens: 0, toolCalls: 0 }) };
    expect(() => assertServableComposition(zeroesButReal, realDispatcher)).not.toThrow();
  });
});
