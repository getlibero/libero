// The skill-embedding pass: what gives a playbook the vector its second
// retrieval leg needs (#305).
//
// ./skill-recall.ts fuses two rank lists, and until this file only one of them
// could answer. `reconcileSkillIndex` embeds nothing — `packages/memory` has no
// model provider, by design — so it leaves rows for `skillsNeedingEmbedding` to
// surface, and nothing surfaced them. `nearest(vector, k, "skill")` therefore
// answered `[]` in every deployment and the hybrid retrieval #292 shipped ran on
// full text alone. This is the missing leg, not a broken one: a question usually
// does share vocabulary with the playbook it wants, which is why the gap was
// survivable long enough to be its own issue.
//
// ## Why it is a sweep, and why not the head of a task
//
// The head of a task is where reconciliation runs, because correctness is
// required at that moment. Embedding is not that: it is a provider round trip
// whose benefit the *next* task collects, so putting one in front of every reply
// buys latency for nobody. Recall already pays for one call at task head — a
// second is a different trade and this file declines it.
//
// So this runs where ./summarize.ts runs, on the same trigger and for the same
// reason: a skill file changes through somebody saving a file, which fires no
// event this process can see, and the reliable moment to look is when something
// else happens in the channel. `SWEEP_INTERVAL_MS` is imported rather than
// restated — it is how often this process bothers to look, and there is one such
// number.
//
// **It is a separate sweep rather than a leg of that one**, because the two
// answer to different blocks of the team sheet. The quiescence sweep is gated on
// `[memory] summarize`; this is gated on `[skills] enabled`. Folding them
// together would mean a channel that turned thread summaries off lost skill
// embedding with them, which is not a thing anybody asked for.
//
// ## It reconciles first, and that is the second caller
//
// `reconcileSkillIndex` had exactly one caller — ./skill-recall.ts, at the head
// of a task — and this is the second. It has to be, or the acceptance this file
// exists for is not met: the index is what says which skills need a vector, so a
// pass that only read it could embed nothing a task had not already indexed. A
// skill somebody wrote with an editor would then wait for a mention before it
// could even become a candidate, and a skill the author turn wrote would wait for
// the *next* task after the one that wrote it.
//
// Both callers hold the session's lock, which is what makes a second one safe
// rather than a race: ingest runs this inside `session.mutex.run`, exactly as it
// runs the quiescence sweep, and a task's reconcile runs inside the same lock.
// The pass is also cheap in the steady state — a `readdir` and a `stat` per file,
// with nothing opened unless its fingerprint moved.
//
// One consequence worth stating plainly: reconciliation is what makes the
// archived rule structural here. `SKILLS_NEEDING_EMBEDDING_SQL` excludes
// `archived`, and reconciliation is what puts a hand-set `status: archived` into
// that column — so a pass that reconciles first cannot embed a skill the team has
// just archived, where a pass that only read the index could.
//
// ## What bounds it
//
// - **The sheet.** `[skills] enabled` turns it off, and `max_skills` is what the
//   directory is truncated to before anything is indexed at all.
// - **`SWEEP_INTERVAL_MS`.** A busy channel does not embed per message.
// - **`MAX_SKILLS_PER_EMBED_PASS`.** One pass is one provider call over at most
//   this many descriptions, so a channel provisioned against a full library
//   embeds it over several passes rather than in one burst.
// - **The description.** Only the description is embedded — never the body —
//   which is the same text `description_hash` stands for, and it is capped by
//   `SKILL_DESCRIPTION_MAX_CHARS` in the schema package.
// - **The meter.** The call reports through the same `SpendReport` path recall
//   and the quiescence sweep use, so `daily_tokens` and `daily_usd` bound it the
//   way they bound a task. The backstop, not the mechanism.
//
// ## And what it deliberately does not do
//
// **A deployment with no embedding provider is unchanged.** No client means the
// pass returns before it reads a sheet or touches a directory — no error, no
// retry loop, and skills go on retrieving from full text, which the team sheet
// calls a supported deployment rather than a degradation.
//
// **Nothing here re-embeds on its own judgement.** What needs a vector is derived
// by a LEFT JOIN over `embedding_source`, and what invalidates one is
// `reconcileSkills` noticing that `description_hash` moved. So a body edit and a
// rewritten `status` cost nothing, and an edited description costs exactly one
// re-embedding. This file holds no opinion about any of that and should not grow
// one.

import { createHash } from "node:crypto";
import type { CompletedTurn, EmbeddingClient } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";
import { reconcileSkillIndex } from "@getlibero/memory";
import type { SkillFilesOpener } from "./skills.js";
import { SWEEP_INTERVAL_MS } from "./summarize.js";

