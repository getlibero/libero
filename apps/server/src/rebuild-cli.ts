// The operator's way out of a changed embedding model (#282).
//
// `packages/memory`'s DDL has always said that changing the embedding model is a
// **stated rebuild** rather than something a file absorbs: a `vec0` table's
// width is fixed at creation, so one file holds one `(model, dims)` pair and
// `putEmbedding` refuses anything that disagrees. That refusal is correct —
// vectors from two models are not comparable — but until this command there was
// no way to make the statement, and the failure it left is the kind that looks
// like the feature quietly not working:
//
//   - every `putEmbedding` throws,
//   - the quiescence sweep catches it and logs `summary_embed_failed` per thread,
//   - summaries are still written, and never embedded,
//   - so recall degrades to nothing while every other part reports healthy.
//
// Not data loss and not an outage, which is why it needed a command rather than
// an alarm.
//
// ## Where this lives, which was forced rather than chosen
//
// `apps/server`'s second operator entrypoint, beside `./tasks-cli.ts`, and for
// that file's two reasons. Not the published `libero` CLI, because `store.db`
// is inside a named volume the host cannot open — #98's rule that the CLI owns
// what the operator authors and a service's entrypoints own what it holds. Not
// the proxy's entrypoints either, because the proxy mounts that volume
// `readOnly` by design and this writes.
//
//   docker compose run --rm server node dist/rebuild.js C024BE91L
//
// ## What it costs, and what it does not
//
// **Embedding calls and no completion ones.** `dropEmbeddings` clears the
// vectors and leaves the corpus, so every summary is re-embedded from text that
// is already on disk. The honest workaround before this — deleting `store.db`
// and letting the sweep re-summarize — paid a model call per thread and threw
// away the channel's messages besides.
//
// **Metered, and not gated.** An embedding call is spend whether it was spent
// writing the corpus or reading it, which is `./index.ts`'s rule for the sweep
// and recall, so this reports to the proxy's meter exactly as they do. It does
// **not** ask `maySpend`. The channel's cap bounds what the channel's own
// activity may spend; this is the operator repairing a configuration they
// changed, from a shell on the host, and a cap that stopped it half way would
// leave the channel in exactly the state the command was run to get out of.
// The spend is still visible — that is what reporting is for.
//
// ## Why it is resumable, and why it is not silently capped
//
// `summariesNeedingEmbedding` is derived by join rather than flagged, and it
// answers oldest first, so a run that stopped — a crash, a ctrl-C, a provider
// that started refusing — picks up where it left off when run again. Nothing
// needs to remember anything.
//
// `MAX_SUMMARIES_PER_REBUILD` is a backstop and never a quiet truncation: a run
// that reaches it says so and says to run it again. A cap that stopped without
// saying would read as "your channel is rebuilt" to an operator whose channel
// is half rebuilt.
//
// ## Skills are not rebuilt here, and that is a decision
//
// A drop takes every vector, skills included, and this re-embeds only summaries.
// The asymmetry is in the corpora rather than in the command:
//
//   - A summary has **no other way back**. `staleThreads` offers threads that
//     are unsummarized, and these are summarized — so nothing in the running
//     system would ever re-embed them. That gap is this command's whole reason.
//   - A skill already has one. `./session/skill-embed.ts` reads
//     `skillsNeedingEmbedding` on channel activity and embeds what has none, so
//     a channel's skills come back on their own.
//
// And embedding a skill correctly means reconciling the index against the
// directory first, because the index is a *cache* of the files — which is that
// pass, whole. A second copy of it here would be a second implementation of one
// thing, in a file whose only claim is that it is small. What it costs is that a
// channel nobody speaks in keeps no skill vectors until somebody does; a channel
// nobody speaks in also runs no task for that to degrade.
//
// Everything is injected — argv, env, both writers, the opener, the embedding
// client and the meter — so the behaviour is testable without a process or a
// provider. ./rebuild.ts is the handful of lines that supply the real ones.

import { createHash } from "node:crypto";
import type { CompletedTurn, EmbeddingClient } from "@getlibero/agent";
import { openMessageStore } from "@getlibero/memory";
import type { MessageStore, StoredThreadSummary } from "@getlibero/memory";
import { ChannelId } from "@getlibero/schema";
import { storeRootFromEnv } from "./env.js";
import type { Env } from "./env.js";

/** 0 ok, 1 an operator error, 2 a usage error. `./tasks-cli.ts`'s set. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * How many summaries go into one provider call.
 *
 * `MAX_SKILLS_PER_EMBED_PASS`'s counterpart at a larger figure, for the reason
 * that constant's own comment gives when it argues the other way: a skill
 * description is a sentence and a summary is up to `SUMMARY_MAX_TEXT_CHARS`, so
 * sixteen of these is a request of about the size ten of those would be if they
 * were paragraphs. Batched at all because `EmbeddingRequest` takes texts plural
 * for exactly this, and a rebuild is where the saving is largest.
 */
