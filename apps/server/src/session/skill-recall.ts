// Skill retrieval: the playbooks this channel has written for work like this,
// put in front of a task before it starts (#292).
//
// ./recall.ts's sibling, and deliberately built to its shape — task head, inside
// the session's lock, never throws, renders into the opening context, not a
// tool. Everything that file argues about *where* retrieval belongs applies here
// unchanged and is not restated: a model-invoked skill search would be an
// ungoverned twin of the proxied built-in #64 made observable, while context
// assembly is the agent deciding what its own task starts from, which this
// process already does for the transcript and for `MEMORY.md`. If mid-task skill
// search is ever wanted, the consistent move is a leg on the existing built-in
// rather than a second unobservable read.
//
// What follows is only what differs from recall.
//
// ## Reconciliation runs here, and this is where it has to run
//
// `reconcileSkillIndex` had no caller until this file, and #290's PR says why
// this is the right one: the moment correctness is required is the moment
// retrieval runs, and outside the session's lock it would race the quiescence
// sweep's writes and — once #291 lands — the previous task's authoring.
//
// It is the whole of how a hand-edited or hand-deleted skill takes effect *for
// the task about to run*. There is no watcher: the team's directory is the truth,
// and this pass is what the index does about it. Its steady-state cost is one
// `readdir` and a `stat` per file; a file is only re-read when its fingerprint
// moved, and only re-embedded when its *description* moved.
//
// Since #305 it is not the only caller. ./skill-embed.ts reconciles too, on
// channel activity rather than at task head, because the index is what says
// which skills still need a vector — so a pass that only read it could embed
// nothing a task had not already indexed. That is a second caller and not a
// second path: both hold the session's lock, both call the same function, and
// what either one does about a changed file is `packages/memory`'s decision
// rather than this file's. What this file still owns is the guarantee that the
// index is current *before this task retrieves*, which nothing running on
// message activity can promise.
//
// ## Two legs, and the fusion is a shape rather than a tuned number
//
// `nearest` answers by L2 distance over whatever the configured provider emits;
// `searchSkills` answers by FTS5 rank. The two numbers are not comparable, and
// ./recall.ts already argues at length why a distance figure cannot be written
// down honestly in this tree — the scale differs between providers and nothing
// obliges one to normalize. That argument rules out a weighted blend, and it
// rules out reciprocal-rank fusion too, whose damping constant would be exactly
// the magic number that argument refuses.
//
// So the fusion is a round-robin interleave over the two rank lists, deduped by
// name. No constant to defend, each leg is guaranteed to contribute, and a skill
// both legs found surfaces once at its better position — which is a mild
// agreement bonus falling out of the shape instead of a knob.
//
// ## Neither leg has a cutoff, and this block's known weakness follows from that
//
// ./recall.ts says it first and its whole argument holds here: a distance number
// cannot be written down honestly, so a channel holding three skills contributes
// them to every embedded question whether or not any of them bears on it. The
// lexical leg has the same shape for a different reason — `searchSkills` ORs its
// terms, so a question sharing only `a` or `the` with a skill produces a hit,
// and `store-db.ts` records why the obvious bm25 rank floor was tried and
// rejected: on a one-skill library every term takes bm25's IDF floor, so any
// threshold that excludes a stop-word match also excludes the only skill a small
// channel has.
//
// The consequence is worth stating plainly rather than leaving in the tests. **A
// task on an unrelated subject gets nothing only when its question matches
// nothing at all**; a channel with a handful of skills and an embedding provider
// will open most tasks with some of them. What stops that being unbounded is
// `[skills] top_k` and `SKILLS_MAX_CHARS`, and what stops it being harmful is
// that a playbook is text: an irrelevant one costs context and a distraction,
// and widens nothing the proxy governs. A measured cutoff is the obvious next
// tuning knob once a deployment has real distances and a real library to look
// at; a guessed one today would be the magic number recall already refused.
//
// ## A missing vector does not end this, and that is where skills differ
//
// ./recall.ts stops dead without one, because a thread summary's only index is
// its vector. A skill also carries an FTS5 index over its description and body,
// so with no embedding provider the lexical leg runs alone and skills still
// retrieve. The team sheet says this is the intended behaviour and refuses to
// make it a field: "skills should retrieve on full text alone in that case, as a
// behaviour, not a setting".
//
// Between #292 and #305 that was every deployment, not just the ones with no
// provider: nothing embedded a skill, so `nearest` answered nothing and this
// fusion ran on one leg everywhere. ./skill-embed.ts is what fills the other in,
// and nothing here changed for it — the vector leg was always written to answer
// with whatever the store had.
//
// ## What is deliberately not decided here
//
// **Nothing filters archived, because nothing has to.** `searchSkills` carries
// its own `status != 'archived'` clause inside the FTS5 match, and
// `reconcileSkills` drops the vector of any skill it sees archived — so an
// archived skill has no vector for `nearest` to return. Both legs exclude it
// structurally, which is why the test asserts the property rather than a filter
// in this file.
//
// **`stale` is left exactly alone.** It stays a candidate and is ranked no
// differently. What stale means to retrieval is #294's call, and marking or
// deprioritizing it now would be this file implementing half a policy that does
// not exist yet, against clocks that nothing is running. When #294 lands it
// changes this file, deliberately.

