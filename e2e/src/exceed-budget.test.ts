// #134, property 3: the model cannot spend past the channel's sheet.
//
// **Two meters, and they hold against different things.** `daily_tool_calls` is
// counted by the proxy from calls it served, so it holds even against an agent
// process that reports nothing and lies about everything. `daily_tokens` is
// counted from what the agent reports — the provider's response envelope, not
// anything the model wrote — so it holds against a prompt-injected model and no
// further. Both are enforced from the sheet in the proxy, and neither asks the
// loop's own caps for an opinion. Every case below is about one of those two
// sentences, and the file is arranged so which one is never ambiguous.
//
// **The boundary is `>=`, and the cases sit on it.** A channel that has spent
// exactly its limit has no budget left, so the interesting call is the one after
// the number is reached, not one somewhere past it. Each sheet here is sized off
// the script — `2 * TURN_TOKENS`, `daily_tool_calls = 2` — so the case fails if
// the rule ever becomes `>`, which a limit set generously would not.
//
// One ordering makes the token cases possible at all: the loop awaits `onTurn`
// *before* dispatching that turn's tool calls, so a turn's tokens are on the
// meter before the call it provoked is judged. Without it a token limit could
// only ever bite on the next task.
//
// One rig per case, per unlisted-tool.test.ts: `model.seen`'s length is the
// script cursor for a rig's whole life, so cases sharing a rig would be coupled
// through something neither of them mentions.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CHANNEL,
  SERVED_MODEL,
  TURN_TOKENS,
  auditRows,
  calls,
  rigOf,
  runBudgetCli,
  says,
  servedBy,
  spendFor,
  startRig,
  withUsage
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

/** One turn's call, with the id the loop needs to be distinct within a turn. */
const call = (id: string) => calls("list_prs", { repo: "getlibero/libero" }, id);

/** What the model is told when the tool-call meter is spent, per schema/refusal.ts. */
const TOOL_CALL_BUDGET = "daily tool-call budget";
/** And when the token meter is. Distinct prose, so a case can say which limit bit. */
const TOKEN_BUDGET = "daily token budget";

describeToolCallCapAndReset();
describeTokenCapAtTheBoundary();
describeReportingNothing();
describeReplayedTurnIds();
describeCacheWeighting();
describeServedModel();
describeSoftLimitWarning();

function describeToolCallCapAndReset(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyToolCalls: 2,
          // Wide on purpose. The claim is that the *proxy's* meter is what
          // stops the loop, and a loop-side cap of 2 would stop it first and
          // make this case prove the wrong thing — quietly, and with the same
          // number of upstream calls.
          maxToolCallsPerTask: 20
        }
      },
      script: [
        call("call-1"),
        call("call-2"),
        call("call-3"),
        says("I have run out of budget."),
        // The second task, after the operator's reset.
        call("call-4"),
        says("Two are open.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "a loop past daily_tool_calls is refused at the boundary, and an operator's reset lifts it",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000050"));

      // Two served, the third refused. The model asked three times and the
      // sheet said two, so the boundary is `>=`: the refusal came when the
      // count had *reached* the limit, not after it passed it.
      expect(upstream.callsTo("tools/call")).toHaveLength(2);
      const first = auditRows(auditDb);
      expect(first.map(row => row.outcome)).toEqual(["ran", "ran", "refused"]);
      expect(first[2]).toMatchObject({ channel: CHANNEL, refusal_reason: "budget_exhausted" });

      // Which limit, in the words the model actually read. The two limits have
      // distinct prose, so this rules out a token refusal wearing the same
      // reason code.
      expect(JSON.stringify(model.seen)).toContain(TOOL_CALL_BUDGET);

      // A refused call is never counted. The meter is written at the moment the
      // proxy commits to serving, so the number cannot be inflated by the very
      // refusals it produces — which would make the limit tighten each time a
      // channel hit it.
      expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(2);

      // And the loop-side cap did not fire. Without this the case would pass
      // just as well on a run where `max_tool_calls_per_task` stopped the task
      // and the proxy was never asked a third time.
      const task = agent.log().find(line => line.fields.event === "task");
      expect(task?.fields.stopReason).toBe("completed");
      expect(agent.slack.posted).toHaveLength(1);

      // The operator clears today's counters, from a second process against the
      // same file — the proxy has no admin route and this is the documented
      // command.
      const reset = await runBudgetCli(budgetDb, ["reset", CHANNEL]);
      expect(reset.status).toBe(0);
      expect(reset.stdout).toContain(`reset ${CHANNEL}`);
      expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(0);

      // Service resumes on the next call. Nothing was restarted and nothing was
      // signalled: the database is WAL and the meter caches nothing, so the
      // running proxy simply read what another process had written.
      await agent.slack.deliverMention(mention("Ev00000051"));
      expect(upstream.callsTo("tools/call")).toHaveLength(3);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "ran", "refused", "ran"]);
      expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(1);

      // The same process throughout, which is the half of "no restart" that an
      // outcome assertion cannot show.
      expect(rigOf(rig).proxy.log().filter(line => line.includes(`"listening"`))).toHaveLength(1);
    },
    CASE_MS
  );
}

