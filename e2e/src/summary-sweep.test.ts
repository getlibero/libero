// The quiescence sweep, driven through the production composition (#308, #231).
//
// This closes the loop `deletion-derived.test.ts` opened. That file plants its
// summaries by hand and says why: "the rig composes createServer without the
// quiescence sweep." It does now, when a case asks — so this is the file that
// proves the sweep writes what that one deletes.
//
// ## Why no mention is delivered here
//
// The sweep fires from the message ingest, never from a mention, so a file that
// delivers only plain messages has **no task at all** — and every entry in its
// script is therefore a background turn. That is what makes the script
// unambiguous: a scripted entry consumed by something other than the sweep would
// be a bug this file could not see, and here there is nothing else to consume
// one.
//
// ## What the sheet says, and what it deliberately does not
//
// `memory: { summarize: true }` with `enabled` left false. The sweep gates on
// `summarize` alone (`session/summarize.ts`), so this is both the smallest
// fixture and a real deployment: threads are summarized into the channel's
// searchable memory, and no curation turn runs to eat a script entry.
//
// Before #308 that distinction was invisible, because `channels.ts` wrote only
// `enabled` and every sheet in this suite carried `summarize = true` from the
// schema's prefault. See that file.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompletionResponse } from "@getlibero/agent";
import { SWEEP_INTERVAL_MS, toSlackTs } from "@getlibero/server";
import {
  CHANNEL,
  auditRows,
  calls,
  rigOf,
  spendFor,
  startRig,
  withUsage
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const TEAM = "T024BE7LD";

/**
 * What a summarization turn reports, chosen so nothing else in this file could
 * have reported it.
 *
 * `TURN_TOKENS`' rule: a budget assertion should name the turn it is about.
 */
const SUMMARY_USAGE = { inputTokens: 700, outputTokens: 31 } as const;
const SUMMARY_TOKENS = SUMMARY_USAGE.inputTokens + SUMMARY_USAGE.outputTokens;

/**
 * Real time plus an offset, forward only.
 *
 * The ingest stamps `at` on the real clock and the sweep compares a thread's
 * newest `ts` against `now - idleMs`, so a fictional past would make every
 * message look like the future. `RigOptions.passClock`'s rule.
 */
let passAt = Date.now();
const passClock = (): number => passAt;

/** One turn's answer: record a summary of the shape and text given. */
function records(shape: string, text: string): CompletionResponse {
  return withUsage(calls("record_thread_summary", { shape, text }), { ...SUMMARY_USAGE });
}

let rig: Rig | undefined;

function inspect<T>(storeRoot: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(storeRoot, CHANNEL, "store.db"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Every thread summary in the channel's file. */
function summaries(storeRoot: string): Array<{
  thread_ts: string;
  shape: string;
  text: string;
  covers_through_ts: string;
  message_count: number;
}> {
  return inspect(storeRoot, db =>
    db
      .prepare(
        "SELECT thread_ts, shape, text, covers_through_ts, message_count FROM thread_summary ORDER BY thread_ts"
      )
      .all()
  ) as never;
}

/** Whether this file has ever held a vector, at all. */
function hasVectorTable(storeRoot: string): boolean {
  const rows = inspect(storeRoot, db =>
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_embedding'").all()
  );
  return rows.length > 0;
}

function embeddingSources(storeRoot: string): number {
  const row = inspect(storeRoot, db =>
    db.prepare("SELECT count(*) AS n FROM embedding_source").get()
  ) as { n: number };
  return row.n;
}

/**
 * The words a pass logs when it failed, which is how a case notices.
 *
 * `ingest.ts` fires each pass as `void … .catch(() => {})` and every pass
 * catches its own provider failure, so a script that ran out inside one does
 * **not** fail as "the model was asked for turn N" — it fails ten seconds later
 * as a `waitForLog` timeout on an event that never came. Assert this first.
 */
function expectNoPassFailure(agent: { log(): Array<{ fields: { event: string } }> }): void {
  const failures = agent
    .log()
    .map(line => line.fields.event)
    .filter(event =>
      ["summary_failed", "summary_embed_failed", "skill_reconcile_failed"].includes(event)
    );
  expect(failures).toEqual([]);
}

const message = (text: string, ts: string, threadTs?: string) => ({
  teamId: TEAM,
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text,
  ts,
  ...(threadTs === undefined ? {} : { threadTs })
});

describe("the quiescence sweep", () => {
  beforeAll(async () => {
    rig = await startRig({
      passes: ["summarize"],
      passClock,
      // Two entries, and the file delivers no mention — so both are the sweep's.
      // The second is the attack: a summarization turn reaching for a proxied
      // tool it was never offered.
      script: [
        records("question_answered", "The team decided to ship on Thursday."),
        withUsage(calls("list_prs", { repo: "getlibero/libero" }), { ...SUMMARY_USAGE })
      ],
      sheets: {
        // `url` is the rig's to fill in — only it knows where the fake
        // upstream bound.
        [CHANNEL]: {
          tools: [{ name: "list_prs", approval: "none" }],
          memory: { summarize: true }
        }
      }
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  });

  it(
    "summarizes a thread that went quiet, charges it to the channel, and writes no vector",
    async () => {
      const { agent, storeRoot, budgetDb, channelsRoot } = rigOf(rig);

      // Three hours quiet, past the sixty-minute default. Computed from the pass
      // clock rather than written as a literal, so the two cannot drift.
      const quiet = passAt - 3 * 60 * 60 * 1000;
      const root = toSlackTs(quiet);
      await agent.slack.deliverMessage(message("when do we ship?", root));
      await agent.slack.deliverMessage(message("Thursday.", toSlackTs(quiet + 1_000), root));

      // The first delivery already ran a sweep and stamped the interval, so the
      // second was a no-op — that is the interval doing its job. Step past it,
      // then deliver a **fresh** message so the trigger is not itself a stale
      // thread this sweep would also summarize.
      passAt += SWEEP_INTERVAL_MS + 1_000;
      await agent.slack.deliverMessage(message("unrelated", toSlackTs(passAt)));

      await agent.waitForLog({ event: "summarized", channel: CHANNEL }, 1);
      expectNoPassFailure(agent);

      const written = summaries(storeRoot);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        thread_ts: root,
        shape: "question_answered",
        text: "The team decided to ship on Thursday.",
        covers_through_ts: toSlackTs(quiet + 1_000),
        message_count: 2
      });

      // The documented degradation, asserted rather than assumed: with no
      // embedding provider a summary is still written and stored, and only its
      // vector is skipped. This file never asked for one.
      expect(hasVectorTable(storeRoot)).toBe(false);
      expect(embeddingSources(storeRoot)).toBe(0);

      // The claim only this suite can make: a model call nobody asked for, on
      // the proxy's own meter, in another process.
      const spend = spendFor(budgetDb, CHANNEL);
      expect(spend.inputTokens + spend.outputTokens).toBe(SUMMARY_TOKENS);

      // The sweep writes into the agent's state root and nowhere else.
      expect(existsSync(join(channelsRoot.path, CHANNEL, "store.db"))).toBe(false);
    },
    CASE_MS
  );

  it(
    "keeps a summarization turn that reaches for a proxied tool away from every gate",
    async () => {
      const { agent, storeRoot, auditDb, upstream } = rigOf(rig);
      const before = auditRows(auditDb).length;
      const upstreamBefore = upstream.callsTo("tools/call").length;

      passAt += SWEEP_INTERVAL_MS + 1_000;
      const quiet = passAt - 3 * 60 * 60 * 1000;
      const root = toSlackTs(quiet);
      await agent.slack.deliverMessage(message("and the incident?", root));
      await agent.slack.deliverMessage(message("closed.", toSlackTs(quiet + 1_000), root));

      passAt += SWEEP_INTERVAL_MS + 1_000;
      await agent.slack.deliverMessage(message("unrelated again", toSlackTs(passAt)));

      await agent.waitForLog({ event: "summary_unusable", channel: CHANNEL }, 1);

      // A row is still written, shaped `nothing` — the runaway guard, so the
      // thread is not re-swept and re-paid for forever.
      const written = summaries(storeRoot).find(row => row.thread_ts === root);
      expect(written).toMatchObject({ shape: "nothing", text: "" });
      expect(hasVectorTable(storeRoot)).toBe(false);

      // And the call reached nothing. The turn is offered one tool and has no
      // executor behind it, so an invented name is a model talking to itself:
      // no upstream request, and no audit row, because the proxy never saw it.
      expect(upstream.callsTo("tools/call")).toHaveLength(upstreamBefore);
      expect(auditRows(auditDb)).toHaveLength(before);
    },
    CASE_MS
  );
});
