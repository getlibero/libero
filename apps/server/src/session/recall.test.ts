// Recall, against a real store.
//
// `packages/memory` is opened for real rather than faked, for the reason
// `summarize.test.ts` gives: the half worth testing is the nearest-neighbour
// query and the trigger behaviour around it, both of which live in SQL.
//
// **The embedding provider is not faked here any more.** Since #292 the call
// lives in ./embed.ts and recall takes the vector it produced, so what is
// supplied below is a point out of the same hand-built space the summaries were
// stored with — see `EMBEDDINGS`. The provider's own behaviour, its metering,
// and what an empty question does are `embed.test.ts`'s now.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore, StoredMessage } from "@getlibero/memory";
import { openMessageStore } from "@getlibero/memory";
import { RECALL_LIMIT, RECALL_MAX_CHARS, createRecall } from "./recall.js";
import type { RecallOptions } from "./recall.js";

const CHANNEL = "C0ENGINEERING";

let root: string;
let store: MessageStore;

/**
 * A hand-built embedding space, and the reason this test can make the claim the
 * issue asks for.
 *
 * Each entry maps a phrase to a point. The two "certificate rotation" phrases
 * sit together and **share no word with each other**, which is what lets the
 * no-shared-stem assertion below be a real test of vector recall rather than a
 * test of the fake: FTS5 over the same corpus is run beside it and finds
 * nothing, and that comparison is the whole point.
 */
const EMBEDDINGS: Record<string, number[]> = {
  // Cluster one: rolling client credentials, said two different ways.
  "how do we roll a new key for a channel": [1, 0, 0],
  // The same question with no article in it, at the same point, and it exists
  // for the no-shared-stem control alone. Since #522 `search` widens from AND
  // to OR when the AND finds nothing, so the phrase above shares `a` with the
  // summary below and the control matched on that one word — which was never
  // what the criterion meant by a shared stem. This one shares nothing at all.
  "how do we roll new keys per channel": [1, 0, 0],
  "rotating a client certificate: --rotate, edit the sheet, --promote": [0.98, 0.02, 0],
  // Cluster two: something else entirely.
  "what did we pick for the base image": [0, 1, 0],
  "chose Debian slim over Alpine because sqlite-vec ships glibc prebuilds": [0, 0.98, 0.02],
  // Cluster three, far from both.
  "unrelated": [0, 0, 1]
};

