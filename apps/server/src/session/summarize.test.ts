// The sweep, against a real store.
//
// `packages/memory` is opened for real here rather than faked, because half of
// what this module does is expressed in SQL that lives there — which threads are
// stale, and what the triggers do to a summary when its thread changes. A fake
// store would let both sides of that agree with each other and with nothing.
// The model and the embedding provider are faked at their client seams, which is
// where every other test in this tree fakes them.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CompletedTurn,
  CompletionClient,
  CompletionResponse,
  EmbeddingClient
} from "@getlibero/agent";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore, StoredMessage } from "@getlibero/memory";
import { openMessageStore } from "@getlibero/memory";
import {
  MAX_THREADS_PER_SWEEP,
  SWEEP_INTERVAL_MS,
  createSummarySweep,
  toSlackTs
} from "./summarize.js";
import type { SummarizeSettings, SummarySweepOptions } from "./summarize.js";

const CHANNEL = "C0ENGINEERING";

/** Fixed wall clock, so "quiet" is a decision the test makes rather than a race. */
const NOW = 1_749_998_700_000;
const MINUTE = 60_000;

const SETTINGS: SummarizeSettings = {
  summarize: true,
  idleMs: 60 * MINUTE,
  model: "test-model",
  maxTokens: 1024
};

let root: string;
let file: string;
let store: MessageStore;

/** A message at a ts derived from a wall-clock instant, so idleness is legible. */
function at(msAgo: number, text: string, thread: string | null = null): StoredMessage {
  return {
    ts: toSlackTs(NOW - msAgo),
    threadTs: thread,
    userId: "U0ALICE",
    displayName: "alice",
    text,
    at: NOW - msAgo
  };
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

/** A completion client that records one summary, and counts how often it was called. */
function summarizing(
  args: Record<string, unknown> | null,
  onCall?: () => void
): { completion: CompletionClient; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    completion: {
      complete: (): Promise<CompletionResponse> => {
        calls += 1;
        onCall?.();
        return Promise.resolve({
          text: "",
          toolCalls:
            args === null
              ? []
              : [{ id: `call_${String(calls)}`, name: "record_thread_summary", arguments: args }],
          stopReason: "tool_use",
          usage: { inputTokens: 500, outputTokens: 20 },
          model: "served-model"
        });
      }
    }
  };
}

/** An embedding client answering one fixed vector. */
function embedding(vector = [1, 0, 0]): EmbeddingClient {
  return {
    embed: ({ texts }) =>
      Promise.resolve({
        vectors: texts.map(() => Float32Array.from(vector)),
        model: "test-embedding-model",
        usage: { inputTokens: 10 }
      })
  };
}

function sweepWith(overrides: Partial<SummarySweepOptions> = {}) {
  const reported: Array<CompletedTurn & { id: string }> = [];
  const base: SummarySweepOptions = {
    completion: summarizing({ shape: "decision", text: "Chose slim over alpine." }).completion,
    embedding: null,
    settings: () => Promise.resolve(SETTINGS),
    reportTurn: (_channel, turn) => {
      reported.push(turn);
      return Promise.resolve();
    },
    now: () => NOW,
    ...overrides
  };
  return { sweep: createSummarySweep(base), reported };
}

