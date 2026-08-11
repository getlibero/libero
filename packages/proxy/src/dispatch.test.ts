import { describe, expect, it } from "vitest";
import type { McpServer, ResolvedToolCall } from "@getlibero/schema";
import {
  type Dispatch,
  type SpendMeter,
  type ToolDispatcher,
  assertServableComposition,
  createUnavailableCatalog,
  createUnavailableDispatcher,
  markProvisional
} from "./dispatch.js";
import type { CallLimits } from "./enforce.js";

/**
 * The channel's bound on a result, which every `callTool` now carries.
 *
 * Roomy on purpose: these cases are about the protocol and the transport, not
 * about truncation. The bound's own behaviour is mcp-bounds.test.ts's.
 */
const LIMITS: CallLimits = { maxResultChars: 100_000 };

const noSpend = { toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The shape ./budget-meter.ts supplies, without the file underneath it. */
const realMeter: SpendMeter = {
  read: () => ({ ...noSpend, toolCalls: 3, inputTokens: 12 }),
  recordToolCall: () => {},
  recordTokens: () => ({ outcome: "recorded" })
};

const realDispatcher: ToolDispatcher = {
  dispatch: (): Dispatch => ({ outcome: "ran", result: { content: "", isError: false } })
};

/**
 * A meter that never exhausts a budget — what `createUnmeteredSpend()` used to
 * be, before #96 landed a real one and deleted it.
 *
 * Built here rather than shipped, because there is no longer a provisional
 * meter in the package and there should not be one. The check below still has
 * to be exercised: the seams that land next (#37, #39, #63) each arrive before
 * their implementation, and a stand-in meter is the obvious way to test one.
 */
const provisionalMeter = (): SpendMeter =>
  markProvisional({
    read: () => noSpend,
    recordToolCall: () => {},
    recordTokens: () => ({ outcome: "recorded" as const })
  });

describe("the provisional dispatcher", () => {
  it("serves no call at all", () => {
    const call = { id: "1", server: "github", tool: "list_prs", arguments: {}, channel: "C1" };
    const upstream: McpServer = { name: "github", transport: "http", url: "http://u:1", tool: [] };
    expect(createUnavailableDispatcher().dispatch(call as ResolvedToolCall, upstream, LIMITS)).toEqual({
      outcome: "unavailable"
    });
  });
});

describe("the provisional catalog", () => {
  it("describes nothing, so every tool stays as the sheet wrote it", async () => {
    const upstream: McpServer = { name: "github", transport: "http", url: "http://u:1", tool: [] };
    expect(await createUnavailableCatalog().describe(upstream, ["list_prs"])).toEqual(new Map());
  });

  // Deliberately not in `assertServableComposition`. A catalog cannot serve a
  // call and cannot spend a budget, so this pairing is a proxy publishing thin
  // listings — a first-class state — rather than the silent failure that check
  // exists to prevent.
  it("is not a composition the servability check has an opinion about", () => {
    expect(() => assertServableComposition(realMeter, realDispatcher)).not.toThrow();
    expect(() => assertServableComposition(provisionalMeter(), createUnavailableDispatcher())).not.toThrow();
  });
});

describe("assertServableComposition", () => {
  // The combination that must not exist: real calls, no meter. It is the one
  // that fails silently — an unmetered proxy does not misbehave, it just never
  // refuses, so the failure surfaces as a bill rather than as an error.
  it("refuses a real dispatcher paired with a provisional meter", () => {
    expect(() => assertServableComposition(provisionalMeter(), realDispatcher)).toThrow(
      /needs a real spend meter/
    );
  });

  it("allows a provisional meter with the unavailable dispatcher", () => {
    expect(() =>
      assertServableComposition(provisionalMeter(), createUnavailableDispatcher())
    ).not.toThrow();
  });

  // What ships now: a real meter, and either dispatcher. A real meter with the
  // unavailable dispatcher is a deployment ahead of its upstream, not a fault.
  it("allows a real meter with either dispatcher", () => {
    expect(() => assertServableComposition(realMeter, createUnavailableDispatcher())).not.toThrow();
    expect(() => assertServableComposition(realMeter, realDispatcher)).not.toThrow();
  });

  // The mark is a module-private symbol reachable only through
  // `markProvisional`, so nothing wears it by resembling a stand-in. A meter
  // that returns zeros of its own accord is somebody's deliberate choice and
  // not this check's business.
  it("does not mistake a look-alike meter for a provisional one", () => {
    const zeroesButReal: SpendMeter = { ...realMeter, read: () => noSpend };
    expect(() => assertServableComposition(zeroesButReal, realDispatcher)).not.toThrow();
  });
});
