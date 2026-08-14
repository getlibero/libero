// Recall, against a real store.
//
// `packages/memory` is opened for real rather than faked, for the reason
// `summarize.test.ts` gives: the half worth testing is the nearest-neighbour
// query and the trigger behaviour around it, both of which live in SQL. The
// embedding provider is faked at its client seam, and the fake is what makes the
// acceptance criterion checkable at all — see `EMBEDDINGS` below.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompletedTurn, EmbeddingClient } from "@getlibero/agent";
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

function embeddingClient(): EmbeddingClient {
  return {
    embed: ({ texts }) =>
      Promise.resolve({
        vectors: texts.map(vectorFor),
        model: "test-embedding-model",
        usage: { inputTokens: 12 }
      })
  };
}

/** A provider that reports no usage. `TokenUsage`'s "absent is not zero". */
function unmeteredEmbeddingClient(): EmbeddingClient {
  return {
    embed: ({ texts }) =>
      Promise.resolve({ vectors: texts.map(vectorFor), model: "test-embedding-model" })
  };
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
  const reported: Array<CompletedTurn & { id: string }> = [];
  return {
    reported,
    recall: createRecall({
      embedding: embeddingClient(),
      embeddingModel: "test-embedding-model",
      reportTurn: (_channel, turn) => {
        reported.push(turn);
        return Promise.resolve();
      },
      ...overrides
    })
  };
}

const ask = (query: string) => ({
  channel: CHANNEL,
  store,
  query,
  enabled: true,
  turnId: "T1.recall"
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

    const query = "how do we roll a new key for a channel";

    // The control: Layer 1 cannot answer this. Not one word of the query appears
    // in the summary, so there is nothing for the index to match on.
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

    const { recall, reported } = recallWith();
    const recalled = await recall({ ...ask("how do we roll a new key for a channel"), enabled: false });

    expect(recalled).toEqual([]);
    // And it costs nothing: the embedding call is not made either.
    expect(reported).toEqual([]);
  });

  // #230's degradation, carried to the read side.
  it("recalls nothing with no embedding provider configured", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");

    const { recall } = recallWith({ embedding: null });

    expect(await recall(ask("how do we roll a new key for a channel"))).toEqual([]);
  });

  it("recalls nothing for a channel with no summaries yet", async () => {
    const { recall } = recallWith();

    expect(await recall(ask("how do we roll a new key for a channel"))).toEqual([]);
  });

  it("recalls nothing for an empty question, without calling the provider", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    const { recall, reported } = recallWith();

    expect(await recall({ ...ask("how do we roll a new key for a channel"), query: "   " })).toEqual(
      []
    );
    expect(reported).toEqual([]);
  });

  it("meters the query embedding as input tokens with no output", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    const { recall, reported } = recallWith();

    await recall(ask("how do we roll a new key for a channel"));

    expect(reported).toEqual([
      {
        usage: { inputTokens: 12, outputTokens: 0 },
        turn: 0,
        id: "T1.recall",
        model: "test-embedding-model"
      }
    ]);
  });

  it("reports nothing when the provider reports no usage", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    const { recall, reported } = recallWith({ embedding: unmeteredEmbeddingClient() });

    await recall(ask("how do we roll a new key for a channel"));

    expect(reported).toEqual([]);
  });

  // Recall is an improvement to an answer, not a precondition for one.
  it("answers nothing rather than throwing when the provider fails", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    const { lines, logger } = capturingLogger();
    const { recall } = recallWith({
      embedding: { embed: () => Promise.reject(new Error("embed upstream down")) },
      logger
    });

    await expect(recall(ask("how do we roll a new key for a channel"))).resolves.toEqual([]);
    expect(lines.map(line => line.event)).toContain("recall_failed");
  });

  it("logs a count and never the summaries themselves", async () => {
    summarized("1.1", "rotating a client certificate: --rotate, edit the sheet, --promote");
    const { lines, logger } = capturingLogger();
    const { recall } = recallWith({ logger });

    await recall(ask("how do we roll a new key for a channel"));

    const recalled = lines.find(line => line.event === "recalled");
    expect(recalled?.totalTokens).toBe(1);
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
});
