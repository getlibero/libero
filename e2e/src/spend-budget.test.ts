// #62: a channel can be capped in dollars, and a channel whose spend cannot be
// priced is stopped rather than metered at zero.
//
// A sibling of exceed-budget.test.ts rather than more cases in it. That file is
// about the two limits the meter has always had and is already six rigs; this
// one is about a third limit that rests on something neither of those does — a
// price table on disk, and a model id the *provider* chose. Splitting them keeps
// "which limit is this case about" answerable from the filename.
//
// **The unit that binds is dollars, and the arithmetic is sized off the rig's
// own price table** rather than written as figures. `PRICES` below says a
// million input tokens on `cheap-model` costs one dollar, so a case that wants
// "two turns over the cap" says so in terms of `TURN_TOKENS` and the price, and
// changing either breaks the case loudly instead of silently changing what it
// proves.
//
// **Every fail-closed case has a control beside it.** A refusal is easy to
// produce by accident — a broken price path refuses everything — so each case
// that asserts a refusal is paired with one showing the same spend served when
// the sheet sets no `daily_usd`. Without that pairing the suite would pass on a
// build where pricing never worked at all.
//
// One rig per case, per exceed-budget.test.ts: `model.seen`'s length is the
// script cursor for a rig's whole life.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CHANNEL,
  SERVED_MODEL,
  auditRows,
  calls,
  rigOf,
  says,
  servedBy,
  spendFor,
  startRig,
  withUsage
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/**
 * Dollars per million input tokens, as the rig writes them into a price table.
 *
 * Round numbers rather than a provider's real card: every assertion below is
 * arithmetic a reader has to be able to do in their head. The ratios between the
 * tiers are the example table's — output 5x, cache write 1.25x, cache read 0.1x
 * — and only the tier case depends on them.
 */
const PRICES = { "cheap-model": 1, "dear-model": 50 } as const;

/**
 * A turn that reports a million input tokens, so a dollar figure is a dollar.
 *
 * The scripted default is `TURN_TOKENS`, which is nineteen — right for a token
 * cap and useless for a spend one, because every sum it produces rounds to
 * `$0.00`, and a warning asserting on that would be a warning nobody could read.
 * At a million tokens a turn, `PRICES` reads directly as dollars per turn: one
 * on the cheap model, fifty on the dear one.
 */
const MTOK = 1_000_000;
const bigTurn = (response: ReturnType<typeof calls>) =>
  withUsage(response, { inputTokens: MTOK, outputTokens: 0 });

/** What one such turn costs on each model, in dollars. */
const CHEAP_TURN_USD = PRICES["cheap-model"];
const DEAR_TURN_USD = PRICES["dear-model"];

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

/** What the model is told when each fault bites, per schema/refusal.ts. */
const SPEND_BUDGET = "daily spend budget";
const NOT_PRICED = "not in the proxy's price table";
const UNREPORTED = "without naming a model";

describeDollarCapWithModelSwitch();
describeUnpricedModelFailsClosed();
describeUnpricedModelServedWithoutTheCap();
describeUnreportedModelFailsClosed();
describeWhicheverBindsFirst();
describeDollarWarning();
describeCacheTierPricing();

