// Slack retention reaches derived data, driven through the real event path
// (#233).
//
// `packages/memory` proves the triggers fire when `remove` and `replaceText` are
// called. `apps/server` proves the sweep writes what those triggers later drop.
// Neither proves the thing an operator is actually promised, which is that
// **deleting a message in Slack** removes what was derived from it — because
// between the Slack event and `store.remove` there is a gateway that normalizes
// three different wire shapes, an ingest that routes them, and a session that
// owns the file handle. This file is that link.
//
// ## Why the derived rows are planted rather than summarized
//
// This rig composes `createServer` without the quiescence sweep — it names no
// `passes`, so nothing here writes a summary on its own. Wiring one in would
// mean sheet fields and messages back-dated past an idle threshold, all to
// arrive at a row this test could have written directly, and it would put a
// second writer into the very tables this case counts.
//
// Since #308 the rig *can* compose one, and `summary-sweep.test.ts` is where it
// does: that file proves the sweep writes these rows and this one proves a Slack
// deletion takes them away. Keeping them apart is the point rather than an
// accident of ordering.
//
// What matters is that the rows are real rows in the real file, put there
// through the same package the sweep uses, and that **nothing in this test
// deletes them**. The only thing that touches them is a Slack event.
//
// ## The positive control is not optional here
//
// Every "the derived data is gone" assertion below would also pass on a run
// where the summary was never written, or was written to another channel's
// file, or where the vec table does not exist. So each case reads the rows back
// through a plain handle *before* the deletion and asserts they are there. The
// suite's rule, and this is the case it was written for.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMessageStore } from "@getlibero/memory";
import { getLoadablePath } from "sqlite-vec";
import { CHANNEL, rigOf, says, startRig } from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const TEAM = "T024BE7LD";

let rig: Rig | undefined;

/** The channel's file. */
function storeFile(storeRoot: string): string {
  return join(storeRoot, CHANNEL, "store.db");
}

/**
 * A read-only handle with sqlite-vec loaded, held by nobody in the process.
 *
 * The extension is loaded because one of the four tables this test looks at is
 * a `vec0` virtual table and a plain handle cannot query it — which is itself a
 * fact `packages/memory` asserts. Read-only, so this cannot be the thing that
 * removed anything.
 */
function inspect<T>(storeRoot: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(storeFile(storeRoot), { readOnly: true, allowExtension: true });
  try {
    db.loadExtension(getLoadablePath());
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * What the file holds for one thread, across every table that derives from it.
 *
 * Scoped to the thread on purpose. The rig is shared across the cases in this
 * file, so a count over a whole table would be a count of everything every
 * earlier case left behind.
 *
 * `vectorId` is the rowid the thread's vector is filed under, or `null`. It is
 * read *before* a deletion and asserted on afterwards, because the vec row's
 * removal has to be checkable independently of the provenance row's: joining the
 * two would answer zero either way and prove only that the join found nothing.
 */
function derivedRows(
  storeRoot: string,
  thread: string
): { messages: number; summaries: number; sources: number; vectorId: number | null } {
  if (!existsSync(storeFile(storeRoot))) {
    return { messages: 0, summaries: 0, sources: 0, vectorId: null };
  }
  return inspect(storeRoot, db => {
    const count = (sql: string, ...binds: string[]): number =>
      Number((db.prepare(sql).get(...binds) as { n: number | bigint }).n);
    const source = db
      .prepare(
        "SELECT id FROM embedding_source WHERE source_kind = 'summary' AND source_ref = ?"
      )
      .get(thread) as { id: number | bigint } | undefined;
    return {
      messages: count("SELECT count(*) AS n FROM message WHERE ts = ? OR thread_ts = ?", thread, thread),
      summaries: count("SELECT count(*) AS n FROM thread_summary WHERE thread_ts = ?", thread),
      sources: count(
        "SELECT count(*) AS n FROM embedding_source WHERE source_kind = 'summary' AND source_ref = ?",
        thread
      ),
      vectorId: source === undefined ? null : Number(source.id)
    };
  });
}

/** Whether one vector row is still in the vec table, by the rowid it was filed under. */
function vectorRows(storeRoot: string, id: number): number {
  return inspect(storeRoot, db =>
    Number(
      (db.prepare("SELECT count(*) AS n FROM vec_embedding WHERE id = ?").get(BigInt(id)) as {
        n: number | bigint;
      }).n
    )
  );
}

/**
 * Give one thread a summary and a vector, the way the sweep would.
 *
 * A second handle on the same file, which WAL makes safe — the agent's session
 * holds its own. Written through `@getlibero/memory` because that is what puts
 * a *correct* row there; the assertions above read with a plain handle instead,
 * which is the suite's rule about not letting the writer grade its own work.
 */
function plantSummary(storeRoot: string, thread: string, text: string): void {
  const store = openMessageStore({ channel: CHANNEL, root: storeRoot });
  try {
    store.putThreadSummary({
      thread,
      shape: "question_answered",
      text,
      coversThroughTs: thread,
      messageCount: 2,
      at: 1_758_000_000_000
    });
    store.putEmbedding({
      source: { kind: "summary", ref: thread },
      vector: Float32Array.from([1, 0, 0]),
      model: "test-embedding-model",
      at: 1_758_000_000_000
    });
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  rig = await startRig({
    sheets: {
      [CHANNEL]: { credential: "github_token", tools: [{ name: "list_prs", approval: "none" }] }
    },
    script: [says("Noted.")]
  });
}, SETUP_MS);

afterAll(async () => {
  await rig?.stop();
}, SETUP_MS);

/**
 * One thread, summarized, then revised through a real Slack event.
 *
 * `kind` is the wire shape the gateway is handed. All three are exercised
 * because the gateway normalizes three into two operations, and a derived row
 * that survived one of them would survive it silently.
 */
async function threadRevisedBy(
  kind: "deleted" | "edited" | "tombstone",
  root: string,
  reply: string,
  revised: string
): Promise<{ before: ReturnType<typeof derivedRows>; after: ReturnType<typeof derivedRows> }> {
  const { agent, storeRoot } = rigOf(rig);

  await agent.slack.deliverMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    userId: "U024BE7LH",
    text: "how do we rotate a channel's client certificate?",
    ts: root
  });
  await agent.slack.deliverMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    userId: "U024BE7LH",
    text: "dev-certs.sh --rotate, edit the sheet, then --promote",
    ts: reply,
    threadTs: root
  });

  plantSummary(storeRoot, root, "Q: how do you rotate a client certificate? A: --rotate, --promote.");

  const before = derivedRows(storeRoot, root);

  await agent.slack.deliverRevision({
    teamId: TEAM,
    channelId: CHANNEL,
    kind,
    ts: revised,
    text: "redacted",
    eventId: `Ev0REV${kind}${revised}`
  });

  return { before, after: derivedRows(storeRoot, root) };
}