import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore, SkillFiles } from "@getlibero/memory";
import { reconcileSkillIndex } from "@getlibero/memory";

/**
 * The most characters the skills block may carry, across all of it.
 *
 * `RECALL_MAX_CHARS`' counterpart, and a constant rather than a sheet field for
 * its reason, which `team-sheet.ts` states from the other side when it declines
 * to add one: what this bounds is what *this process* assembles, not a policy a
 * channel holds an opinion about. `[skills] top_k` is the channel's opinion, and
 * this is what binds first when its skills run long.
 *
 * Three times `SKILL_BODY_MAX_CHARS`, rounded to a round number — the same
 * derivation `RECALL_MAX_CHARS` uses against `SUMMARY_MAX_TEXT_CHARS`, at the
 * larger figure a skill is allowed to be.
 *
 * **It is deliberately not the sum of three maxima.** Descriptions count toward
 * it as well as bodies, so three skills written at the model's exact ceiling
 * lose the last one, and a channel whose three nearest skills are hand-written
 * at `max_skill_chars` gets one. That is the bound doing its job: a skill
 * occupies part of the input of *every* turn for the rest of the task, competing
 * with the transcript and `MEMORY.md`, and a budget that could never bind would
 * not be a budget.
 */
export const SKILLS_MAX_CHARS = 12_000;

/** One skill that came back, as much of it as the block will render. */
export interface LoadedSkill {
  /** The filename stem, which is the skill's identity and the index's key. */
  readonly name: string;
  /** When to reach for it — the line retrieval matched against. */
  readonly description: string;
  /** The playbook itself. */
  readonly body: string;
}

export interface SkillRecallOptions {
  logger?: Logger;
  /** The clock. Stamps a new skill's `first_seen_at` and every use recorded here. */
  now?: () => number;
}

export interface SkillRecallRequest {
  readonly channel: string;
  readonly store: MessageStore;
  /** This channel's skills directory, already gated — see ./skills.ts. */
  readonly files: SkillFiles;
  /** The embedded question, from ./embed.ts. `null` runs the lexical leg alone. */
  readonly vector: Float32Array | null;
  /** What was asked, verbatim. The lexical leg's query; the store tokenizes it. */
  readonly query: string;
  /** `[skills] top_k`. */
  readonly topK: number;
  /** `[skills] max_skill_chars`. A skill whose body exceeds it is not loaded. */
  readonly maxSkillChars: number;
  /** `[skills] max_skills`. What reconciliation truncates the directory to. */
  readonly maxSkills: number;
}

/**
 * The candidates from both legs, interleaved and deduped, best first.
 *
 * Vector rank 1, lexical rank 1, vector rank 2, lexical rank 2, and so on until
 * `limit` names have been taken. A name already taken is skipped rather than
 * repeated, so a skill both legs found keeps only its better position.
 *
 * Exported for its own test. It is a pure function of two rank lists.
 */
export function interleaveCandidates(
  byVector: readonly string[],
  byText: readonly string[],
  limit: number
): string[] {
  const taken: string[] = [];
  const seen = new Set<string>();
  const depth = Math.max(byVector.length, byText.length);

  for (let rank = 0; rank < depth && taken.length < limit; rank += 1) {
    for (const list of [byVector, byText]) {
      if (taken.length >= limit) break;
      const name = list[rank];
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      taken.push(name);
    }
  }

  return taken;
}