// The acceptance criterion, and the one case a token cap could not fake: the
// model changes mid-day and the same token count costs a hundred times more.
function describeDollarCapWithModelSwitch(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          // Above two cheap turns ($2) and below one dear one ($50), so the
          // model switch is the only thing that can cross it.
          dailyUsd: 10,
          // Both token limits wide, so what stops this channel is provably the
          // dollars. A token cap that bit first would make the case prove the
          // wrong thing, quietly and with the same number of upstream calls.
          // Wide on purpose, per exceed-budget.test.ts: the claim is that the
          // *proxy's* meter stops this channel, and a loop-side cap that ended
          // the task first would prove the wrong thing with the same call count.
          maxTokensPerTask: 1_000_000_000,
          dailyTokens: 1_000_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [
        servedBy(bigTurn(call("call-1")), "cheap-model"),
        servedBy(bigTurn(call("call-2")), "cheap-model"),
        // The router switches. This turn's token count is identical to the two
        // above and costs fifty times as much.
        servedBy(bigTurn(call("call-3")), "dear-model"),
        says("I have run out of budget.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "stops at the dollar figure with the model switching mid-day",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000060"));

      // Two calls ran and the third did not. **The loop reports a turn's spend
      // before dispatching that turn's calls**, so the dear turn's fifty dollars
      // were on the meter when its own call was judged — the ordering that lets
      // a spend cap bite within a task rather than at the next one.
      const rows = auditRows(auditDb);
      expect(upstream.callsTo("tools/call")).toHaveLength(2);
      expect(rows.map(row => row.outcome)).toEqual(["ran", "ran", "refused"]);
      expect(rows[2]).toMatchObject({ channel: CHANNEL, refusal_reason: "budget_exhausted" });

      // Which limit, in the words the model read. The three limits have distinct
      // prose, so this rules out a token refusal wearing the same reason code —
      // and the token limit here is five hundred times what was spent.
      expect(JSON.stringify(model.seen)).toContain(SPEND_BUDGET);

      // The claim the whole feature rests on, in two numbers. Two cheap turns
      // are far under the cap and one dear turn is over it, on identical token
      // counts — so what refused this channel was the price and nothing else.
      expect(2 * CHEAP_TURN_USD).toBeLessThan(10);
      expect(DEAR_TURN_USD).toBeGreaterThan(10);

      // And the meter kept them apart, which is what made the pricing possible.
      // `toContain` rather than an exact list: the task's final answer turn runs
      // on the harness's default model and adds a third bucket, which is true of
      // any real task and is not what this case is about.
      const models = spendFor(budgetDb, CHANNEL).byModel.map(bucket => bucket.model);
      expect(models).toContain("cheap-model");
      expect(models).toContain("dear-model");
    },
    CASE_MS
  );
}

