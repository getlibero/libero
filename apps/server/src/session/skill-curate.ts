// The merge curator: one model call that drafts a merge, and a file a person
// reads (#295).
//
// The author turn only sees the skills retrieval had already loaded, so a
// playbook gets written twice by a turn that could not see the first copy. This
// is what notices — and what it does about it is **propose**, never rewrite,
// because a skill library is institutional knowledge and the team owns what it
// says.
//
// ## The review surface is the filesystem, and that is forced rather than chosen
//
// The obvious surface is the channel: post the diff where the team is. This
// process cannot. `MessagePoster.postThreadReply` is deliberately withheld from
// the composing app — `packages/gateway`'s surface narrows to `CardPoster` so
// that a handler cannot post out of band — and a card needs a `threadTs` from an
// inbound event, which a background pass does not have. A proactive post is the
// ambient heartbeat's mechanic, which ships later and behind its own switch.
//
// Approval cards are also not it for a second, independent reason: a card is the
// **proxy's** mechanic for a held tool call, and this is not a tool call. Reaching
// for the card machinery here would put a proxy dependency where none belongs.
//
// So a proposal is a markdown file in `proposals/`, beside `skills/` in the
// channel's own state root. Applying it is replacing one skill file and deleting
// the other; declining it is deleting the proposal. Both are hand edits, and
// reconciliation is how either takes effect — the same road every other change to
// that directory takes.
//
// ## What stops a declined proposal coming back every week
//
// `skill_merge_proposal` records every pair this pass has *considered*, with the
// two description hashes it considered them at, and the nomination query excludes
// a pair whose row still matches. So a pair is raised once and not again until
// somebody edits one of the two descriptions.
//
// **Deleting the file is the decline, and nothing observes it.** Ignoring a
// proposal and declining it therefore come to exactly the same thing, which is
// the point: the team never has to tell this process anything, and there is no
// state they can get wrong.
//
// ## Nomination is the index's job, and the model only drafts
//
// `skillMergeCandidate` answers the closest **mutual nearest neighbour** pair not
// yet considered — B is A's nearest and A is B's. The argument for that rule, and
// for its needing no distance constant, is on the SQL in `packages/memory`. What
// matters here is the shape it buys: the index decides *which two*, the model
// decides *whether they are one*, and neither does the other's job.
//
// ## What bounds it
//
// - **The sheet.** `[skills] enabled` and `[skills] curate`, the second of which
//   exists because this is the one skill pass that spends with nobody waiting.
// - **`CURATE_INTERVAL_MS`**, a day per channel.
// - **One pair, one model call, per run** — structural: the nomination answers one
//   row and there is no loop.
// - **`MAX_OPEN_PROPOSALS`.** A team that never opens the directory stops being
//   asked after three.
// - **The hash rule**, which makes the steady state one SELECT and no call at all.
// - **The meter.** The turn reports through the same `SpendReport` path the sweep
//   and recall use. The backstop, not the mechanism.
// - **`maySpend`** (#335). A channel over its caps proposes nothing — asked
//   where the turn is about to run, so reconciliation and pruning still happen.
//   `./summarize.ts`'s header carries the argument for why declining is this
//   process's own and why it fails closed.
//
// ## And what it deliberately does not do
//
// **It writes no skill file, and holds nothing that could.** `SkillProposals` has
// no method that names one, and `runSkillMergeTurn` takes no handler — so the
// guarantee is two structural halves rather than a rule anybody has to keep.
//
// **A deployment with no embedding provider proposes nothing.** `skillMergeCandidate`
// answers `null` before it touches a vec table that may not exist, so there is no
// error, no log line and no retry. This is a **behaviour difference from skill
// retrieval**, which degrades to full text and is documented as a supported
// deployment: there is no lexical answer to "are these two near each other",
// because bm25 answers a question about a query rather than about a pair, and
// inventing one would be the magic-constant problem in a worse coordinate system.

import { createHash } from "node:crypto";
import type { CompletedTurn, CompletionClient, MergeCandidate } from "@getlibero/agent";
import { runSkillMergeTurn } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore, SkillMergePair } from "@getlibero/memory";
import { reconcileSkillIndex } from "@getlibero/memory";
import type { SkillFile } from "@getlibero/schema";
import type { SkillProposalsOpener } from "./proposals.js";
import type { SkillFilesOpener } from "./skills.js";

