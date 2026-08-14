// The quiescence sweep: what turns a channel's quiet threads into the second
// corpus semantic recall reads (#231).
//
// Everything about *how* a thread is summarized is in `runSummarizationTurn` in
// `@getlibero/agent`, and everything about how one is stored is in
// `packages/memory`. This module is the part neither of those can hold: deciding
// which threads are ready, and when to look.
//
// ## Why a sweep and not a timer
//
// A thread is ready when it has gone quiet, and "gone quiet" is a thing that
// becomes true through nothing happening — which is exactly what no event fires
// for. The obvious implementation is a timer per thread; this is not that.
//
// `./threads.ts` already solved the same problem the same way for follow-up
// windows: it keeps deadlines and lets the next call sweep the expired ones,
// "rather than holding a timer per thread". A deadline that nobody looks at has
// not been missed, it is simply not yet observed, and observing it one message
// late costs nothing. So the sweep runs on channel activity, and a channel that
// has gone completely silent stops summarizing — which is correct, because the
// threads in it are already summarized or were never going to be.
//
// ## What bounds it
//
// This is the first model spend in the deployment that does not follow a
// mention, so what stops it running away is worth stating in one place.
//
//   - **The sheet.** `[memory] summarize` turns it off, and
//     `summarize_after_idle_minutes` says how quiet is quiet.
//   - **`SWEEP_INTERVAL_MS`.** A busy channel does not sweep per message.
//   - **`MAX_THREADS_PER_SWEEP`.** One sweep cannot fire twenty model calls, so a
//     channel that has just been provisioned against a long backlog summarizes
//     it over many sweeps instead of in one burst.
//   - **The meter.** Every turn reports through the same `SpendReport` path as
//     every other turn, so `daily_tokens` and `daily_usd` bound it the way they
//     bound a task. That is the backstop and not the mechanism.
//
// ## And what does not bound it
//
// Nothing here refuses a call — the proxy's meter does that, and this process
// only reports. That is the same standing `[memory] enabled` has, stated in
// `packages/schema/src/team-sheet.ts`: this block is honoured by the agent and
// by nothing else, so it holds against a model that has been talked into
// something and not against a compromised agent process.

import type {
  EmbeddingClient,
  SummarizationMessage,
  SummarizationTurnResult
} from "@getlibero/agent";
import { runSummarizationTurn } from "@getlibero/agent";
import type { CompletionClient } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore, StaleThread } from "@getlibero/memory";
import type { CompletedTurn } from "@getlibero/agent";

/**
 * How often one channel may sweep.
 *
 * Not a sheet field, because it is not a fact about how a team talks — it is how
 * often this process bothers to look, and looking is a SQLite query. Five
 * minutes means a thread that goes quiet is picked up within five minutes of the
 * channel's next message, which is inside the noise of an idle threshold
 * measured in tens of minutes.
 */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The most threads one sweep will summarize.
 *
 * The bound that matters on the first sweep of an existing channel, where every
 * thread in the file's history is quiet and unsummarized at once. Three per
 * sweep spreads that over the channel's next few hours rather than spending a
 * day's budget in one minute — and `staleThreads` answers newest-first, so what
 * gets summarized first is what people most recently stopped talking about.
 */
export const MAX_THREADS_PER_SWEEP = 3;

/**
 * The most messages of one thread that go to the model.
 *
 * `READ_MAX_LIMIT` in `packages/memory` is 200 and would already clamp this; the
 * lower figure here is about the summary rather than the read. One vector stands
 * for one summary, so a thread far past this is one whose summary is an average
 * of several conversations and retrieves none of them well. See the ceiling
 * noted in `packages/memory/README.md`.
 */
export const MAX_THREAD_MESSAGES = 60;

/** What the sweep needs from a channel's sheet. Resolved by `./sheet.ts`. */
export interface SummarizeSettings {
  /** `[memory] summarize`. */
  readonly summarize: boolean;
  /** `[memory] summarize_after_idle_minutes`, in ms. */
  readonly idleMs: number;
  /** The model id this channel completes with. */
  readonly model: string;
  /** `[llm] max_tokens_per_turn`. */
  readonly maxTokens: number;
}

export interface SummarySweepOptions {
  completion: CompletionClient;
  /**
   * How this deployment embeds, or `null` when it does not (#230).
   *
   * **A summary is still written and stored when this is null**, and only the
   * vector is skipped. That is the honest degradation: the row is the record
   * that a thread was assessed, so a deployment that later configures an
   * embedding provider has a corpus to embed rather than a channel's history to
   * re-summarize.
   */
  embedding: EmbeddingClient | null;
  /** The embedding model id, when `embedding` is set. Stamped against vectors. */
  embeddingModel?: string;
  /** The channel's summarization settings. `null` skips the channel entirely. */
  settings: (channel: string) => Promise<SummarizeSettings | null>;
  /** Reports one turn's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  logger?: Logger;
  now?: () => number;
  /** Cancels in-flight work when the process is stopping. */
  signal?: AbortSignal;
}

/**
 * Sweeps one channel, if it is due.
 *
 * Returns how many threads it summarized, which is what its tests assert on and
 * what a caller may ignore. **Never rejects**: it is called from the message
 * ingest path, where nothing is waiting on it and a failure must not cost a
 * channel its message write.
 */
export type SummarySweep = (channel: string, store: MessageStore) => Promise<number>;