/**
 * Retrieve the playbooks that bear on the question.
 *
 * **Never rejects and never throws**, for ./recall.ts's reason: it runs on the
 * path a mention takes, and a skill is an improvement to an answer rather than a
 * precondition for one. A directory that cannot be read, a store that cannot
 * answer, and a channel with no skills all produce the same thing, which is a
 * task that starts the way it did before phase 3.
 */
export type SkillRecall = (request: SkillRecallRequest) => Promise<readonly LoadedSkill[]>;

export function createSkillRecall(options: SkillRecallOptions = {}): SkillRecall {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  return async request => {
    const { channel, store, files, query, topK, maxSkillChars, maxSkills } = request;
    // One instant for the whole pass, so a skill first seen by this reconcile and
    // used by this retrieval carries the same figure in both columns.
    const at = now();

    try {
      reconcileSkillIndex({ files, store, maxSkills, at, channel, logger });
    } catch (error) {
      // A separate word from the search failure below. The two have different
      // fixes — a directory this process cannot read is a mount or a permission,
      // where a store that cannot answer is a database — and an operator reading
      // one should not have to guess which happened.
      logger.log("warn", {
        event: "skill_reconcile_failed",
        channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return [];
    }

    try {
      // Both legs asked for `topK`, not a multiple of it. The interleave takes at
      // most `topK` names in total, so over-fetching either side would buy
      // nothing but rows to discard — and `nearest` spends `k` inside the vec0
      // match, which is the cost #290 went to some trouble to keep exact.
      const byVector =
        request.vector === null
          ? []
          : store.nearest(request.vector, topK, "skill").map(hit => hit.source.ref);
      const byText = store.searchSkills(query, topK);

      const loaded: LoadedSkill[] = [];
      let chars = 0;

      for (const name of interleaveCandidates(byVector, byText, topK)) {
        // Resolved through the file, one at a time, and `null` is a real answer
        // — the index holds no text a caller reads, by #290's decision, exactly
        // so that a hand-deleted skill's stale body cannot reach a model. A
        // candidate whose file is gone or no longer parses is skipped, which is
        // what recall already does for an invalidated summary.
        const skill = files.read(name);
        if (skill === null) continue;

        // The channel's own per-skill cap. `packages/memory` declined to take
        // this figure on the grounds that refusing an over-cap file "is the
        // indexer's outcome to name" — this is the indexer's caller, and this is
        // it naming it. No operation can produce one; a hand-written playbook
        // that grew past the cap can.
        //
        // `continue`, not `break`: unlike the aggregate below, this says nothing
        // about what comes after it in the ranking.
        //
        // The skill's name is deliberately not in the line. `LogFields.reason`
        // is a closed vocabulary of codes, and there is no member that carries
        // an identifier a model or a team member chose. What an operator needs
        // in order to act is the channel and the fact, and the file itself is
        // one `wc -c` away in a directory they own.
        if (skill.body.length > maxSkillChars) {
          logger.log("warn", { event: "skill_oversize", channel, reason: "max_skill_chars" });
          continue;
        }

        // Dropped from the far end — the least similar — which is recall's rule
        // and its reason: the ordering here is relevance rather than time, so
        // what a bound sheds should be the weakest match. Description and body
        // both count, because both are rendered.
        const cost = skill.frontmatter.description.length + skill.body.length;
        if (chars + cost > SKILLS_MAX_CHARS) break;
        chars += cost;

        loaded.push({
          name,
          description: skill.frontmatter.description,
          body: skill.body
        });
      }

      if (loaded.length > 0) {
        // **Recorded for what actually loaded**, not for what was nominated. The
        // lifecycle clocks #294 will run read this column, and a use has to mean
        // "this skill reached a model" or the signal is about the ranker rather
        // than about the library.
        store.recordSkillUse(
          loaded.map(skill => skill.name),
          at
        );

        logger.log("info", {
          event: "skills_loaded",
          channel,
          // A count, never the skills: a playbook is the team's own text and a
          // log line is not where it goes. `recalled` logs its count the same
          // way and through the same field.
          totalTokens: loaded.length
        });
      }

      return loaded;
    } catch (error) {
      // A store that cannot answer costs the task its skills and nothing else.
      logger.log("warn", {
        event: "skill_recall_failed",
        channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return [];
    }
  };
}