/**
 * How often one channel's library may be looked at.
 *
 * A day, and it is the first interval in this process that is neither the
 * five-minute sweep nor the lifecycle job's six hours. What the others bound is
 * how stale a derived thing may get; what this bounds is **how often a team may
 * be asked to read something**. A proposal is a request for somebody's attention,
 * and six hours could put four of them in front of a person between one working
 * day and the next.
 *
 * Nothing is lost by waiting. The candidate set changes only when a description
 * hash moves, so a shorter interval would find the same pair and pay for it no
 * sooner — what a run past the fixed point costs is one SELECT.
 */
export const CURATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How many proposals may be waiting before the pass stops making more.
 *
 * The bound that answers a team who never opens the directory. The hash rule
 * stops a *pair* being raised twice; it does not stop other pairs piling up, and
 * a library with a dozen unread drafts in it is one where every further model
 * call is spend on something nobody will look at. Three is a number a person
 * clears in a sitting.
 *
 * **Counted from the directory rather than from the index**, which is what makes
 * deleting a file both the decline and the way to unblock the pass — one act with
 * one meaning, rather than a state the team has to maintain.
 */
export const MAX_OPEN_PROPOSALS = 3;

/** The most orphaned rows one pass will clean up after. */
export const MAX_PROPOSAL_PRUNES_PER_PASS = 8;

/** What the pass needs from a channel's sheet. Resolved by ./sheet.ts. */
export interface SkillCurateSettings {
  /** `[skills] enabled`. False stops the whole feature. */
  readonly enabled: boolean;
  /** `[skills] curate`. False stops only this pass. */
  readonly curate: boolean;
  /** `[skills] max_skills`. What reconciliation truncates the directory to. */
  readonly maxSkills: number;
  /** The channel's model, from `[llm] model` or the process default. */
  readonly model: string;
  /**
   * `[llm] max_tokens_per_turn`.
   *
   * The per-*turn* cap rather than the per-task one, `CurationTurnOptions`'
   * reason: there is no task here and nobody waiting, so the figure that applies
   * is the one bounding a single answer.
   */
  readonly maxTokens: number;
}

export interface SkillCuratePassOptions {
  completion: CompletionClient;
  /** How the channel's skills directory is opened. Takes the sheet's cap. */
  files: SkillFilesOpener;
  /** How the channel's proposals directory is opened. */
  proposals: SkillProposalsOpener;
  /** The channel's skill settings. `null` skips the channel entirely. */
  settings: (channel: string) => Promise<SkillCurateSettings | null>;
  /** Reports the turn's spend to the proxy's meter. Must not throw. */
  reportTurn: (channel: string, turn: CompletedTurn & { id: string }) => Promise<void>;
  /**
   * Whether this channel may be spent for at all (#335). Must not throw.
   *
   * Required for `reportTurn`'s reason, and asked at the point the turn is about
   * to run rather than at the head of the pass: reconciliation and proposal
   * pruning above it are bookkeeping the next task reads, and a channel over its
   * caps should still get them.
   */
  maySpend: (channel: string) => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
  /** Cancels in-flight work when the process is stopping. */
  signal?: AbortSignal;
}

/**
 * Considers one pair, if the channel is due and a pair is nominated, and answers
 * how many proposals it wrote — 0 or 1.
 *
 * **Never rejects**: it is called from the message ingest path, where nothing is
 * waiting on it and a failure must not cost a channel its message write.
 */
export type SkillCuratePass = (channel: string, store: MessageStore) => Promise<number>;