describe("a Slack deletion reaches what was derived from the message", () => {
  it(
    "removes the thread's summary and its embedding when a reply is deleted",
    async () => {
      const root = "1758000100.000100";
      const { before, after } = await threadRevisedBy(
        "deleted",
        root,
        "1758000100.000200",
        "1758000100.000200"
      );

      // The positive control. Without this every assertion below also passes on
      // a run where nothing was ever written.
      expect(before).toMatchObject({ messages: 2, summaries: 1, sources: 1 });
      expect(before.vectorId).not.toBeNull();

      // The message is gone, and so is everything drawn from it. A summary that
      // outlived its source would be the store asserting a conclusion reached
      // from words their author retracted.
      expect(after.messages).toBe(1);
      expect(after.summaries).toBe(0);
      expect(after.sources).toBe(0);
      // The vector itself, by the rowid it was filed under before the deletion.
      expect(vectorRows(rigOf(rig).storeRoot, before.vectorId ?? -1)).toBe(0);
    },
    CASE_MS
  );

  it(
    "removes them when the deleted message is the thread's root",
    async () => {
      const root = "1758000200.000100";
      const { before, after } = await threadRevisedBy(
        "deleted",
        root,
        "1758000200.000200",
        root
      );

      expect(before).toMatchObject({ messages: 2, summaries: 1, sources: 1 });
      expect(after.summaries).toBe(0);
      expect(after.sources).toBe(0);
      expect(vectorRows(rigOf(rig).storeRoot, before.vectorId ?? -1)).toBe(0);
    },
    CASE_MS
  );

  // An edit is the other half of the same promise: the store keeps the new text,
  // so a summary of the old text must not outlive it.
  it(
    "removes them when a message is edited rather than deleted",
    async () => {
      const root = "1758000300.000100";
      const reply = "1758000300.000200";
      const { before, after } = await threadRevisedBy("edited", root, reply, reply);

      expect(before).toMatchObject({ messages: 2, summaries: 1, sources: 1 });
      // The message survives an edit — that is what makes this the interesting
      // case — and the summary does not.
      expect(after.messages).toBe(2);
      expect(after.summaries).toBe(0);
      expect(after.sources).toBe(0);
      expect(vectorRows(rigOf(rig).storeRoot, before.vectorId ?? -1)).toBe(0);
    },
    CASE_MS
  );

  // Slack's third wire shape: a deleted thread parent with replies arrives as a
  // `message_changed` carrying a tombstone, and `toRevision` reads it as a
  // deletion. A derived row that survived only this shape would survive silently.
  it(
    "removes them when a deletion arrives as a tombstone",
    async () => {
      const root = "1758000400.000100";
      const { before, after } = await threadRevisedBy("tombstone", root, "1758000400.000200", root);

      expect(before).toMatchObject({ messages: 2, summaries: 1, sources: 1 });
      expect(after.summaries).toBe(0);
      expect(after.sources).toBe(0);
      expect(vectorRows(rigOf(rig).storeRoot, before.vectorId ?? -1)).toBe(0);
    },
    CASE_MS
  );

  // The blast radius. One thread's deletion must not reach another thread's
  // summary, which is the failure a trigger written against the wrong column
  // would produce.
  it(
    "leaves another thread's summary and vector alone",
    async () => {
      const { agent, storeRoot } = rigOf(rig);
      const kept = "1758000500.000100";
      const doomed = "1758000600.000100";

      for (const ts of [kept, doomed]) {
        await agent.slack.deliverMessage({
          teamId: TEAM,
          channelId: CHANNEL,
          userId: "U024BE7LH",
          text: `a thread starting at ${ts}`,
          ts
        });
        plantSummary(storeRoot, ts, `a summary of the thread at ${ts}`);
      }

      expect(derivedRows(storeRoot, kept).summaries).toBe(1);
      expect(derivedRows(storeRoot, doomed).summaries).toBe(1);

      await agent.slack.deliverRevision({
        teamId: TEAM,
        channelId: CHANNEL,
        kind: "deleted",
        ts: doomed,
        text: "",
        eventId: "Ev0REVISOLATION"
      });

      expect(derivedRows(storeRoot, doomed).summaries).toBe(0);
      expect(derivedRows(storeRoot, doomed).sources).toBe(0);
      // Untouched: a different thread, a different summary, a different vector.
      expect(derivedRows(storeRoot, kept).summaries).toBe(1);
      expect(derivedRows(storeRoot, kept).sources).toBe(1);
    },
    CASE_MS
  );
});