/** Reads past the module's API, the way `store-db.test.ts` does. */
function summaries(): Array<{ thread_ts: string; shape: string; text: string }> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT thread_ts, shape, text FROM thread_summary ORDER BY thread_ts").all() as Array<{
      thread_ts: string;
      shape: string;
      text: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-sweep-"));
  mkdirSync(join(root, CHANNEL));
  file = join(root, CHANNEL, "store.db");
  store = openMessageStore({ channel: CHANNEL, root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("createSummarySweep", () => {
  it("summarizes a thread that has gone quiet", async () => {
    store.append(at(90 * MINUTE, "how do we rotate a cert?"));
    store.append(at(89 * MINUTE, "--rotate then --promote", toSlackTs(NOW - 90 * MINUTE)));

    const { sweep } = sweepWith();
    expect(await sweep(CHANNEL, store)).toBe(1);

    expect(summaries()).toEqual([
      {
        thread_ts: toSlackTs(NOW - 90 * MINUTE),
        shape: "decision",
        text: "Chose slim over alpine."
      }
    ]);
  });

  // The correctness condition, not politeness. A summary written mid-argument
  // records that the team was weighing X against Y, gets embedded, and is then
  // retrieved by exactly the question it is worst at answering.
  it("leaves a thread that is still being talked in alone", async () => {
    store.append(at(90 * MINUTE, "how do we rotate a cert?"));
    store.append(at(2 * MINUTE, "still thinking", toSlackTs(NOW - 90 * MINUTE)));

    const { sweep } = sweepWith();
    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(summaries()).toEqual([]);
  });

  it("skips a channel whose sheet turns summarization off", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));

    const summarizer = summarizing({ shape: "decision", text: "x" });
    const { sweep } = sweepWith({
      completion: summarizer.completion,
      settings: () => Promise.resolve({ ...SETTINGS, summarize: false })
    });

    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(summarizer.calls()).toBe(0);
  });

  it("skips a channel with no sheet at all", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));
    const { sweep } = sweepWith({ settings: () => Promise.resolve(null) });

    expect(await sweep(CHANNEL, store)).toBe(0);
  });

  it("honours the channel's own idle threshold", async () => {
    store.append(at(20 * MINUTE, "quiet for twenty minutes"));

    const { sweep: strict } = sweepWith();
    expect(await strict(CHANNEL, store)).toBe(0);

    const { sweep: relaxed } = sweepWith({
      settings: () => Promise.resolve({ ...SETTINGS, idleMs: 10 * MINUTE })
    });
    expect(await relaxed(CHANNEL, store)).toBe(1);
  });

  // A busy channel must not sweep per message.
  it("does not sweep again inside the interval", async () => {
    store.append(at(90 * MINUTE, "one"));
    store.append(at(91 * MINUTE, "two"));
    store.append(at(92 * MINUTE, "three"));
    store.append(at(93 * MINUTE, "four"));

    const summarizer = summarizing({ shape: "decision", text: "x" });
    let clock = NOW;
    const { sweep } = sweepWith({ completion: summarizer.completion, now: () => clock });

    expect(await sweep(CHANNEL, store)).toBe(MAX_THREADS_PER_SWEEP);
    expect(await sweep(CHANNEL, store)).toBe(0);

    clock = NOW + SWEEP_INTERVAL_MS + 1;
    expect(await sweep(CHANNEL, store)).toBe(1);
  });

  // The bound that matters on a channel's first sweep, where every thread in its
  // history is quiet and unsummarized at once.
  it("summarizes at most MAX_THREADS_PER_SWEEP threads in one sweep", async () => {
    for (let i = 0; i < 10; i++) store.append(at((90 + i) * MINUTE, `thread ${String(i)}`));

    const { sweep } = sweepWith();
    expect(await sweep(CHANNEL, store)).toBe(MAX_THREADS_PER_SWEEP);
    expect(summaries()).toHaveLength(MAX_THREADS_PER_SWEEP);
  });

  it("reports every turn's spend under an id the meter can dedupe", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));
    const { sweep, reported } = sweepWith();

    await sweep(CHANNEL, store);

    expect(reported).toHaveLength(1);
    expect(reported[0]?.usage).toEqual({ inputTokens: 500, outputTokens: 20 });
    expect(reported[0]?.model).toBe("served-model");
    // <thread>-<watermark>: the same id on a retry, a different one once the
    // thread has said more.
    expect(reported[0]?.id).toBe(
      `summary-${toSlackTs(NOW - 90 * MINUTE)}-${toSlackTs(NOW - 90 * MINUTE)}`
    );
  });

  // The row records that a thread was assessed; the vector store is the corpus.
  // Without the row the sweep pays a model call to conclude "nothing" forever.
  it("stores a `nothing` row and embeds no vector for it", async () => {
    store.append(at(90 * MINUTE, "deploying now"));

    const { sweep } = sweepWith({
      completion: summarizing({ shape: "nothing", text: "" }).completion,
      embedding: embedding(),
      embeddingModel: "test-embedding-model"
    });

    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(summaries()).toEqual([
      { thread_ts: toSlackTs(NOW - 90 * MINUTE), shape: "nothing", text: "" }
    ]);
    expect(store.nearest(Float32Array.from([1, 0, 0]), 5)).toEqual([]);
  });

  it("embeds a summary that has a shape worth retrieving", async () => {
    store.append(at(90 * MINUTE, "how do we rotate a cert?"));

    const { sweep } = sweepWith({
      completion: summarizing({
        shape: "question_answered",
        text: "Q: how do you rotate a cert? A: --rotate then --promote."
      }).completion,
      embedding: embedding(),
      embeddingModel: "test-embedding-model"
    });

    await sweep(CHANNEL, store);

    expect(store.nearest(Float32Array.from([1, 0, 0]), 5).map(hit => hit.source)).toEqual([
      { kind: "summary", ref: toSlackTs(NOW - 90 * MINUTE) }
    ]);
  });

  // #230's degradation, carried through: the row is still written, so a
  // deployment that configures a provider later has a corpus to embed rather
  // than a history to re-summarize.
  it("stores the summary with no embedding provider configured", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));
    const { sweep } = sweepWith({ embedding: null });

    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(summaries()).toHaveLength(1);
  });

  it("keeps the summary when embedding fails", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));
    const { lines, logger } = capturingLogger();
    const { sweep } = sweepWith({
      embedding: { embed: () => Promise.reject(new Error("embed upstream down")) },
      embeddingModel: "test-embedding-model",
      logger
    });

    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(summaries()).toHaveLength(1);
    expect(lines.map(line => line.event)).toContain("summary_embed_failed");
  });

  // A provider outage must not permanently mark a channel's threads as holding
  // nothing, so no row is written and the thread stays stale.
  it("writes no row when the provider fails, so a later sweep retries", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));
    const { lines, logger } = capturingLogger();
    const { sweep } = sweepWith({
      completion: { complete: () => Promise.reject(new Error("upstream down")) },
      logger
    });

    expect(await sweep(CHANNEL, store)).toBe(0);
    expect(summaries()).toEqual([]);
    expect(lines.map(line => line.event)).toContain("summary_failed");
  });

  // The opposite side: a model that cannot follow the schema will fail the same
  // way on the same thread forever, so the row is written and the sweep moves on.
  it("writes a `nothing` row when the model's answer is unusable", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));
    const { lines, logger } = capturingLogger();
    const { sweep } = sweepWith({
      completion: summarizing({ shape: "gossip", text: "who said what" }).completion,
      logger
    });

    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(summaries()[0]?.shape).toBe("nothing");
    expect(lines.map(line => line.event)).toContain("summary_unusable");
  });

  it("does not summarize a thread again once it is covered", async () => {
    store.append(at(90 * MINUTE, "quiet thread"));
    const summarizer = summarizing({ shape: "decision", text: "x" });
    let clock = NOW;
    const { sweep } = sweepWith({ completion: summarizer.completion, now: () => clock });

    await sweep(CHANNEL, store);
    clock = NOW + SWEEP_INTERVAL_MS + 1;
    await sweep(CHANNEL, store);

    expect(summarizer.calls()).toBe(1);
  });

  it("summarizes again once the thread has said more", async () => {
    const rootTs = toSlackTs(NOW - 90 * MINUTE);
    store.append(at(90 * MINUTE, "quiet thread"));
    const summarizer = summarizing({ shape: "decision", text: "x" });
    let clock = NOW;
    const { sweep, reported } = sweepWith({ completion: summarizer.completion, now: () => clock });

    await sweep(CHANNEL, store);
    store.append(at(80 * MINUTE, "one more thing", rootTs));
    clock = NOW + SWEEP_INTERVAL_MS + 1;
    await sweep(CHANNEL, store);

    expect(summarizer.calls()).toBe(2);
    expect(summaries()).toHaveLength(1);
    // Different watermark, so the meter counts it rather than deduping it away.
    expect(reported[0]?.id).not.toBe(reported[1]?.id);
  });

  // #231's acceptance criterion, driven through the real store: an edit to a
  // source message invalidates the summary, and the next sweep regenerates it.
  it("regenerates after an edit to one of the thread's messages", async () => {
    const rootTs = toSlackTs(NOW - 90 * MINUTE);
    store.append(at(90 * MINUTE, "how do we rotate a cert?"));
    store.append(at(89 * MINUTE, "--rotate then --promote", rootTs));

    const summarizer = summarizing({ shape: "decision", text: "x" });
    let clock = NOW;
    const { sweep } = sweepWith({
      completion: summarizer.completion,
      embedding: embedding(),
      embeddingModel: "test-embedding-model",
      now: () => clock
    });

    await sweep(CHANNEL, store);
    // The positive control: it was there before the edit.
    expect(summaries()).toHaveLength(1);
    expect(store.nearest(Float32Array.from([1, 0, 0]), 5)).toHaveLength(1);

    store.replaceText(toSlackTs(NOW - 89 * MINUTE), "actually, edit the sheet in between");

    expect(summaries()).toEqual([]);
    expect(store.nearest(Float32Array.from([1, 0, 0]), 5)).toEqual([]);

    clock = NOW + SWEEP_INTERVAL_MS + 1;
    expect(await sweep(CHANNEL, store)).toBe(1);
    expect(summaries()).toHaveLength(1);
  });

  it("stops summarizing when the process is stopping", async () => {
    for (let i = 0; i < 3; i++) store.append(at((90 + i) * MINUTE, `thread ${String(i)}`));

    const controller = new AbortController();
    const summarizer = summarizing({ shape: "decision", text: "x" }, () => controller.abort());
    const { sweep } = sweepWith({ completion: summarizer.completion, signal: controller.signal });

    expect(await sweep(CHANNEL, store)).toBe(1);
  });
});

describe("toSlackTs", () => {
  // The comparison `staleThreads` makes is a string one, which is correct only
  // while both sides are the same width.
  it("is fixed-width: ten digits, a dot, six more", () => {
    expect(toSlackTs(NOW)).toMatch(/^\d{10}\.\d{6}$/);
    expect(toSlackTs(0)).toBe("0000000000.000000");
  });

  it("orders the same as the instants it came from", () => {
    expect(toSlackTs(NOW - MINUTE) < toSlackTs(NOW)).toBe(true);
  });
});
