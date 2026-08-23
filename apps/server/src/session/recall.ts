// Semantic recall: what the channel already worked out, put in front of a task
// before it starts (#232).
//
// Layers 1 and 2 both already reach the model at task start — the transcript
// through `assembleContext`, `MEMORY.md` through `<channel-memory>`. This is the
// third, and the one that can answer a question whose words appear nowhere in
// the corpus: the query is embedded and matched against the thread summaries
// #231 writes, so "how do we roll a certificate" reaches a thread about
// rotating a client cert with no stem in common.
//
// ## Where recall enters a task, which is #232's actual question
//
// **At context assembly, agent-local, and not as a tool.** The issue named three
// shapes and this is the first; the other two are rejected here rather than
// deferred, because a decision nobody wrote down is one the next person makes
// again.
//
// **A model-invoked recall tool was rejected as an ungoverned twin.** #64
// deliberately made `search_channel_history` a *proxied built-in*: granted by a
// `[[builtin]]` block, refused when the sheet omits it, approval-gatable,
// metered, and written to the audit log — with the file's own comment insisting
// "a built-in is not a bypass". A second model-invoked read of the same
// channel's content, executed agent-side and answering to none of that, would
// not be an extension of that decision but a way around it. The fact that the
// agent process *could* read the store directly is not a counter-argument: it is
// why the built-in exists to make the model's reads observable, and building a
// second unobservable one gives that up for convenience.
//
// **Context assembly is a different act, and already ungoverned by the sheet.**
// `assembleContext` reads this channel's store for the transcript, bounded by
// `[llm] max_history_messages` and by no `[[builtin]]` grant, and injects the
// whole of `MEMORY.md` beside it. Adding retrieved summaries to that is the same
// class of thing the process already does: the *agent* decides what its own task
// starts from. Nothing here is invoked by the model, parameterised by the model,
// or reachable from a tool call.
//
// **The hybrid built-in remains the right shape if mid-task recall is ever
// wanted**, and it is rejected on cost rather than on principle: it puts a
// vector on the wire, grows `MessageReader` a nearest-neighbour query, and
// leaves an audit row recording a vector rather than a question — an operator
// reading `searched for [0.02, -0.5, …]` learns nothing. If that is ever built,
// extending the governed built-in is the consistent move; adding a twin is not.
//
// ## What it costs and who pays
//
// The query embedding is not this file's any more. It moved to ./embed.ts when
// skills needed the same vector (#292), so what arrives here is a vector
// somebody else paid for and metered; `null` means it could not be had, which
// covers a deployment with no embedding provider — #230's stated degradation —
// as well as an empty question and a provider that failed.
//
// **A null vector ends recall, and that is not what it does to skills.** The
// asymmetry is in the corpora rather than in the two files' taste: a thread
// summary's only index is its vector, so with no vector there is nothing to
// search, while a skill also carries an FTS5 index over its description and
// body and can still be retrieved on words alone. See ./skill-recall.ts, which
// says the same thing from the other side.
//
// What is still charged twice over is the block, and the second charge is the
// one to watch: it occupies part of every turn's input for the rest of the task.
// `RECALL_LIMIT` and `RECALL_MAX_CHARS` are what bound it, and they are
// deliberately small — the transcript and `MEMORY.md` are competing for the same
// context, and recall earning its place means displacing something.

import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";

/**
 * How many summaries one task may start with.
 *
 * Small on purpose. Every one of these occupies part of the input of every turn
 * for the rest of the task, competing with the transcript and `MEMORY.md` — and
 * a retrieved summary that was not relevant is not neutral, it is a distractor
 * the model has to read past. Five is enough for the question to be covered and
 * few enough that being wrong about one of them costs little.
 */
export const RECALL_LIMIT = 5;

/**
 * The most characters the block may carry, across all of it.
 *
 * `[llm] max_history_chars`'s counterpart, and a constant rather than a sheet
 * field for `SUMMARY_MAX_TEXT_CHARS`'s reason — what it bounds is what this
 * process assembles, not a policy a channel holds an opinion about. Summaries
 * are individually capped at 2048, so this is roughly three of them; the limit
 * binds before `RECALL_LIMIT` does when summaries run long, which is the right
 * order because the cost that matters is characters and not rows.
 */
export const RECALL_MAX_CHARS = 6_000;