function vectorFor(text: string): Float32Array {
  const point = EMBEDDINGS[text];
  if (point === undefined) throw new Error(`the fixture has no embedding for: ${text}`);
  return Float32Array.from(point);
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

function message(ts: string, text: string, threadTs: string | null = null): StoredMessage {
  return { ts, threadTs, userId: "U0ALICE", displayName: "alice", text, at: 1_700_000_000_000 };
}

/** A summarized thread: one message, one summary, one vector. */
function summarized(thread: string, text: string, shape = "question_answered" as const): void {
  store.append(message(thread, text));
  store.putThreadSummary({
    thread,
    shape,
    text,
    coversThroughTs: thread,
    messageCount: 1,
    at: 1_700_000_000_000
  });
  store.putEmbedding({
    source: { kind: "summary", ref: thread },
    vector: vectorFor(text),
    model: "test-embedding-model",
    at: 1_700_000_000_000
  });
}

function recallWith(overrides: Partial<RecallOptions> = {}) {
  return { recall: createRecall({ ...overrides }) };
}

/**
 * A question, already embedded — which is what recall takes now.
 *
 * The query text is still named rather than a bare vector, so a case reads as a
 * question being asked. `vectorFor` is the same fixture the summaries were
 * stored with, which is what makes "shares no stem" a real claim.
 */
const ask = (query: string) => ({
  channel: CHANNEL,
  store,
  vector: vectorFor(query),
  enabled: true
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-recall-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("createRecall", () => {
  // **#232's acceptance criterion.** The query and the summary it retrieves
  // share no word, so no stemmer relates them — and the FTS5 assertion beside it
  // is the control that says so rather than being taken on trust.
  it("retrieves a summary that shares no stem with the query", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    summarized("2.1", "chose Debian slim over Alpine because sqlite-vec ships glibc prebuilds");

    const query = "how do we roll new keys per channel";

    // The control: Layer 1 cannot answer this. Not one word of the query
    // appears in either summary, so there is nothing for the index to match on
    // — under the conjunction it runs first, or under the widened retry behind
    // it. See the fixture for why this phrasing rather than the other one.
    expect(store.search(query, 10)).toEqual([]);

    const { recall } = recallWith();
    const recalled = await recall(ask(query));

    // Nearest first. Both summaries come back because there is no distance
    // cutoff — see the argument in recall.ts — so what the criterion turns on is
    // that the *right* one leads, against a query sharing none of its words.
    expect(recalled[0]?.thread).toBe("1.1");
    expect(recalled[0]?.text).toContain("--promote");
  });

  // The decision recorded beside `RECALL_MAX_CHARS`, kept as a test so that
  // adding a cutoff later is a deliberate change rather than a silent one.
  it("applies no distance cutoff, so a small corpus contributes all of itself", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    summarized("2.1", "chose Debian slim over Alpine because sqlite-vec ships glibc prebuilds");

    const { recall } = recallWith();
    const recalled = await recall(ask("how do we roll a new key for a channel"));

    expect(recalled.map(summary => summary.thread)).toEqual(["1.1", "2.1"]);
  });

  it("orders what it found by nearness", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    summarized("2.1", "chose Debian slim over Alpine because sqlite-vec ships glibc prebuilds");

    const { recall } = recallWith();
    const recalled = await recall(ask("how do we roll a new key for a channel"));

    expect(recalled.map(summary => summary.thread)).toEqual(["1.1", "2.1"]);
  });

  it("carries each summary's shape and thread, so a reply can point at what it rests on", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");

    const { recall } = recallWith();
    const recalled = await recall(ask("how do we roll a new key for a channel"));

    expect(recalled[0]).toEqual({
      thread: "1.1",
      shape: "question_answered",
      text: "rotating a client certificate: --rotate, edit the sheet, --promote"
    });
  });

  // The same switch that writes the corpus, rather than a third one: a channel
  // that turned summarization off should not go on being answered out of
  // summaries it asked to stop producing.
  it("recalls nothing when the channel turned summarization off", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");

    const { recall } = recallWith();
    const recalled = await recall({
      ...ask("how do we roll a new key for a channel"),
      enabled: false
    });

    expect(recalled).toEqual([]);
  });

  // #230's degradation, carried to the read side — and, since #292, arriving as
  // a null vector rather than as a null client. It collapses three cases
  // ./embed.ts keeps apart, and this end treats all three the same because a
  // summary has no index but its vector. **`skill-recall.test.ts` asserts the
  // opposite for the same input**, which is the asymmetry both headers name.
  it("recalls nothing with no vector, whatever produced the null", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");

    const { recall } = recallWith();

    expect(
      await recall({ ...ask("how do we roll a new key for a channel"), vector: null })
    ).toEqual([]);
  });

  it("recalls nothing for a channel with no summaries yet", async () => {
    const { recall } = recallWith();

    expect(await recall(ask("how do we roll a new key for a channel"))).toEqual([]);
  });

  it("logs a count and never the summaries themselves", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    const { lines, logger } = capturingLogger();
    const { recall } = recallWith({ logger });

    await recall(ask("how do we roll a new key for a channel"));

    const recalled = lines.find(line => line.event === "recalled");
    expect(recalled?.count).toBe(1);
    // Through `count` and not `totalTokens` (#429): summaries recalled were a
    // term in the sum an operator does over the spend field.
    expect(recalled).not.toHaveProperty("totalTokens");
    expect(JSON.stringify(lines)).not.toContain("--promote");
  });

  // A vector outlives its summary for as long as it takes a trigger to fire, so
  // a hit whose summary went away is skipped rather than fatal. Driven through
  // the real trigger: editing the thread's message drops the summary.
  it("skips a hit whose summary was invalidated", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    summarized("2.1", "chose Debian slim over Alpine because sqlite-vec ships glibc prebuilds");

    // The positive control: both are reachable first.
    const { recall } = recallWith();
    expect(await recall(ask("how do we roll a new key for a channel"))).toHaveLength(2);

    store.replaceText("1.1", "actually, something else entirely");

    const after = await recall(ask("how do we roll a new key for a channel"));
    expect(after.map(summary => summary.thread)).toEqual(["2.1"]);
  });

  // A `nothing` summary is a row with no text and no vector, so it should never
  // surface — but the row exists, and a bug that embedded one would show up here.
  it("never returns a summary with no text", async () => {
    store.append(message("1.1", "deploying now"));
    store.putThreadSummary({
      thread: "1.1",
      shape: "nothing",
      text: "",
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1
    });
    store.putEmbedding({
      source: { kind: "summary", ref: "1.1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "test-embedding-model",
      at: 1
    });

    const { recall } = recallWith();

    expect(await recall(ask("how do we roll a new key for a channel"))).toEqual([]);
  });

  // Curated facts reach a task through `<channel-memory>`, whole. Nothing
  // produces `fact` vectors today, and if something does they are not this
  // block's to render.
  it("ignores sources that are not summaries", async () => {
    store.putEmbedding({
      source: { kind: "fact", ref: "f1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "test-embedding-model",
      at: 1
    });

    const { recall } = recallWith();

    expect(await recall(ask("how do we roll a new key for a channel"))).toEqual([]);
  });

  it("returns at most RECALL_LIMIT summaries", async () => {
    for (let i = 0; i < RECALL_LIMIT + 3; i++) {
      const thread = `${String(i + 1)}.1`;
      store.append(message(thread, "filler"));
      store.putThreadSummary({
        thread,
        shape: "decision",
        text: `summary ${String(i)}`,
        coversThroughTs: thread,
        messageCount: 1,
        at: 1
      });
      store.putEmbedding({
        source: { kind: "summary", ref: thread },
        vector: Float32Array.from([1 - i / 100, 0, 0]),
        model: "test-embedding-model",
        at: 1
      });
    }

    const { recall } = recallWith();

    expect(await recall(ask("how do we roll a new key for a channel"))).toHaveLength(RECALL_LIMIT);
  });

  // Dropped from the least similar end, unlike the transcript's bound which
  // drops the oldest: here the ordering is relevance and not time.
  it("stops at RECALL_MAX_CHARS, keeping the nearest", async () => {
    const long = "x".repeat(RECALL_MAX_CHARS - 100);
    store.append(message("1.1", "near"));
    store.putThreadSummary({
      thread: "1.1",
      shape: "decision",
      text: long,
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1
    });
    store.putEmbedding({
      source: { kind: "summary", ref: "1.1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "test-embedding-model",
      at: 1
    });
    store.append(message("2.1", "far"));
    store.putThreadSummary({
      thread: "2.1",
      shape: "decision",
      text: "y".repeat(500),
      coversThroughTs: "2.1",
      messageCount: 1,
      at: 1
    });
    store.putEmbedding({
      source: { kind: "summary", ref: "2.1" },
      vector: Float32Array.from([0.5, 0.5, 0]),
      model: "test-embedding-model",
      at: 1
    });

    const { recall } = recallWith();
    const recalled = await recall(ask("how do we roll a new key for a channel"));

    expect(recalled.map(summary => summary.thread)).toEqual(["1.1"]);
  });

  // ## #427: the distance of every hit
  //
  // These lines are written for an analysis rather than for an operator, and
  // what makes them worth anything is the part these cases pin: one line per
  // hit *whatever became of it*, a rank and a distance beside it, and not a
  // word of what was recalled. The distances were being computed and dropped,
  // so no deployment however long-lived produced the distribution #283 needs.

  it("records a line for every hit, with its rank and its distance", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    summarized("2.1", "chose Debian slim over Alpine because sqlite-vec ships glibc prebuilds");
    const { lines, logger } = capturingLogger();
    const { recall } = recallWith({ logger });

    await recall(ask("how do we roll a new key for a channel"));

    const hits = lines.filter(line => line.event === "recall_hit");
    expect(hits.map(hit => [hit.kind, hit.threadTs, hit.rank, hit.disposition])).toEqual([
      ["summary", "1.1", 1, "loaded"],
      ["summary", "2.1", 2, "loaded"]
    ]);
    // The numbers themselves and not merely their presence. Nearer is smaller,
    // which is the property the whole measurement rests on — a line carrying a
    // constant, or a rank order the distance contradicted, would look like this
    // one at every level above the value.
    const near = hits[0]?.distance ?? Number.NaN;
    const far = hits[1]?.distance ?? Number.NaN;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
  });

  // The case the `break` this replaced used to lose. A hit that was near and
  // got cut for length and a hit that was simply far are different things, and
  // a distribution that cannot separate them answers neither of #283's
  // questions.
  it("records the hits the character bound cut, not only the ones it loaded", async () => {
    store.append(message("1.1", "near"));
    store.putThreadSummary({
      thread: "1.1",
      shape: "decision",
      text: "x".repeat(RECALL_MAX_CHARS - 100),
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1
    });
    store.putEmbedding({
      source: { kind: "summary", ref: "1.1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "test-embedding-model",
      at: 1
    });
    store.append(message("2.1", "far"));
    store.putThreadSummary({
      thread: "2.1",
      shape: "decision",
      text: "y".repeat(500),
      coversThroughTs: "2.1",
      messageCount: 1,
      at: 1
    });
    store.putEmbedding({
      source: { kind: "summary", ref: "2.1" },
      vector: Float32Array.from([0.5, 0.5, 0]),
      model: "test-embedding-model",
      at: 1
    });
    const { lines, logger } = capturingLogger();
    const { recall } = recallWith({ logger });

    const recalled = await recall(ask("how do we roll a new key for a channel"));

    expect(recalled.map(summary => summary.thread)).toEqual(["1.1"]);
    const hits = lines.filter(line => line.event === "recall_hit");
    expect(hits.map(hit => [hit.threadTs, hit.disposition])).toEqual([
      ["1.1", "loaded"],
      ["2.1", "dropped_chars"]
    ]);
  });

  // A hit the block could not turn into text is still a distance the k-NN
  // answered, so it is still recorded — with the word that says nothing reached
  // the model.
  //
  // Driven through a vector pointing at a `nothing` summary rather than through
  // `replaceText`, and the difference is worth knowing: editing the thread's
  // message drops the summary *and* its vector, so that hit does not come back
  // at all. What this reaches is the branch that survives — a row the k-NN can
  // find and the loop cannot use.
  it("records a hit whose summary carries no text", async () => {
    store.append(message("1.1", "deploying now"));
    store.putThreadSummary({
      thread: "1.1",
      shape: "nothing",
      text: "",
      coversThroughTs: "1.1",
      messageCount: 1,
      at: 1
    });
    store.putEmbedding({
      source: { kind: "summary", ref: "1.1" },
      vector: Float32Array.from([1, 0, 0]),
      model: "test-embedding-model",
      at: 1
    });
    summarized("2.1", "chose Debian slim over Alpine because sqlite-vec ships glibc prebuilds");
    const { lines, logger } = capturingLogger();
    const { recall } = recallWith({ logger });

    const recalled = await recall(ask("how do we roll a new key for a channel"));

    expect(recalled.map(summary => summary.thread)).toEqual(["2.1"]);
    const hits = lines.filter(line => line.event === "recall_hit");
    expect(hits.map(hit => [hit.threadTs, hit.disposition])).toEqual([
      ["1.1", "unresolved"],
      ["2.1", "loaded"]
    ]);
  });

  it("never carries a summary's text on a hit line", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    const { lines, logger } = capturingLogger();
    const { recall } = recallWith({ logger });

    await recall(ask("how do we roll a new key for a channel"));

    const hits = lines.filter(line => line.event === "recall_hit");
    expect(hits).toHaveLength(1);
    expect(JSON.stringify(hits)).not.toContain("--promote");
    // The thread id is the point rather than an oversight: it is an id and not
    // content, and it is what lets whoever reads the distribution open the
    // conversation and judge the hit relevant or not.
    expect(hits[0]?.threadTs).toBe("1.1");
  });
});