function describeTokenCapAtTheBoundary(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          // Two turns' worth exactly, sized off the script rather than written
          // as a number: turn one's call runs under it, turn two's call is
          // judged at it.
          dailyTokens: 2 * TURN_TOKENS,
          dailyToolCalls: 200
        }
      },
      script: [call("call-1"), call("call-2"), says("I have run out of budget.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "daily_tokens refuses the call whose turn reached the limit",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000052"));

      // Turn one reported one turn's tokens and its call ran; turn two took the
      // total to the limit and its call did not.
      expect(upstream.callsTo("tools/call")).toHaveLength(1);
      const rows = auditRows(auditDb);
      expect(rows.map(row => row.outcome)).toEqual(["ran", "refused"]);
      expect(rows[1]).toMatchObject({ refusal_reason: "budget_exhausted" });
      expect(JSON.stringify(model.seen)).toContain(TOKEN_BUDGET);

      // Exactly at the limit, not past it. The third turn spends too, so this
      // is asserted as `>=` the limit rather than as an equality that a later
      // turn would break.
      const spend = spendFor(budgetDb, CHANNEL);
      expect(spend.inputTokens + spend.outputTokens).toBeGreaterThanOrEqual(2 * TURN_TOKENS);
      expect(spend.toolCalls).toBe(1);
    },
    CASE_MS
  );
}

function describeReportingNothing(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      // The compromised agent, on the wire rather than in a flag.
      spendReports: "dropped",
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyTokens: 1_000_000,
          dailyToolCalls: 1
        }
      },
      script: [call("call-1"), call("call-2"), says("I have run out of budget.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "an agent that reports no tokens at all still exhausts daily_tool_calls",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000053"));

      expect(upstream.callsTo("tools/call")).toHaveLength(1);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "refused"]);
      expect(JSON.stringify(model.seen)).toContain(TOOL_CALL_BUDGET);

      // The narrow claim, in two numbers. The token meter never moved, because
      // the agent said nothing it could move with — and the count the proxy
      // keeps itself bit anyway. Under-reporting buys nothing.
      const spend = spendFor(budgetDb, CHANNEL);
      expect(spend.toolCalls).toBe(1);
      expect(spend.inputTokens).toBe(0);
      expect(spend.outputTokens).toBe(0);
      expect(spend.cacheReadTokens).toBe(0);
      expect(spend.cacheWriteTokens).toBe(0);
    },
    CASE_MS
  );
}