export const MAX_SUMMARIES_PER_EMBED_CALL = 16;

/**
 * The most one run will embed before stopping and saying so.
 *
 * A backstop rather than a page. `MAX_THREADS_PER_SWEEP` is three because a
 * sweep runs unasked on a path where a person is waiting; nobody is waiting on
 * this and an operator who ran it wants it finished, so the figure is where a
 * provider bill stops being something you would want to discover afterwards
 * rather than where a batch stops being polite.
 *
 * Reaching it is reported, never silent — see the header.
 */
export const MAX_SUMMARIES_PER_REBUILD = 1000;

const USAGE = [
  "usage: rebuild <channel>",
  "",
  "Re-embeds the summaries a channel has already stored. Where the configured",
  "embedding model differs from the one the channel's vectors are under, its",
  "vectors are dropped first — a vec0 table's width is fixed at creation, so",
  "that is the only way it changes.",
  "",
  "Reads AGENT_STORE_ROOT and the AGENT_EMBEDDING_* variables. Costs embedding",
  "calls and no completion ones. Safe to run again: it re-embeds what has no",
  "vector, so a run that stopped continues where it left off.",
  "",
  "Skills are not rebuilt here — the skill-embedding pass picks those up on the",
  "channel's next message."
].join("\n");

export interface RebuildCliIo {
  argv: readonly string[];
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * How this deployment embeds, or `null` when it has configured no provider.
   *
   * `SummarySweepOptions.embedding`'s shape, and unlike that one a `null` here
   * ends the command: a rebuild that cannot embed has nothing to do but say so.
   */
  embedding: EmbeddingClient | null;
  /** The configured embedding model id. Absent alongside a null client. */
  embeddingModel?: string;
  /** Reports one call's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  /** Injected so a test states the clock rather than reading one. */
  now?: () => number;
  /**
   * The backstop, injected so a test can reach it without a thousand summaries.
   * Defaults to `MAX_SUMMARIES_PER_REBUILD`.
   *
   * A seam and not an option: there is no `--limit`, because a rebuild an
   * operator has to size is a rebuild they have to size wrongly once. What
   * bounds a run is a figure this file argues for, and what makes a truncated
   * run safe is that it says so and continues on the next.
   */
  limit?: number;
  /** Injected so a test drives a store it built. Defaults to the real opener. */
  open?: (channel: string, root: string) => MessageStore;
}

/**
 * The meter's id for one batch, hashed over what is in it.
 *
 * `turnIdFor` in ./session/skill-embed.ts, and the property is the same one: the
 * proxy's meter dedupes on `(channel, day, turn)`, so the id has to be stable
 * across a crash-retry of the same work and different when the work differs. A
 * batch is identified by the threads in it, and a rerun after a crash reads the
 * same pending set in the same order and so builds the same batches — which is
 * what makes an interrupted rebuild resumable without being counted twice.
 *
 * The refs and not the texts: a summary's text is a channel's conversation
 * condensed, and there is no reason to run it through a hash that a thread ts
 * does not serve. A summary rewritten between two runs is a different vector
 * under the same id, and the earlier run already paid for the earlier one.
 */