// Fail closed, and the refusal names the model so an operator knows what to
// price. The channel is nowhere near its cap in dollars — it has no priceable
// spend at all — which is the point: a cap whose position cannot be computed is
// not a cap.
function describeUnpricedModelFailsClosed(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyUsd: 1_000,
          dailyTokens: 10_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      // `SERVED_MODEL` is the harness default and is deliberately absent from
      // PRICES, so this is the ordinary shape of the mistake: a deployment that
      // priced two models and met a third.
      script: [call("call-1"), says("I cannot run.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "refuses spend on a model the table does not price, and names it",
    async () => {
      const { agent, upstream, model, auditDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000061"));

      // **Nothing ran at all**, and that is the ordering rather than an
      // over-reach: the loop reports a turn's spend before dispatching that
      // turn's calls, so the first turn's unpriceable tokens were already on the
      // meter when the first call was judged. A channel whose spend cannot be
      // priced is stopped from its first call, not from its second.
      expect(upstream.callsTo("tools/call")).toHaveLength(0);
      const rows = auditRows(auditDb);
      expect(rows.map(row => row.outcome)).toEqual(["refused"]);
      expect(rows[0]).toMatchObject({ refusal_reason: "model_not_priced" });

      // Named, because the remedy is a line in the price table and an operator
      // cannot write it without the spelling.
      const seen = JSON.stringify(model.seen);
      expect(seen).toContain(NOT_PRICED);
      expect(seen).toContain(SERVED_MODEL);
    },
    CASE_MS
  );
}

// **The non-vacuity control for the case above**, and for every fail-closed
// claim in this file. The same rig, the same unpriced model, the same script —
// with no `daily_usd`. Everything runs.
//
// Without this, a build whose price lookup always answered "unpriced" would pass
// the case above, and the property that matters most to every existing
// deployment — a channel that caps tokens and tool calls never consults a price
// at all — would go unasserted.
function describeUnpricedModelServedWithoutTheCap(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          // No dailyUsd. That one absent line is the whole difference.
          dailyTokens: 10_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [call("call-1"), call("call-2"), says("Both checked.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "serves the same unpriced model when the sheet sets no dollar cap",
    async () => {
      const { agent, upstream, model, auditDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000062"));

      expect(upstream.callsTo("tools/call")).toHaveLength(2);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "ran"]);
      // And the model was told nothing about prices, which is the half an
      // outcome assertion cannot show.
      const seen = JSON.stringify(model.seen);
      expect(seen).not.toContain(NOT_PRICED);
      expect(seen).not.toContain(SPEND_BUDGET);
    },
    CASE_MS
  );
}

// The other pricing fault, and the reason there are two reasons: this one has
// nothing to name, and its remedy is the agent rather than the table.
function describeUnreportedModelFailsClosed(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      // The old agent, on the wire rather than in a flag: counts arrive, the
      // model does not.
      spendReports: "unmodelled",
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyUsd: 1_000,
          dailyTokens: 10_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [servedBy(call("call-1"), "cheap-model"), says("I cannot run.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "refuses spend reported without a model, and names no model to price",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000063"));

      // Refused from the first call, for the reason the unpriced case gives:
      // the turn's spend reaches the meter before its own call is judged.
      expect(upstream.callsTo("tools/call")).toHaveLength(0);
      const rows = auditRows(auditDb);
      expect(rows.map(row => row.outcome)).toEqual(["refused"]);
      expect(rows[0]).toMatchObject({ refusal_reason: "model_unreported" });

      // Distinct prose from the other fault, so an operator reading the thread
      // is sent to the agent rather than to the price table — and the model the
      // script *said* it used is nowhere in the sentence, because the proxy
      // never learned it.
      const seen = JSON.stringify(model.seen);
      expect(seen).toContain(UNREPORTED);
      expect(seen).not.toContain(NOT_PRICED);

      // The counts still arrived. That is what separates this from an agent
      // that reports nothing at all: `daily_tokens` is unaffected and only the
      // pricing is impossible.
      const spend = spendFor(budgetDb, CHANNEL);
      expect(spend.inputTokens + spend.outputTokens).toBeGreaterThan(0);
      expect(spend.byModel.map(bucket => bucket.model)).toEqual(["(unreported)"]);
    },
    CASE_MS
  );
}

// Both caps set, and the token one is the tighter. The dollar cap is checked
// first and has room, so the answer names the limit that actually bound.
function describeWhicheverBindsFirst(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          // Generous: two cheap turns is two dollars against it, so this cap
          // cannot be what stops the channel.
          dailyUsd: 1_000,
          // Tight: exactly two turns, as exceed-budget.test.ts sizes its own.
          maxTokensPerTask: 1_000_000_000,
          dailyTokens: 2 * MTOK,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [
        servedBy(bigTurn(call("call-1")), "cheap-model"),
        servedBy(bigTurn(call("call-2")), "cheap-model"),
        says("I have run out of budget.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "stops at whichever limit binds first and says which one it was",
    async () => {
      const { agent, upstream, model, auditDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000064"));

      expect(upstream.callsTo("tools/call")).toHaveLength(1);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "refused"]);

      // The token limit, not the dollar one — the two have distinct prose, and
      // an ordering that reported the dollar cap here would send an operator to
      // raise a number with a thousand dollars of room in it.
      const seen = JSON.stringify(model.seen);
      expect(seen).toContain("daily token budget");
      expect(seen).not.toContain(SPEND_BUDGET);

      // And the spend really was negligible against the dollar cap, so the
      // assertion above is about the ordering rather than about a cap that
      // happened to be spent too.
      expect(2 * CHEAP_TURN_USD).toBeLessThan(1_000);
      expect(CHEAP_TURN_USD).toBeGreaterThan(0);
    },
    CASE_MS
  );
}