export function createSkillCuratePass(options: SkillCuratePassOptions): SkillCuratePass {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  // ./skill-lifecycle.ts's map and its reasons: this module's business, one
  // number per channel the process has seen, never evicted. Its own rather than
  // shared, because the passes gate on different sheet fields and a shared stamp
  // would let one channel's disabled feature set another's clock.
  const lastRanAt = new Map<string, number>();

  return async (channel, store) => {
    const startedAt = now();
    const previous = lastRanAt.get(channel);
    if (previous !== undefined && startedAt - previous < CURATE_INTERVAL_MS) return 0;
    // Stamped before the work rather than after, so a slow pass does not let a
    // second one start behind it.
    lastRanAt.set(channel, startedAt);

    let settings: SkillCurateSettings | null;
    try {
      settings = await options.settings(channel);
    } catch {
      // The resolver is documented total; this is defence rather than a path. A
      // channel whose sheet cannot be read proposes nothing, which is the
      // direction `DEFAULT_SKILL_SETTINGS` already falls in.
      return 0;
    }
    if (settings === null || !settings.enabled || !settings.curate) return 0;

    const files = options.files(channel, settings.maxSkills);
    const proposals = options.proposals(channel);
    // Already logged by whichever opener declined, with the reason it had.
    if (files === null || proposals === null) return 0;

    // One instant for the whole pass, ./skill-recall.ts's rule.
    //
    // **Reconciling first is required rather than tidy.** The index is what
    // nominates the pair *and* what holds the description hashes the bound is
    // decided on, so a pass that skipped it would nominate against a directory
    // that has moved and would compare a fresh proposal against a stale hash.
    // This is `reconcileSkillIndex`'s fourth caller, all four inside the
    // session's lock.
    try {
      reconcileSkillIndex({
        files,
        store,
        maxSkills: settings.maxSkills,
        at: startedAt,
        channel,
        logger
      });
    } catch (error) {
      logger.log("warn", { event: "skill_reconcile_failed", channel, reason: reasonOf(error) });
      return 0;
    }

    // Before the cap check, so a slot freed by a proposal somebody applied is
    // usable on the same run rather than a day later.
    prune(channel, store, proposals);

    if (options.signal?.aborted === true) return 0;

    let waiting: number;
    try {
      waiting = proposals.count();
    } catch (error) {
      logger.log("warn", { event: "skill_merge_failed", channel, reason: reasonOf(error) });
      return 0;
    }
    if (waiting >= MAX_OPEN_PROPOSALS) {
      // An `info` line rather than silence, so an operator asking why a channel
      // stopped proposing gets an answer without reading this file.
      logger.log("info", { event: "skill_merge_backlog", channel, count: waiting });
      return 0;
    }

    let pair: SkillMergePair | null;
    try {
      pair = store.skillMergeCandidate();
    } catch (error) {
      logger.log("warn", { event: "skill_merge_failed", channel, reason: reasonOf(error) });
      return 0;
    }
    // No vectors, no mutual pair, or nothing new since the last look. All three
    // are "nothing to propose" and none of them has cost a model call.
    if (pair === null) return 0;

    // Resolved through the files, which is retrieval's two-step and its reason:
    // the index holds no text a caller reads, so a skill deleted between the
    // nomination and this read resolves to nothing rather than to a stale body.
    const keepFile = files.read(pair.a);
    const dropFile = files.read(pair.b);
    if (keepFile === null || dropFile === null) return 0;

    return consider({
      channel,
      store,
      proposals,
      settings,
      pair,
      keepFile,
      dropFile,
      startedAt
    });
  };

  /**
   * Remove the proposals whose pair no longer exists, and forget their rows.
   *
   * How the pass cleans up after a merge somebody applied — and after one they
   * half-applied. **File first, then the row**, for ./skill-lifecycle.ts's
   * reason: a crash between them leaves a row with no file, which the next pass
   * prunes again harmlessly, where the other order would leave a file nothing
   * could ever find and a cap slot consumed forever.
   */
  function prune(
    channel: string,
    store: MessageStore,
    proposals: NonNullable<ReturnType<SkillProposalsOpener>>
  ): void {
    let orphans: readonly { readonly a: string; readonly b: string }[];
    try {
      orphans = store.orphanedSkillMergeProposals(MAX_PROPOSAL_PRUNES_PER_PASS);
    } catch (error) {
      logger.log("warn", { event: "skill_merge_failed", channel, reason: reasonOf(error) });
      return;
    }
    if (orphans.length === 0) return;

    let pruned = 0;
    for (const orphan of orphans) {
      try {
        proposals.remove(orphan);
        store.forgetSkillMergeProposal(orphan);
        pruned += 1;
      } catch (error) {
        // One failure will meet the rest, so one line says what eight would.
        logger.log("warn", { event: "skill_merge_failed", channel, reason: reasonOf(error) });
        break;
      }
    }

    if (pruned > 0) {
      logger.log("info", { event: "skill_merge_pruned", channel, count: pruned });
    }
  }

  /**
   * One model call about one pair, and what it produced.
   *
   * **The row is written for every outcome the model reached**, drafted or
   * declined, because a declined pair with no row is a pair paid for again on
   * every later run. The one outcome that records nothing is a provider that
   * threw: that is an outage rather than an answer, and the pair should be
   * nominated again next time.
   *
   * A draft writes the file **before** the row, ./skill-lifecycle.ts's ordering:
   * a crash between them re-proposes and overwrites the same filename, costing
   * one call, where the other order would lose the proposal until a hash moved.
   */
  async function consider(work: {
    readonly channel: string;
    readonly store: MessageStore;
    readonly proposals: NonNullable<ReturnType<SkillProposalsOpener>>;
    readonly settings: SkillCurateSettings;
    readonly pair: SkillMergePair;
    readonly keepFile: SkillFile;
    readonly dropFile: SkillFile;
    readonly startedAt: number;
  }): Promise<number> {
    const { channel, store, proposals, settings, pair, keepFile, dropFile, startedAt } = work;

    // Here rather than at the head of the pass (#335), for `./skill-embed.ts`'s
    // reason and one of its own: everything above this — reconciliation, pruning
    // an applied proposal, the backlog check — is bookkeeping the next task
    // reads, and a channel over its token cap should still get all of it. This
    // is the line where the pass starts costing money.
    if (!(await options.maySpend(channel))) return 0;

    let result;
    try {
      result = await runSkillMergeTurn({
        completion: options.completion,
        model: settings.model,
        pair: [asCandidate(keepFile), asCandidate(dropFile)],
        maxTokens: settings.maxTokens,
        turn: 0,
        onTurn: async completed => {
          await options.reportTurn(channel, { ...completed, id: turnIdFor(pair) });
        },
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });
    } catch (error) {
      logger.log("warn", { event: "skill_merge_failed", channel, reason: reasonOf(error) });
      return 0;
    }

    if (result.draft === null) {
      // A call that did not fit the schema is recorded exactly as a decline is,
      // and the argument is worth stating: the spend already happened, and the
      // same two texts would very likely produce the same failure tomorrow. A
      // pair that costs a call a day forever because a model could not pick
      // between two names it was given is the failure the hash rule exists to
      // prevent.
      store.recordSkillMergeConsidered(pair, startedAt);
      if (result.unusable === undefined) {
        logger.log("info", { event: "skill_merge_none", channel });
      } else {
        logger.log("warn", { event: "skill_merge_unusable", channel, reason: result.unusable });
      }
      return 0;
    }

    const before = result.draft.keep === keepFile.frontmatter.name ? keepFile : dropFile;
    const other = before === keepFile ? dropFile : keepFile;

    try {
      proposals.write({
        draft: result.draft,
        keepBefore: before,
        dropBefore: other,
        // The merged file as it should read once applied: the kept skill's own
        // `created` and `status`, because a merge is not a new playbook and its
        // history is the whole reason it keeps one of the two names.
        after: {
          frontmatter: { ...before.frontmatter, description: result.draft.description },
          body: result.draft.body
        },
        ...(result.model === undefined ? {} : { model: result.model }),
        at: startedAt
      });
    } catch (error) {
      // Nothing recorded, so the pair is nominated again next run. Under a
      // persistent failure that costs one call a day, bounded by the interval and
      // by the meter, with a `warn` line an operator sees daily.
      logger.log("warn", { event: "skill_merge_failed", channel, reason: reasonOf(error) });
      return 0;
    }

    store.recordSkillMergeConsidered(pair, startedAt);
    logger.log("info", { event: "skill_merge_proposed", channel });
    return 1;
  }

}