/**
 * The most skills one pass will embed.
 *
 * `MAX_THREADS_PER_SWEEP`'s counterpart at a larger figure, and the difference is
 * what is being bounded. That one bounds *calls*: three summaries are three
 * completions. This is one call either way — `EmbeddingRequest` takes texts,
 * plural, precisely so that a caller's loop is not where batching gets forgotten
 * — so what this bounds is the tokens in it, and a description is capped at a few
 * hundred characters where a thread is capped at sixty messages.
 *
 * Ten of them is a small call. A channel provisioned against a full library —
 * `[skills] max_skills` defaults to a hundred — works through it over ten passes,
 * which is under an hour of an active channel, and `skillsNeedingEmbedding`
 * answers in name order, so which ten come first is deterministic rather than
 * whatever the directory listed.
 */
export const MAX_SKILLS_PER_EMBED_PASS = 10;

/** What the pass needs from a channel's sheet. Resolved by ./sheet.ts. */
export interface SkillEmbedSettings {
  /** `[skills] enabled`. */
  readonly enabled: boolean;
  /** `[skills] max_skills`. What reconciliation truncates the directory to. */
  readonly maxSkills: number;
}

export interface SkillEmbedSweepOptions {
  /**
   * How this deployment embeds, or `null` when it does not.
   *
   * Unlike `SummarySweepOptions.embedding`, `null` here means the pass does
   * nothing at all rather than doing a reduced version of its work: a vector is
   * the only thing it produces. See the header on why that is a supported
   * deployment and not a failure.
   */
  embedding: EmbeddingClient | null;
  /** The embedding model id, when `embedding` is set. Stamped against vectors. */
  embeddingModel?: string;
  /** How the channel's skills directory is opened. Takes the sheet's cap. */
  files: SkillFilesOpener;
  /** The channel's skill settings. `null` skips the channel entirely. */
  settings: (channel: string) => Promise<SkillEmbedSettings | null>;
  /** Reports one call's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  logger?: Logger;
  now?: () => number;
  /** Cancels in-flight work when the process is stopping. */
  signal?: AbortSignal;
}

/**
 * Reconciles one channel's skill index and embeds what has no vector, if it is
 * due.
 *
 * Returns how many vectors it stored, which is what its tests assert on and what
 * a caller may ignore. **Never rejects**: it is called from the message ingest
 * path, where nothing is waiting on it and a failure must not cost a channel its
 * message write.
 */
export type SkillEmbedSweep = (channel: string, store: MessageStore) => Promise<number>;

