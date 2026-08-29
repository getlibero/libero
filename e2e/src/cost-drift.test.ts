// #239: what a gateway says a call cost is recorded beside what the proxy
// computed, and it decides nothing.
//
// A file of its own rather than more cases in spend-budget.test.ts, on that
// file's own rule: that one is about a limit — a channel capped in dollars, and
// what happens when its spend cannot be priced — and this one is about an
// observation that is deliberately not a limit. "Which limit is this case
// about" stays answerable from the filename, and here the answer is none.
//
// **The claim is negative, so it is made in both directions.** A negative claim
// is the easy one to fake: a build that ignored the reported figure entirely
// would pass a case that only checked nothing was refused. So one case reports a
// cost a hundred times the proxy's and asserts every call is still served, and
// the other reports almost nothing while the proxy's own table takes the channel
// over its cap — and asserts the refusal happens anyway. Between them, the
// reported figure is shown to move the decision in neither direction.
//
// The positive half rides along: both cases read the record back through the
// operator's real entrypoint, which is the other thing #239 asks for — a stale
// price table visible without the provider's invoice.
//
// One rig per case, per spend-budget.test.ts: `model.seen`'s length is the
// script cursor for a rig's whole life.

import { after as afterAll, before as beforeAll, it } from "node:test";
import { expect } from "expect";
import {
  CHANNEL,
  auditRows,
  calls,
  rigOf,
  runDriftCli,
  says,
  servedBy,
  spendFor,
  startRig,
  withReportedCost,
  withUsage
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/** One dollar per million input tokens, so a turn's cost reads as a dollar. */
const PRICES = { "cheap-model": 1 } as const;
const MTOK = 1_000_000;

const bigTurn = (response: ReturnType<typeof calls>) =>
  withUsage(response, { inputTokens: MTOK, outputTokens: 0 });

/** Nano-USD, as a gateway reports them. A hundred dollars for a dollar's tokens. */
const HUNDRED_DOLLARS = 100_000_000_000;

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

const call = (id: string) => calls("list_prs", { repo: "getlibero/libero" }, id);

/** What the model is told when the dollar cap bites, per schema/refusal.ts. */
const SPEND_BUDGET = "daily spend budget";

describeAWildlyHigherFigureRefusesNothing();
describeALowFigureSavesNothingFromTheCap();

// A gateway charging a hundred times what this deployment's table says changes
// no decision. If the proxy ever metered on the reported figure, three turns at
// a hundred dollars would blow a ten dollar cap on the second call.
function describeAWildlyHigherFigureRefusesNothing(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          // Comfortably above the three dollars the table prices this task at,
          // and far below the three hundred the gateway reports.
          dailyUsd: 10,
          maxTokensPerTask: 1_000_000_000,
          dailyTokens: 1_000_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [
        servedBy(withReportedCost(bigTurn(call("call-1")), HUNDRED_DOLLARS), "cheap-model"),
        servedBy(withReportedCost(bigTurn(call("call-2")), HUNDRED_DOLLARS), "cheap-model"),
        servedBy(withReportedCost(bigTurn(call("call-3")), HUNDRED_DOLLARS), "cheap-model"),
        // No cost on the closing turn, which is what a direct provider call
        // looks like — and what keeps the record's turn count at three.
        says("All three checked.")
      ]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "serves every call while the gateway reports a hundred times the cost",
    { timeout: CASE_MS },
    async () => {
      const { agent, upstream, auditDb, budgetDb, driftDb, priceTable } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000090"));

      // Nothing was refused, and nothing was warned about: the day cost three
      // dollars against a ten dollar cap, which is what the table says.
      expect(upstream.callsTo("tools/call")).toHaveLength(3);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "ran", "ran"]);

      // The meter holds the counts and nothing else. There is no column here
      // for what a gateway charged, which is the structural half of the claim.
      expect(spendFor(budgetDb, CHANNEL).inputTokens).toBeGreaterThanOrEqual(3 * MTOK);

      // And the disagreement was recorded, read back the way an operator reads
      // it: a second process, against the file the proxy just wrote.
      const shown = await runDriftCli(driftDb, priceTable, ["show"]);
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain("cheap-model");
      expect(shown.stdout).toContain("3 turns");
      expect(shown.stdout).toContain("computed $3.0000");
      expect(shown.stdout).toContain("reported $300.0000");
      // The direction, in words. Under-pricing is the direction that matters:
      // this channel's daily_usd is allowing more real spend than it reads.
      expect(shown.stdout).toContain("below the gateway");

      // The closing turn reported no cost and is not in the record — a call
      // nobody priced is not a disagreement. Three turns, not four.
      expect(shown.stdout).not.toContain("4 turns");
    });
}

// The mirror. A gateway reporting almost nothing does not save a channel from
// its own price table: the cap is computed from the table, on the counts, and a
// figure the proxy did not compute is not part of that arithmetic.
function describeALowFigureSavesNothingFromTheCap(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          // Three dollars. The gate reads the day's spend *before* serving a
          // call, and the turn that asked for it has already reported — so
          // call-1 is gated at $1, call-2 at $2, and call-3 at $3, which is the
          // cap. Two run and the third is refused.
          dailyUsd: 3,
          maxTokensPerTask: 1_000_000_000,
          dailyTokens: 1_000_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [
        // One nano-dollar a turn. A meter reading these would never stop.
        servedBy(withReportedCost(bigTurn(call("call-1")), 1), "cheap-model"),
        servedBy(withReportedCost(bigTurn(call("call-2")), 1), "cheap-model"),
        servedBy(withReportedCost(bigTurn(call("call-3")), 1), "cheap-model"),
        says("I have run out of budget.")
      ]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "refuses on the price table even where the gateway reported almost nothing",
    { timeout: CASE_MS },
    async () => {
      const { agent, upstream, model, auditDb, driftDb, priceTable } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000091"));

      // Two ran and the third was refused, which is what the table says: the
      // day had cost two dollars and the cap is two.
      expect(upstream.callsTo("tools/call")).toHaveLength(2);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "ran", "refused"]);
      expect(JSON.stringify(model.seen)).toContain(SPEND_BUDGET);

      // The record shows the two figures a mile apart and the refusal happened
      // regardless — which is the whole of "recorded, never enforced".
      const shown = await runDriftCli(driftDb, priceTable, ["show"]);
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain("above the gateway");
      // No exit code for a difference of any size, deliberately: a script that
      // gated on one would be enforcing on a figure the proxy did not compute.
      expect(shown.status).toBe(0);
    });
}