function describeReplayedTurnIds(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      // Every report sent twice: a retry loop, a restart replaying a queue, or
      // an agent trying to make a channel look spent.
      spendReports: "replayed",
      script: [call("call-1"), says("Two are open.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "a replayed turn id is answered duplicate and charged once",
    async () => {
      const { agent, proxy, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000054"));

      // The replay really happened. This is the case's own non-vacuity guard: a
      // decorator that quietly sent one copy would produce no duplicate line,
      // and every assertion below would pass for the wrong reason. Read from
      // the proxy, which is the authority on what it counted — the agent is
      // handed the first answer and never learns of the second.
      await proxy.waitForLog({ event: "spend_reported", channel: CHANNEL, report: "duplicate" });

      // And charged once. Two turns at one turn's tokens each, not four.
      const spend = spendFor(budgetDb, CHANNEL);
      expect(spend.inputTokens + spend.outputTokens).toBe(2 * TURN_TOKENS);
      expect(spend.toolCalls).toBe(1);
    },
    CASE_MS
  );
}

function describeCacheWeighting(): void {
  let rig: Rig | undefined;

  /** Five times the limit raw, a twentieth of it at the sheet's ratio. */
  const CACHE_READS = 500;

  beforeAll(async () => {
    rig = await startRig({
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyTokens: 100,
          dailyToolCalls: 200,
          // Written out rather than left to the schema's default, because this
          // case is about the ratio and a sheet that did not name it would make
          // the arithmetic below depend on a number nothing here says.
          cacheReadWeight: 0.1
        }
      },
      script: [
        withUsage(call("call-1"), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: CACHE_READS }),
        withUsage(call("call-2"), { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: CACHE_READS }),
        says("I have run out of budget.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "cache reads are charged at the sheet's ratio, and exhaust the budget at it",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000055"));

      // Turn one reported five times the limit in raw cache reads and its call
      // ran, because the sheet prices them at a tenth: 500 * 0.1 = 50, under
      // 100. Counting them at full weight would have refused here.
      expect(upstream.callsTo("tools/call")).toHaveLength(1);

      // Turn two took the weighted total to exactly 100 and its call was
      // refused. So they are not free either — a model cannot move its spend
      // into a bucket the operator did not price at zero.
      const rows = auditRows(auditDb);
      expect(rows.map(row => row.outcome)).toEqual(["ran", "refused"]);
      expect(rows[1]).toMatchObject({ refusal_reason: "budget_exhausted" });
      expect(JSON.stringify(model.seen)).toContain(TOKEN_BUDGET);

      // The meter stored the raw counts and the sheet decided what they cost:
      // a thousand cache reads recorded against a limit of a hundred. And the
      // ordinary tokens are nowhere near it — the final turn reports a handful
      // — so what exhausted this channel was the weighted cache reads and
      // nothing else.
      const spend = spendFor(budgetDb, CHANNEL);
      expect(spend.cacheReadTokens).toBeGreaterThanOrEqual(2 * CACHE_READS);
      expect(spend.inputTokens + spend.outputTokens).toBeLessThan(100);
    },
    CASE_MS
  );
}

// The dimension #62 added to the meter, end to end. Nothing here enforces a
// dollar cap — `daily_usd` parses and is not read in this build — so what this
// proves is the *plumbing* the cap will rest on: that the model the provider
// echoed reaches the proxy's counters through five hops and a strict wire
// schema, and that a turn naming none lands somewhere no price table can reach.
//
// Worth having before the enforcement rather than with it. If the id does not
// arrive, a dollar cap built on top refuses every channel in the deployment, and
// the failure would look like a pricing bug rather than a plumbing one.
function describeServedModel(): void {
  let rig: Rig | undefined;

  /** Not `SERVED_MODEL`: a router's answer differs from what the sheet asked. */
  const ROUTED = "claude-opus-4-6";

  beforeAll(async () => {
    rig = await startRig({
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyTokens: 1_000_000,
          dailyToolCalls: 200
        }
      },
      script: [
        call("call-1"),
        // The same task, served by something else. A LiteLLM sidecar resolving
        // an alias mid-day is the case, and it is the one `[llm] model` cannot
        // describe.
        servedBy(call("call-2"), ROUTED),
        // And a provider that echoed nothing at all.
        servedBy(call("call-3"), undefined),
        says("Three checked.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "meters each turn against the model that served it, and names the unreported ones",
    async () => {
      const { agent, upstream, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000058"));

      // Nothing was refused: this build prices nothing, so the counters moved
      // and every call ran. That is the control for everything below — a case
      // where calls were refused would prove the plumbing by accident.
      expect(upstream.callsTo("tools/call")).toHaveLength(3);

      const spend = spendFor(budgetDb, CHANNEL);
      const buckets = new Map(spend.byModel.map(bucket => [bucket.model, bucket]));

      // Four turns — three calls and the answer — across three buckets.
      expect([...buckets.keys()].sort()).toEqual(["(unreported)", ROUTED, SERVED_MODEL].sort());

      const tokensIn = (model: string): number => {
        const bucket = buckets.get(model);
        return bucket === undefined ? -1 : bucket.inputTokens + bucket.outputTokens;
      };

      // Sized off the script rather than written as numbers: turns 1 and 4 ran
      // on the sheet's model, turn 2 on the router's answer, turn 3 on nothing.
      // Asserting the exact split is what makes this a test of attribution
      // rather than of arithmetic — a meter that filed every turn under one id
      // would still total correctly.
      expect(tokensIn(SERVED_MODEL)).toBe(2 * TURN_TOKENS);
      expect(tokensIn(ROUTED)).toBe(TURN_TOKENS);
      expect(tokensIn("(unreported)")).toBe(TURN_TOKENS);

      // The totals still read as they always did. `daily_tokens` is summed
      // across the buckets, so splitting them changed no limit that existed
      // before this.
      expect(spend.inputTokens + spend.outputTokens).toBe(4 * TURN_TOKENS);
      expect(spend.toolCalls).toBe(3);

      // The operator's read of which spelling to price, which is the thing they
      // cannot get from the team sheet.
      await rigOf(rig).proxy.waitForLog({
        event: "spend_reported",
        channel: CHANNEL,
        model: ROUTED
      });
    },
    CASE_MS
  );
}

// The other half of the meter (#99): the soft limit, which warns rather than
// refusing. Here rather than in its own file because it is the same two
// counters and the same sheet — and because the claim that matters is a
// *contrast* with every case above: the call runs.
function describeSoftLimitWarning(): void {
  let rig: Rig | undefined;

  /** A fifth of twenty is four, so the fifth call is the one that crosses. */
  const LIMIT = 20;

  beforeAll(async () => {
    rig = await startRig({
      sheets: {
        [CHANNEL]: {
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }],
          dailyToolCalls: LIMIT,
          warnAt: 0.2,
          // Wide, for the reason the first case's is: the claim is that the
          // proxy warned and went on serving, and a loop-side cap that ended
          // the task first would make that untestable.
          maxToolCallsPerTask: 20
        }
      },
      script: [
        call("call-1"),
        call("call-2"),
        call("call-3"),
        call("call-4"),
        call("call-5"),
        says("Five checked."),
        // A second task, well past the threshold and nowhere near the limit.
        call("call-6"),
        says("One more.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "warns in the thread once a day and serves the call that crossed",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000056"));

      // Every call ran. That is the whole difference from the cases above: the
      // soft limit is not a refusal, and nothing here was denied.
      expect(upstream.callsTo("tools/call")).toHaveLength(5);
      expect(auditRows(auditDb).map(row => row.outcome)).toEqual(["ran", "ran", "ran", "ran", "ran"]);
      expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(5);

      // In the thread, naming the limit and the channel's position against it —
      // the position *before* the call that carried it, which is the number the
      // decision was made against.
      const [first] = agent.slack.posted;
      expect(first?.text).toContain("Five checked.");
      expect(first?.text).toContain(`Budget: this channel has made 4 of its ${LIMIT} daily tool calls.`);

      // And nowhere near the model. A warning in a tool result would be re-sent
      // as context on every later turn, and the remedy it asks for — a larger
      // number in the sheet — is not the model's to reach for.
      expect(JSON.stringify(model.seen)).not.toContain("Budget");

      // Once a day. The second task is further past the threshold than the
      // first ever was, and it is told nothing: the claim is the proxy's, made
      // against its own meter, and it was spent.
      await agent.slack.deliverMention(mention("Ev00000057"));

      expect(upstream.callsTo("tools/call")).toHaveLength(6);
      const [, second] = agent.slack.posted;
      expect(second?.text).toBe("One more.");
      expect(agent.slack.posted.filter(post => post.text.includes("Budget:"))).toHaveLength(1);
    },
    CASE_MS
  );
}