/** A skill file as the turn sees it: no `created`, no `status`. */
function asCandidate(file: SkillFile): MergeCandidate {
  return {
    name: file.frontmatter.name,
    description: file.frontmatter.description,
    body: file.body
  };
}

/**
 * The meter's id for one consideration: which pair, at which two texts.
 *
 * `skill-embed.ts`'s `turnIdFor` and its reasons. The proxy's meter dedupes on
 * `(channel, day, turn)`, so the id has to be the same across a crash-retry of
 * the same work and different when the work differs — which the description
 * hashes give exactly, because they are also what decides whether a pair is
 * reconsidered at all.
 *
 * A hash rather than the names, for `description_hash`'s reason: the value exists
 * to be compared, and a turn id is not where a channel's chosen words belong.
 */
function turnIdFor(pair: SkillMergePair): string {
  const hash = createHash("sha256");
  // NUL between the fields, so no pair of values can be concatenated into
  // another pair's bytes.
  hash.update(`${pair.a}\u0000${pair.hashA}\u0000${pair.b}\u0000${pair.hashB}`, "utf8");
  return `skills-merge-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * A reason code from an error, and never its message.
 *
 * ./skill-embed.ts's rule: a provider's message can carry a URL, a key fragment,
 * or a channel's own words back into a log line.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