// ## There is no distance cutoff, and that is a decision
//
// `nearest` answers the k closest vectors and nothing filters them, so a channel
// holding three summaries contributes all three to every task whether or not any
// of them bears on the question. That is this shape's known weakness — a
// retrieved summary that was not relevant is not neutral, it is a distractor the
// model reads past — and it was weighed rather than missed.
//
// A cutoff was rejected because the number cannot be written down honestly here.
// The distance is L2 over whatever the configured provider emits; for normalized
// embeddings that maps onto cosine and a cutoff near 1.0 would mean "less than
// half similar", but nothing obliges a provider to normalize, and the scale
// differs between them. A threshold tuned against one model silently drops good
// hits under another, and a recall that quietly returns nothing is a worse
// failure than one that returns something weak — the first looks like a channel
// with no memory, the second is visible and hedged.
//
// What bounds the cost instead: `RECALL_LIMIT` is small, `RECALL_MAX_CHARS` is
// smaller, and the block's preamble says these *may* bear on the question rather
// than asserting they do. A measured cutoff is the obvious next tuning knob once
// there are real embeddings and someone can look at the distances; a guessed one
// today would be a magic number nobody could defend.

/** One summary that came back, and what it was. */
export interface RecalledSummary {
  /** The thread it summarizes, as a Slack `ts`. */
  readonly thread: string;
  /** What kind of durable content the thread produced. */
  readonly shape: string;
  readonly text: string;
}

export interface RecallOptions {
  logger?: Logger;
}

export interface RecallRequest {
  readonly channel: string;
  readonly store: MessageStore;
  /**
   * The embedded question, from `./embed.ts`, or `null` when there is none.
   *
   * `null` ends recall, because a summary has no other index. See the header on
   * why the same `null` does not end skill retrieval.
   */
  readonly vector: Float32Array | null;
  /** `[memory] summarize`. False skips recall entirely — see `recallFor`. */
  readonly enabled: boolean;
}

/**
 * Retrieve what this channel already worked out that bears on the question.
 *
 * **Never rejects and never throws.** It runs on the path a mention takes, and
 * recall is an improvement to an answer rather than a precondition for one: a
 * provider outage, a store with no vectors, a channel that turned summarization
 * off all produce the same thing, which is a task that starts the way it did
 * before phase 2.
 */
export type Recall = (request: RecallRequest) => Promise<readonly RecalledSummary[]>;

export function createRecall(options: RecallOptions): Recall {
  const logger = options.logger ?? createSilentLogger();

  return async request => {
    // Two ways to have nothing to do, and neither is a failure.
    // `summarize = false` is the channel saying so with the same switch that
    // stops the corpus being written, because half a feature is a worse answer
    // than none of it; and no vector is ./embed.ts's three cases collapsed into
    // one, all of which mean there is nothing to search with.
    if (!request.enabled) return [];
    const vector = request.vector;
    if (vector === null) return [];

    try {
      // **Only summaries, and asked for as such rather than filtered after.**
      // `EmbeddingSource.kind` admits `fact`, which nothing produces — curated
      // facts reach a task through `<channel-memory>`, whole — and since #290 it
      // admits `skill`, which something very much does. Every kind shares one
      // vector table and `k` is spent inside the k-NN, so a channel holding a
      // hundred skills would fill all five of these slots with them and this
      // would answer nothing. Passing the kind moves the filter inside vec0's
      // own search, where it costs a slot nothing.
      const hits = request.store.nearest(vector, RECALL_LIMIT, "summary");
      const recalled: RecalledSummary[] = [];
      let chars = 0;

      for (const hit of hits) {

        // Resolved one at a time, and `null` is a real answer: a vector outlives
        // its summary for as long as it takes a trigger to fire, so a hit whose
        // summary was invalidated between the two is skipped rather than fatal.
        const summary = request.store.readThreadSummary(hit.source.ref);
        if (summary === null || summary.text === "") continue;

        // Dropped from the far end, which is the *least* similar — the opposite
        // of `assembleContext`, which drops the oldest. Here the ordering is
        // relevance and not time, so what a bound should shed is the weakest
        // match rather than the earliest one.
        if (chars + summary.text.length > RECALL_MAX_CHARS) break;
        chars += summary.text.length;

        recalled.push({ thread: summary.thread, shape: summary.shape, text: summary.text });
      }

      if (recalled.length > 0) {
        logger.log("info", {
          event: "recalled",
          channel: request.channel,
          // A count, never the summaries: those are a channel's conversation
          // distilled, and a log line is not where they go.
          count: recalled.length
        });
      }
      return recalled;
    } catch (error) {
      // A store that cannot answer costs the task its recall and nothing else.
      logger.log("warn", {
        event: "recall_failed",
        channel: request.channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return [];
    }
  };
}
