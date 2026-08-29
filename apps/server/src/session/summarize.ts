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
//   - **`maySpend`** (#335). Before the first model call of a sweep, this pass
//     asks whether the channel is over its caps at all, and does nothing if it
//     is. That is new, and it is the first time this process declines to spend
//     rather than merely reporting what it spent — see below.
//
// ## Declining is this process's own, and it fails closed
//
// Until #335 the rule here was that nothing refused a call: the tool proxy
// service does that, and this process only reports. That was true enough while
// the meter's only job was refusing tool calls, and it is not true of a
// summarization turn — a completion never reaches that service, so a turn that
// calls no tool met no gate at all, however far over its caps a channel was.
// `maySpend` is the question that closes it.
//
// **It is this process's decision, and therefore it fails closed.**
// `./sheet.ts` falls back *open* when it cannot read a sheet, and states why: a
// fallback cannot loosen an authorization decision, because the authorization
// decision is not made there. Run that sentence backwards and you have this one.
// The decision *is* made here — nothing downstream will catch a completion — so
// a question that cannot be answered means the turn does not run.
//
// The sharper argument for that direction: during an outage this pass's spend
// would be not merely unbounded but **unrecorded**, because `reportTurn` fails
// the same way and for the same reason. Failing open would make an outage the
// one condition under which background work spends freely and invisibly.
//
// **It is not a boundary**, and the caller's own documentation says so: a
// compromised agent process does not ask. This is the same standing
// `[memory] enabled` has, stated in `packages/schema/src/team-sheet.ts` — the
// block is honoured by the agent and by nothing else, so it holds against a
// model that has been talked into something and not against a compromised
// process.

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
  /**
   * Whether this channel may be spent for at all (#335). Must not throw.
   *
   * Required rather than optional, which is `reportTurn`'s standing and the same
   * argument: an option that defaulted would default to *unbounded*, and a
   * deployment that forgot to wire it would look exactly like one whose channels
   * are all under their caps. `./skill-lifecycle.ts` is the pass that holds
   * neither of these, and it holds neither because it spends nothing — the
   * pairing is what makes that legible.
   *
   * The policy behind the boolean lives with the caller, where the logger is:
   * this pass is told yes or no and does not learn why.
   */
  maySpend: (channel: string) => Promise<boolean>;
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

    // Nothing quiet to summarize. An early return rather than a loop that does
    // not run, because the budget question below must not be asked by a channel
    // that was never going to spend.
    if (stale.length === 0) return 0;

    // Here rather than at the head of the sweep, and after the sheet check and
    // the read above for a sharper reason than tidiness: this is a network round
    // trip, and asking it on a channel that has turned summarization off — or
    // has no quiet thread to summarize — would spend one per message on a
    // deployment that was never going to spend anything. A non-empty `stale` is
    // what makes the question worth asking, because it is the point at which the
    // next thing this pass does costs money (#335).
    if (!(await options.maySpend(channel))) return 0;

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
    if (result.summary.shape !== "nothing") {
      await embed(channel, store, thread, result, `${turnId}.embed`);
    }

    logger.log("info", { event: "summarized", channel, reason: result.summary.shape });
    return true;
  }

  /**
   * The vector, when this deployment has somewhere to get one.
   *
   * **Metered, and on its own turn id.** An embedding call is spend whether it
   * was spent writing the corpus or reading it — `reportTurn`'s own doc in
   * ../index.ts says so, and `recall.ts` has always reported the read side. This
   * is the write side, which did not until #298: the response's `usage` was
   * fetched and dropped, so a channel's summarization embeddings never reached
   * `daily_tokens`.
   *
   * `turnId` is the completion turn's with `.embed` on it — recall's
   * `${traceId}.recall` shape — and the suffix is what makes it work rather than
   * cosmetic. The proxy's meter dedupes on turn id, so reusing the summarization
   * turn's would have this discarded as a retry of it. Sharing the base keeps
   * the crash-retry property the base id was chosen for: a second attempt at the
   * same thread at the same watermark is the same pair of ids and is counted
   * once.
   *
   * Reported **before** `putEmbedding`, which is recall's ordering and the
   * loop's: what was paid for is counted even if what it bought is then dropped.
   */
  async function embed(
    channel: string,
    store: MessageStore,
    thread: StaleThread,
    result: SummarizationTurnResult,
    turnId: string
  ): Promise<void> {
    const client = options.embedding;
    const model = options.embeddingModel;
    if (client === null || model === undefined) return;

    try {
      const response = await client.embed({ model, texts: [result.summary.text] });

      // An absent `usage` means the provider did not report, which is not the
      // same as free — so nothing is reported rather than a zero being invented.
      if (response.usage !== undefined) {
        await options.reportTurn(channel, {
          usage: { inputTokens: response.usage.inputTokens, outputTokens: 0 },
          turn: 0,
          id: turnId,
          ...(response.model === undefined ? {} : { model: response.model }),
          // What the gateway said this embedding cost, when one said
          // anything (#239). An embedding call is where the unit shows: nine
          // tokens through LiteLLM is 1.8e-07 USD, which is 180 nano-USD and
          // nothing at all at micro.
          ...(response.costNanoUsd === undefined ? {} : { costNanoUsd: response.costNanoUsd })
        });
      }

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