export function createSkillEmbedSweep(options: SkillEmbedSweepOptions): SkillEmbedSweep {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  // When each channel last ran. ./summarize.ts's map and its reasons: this
  // module's business, one number per channel the process has seen, never
  // evicted because a workspace has as many channels as it has.
  //
  // Its own map rather than the sweep's, because the two gate on different sheet
  // blocks and a shared stamp would let one channel's disabled feature set the
  // other's clock.
  const lastRanAt = new Map<string, number>();

  return async (channel, store) => {
    const client = options.embedding;
    const model = options.embeddingModel;
    // Before the interval stamp and before the sheet read, so a deployment with
    // no provider does no work and leaves no state — see the header.
    if (client === null || model === undefined) return 0;

    const startedAt = now();
    const previous = lastRanAt.get(channel);
    if (previous !== undefined && startedAt - previous < SWEEP_INTERVAL_MS) return 0;
    // Stamped before the work rather than after, so a slow pass does not let a
    // second one start behind it.
    lastRanAt.set(channel, startedAt);

    let settings: SkillEmbedSettings | null;
    try {
      settings = await options.settings(channel);
    } catch {
      // The resolver is documented total; this is defence rather than a path. A
      // channel whose sheet cannot be read embeds nothing, which is the
      // direction `DEFAULT_SKILL_SETTINGS` already falls in.
      return 0;
    }
    if (settings === null || !settings.enabled) return 0;

    const files = options.files(channel, settings.maxSkills);
    // Already logged by the opener, with the reason it had.
    if (files === null) return 0;

    try {
      // The index is what says which skills need a vector, so making it match the
      // directory is the first half of the pass rather than a favour to the next
      // task. One instant for the whole pass, ./skill-recall.ts's rule.
      reconcileSkillIndex({
        files,
        store,
        maxSkills: settings.maxSkills,
        at: startedAt,
        channel,
        logger
      });
    } catch (error) {
      // ./skill-recall.ts's word, for its reason: a directory this process cannot
      // read is a mount or a permission, and an operator reading the line should
      // not have to guess which half failed.
      logger.log("warn", {
        event: "skill_reconcile_failed",
        channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return 0;
    }

    if (options.signal?.aborted === true) return 0;

    let names: readonly string[];
    try {
      names = store.skillsNeedingEmbedding(MAX_SKILLS_PER_EMBED_PASS);
    } catch (error) {
      logger.log("warn", { event: "skill_embed_failed", channel, reason: reasonOf(error) });
      return 0;
    }
    if (names.length === 0) return 0;

    // Resolved through the file, one at a time, which is retrieval's two-step and
    // its reason: the index holds no text a caller reads, so that a hand-deleted
    // skill's stale body cannot reach anything. A name whose file is gone or no
    // longer parses is skipped — reconciliation just ran, so this is a directory
    // that moved underneath the pass rather than an ordinary case.
    const pending: Array<{ readonly name: string; readonly description: string }> = [];
    for (const name of names) {
      const skill = files.read(name);
      if (skill === null) continue;
      pending.push({ name, description: skill.frontmatter.description });
    }
    if (pending.length === 0) return 0;

    return embed(channel, store, pending);
  };

  /**
   * One provider call, and what it bought.
   *
   * **Batched**, because `EmbeddingRequest` takes texts plural for exactly this:
   * every compatible endpoint batches, and a loop of one-text calls would be this
   * file paying per skill for something the interface already solved.
   *
   * **Metered, on an id derived from what was sent.** The proxy's meter dedupes
   * on `(channel, day, turn)`, so the id has to be the same across a crash-retry
   * of the same work and different when the work differs — which is
   * `summary-<thread>-<watermark>`'s property, reached here by hashing the
   * (name, description) pairs rather than by having a watermark to name. The
   * cost of that shape is stated rather than hidden: a description edited and
   * then edited back within a day re-embeds for free on the meter. That is a
   * cheaper error than the alternative, which is a retried batch counted twice.
   *
   * Reported **before** the vectors are stored, which is recall's ordering and
   * the sweep's: what was paid for is counted even if what it bought is dropped.
   */
  async function embed(
    channel: string,
    store: MessageStore,
    pending: ReadonlyArray<{ readonly name: string; readonly description: string }>
  ): Promise<number> {
    const client = options.embedding;
    const model = options.embeddingModel;
    if (client === null || model === undefined) return 0;

    try {
      const response = await client.embed({
        model,
        texts: pending.map(skill => skill.description),
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });

      // An absent `usage` means the provider did not report, which is not the
      // same as free — so nothing is reported rather than a zero being invented.
      if (response.usage !== undefined) {
        await options.reportTurn(channel, {
          usage: { inputTokens: response.usage.inputTokens, outputTokens: 0 },
          turn: 0,
          id: turnIdFor(pending),
          ...(response.model === undefined ? {} : { model: response.model })
        });
      }

      let stored = 0;
      for (const [index, skill] of pending.entries()) {
        // Positional, which is the response's own contract: the vectors come
        // back in the order their texts were given. A provider that returned
        // fewer leaves the rest with no vector, and the next pass asks again.
        const vector = response.vectors[index];
        if (vector === undefined) continue;
        store.putEmbedding({
          source: { kind: "skill", ref: skill.name },
          vector,
          // The **served** model, falling back to what was asked for. The store
          // stamps this against every vector in the file and refuses a later one
          // that disagrees, so what matters is that it is stable rather than
          // that it is echoed.
          model: response.model ?? model,
          at: now()
        });
        stored += 1;
      }

      if (stored > 0) {
        logger.log("info", {
          event: "skills_embedded",
          channel,
          // A count, never the names: a playbook's name is the team's own words
          // and `LogFields.reason` is a closed vocabulary of codes.
          // `skills_loaded` reports its count through the same field.
          totalTokens: stored
        });
      }
      return stored;
    } catch (error) {
      // Nothing is stored and nothing is marked. The skills stay in
      // `skillsNeedingEmbedding` and the next pass tries again, which is the
      // right side to fall on: a provider outage must not leave a library
      // permanently unreachable by its vector leg.
      logger.log("warn", { event: "skill_embed_failed", channel, reason: reasonOf(error) });
      return 0;
    }
  }
}

/**
 * The meter's id for one batch: what was embedded, not when.
 *
 * A hash rather than the names themselves, for `description_hash`'s reason — the
 * value exists to be compared, and a turn id is not where a channel's chosen
 * words belong. The description is in it as well as the name, so a re-embedding
 * after an edit is a different turn rather than a retry of the last one.
 *
 * Not a security boundary. A collision would cost a channel one uncounted
 * embedding call.
 */
function turnIdFor(
  pending: ReadonlyArray<{ readonly name: string; readonly description: string }>
): string {
  const hash = createHash("sha256");
  // NUL between the two fields and a newline between pairs, so no pair of
  // (name, description) values can be concatenated into another pair's bytes.
  for (const skill of pending) hash.update(`${skill.name}\u0000${skill.description}\n`, "utf8");
  return `skills-embed-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * A reason code from an error, and never its message.
 *
 * ./summarize.ts's rule: a provider's message can carry a URL, a key fragment,
 * or a channel's own words back into a log line.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