function turnIdFor(batch: readonly StoredThreadSummary[]): string {
  const hash = createHash("sha256");
  for (const summary of batch) hash.update(`${summary.thread}\n`, "utf8");
  return `rebuild-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * One provider call, and what it bought.
 *
 * Module level rather than a closure over the command, so that what it needs is
 * stated rather than captured — and so the two values the command's guards
 * established, a client and a model id, arrive here already narrowed.
 *
 * Reports spend **before** the vectors are stored, which is the sweep's ordering
 * and recall's: what was paid for is counted even if what it bought is dropped.
 */
async function embedBatch(
  deps: {
    readonly channel: string;
    readonly client: EmbeddingClient;
    readonly model: string;
    readonly store: MessageStore;
    readonly reportTurn: RebuildCliIo["reportTurn"];
    readonly now: () => number;
  },
  batch: readonly StoredThreadSummary[]
): Promise<number> {
  const response = await deps.client.embed({
    model: deps.model,
    texts: batch.map(summary => summary.text)
  });

  // An absent `usage` means the provider did not report, which is not the same
  // as free — so nothing is reported rather than a zero being invented.
  if (response.usage !== undefined) {
    await deps.reportTurn(deps.channel, {
      usage: { inputTokens: response.usage.inputTokens, outputTokens: 0 },
      turn: 0,
      id: turnIdFor(batch),
      ...(response.model === undefined ? {} : { model: response.model })
    });
  }

  let stored = 0;
  for (const [index, summary] of batch.entries()) {
    // Positional, which is the response's own contract: the vectors come back in
    // the order their texts were given. A provider that returned fewer leaves the
    // rest with no vector, and they are still pending.
    const vector = response.vectors[index];
    if (vector === undefined) continue;
    deps.store.putEmbedding({
      source: { kind: "summary", ref: summary.thread },
      vector,
      // The **served** model, falling back to what was asked for — the sweep's
      // rule, and it matters more here than anywhere: this is the value the file
      // stamps and every later `putEmbedding` is checked against, so a rebuild
      // that stamped the requested id while the provider served another would
      // leave the file needing a second rebuild.
      model: response.model ?? deps.model,
      at: deps.now()
    });
    stored += 1;
  }
  return stored;
}

export async function runRebuildCommand(io: RebuildCliIo): Promise<number> {
  const [channel, ...rest] = io.argv;

  if (channel === undefined || rest.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  // ./tasks-cli.ts's check and its reason: the id becomes a path segment, and
  // this one comes off a command line.
  if (!ChannelId.safeParse(channel).success) {
    io.err(`rebuild: ${JSON.stringify(channel)} is not a valid channel id`);
    return EXIT_USAGE;
  }

  const client = io.embedding;
  const model = io.embeddingModel;
  // Before the store is opened, because a deployment with no embedding provider
  // is a configuration answer rather than anything about this channel — and
  // opening a store to say so would create nothing and tell the operator less.
  if (client === null || model === undefined) {
    io.err(
      "rebuild: this deployment has configured no embedding provider, so there is nothing " +
        "to rebuild with (AGENT_EMBEDDING_PROVIDER, AGENT_EMBEDDING_MODEL)"
    );
    return EXIT_ERROR;
  }

  let root: string;
  try {
    root = storeRootFromEnv(io.env);
  } catch (error) {
    io.err(`rebuild: ${error instanceof Error ? error.message : "AGENT_STORE_ROOT is not set"}`);
    return EXIT_ERROR;
  }

  let store: MessageStore;
  try {
    store = (io.open ?? ((name, at) => openMessageStore({ channel: name, root: at })))(
      channel,
      root
    );
  } catch (error) {
    // ./tasks-cli.ts's wording: "no such channel" and "nothing to do" are
    // different answers and an empty one would blur them.
    io.err(`rebuild: no store for ${channel} (${error instanceof Error ? error.name : "unknown"})`);
    return EXIT_ERROR;
  }

  const now = io.now ?? Date.now;

  try {
    const held = store.embeddingModel();

    // The drop, and the one condition under which it happens. A file already
    // under the configured model needs no drop — its vectors are comparable to
    // the ones about to be written — so this becomes a repair of whatever was
    // never embedded rather than a rebuild of everything, and costs accordingly.
    if (held !== null && held.model !== model) {
      store.dropEmbeddings();
      io.out(
        `dropped ${channel}'s vectors: they were ${held.model} at ${held.dims} dimensions, ` +
          `and this deployment embeds with ${model}`
      );
    }

    const limit = io.limit ?? MAX_SUMMARIES_PER_REBUILD;
    let embedded = 0;
    let stopped = false;
    while (embedded < limit) {
      const wanted = Math.min(MAX_SUMMARIES_PER_EMBED_CALL, limit - embedded);
      const batch = store.summariesNeedingEmbedding(wanted);
      if (batch.length === 0) break;

      const stored = await embedBatch(
        { channel, client, model, store, reportTurn: io.reportTurn, now },
        batch
      );
      // A provider that answered with fewer vectors than it was given texts
      // leaves the rest pending, which the next iteration would read back
      // unchanged — so a batch that stored nothing ends the run rather than
      // spinning on it. Reported below as an incomplete rebuild, because it is.
      if (stored === 0) {
        stopped = true;
        break;
      }
      embedded += stored;
      // Only while there is plausibly more to come. A channel that finishes
      // inside one batch gets the closing line and nothing else; a run long
      // enough for an operator to wonder whether it is moving gets a heartbeat.
      if (stored === wanted) io.out(`embedded ${embedded} so far`);
    }

    if (stopped) {
      io.err(
        `rebuild: stopped after ${embedded} — the provider returned no vector for the next ` +
          `batch. Nothing is lost; run it again once it is answering.`
      );
      return EXIT_ERROR;
    }

    if (embedded === limit) {
      io.out(
        `embedded ${embedded} summaries in ${channel}, which is this run's limit — ` +
          `run it again to continue`
      );
      return EXIT_OK;
    }

    io.out(
      embedded === 0
        ? `nothing to rebuild in ${channel}: every summary it holds has a vector under ${model}`
        : `rebuilt ${channel}: ${embedded} ${embedded === 1 ? "summary" : "summaries"} embedded under ${model}`
    );
    return EXIT_OK;
  } catch (error) {
    // The store's own message, which is the one worth reading: `putEmbedding`
    // names both models and both widths, and `openMessageStore`'s failures name
    // the file. An error here has already stopped the run, and what was embedded
    // before it stopped is kept — the point of the resumable read.
    io.err(`rebuild: ${error instanceof Error ? error.message : "failed"}`);
    return EXIT_ERROR;
  } finally {
    store.close();
  }
}