// `warn_at` covers the dollar cap too, so its first sign is a notice rather than
// a refusal — and the notice is in dollars.
function describeDollarWarning(): void {
  let rig: Rig | undefined;

  /**
   * Six cheap turns' worth, which is the only sizing that shows a warning with
   * nothing refused: the fifth call is judged at five dollars, which is past
   * four fifths of six and short of six.
   */
  const CAP_USD = 6 * CHEAP_TURN_USD;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyUsd: CAP_USD,
          warnAt: 0.8,
          // Wide on purpose, per exceed-budget.test.ts: the claim is that the
          // *proxy's* meter stops this channel, and a loop-side cap that ended
          // the task first would prove the wrong thing with the same call count.
          maxTokensPerTask: 1_000_000_000,
          dailyTokens: 1_000_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [
        servedBy(bigTurn(call("call-1")), "cheap-model"),
        servedBy(bigTurn(call("call-2")), "cheap-model"),
        servedBy(bigTurn(call("call-3")), "cheap-model"),
        servedBy(bigTurn(call("call-4")), "cheap-model"),
        servedBy(bigTurn(call("call-5")), "cheap-model"),
        says("Five checked.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "warns in dollars before the dollar cap refuses, and serves the call that crossed",
    async () => {
      const { agent, upstream, model } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000065"));

      // Every call ran. That is the whole difference from the cases above: a
      // soft limit is not a refusal.
      expect(upstream.callsTo("tools/call")).toHaveLength(5);

      // In the thread, and in dollars with both fraction digits — a warning that
      // said `$0` of a cap this size would be a warning nobody can act on.
      const [first] = agent.slack.posted;
      expect(first?.text).toContain("Five checked.");
      expect(first?.text).toContain("Budget: this channel has spent $5.00 of its $6.00 daily budget.");

      // And nowhere near the model, for #99's reason: a notice in a tool result
      // is re-sent as context on every later turn, and the remedy it asks for is
      // not the model's to reach for.
      expect(JSON.stringify(model.seen)).not.toContain("Budget");
    },
    CASE_MS
  );
}

// A cache-heavy turn is priced at the cache tier, not the input one. Its own
// case because it is the claim that a table collapsing the four tiers would
// break, and nothing else here would notice.
function describeCacheTierPricing(): void {
  let rig: Rig | undefined;

  /** A million cache reads: ten cents at the cache rate, a dollar as input. */
  const CACHE_READS = MTOK;

  beforeAll(async () => {
    rig = await startRig({
      prices: PRICES,
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          // $2.00: above what the two turns cost with the cache tier priced at
          // its own rate ($0.10 + $1.00) and at exactly what they would cost if
          // cache reads were billed as input ($1.00 + $1.00), which `>=` refuses.
          dailyUsd: 2,
          // Wide on purpose, per exceed-budget.test.ts: the claim is that the
          // *proxy's* meter stops this channel, and a loop-side cap that ended
          // the task first would prove the wrong thing with the same call count.
          maxTokensPerTask: 1_000_000_000,
          dailyTokens: 1_000_000_000,
          dailyToolCalls: 500,
          maxToolCallsPerTask: 20
        }
      },
      script: [
        servedBy(
          withUsage(call("call-1"), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: CACHE_READS }),
          "cheap-model"
        ),
        servedBy(bigTurn(call("call-2")), "cheap-model"),
        says("Both checked.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "prices cache reads at the cache rate rather than as input tokens",
    async () => {
      const { agent, upstream, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000066"));

      // Both calls ran. At the cache rate the day cost $1.10 against a $2.00
      // cap; billed as input it would have been exactly $2.00, and `>=` would
      // have refused the second call.
      expect(upstream.callsTo("tools/call")).toHaveLength(2);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "ran"]);

      // The reads really happened and landed in the cache column rather than the
      // input one, which is the non-vacuity guard: a turn whose cache reads had
      // been recorded as input would have produced the same two `ran` rows for
      // the wrong reason, at a cost of exactly the cap.
      const spend = spendFor(budgetDb, CHANNEL);
      expect(spend.cacheReadTokens).toBe(CACHE_READS);
      // At least, not exactly: the task's final answer turn reports a handful of
      // ordinary tokens on top, as every real task does.
      expect(spend.inputTokens).toBeGreaterThanOrEqual(MTOK);
    },
    CASE_MS
  );
}
