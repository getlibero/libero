import { describe, expect, it } from "vitest";
import type { BuiltinToolName, McpServer, ResolvedToolCall } from "@getlibero/schema";
import {
  type Dispatch,
  type SpendMeter,
  type ToolDispatcher,
  assertServableComposition,
  createToolDispatcher,
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

// The composite is the seam the server holds, and the whole of its behaviour is
// which arm a target reaches. Both arms record, so a test can assert the one
// that was *not* called — which is the property that matters: the arm holding
// the vault and the pool must never see a built-in, and the arm holding a path
// to channel messages must never see an upstream.
describe("createToolDispatcher", () => {
  const call = { id: "1", server: "github", tool: "list_prs", arguments: {}, channel: "C1" } as ResolvedToolCall;
  const upstream: McpServer = { name: "github", transport: "http", url: "http://u:1", tool: [] };

  const arms = () => {
    const seen = { mcp: [] as McpServer[], builtin: [] as string[] };
    return {
      seen,
      mcp: {
        dispatch: (_call: ResolvedToolCall, server: McpServer): Dispatch => {
          seen.mcp.push(server);
          return { outcome: "ran", result: { content: "mcp", isError: false } };
        }
      },
      builtin: {
        run: (_call: ResolvedToolCall, tool: BuiltinToolName): Dispatch => {
          seen.builtin.push(tool);
          return { outcome: "ran", result: { content: "builtin", isError: false } };
        }
      }
    };
  };

  it("sends an mcp target to the mcp arm, unwrapped", () => {
    const { seen, mcp, builtin } = arms();
    const result = createToolDispatcher({ mcp, builtin }).dispatch(call, { kind: "mcp", upstream }, LIMITS);

    expect(result).toEqual({ outcome: "ran", result: { content: "mcp", isError: false } });
    // The arm receives the `McpServer`, not the `Target` around it: it cannot
    // be handed a built-in, so it needs no branch that could mistake one.
    expect(seen.mcp).toEqual([upstream]);
    expect(seen.builtin).toEqual([]);
  });

  it("sends a builtin target to the builtin arm, and never to the mcp one", () => {
    const { seen, mcp, builtin } = arms();
    const result = createToolDispatcher({ mcp, builtin }).dispatch(
      call,
      { kind: "builtin", tool: "search_channel_history" },
      LIMITS
    );

    expect(result).toEqual({ outcome: "ran", result: { content: "builtin", isError: false } });
    expect(seen.builtin).toEqual(["search_channel_history"]);
    // The arm that holds the vault and the client pool saw nothing.
    expect(seen.mcp).toEqual([]);
  });

  it("answers a builtin target 501 when no builtin arm was composed", () => {
    const { mcp } = arms();
    expect(
      createToolDispatcher({ mcp }).dispatch(call, { kind: "builtin", tool: "search_channel_history" }, LIMITS)
    ).toEqual({ outcome: "unavailable" });
  });

  // `assertServableComposition` asks whether this can really serve a call. It
  // can if *either* arm can — a real built-in beside an unbuilt upstream still
  // spends a channel's meter, so it still demands a real one.
  it("is provisional only when both arms are", () => {
    const { mcp, builtin } = arms();

    expect(() =>
      assertServableComposition(provisionalMeter(), createToolDispatcher({ mcp: createUnavailableDispatcher() }))
    ).not.toThrow();

    expect(() =>
      assertServableComposition(
        provisionalMeter(),
        createToolDispatcher({ mcp: createUnavailableDispatcher(), builtin })
      )
    ).toThrow(/needs a real spend meter/);

    expect(() =>
      assertServableComposition(provisionalMeter(), createToolDispatcher({ mcp }))
    ).toThrow(/needs a real spend meter/);
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
    expect(() => assertServableComposition(provisionalMeter(), createToolDispatcher({ mcp: createUnavailableDispatcher() }))).not.toThrow();
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
      assertServableComposition(provisionalMeter(), createToolDispatcher({ mcp: createUnavailableDispatcher() }))
    ).not.toThrow();
  });

  // What ships now: a real meter, and either dispatcher. A real meter with the
  // unavailable dispatcher is a deployment ahead of its upstream, not a fault.
  it("allows a real meter with either dispatcher", () => {
    expect(() => assertServableComposition(realMeter, createToolDispatcher({ mcp: createUnavailableDispatcher() }))).not.toThrow();
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