export function createSummarySweep(options: SummarySweepOptions): SummarySweep {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  // When each channel last swept.
  //
  // In this closure rather than on the session, because it is this module's
  // business and the session type is shared with everything else under here. One
  // number per channel the process has seen, never evicted — which is bounded by
  // how many channels a workspace has, and each entry is a number.
  const lastSweptAt = new Map<string, number>();

  return async (channel, store) => {
    const startedAt = now();
    const previous = lastSweptAt.get(channel);
    if (previous !== undefined && startedAt - previous < SWEEP_INTERVAL_MS) return 0;
    // Stamped before the work rather than after, so a slow sweep does not let a
    // second one start behind it.
    lastSweptAt.set(channel, startedAt);

    let settings: SummarizeSettings | null;
    try {
      settings = await options.settings(channel);
    } catch {
      // The resolver is documented total; this is defence rather than a path.
      // A channel whose sheet cannot be read summarizes nothing, which is the
      // same direction `[memory] enabled` falls back in.
      return 0;
    }
    if (settings === null || !settings.summarize) return 0;

    const idleBefore = toSlackTs(startedAt - settings.idleMs);

    let stale: readonly StaleThread[];
    try {
      stale = store.staleThreads(idleBefore, MAX_THREADS_PER_SWEEP);
    } catch (error) {
      logger.log("warn", { event: "summary_failed", channel, reason: reasonOf(error) });
      return 0;
    }

    let summarized = 0;
    for (const thread of stale) {
      if (options.signal?.aborted === true) break;
      if (await summarizeThread(channel, store, thread, settings)) summarized += 1;
    }
    return summarized;
  };

  /** One thread, end to end. Answers whether a row was written. */
  async function summarizeThread(
    channel: string,
    store: MessageStore,
    thread: StaleThread,
    settings: SummarizeSettings
  ): Promise<boolean> {
    const rows = store.recentInThread(thread.thread, MAX_THREAD_MESSAGES);
    const messages: SummarizationMessage[] = rows.map(row => ({
      // The name captured when the message was stored, falling back to the id.
      // Which one it is does not matter to the model — what it is for is telling
      // speakers apart so that "who owns it" has an answer.
      author: row.displayName ?? row.userId,
      text: row.text
    }));

    // The id the meter dedupes on. `<thread>-<watermark>` rather than a counter,
    // so a retry after a crash is the same id and is counted once, while a
    // genuinely second summary — the thread said more — is a different one.
    const turnId = `summary-${thread.thread}-${thread.newestTs}`;

    let result: SummarizationTurnResult;
    try {
      result = await runSummarizationTurn({
        completion: options.completion,
        model: settings.model,
        messages,
        maxTokens: settings.maxTokens,
        turn: 1,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        onTurn: async turn => {
          await options.reportTurn(channel, { ...turn, id: turnId });
        }
      });
    } catch (error) {
      // The provider failed. **No row is written**, so the thread stays stale and
      // a later sweep tries again — which is the right side to fall on, because
      // a provider outage must not permanently mark a channel's threads as
      // holding nothing.
      logger.log("warn", { event: "summary_failed", channel, reason: reasonOf(error) });
      return false;
    }

    if (result.malformed !== undefined) {
      // A model that could not follow the schema. The row **is** written, as
      // `nothing`: the same thread with the same content will fail the same way,
      // and re-sweeping it every five minutes forever is the runaway this design
      // is most exposed to. Logged distinctly from the failure above, so an
      // operator can tell "quiet channel" from "the model cannot comply".
      logger.log("warn", { event: "summary_unusable", channel, reason: result.malformed });
    }

    store.putThreadSummary({
      thread: thread.thread,
      shape: result.summary.shape,
      text: result.summary.text,
      coversThroughTs: thread.newestTs,
      messageCount: thread.messageCount,
      at: now()
    });

    // Only what has a shape worth retrieving is embedded. A `nothing` row keeps
    // the sweep from asking again; a `nothing` vector would sit in the
    // neighbourhood of every query and dilute it.
    if (result.summary.shape !== "nothing") await embed(channel, store, thread, result);

    logger.log("info", { event: "summarized", channel, reason: result.summary.shape });
    return true;
  }

  /** The vector, when this deployment has somewhere to get one. */
  async function embed(
    channel: string,
    store: MessageStore,
    thread: StaleThread,
    result: SummarizationTurnResult
  ): Promise<void> {
    const client = options.embedding;
    const model = options.embeddingModel;
    if (client === null || model === undefined) return;

    try {
      const response = await client.embed({ model, texts: [result.summary.text] });
      const vector = response.vectors[0];
      if (vector === undefined) return;
      store.putEmbedding({
        source: { kind: "summary", ref: thread.thread },
        vector,
        // The **served** model, falling back to what was asked for. The store
        // stamps this against every vector in the file and refuses a later one
        // that disagrees, so what matters is that it is stable rather than that
        // it is echoed.
        model: response.model ?? model,
        at: now()
      });
    } catch (error) {
      // The summary is already stored. An embedding that failed leaves a row
      // recall cannot reach yet, which is a smaller loss than re-summarizing —
      // and #232 is where a rebuild for exactly this case belongs.
      logger.log("warn", { event: "summary_embed_failed", channel, reason: reasonOf(error) });
    }
  }
}

/**
 * A wall-clock instant as a Slack `ts`.
 *
 * Fixed-width — ten digits of seconds, a dot, six more — because
 * `staleThreads` compares it as a string against stored timestamps, which is
 * correct only while both are the same width. `padStart` rather than trusting
 * the epoch to stay ten digits: it does until 2286, and a bound that holds by
 * arithmetic is cheaper than one that holds by luck.
 */
export function toSlackTs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const micros = Math.floor((ms - seconds * 1000) * 1000);
  return `${String(seconds).padStart(10, "0")}.${String(micros).padStart(6, "0")}`;
}

/**
 * A reason code from an error, and never its message.
 *
 * `./store.ts`'s rule: a provider's message can carry a URL, a key fragment, or
 * a channel's own words back into a log line.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
