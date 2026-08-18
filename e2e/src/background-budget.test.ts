// #335: a background turn asks the tool proxy service whether the channel can
// afford it, and a channel over its cap spends nothing.
//
// This is the one claim that cannot be made in `apps/server`. There, `maySpend`
// is a stub and "the pass declined" proves only that the stub was called. Here
// the question crosses mutual TLS to another process, which reads the meter it
// wrote when the *previous* turn reported — so what is asserted is that one
// background turn's spend closes the gate on the next one, through two processes
// and a SQLite file, with no test double anywhere in the loop.
//
// ## Why the sweep, and why no mention
//
// `summary-sweep.test.ts`'s reason: the sweep fires from the message ingest and
// never from a mention, so a file that delivers only plain messages has no task
// at all and every scripted entry is a background turn. That is what lets a case
// assert that an entry was **not** consumed — with nothing else able to consume
// one, an untouched script cursor is proof the turn did not run.
//
// ## Every fail-closed case has a control beside it
//
// `spend-budget.test.ts`'s rule, and it bites harder here than anywhere. A build
// where the budget client always threw would decline every turn and pass the
// first describe below completely — silence is exactly what a broken gate
// produces. So the second describe runs the identical sequence against a sheet
// whose cap is out of reach and shows the same sweep summarizing twice. Without
// that pairing this file would pass on a build where the read never worked.
//
// The cap is sized off the script rather than written as a figure — one summary
// turn's own tokens — so changing either breaks the case loudly instead of
// quietly changing what it proves.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompletionResponse } from "@getlibero/agent";
import { SWEEP_INTERVAL_MS, toSlackTs } from "@getlibero/server";
import { CHANNEL, calls, rigOf, spendFor, startRig, withUsage } from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const TEAM = "T024BE7LD";

/** What one summarization turn reports. The cap below is this, exactly. */
const SUMMARY_USAGE = { inputTokens: 700, outputTokens: 31 } as const;
const SUMMARY_TOKENS = SUMMARY_USAGE.inputTokens + SUMMARY_USAGE.outputTokens;

let passAt = Date.now();
const passClock = (): number => passAt;

function records(text: string): CompletionResponse {
  return withUsage(calls("record_thread_summary", { shape: "decision", text }), {
    ...SUMMARY_USAGE
  });
}

const message = (text: string, ts: string, threadTs?: string) => ({
  teamId: TEAM,
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text,
  ts,
  ...(threadTs === undefined ? {} : { threadTs })
});

function summaryCount(storeRoot: string): number {
  const db = new DatabaseSync(join(storeRoot, CHANNEL, "store.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM thread_summary").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/**
 * Plants a quiet thread and then a fresh message, which is what makes a sweep
 * run and find something.
 *
 * `summary-sweep.test.ts`'s sequence: the first delivery already swept and
 * stamped the interval, so the trigger has to be a separate, later message —
 * and it must be fresh, or the sweep would summarize the trigger too.
 */
async function plantQuietThread(
  agent: { slack: { deliverMessage(m: ReturnType<typeof message>): Promise<void> } },
  root: string
): Promise<void> {
  const quiet = passAt - 3 * 60 * 60 * 1000;
  await agent.slack.deliverMessage(message("when do we ship?", root ?? toSlackTs(quiet)));
  await agent.slack.deliverMessage(message("Thursday.", toSlackTs(quiet + 1_000), root));

  passAt += SWEEP_INTERVAL_MS + 1_000;
  await agent.slack.deliverMessage(message("unrelated", toSlackTs(passAt)));
}

describe("a background pass over its cap", () => {
  let rig: Rig | undefined;

  beforeAll(async () => {
    passAt = Date.now();
    rig = await startRig({
      passes: ["summarize"],
      passClock,
      // Two entries. The first summary is meant to be spent; the second exists
      // so that "the turn did not run" is provable — if the gate let it through,
      // this is what it would have consumed.
      script: [records("Ship on Thursday."), records("This must never be reached.")],
      sheets: {
        [CHANNEL]: {
          // No tool this file ever calls: the sweep makes no tool call, and a
          // sheet naming none would still have to name the list.
          tools: [],
          // Exactly one summarization turn's tokens. After the first sweep the
          // channel has spent its cap to the token, and `>=` is what makes the
          // next question a refusal rather than a near miss.
          dailyTokens: SUMMARY_TOKENS,
          memory: { summarize: true }
        }
      }
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  });

  it(
    "spends its cap once and is then refused, having asked another process",
    async () => {
      const { agent, storeRoot, budgetDb, model } = rigOf(rig);

      // The first sweep. Nothing has spent yet, so the channel is under its cap
      // and the turn runs.
      const first = toSlackTs(passAt - 3 * 60 * 60 * 1000);
      await plantQuietThread(agent, first);
      await agent.waitForLog({ event: "summarized", channel: CHANNEL }, 1);

      expect(summaryCount(storeRoot)).toBe(1);
      const spent = spendFor(budgetDb, CHANNEL);
      expect(spent.inputTokens + spent.outputTokens).toBe(SUMMARY_TOKENS);

      // The second sweep, on a different quiet thread. The meter now reads
      // exactly the cap, so the question the pass asks comes back a refusal.
      passAt += SWEEP_INTERVAL_MS + 1_000;
      const second = toSlackTs(passAt - 3 * 60 * 60 * 1000);
      await plantQuietThread(agent, second);
      await agent.waitForLog({ event: "budget_declined", channel: CHANNEL }, 1);

      // No second summary, and no second turn: the script's second entry is
      // still there, which nothing else in this rig could have left untouched.
      expect(summaryCount(storeRoot)).toBe(1);
      expect(model.seen).toHaveLength(1);

      // And nothing was spent by being refused. The meter reads what the one
      // turn that ran reported, not a token more.
      const after = spendFor(budgetDb, CHANNEL);
      expect(after.inputTokens + after.outputTokens).toBe(SUMMARY_TOKENS);
    },
    CASE_MS
  );
});

// The positive control. Identical sequence, a cap out of reach — and the sweep
// summarizes twice. Without this, a build whose budget read always failed would
// pass everything above.
describe("the same sweep under a cap it cannot reach", () => {
  let rig: Rig | undefined;

  beforeAll(async () => {
    passAt = Date.now();
    rig = await startRig({
      passes: ["summarize"],
      passClock,
      script: [records("Ship on Thursday."), records("And the incident is closed.")],
      sheets: {
        [CHANNEL]: {
          tools: [],
          dailyTokens: 100 * SUMMARY_TOKENS,
          memory: { summarize: true }
        }
      }
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  });

  it(
    "summarizes both threads and spends twice",
    async () => {
      const { agent, storeRoot, budgetDb, model } = rigOf(rig);

      const first = toSlackTs(passAt - 3 * 60 * 60 * 1000);
      await plantQuietThread(agent, first);
      await agent.waitForLog({ event: "summarized", channel: CHANNEL }, 1);

      passAt += SWEEP_INTERVAL_MS + 1_000;
      const second = toSlackTs(passAt - 3 * 60 * 60 * 1000);
      await plantQuietThread(agent, second);
      await agent.waitForLog({ event: "summarized", channel: CHANNEL }, 2);

      expect(summaryCount(storeRoot)).toBe(2);
      expect(model.seen).toHaveLength(2);

      const spent = spendFor(budgetDb, CHANNEL);
      expect(spent.inputTokens + spent.outputTokens).toBe(2 * SUMMARY_TOKENS);
    },
    CASE_MS
  );
});
