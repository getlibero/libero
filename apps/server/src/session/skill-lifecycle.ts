// The lifecycle job: the stale and archive clocks, run over a channel's skill
// library (#294).
//
// A library only ever grows. `[skills] max_skills` bounds it, there is no delete
// operation, and until this file nothing aged a playbook that had stopped being
// true. What ages one here is not its text and not its `created` line — it is
// what the index observed: when a task last loaded it, or, for a skill no task
// ever has, when this store first saw the file.
//
// ## It is the one background pass that spends nothing, and that is structural
//
// `SkillLifecycleOptions` holds no `CompletionClient`, no `EmbeddingClient` and
// no `reportTurn`. That is the whole of "deterministic, no model call": this
// module is not promising to be frugal, it is holding nothing it could spend
// with. It is the first pass in this process for which the shared spend reporter
// is deliberately not wired, and anyone adding one of those options here should
// take that as the question rather than the answer.
//
// ## What the job may move, and what it must not
//
// The arbitration is `planSkillLifecycle` below and its rules are three:
//
//   - **A status the job did not write is the team's**, detected by comparing
//     `skill.status` against `status_by_job` rather than by any timestamp. On a
//     disagreement — or a missing row, which is the job having never spoken here
//     — it *adopts*: it records what the file says and writes no file that run.
//   - **Adopting restamps `status_by_job_at`, and that stamp is part of the
//     clock.** A skill ages from
//     `max(last_used_at ?? first_seen_at, status_by_job_at)`, so a hand edit buys
//     the team a full stale window before the clock speaks again. Without it,
//     somebody un-archiving a long-unused playbook would watch the job archive it
//     back a cycle later, which is fighting them rather than respecting them.
//   - **The job's own move does not restamp it.** The clock is what its decisions
//     are measured against, so a job that reset the clock every time it acted
//     could never reach its second threshold: a skill marked stale at thirty days
//     would archive at a hundred and twenty rather than ninety.
//
// The consequence of folding the stamp into the clock is stated rather than
// discovered: **a lost index costs one full stale window** of no-ops, where the
// comment written before this job existed said one cycle. That is the better
// failure — an operator restoring a store should not have their whole library
// archived by the next message in the channel — and it is the same mechanism that
// makes a hand-set status survive, so the two cannot be had separately.
//
// **A target is absolute rather than a step**, so a skill two hundred days idle
// goes straight to `archived` without an intervening run at `stale`. `stale` is a
// waypoint a team observes when the clock passes through it in real time, not a
// turnstile the job has to be present for, and a channel whose process was down
// for a month should not need two passes to reach the state its own dates already
// imply. What guards against a burst is the first-sight rule above, not
// step-limiting: the job moves nothing on the run it first meets a skill.
//
// **Ageing needs only time; freshening needs a use.** The clock alone may move a
// skill toward `archived`, because idle time is evidence a skill has gone quiet.
// It may not move one back the same way, because "not idle" is evidence of
// nothing — a skill somebody archived by hand this morning has an idle time of
// zero, and reading that as freshness would un-archive it on the next pass. So a
// move toward `active` also requires that the most recent thing that happened to
// the skill was a task loading it.
//
// **Archived is terminal, and no `if` here says so.** An archived skill is
// excluded from both retrieval legs, so it can never record a use, so the
// condition above can never hold for one. The only road back is a person editing
// the file, which the adoption rule respects. That is a consequence of retrieval
// rather than a rule of this module's, and it should stay one.
//
// ## Ordering, and why reconciliation comes first
//
// The arbitration compares the *file's* status against the job's record, and the
// file's status reaches it through the index. So a pass that did not reconcile
// first would read its own last word back and conclude nothing had changed —
// every hand edit since the previous pass invisible. **Reconciling first is what
// makes "a hand-set status is respected" a property rather than a race**, and it
// makes this `reconcileSkillIndex`'s third caller after ./skill-recall.ts and
// ./skill-embed.ts. All three hold the session's lock.
//
// Files are written **before** their stamps. A crash between the two leaves a
// file the job wrote with a baseline it did not record, which the next pass reads
// as somebody else's edit: it adopts, and the cost is one stale window. The other
// order would leave the index claiming a move the file never took, and under a
// persistent `EACCES` the baseline would churn every run while the skill never
// aged.
//
// ## What bounds it
//
// - **The sheet.** `[skills] enabled` turns it off — a channel that disabled
//   skills has its statuses frozen rather than rewritten by a feature it does not
//   run — and `stale_after_days` / `archive_after_days` are the two clocks.
// - **`LIFECYCLE_INTERVAL_MS`**, per channel, six hours rather than the sweep's
//   five minutes. See the constant.
// - **`MAX_SKILL_STATUS_WRITES_PER_PASS`.** A pass that decides fifty skills have
//   aged rewrites twenty files and leaves the rest for the next one, in name
//   order, so a channel provisioned against a long-abandoned library works
//   through it deterministically.
// - **`setStatus` itself**, which cannot create a file, cannot create the
//   directory, and cannot write a file it could not first read.
//
// ## And what it deliberately does not do
//
// **It never deletes.** Archiving is a status; removing a file is the team's act
// on the team's directory. There is no delete on `SkillFiles` to reach for.
//
// **It writes nothing when nothing moved.** `setStatus` answers `unchanged`
// without touching the file, which is what keeps a steady-state pass from
// renaming every skill in the library and making the next reconciliation re-read
// all of them.

import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore, SkillClock, SkillStatusStamp } from "@getlibero/memory";
import { reconcileSkillIndex } from "@getlibero/memory";
import type { SkillStatus } from "@getlibero/schema";
import type { SkillFilesOpener } from "./skills.js";

/**
 * How often one channel's clocks may be read.
 *
 * **Not `SWEEP_INTERVAL_MS`, and the departure is deliberate.** ./skill-embed.ts
 * argues there is one "how often this process bothers to look" number and imports
 * it rather than restating five minutes. That argument is against *restating* a
 * figure, not against a second one existing: what it bounds there is how soon a
 * newly saved skill gets a vector, which is a question whose answer changes
 * within minutes. Here the smallest unit either threshold is expressed in is a
 * **day**, so looking 288 times a day would answer a question that changes at
 * most twice in a skill's life.
 *
 * Six hours is the same slack the five-minute sweep claims against a threshold in
 * tens of minutes, and it means a skill moves within six hours of crossing —
 * inside the noise of thirty days by two orders of magnitude.
 *
 * The spec calls this a *weekly* maintenance job. What makes any interval at or
 * below that satisfy it is **idempotence**: the clocks are absolute dates, so
 * running more often moves nothing sooner than its threshold and running less
 * often only delays. "Weekly" is a statement about how often a status needs
 * revisiting, not about a schedule this process would have to grow a timer and a
 * channel enumerator to keep.
 */
export const LIFECYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The most files one pass will rewrite.
 *
 * `MAX_THREADS_PER_SWEEP`'s counterpart, and what it bounds is neither calls nor
 * tokens but **writes to files a team owns**. A channel coming back to a library
 * nobody has touched in a year should not have a hundred files rewritten under it
 * in one burst; twenty at a time, in name order, is a change somebody can read in
 * a diff.
 *
 * It is a bound on the tail and not on the ordinary case: a steady library moves
 * nothing most passes and one or two skills when it does.
 */
export const MAX_SKILL_STATUS_WRITES_PER_PASS = 20;

/** What the pass needs from a channel's sheet. Resolved by ./sheet.ts. */
export interface SkillLifecycleSettings {
  /** `[skills] enabled`. False freezes this channel's statuses. */
  readonly enabled: boolean;
  /** `[skills] max_skills`. What reconciliation truncates the directory to. */
  readonly maxSkills: number;
  /** `[skills] stale_after_days`, in milliseconds. */
  readonly staleAfterMs: number;
  /** `[skills] archive_after_days`, in milliseconds. Never below the above. */
  readonly archiveAfterMs: number;
}

export interface SkillLifecycleOptions {
  /** How the channel's skills directory is opened. Takes the sheet's cap. */
  files: SkillFilesOpener;
  /** The channel's skill settings. `null` skips the channel entirely. */
  settings: (channel: string) => Promise<SkillLifecycleSettings | null>;
  logger?: Logger;
  now?: () => number;
  /** Cancels in-flight work when the process is stopping. */
  signal?: AbortSignal;
}

/**
 * Runs one channel's clocks, if it is due, and answers how many files it
 * rewrote.
 *
 * **Never rejects**: it is called from the message ingest path, where nothing is
 * waiting on it and a failure must not cost a channel its message write.
 */
export type SkillLifecyclePass = (channel: string, store: MessageStore) => Promise<number>;

/** What one pass decided, before it touched anything. */
export interface SkillLifecyclePlan {
  /** Statuses the job is adopting rather than deciding. No file is written. */
  readonly adopt: readonly SkillStatusStamp[];
  /** Skills the clock moved, in name order, already bounded. */
  readonly move: readonly SkillStatusStamp[];
}

/**
 * The arbitration, decided without touching a disk.
 *
 * Exported for its own test and absent from any barrel, which is `planSkillOp`'s
 * standing in `packages/memory`. It lives here rather than there because the two
 * thresholds are a channel's policy and that package holds no team sheet — the
 * same reason `maxSkills` is a required option over there and `SKILLS_MAX_CHARS`
 * is a constant here.
 */
export function planSkillLifecycle(
  clocks: readonly SkillClock[],
  settings: Pick<SkillLifecycleSettings, "staleAfterMs" | "archiveAfterMs">,
  at: number
): SkillLifecyclePlan {
  const adopt: SkillStatusStamp[] = [];
  const move: SkillStatusStamp[] = [];

  for (const clock of clocks) {
    // Somebody other than the job wrote this status, or the job has never spoken
    // about this skill. Either way it takes the file's word and changes nothing.
    if (clock.statusByJob === null || clock.status !== clock.statusByJob) {
      adopt.push({ name: clock.name, status: clock.status });
      continue;
    }

    const origin = Math.max(clock.lastUsedAt ?? clock.firstSeenAt, clock.statusByJobAt ?? 0);
    const idle = at - origin;
    const target: SkillStatus =
      idle >= settings.archiveAfterMs
        ? "archived"
        : idle >= settings.staleAfterMs
          ? "stale"
          : "active";

    if (target === clock.status) continue;

    // **Ageing needs only time; freshening needs a use.** Idle time is evidence
    // that a skill has gone quiet and it is the only evidence this job has, so it
    // moves a skill *toward* archived on the clock alone. It cannot move one back
    // the same way, because "not idle" is not evidence of anything: a skill
    // somebody archived by hand this morning has an idle time of zero, and a job
    // that read that as freshness would un-archive it on the next pass — which is
    // the team's word overturned by arithmetic.
    //
    // So a move toward active requires that the most recent thing that happened
    // to this skill was a *task loading it*. That is what makes **archived
    // terminal without an `if` for it**: an archived skill is excluded from both
    // retrieval legs, so it can never record a use, so this condition can never
    // hold for one. The only road back is a person editing the file, which the
    // adoption rule above respects.
    if (RANK[target] < RANK[clock.status]) {
      if (clock.lastUsedAt === null || clock.lastUsedAt < origin) continue;
    }

    move.push({ name: clock.name, status: target });
  }

  return { adopt, move: move.slice(0, MAX_SKILL_STATUS_WRITES_PER_PASS) };
}

/**
 * How far through its life each status is.
 *
 * Not on `SkillStatus` in the schema package: an order is a fact about what this
 * job does with the three, and nothing else in the tree compares them. The set is
 * closed, so a fourth member would be a type error here rather than a silent
 * `undefined`.
 */
const RANK: Record<SkillStatus, number> = { active: 0, stale: 1, archived: 2 };

export function createSkillLifecyclePass(options: SkillLifecycleOptions): SkillLifecyclePass {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  // When each channel last ran. ./skill-embed.ts's map and its reasons, with one
  // of its own: this is the only state the job keeps in memory, so a restart
  // makes the next message in each channel run a pass immediately. That costs one
  // SELECT and one readdir and moves nothing that was not already due, because
  // the clocks are dates — the interval bounds frequency, not schedule.
  const lastRanAt = new Map<string, number>();

  return async (channel, store) => {
    const startedAt = now();
    const previous = lastRanAt.get(channel);
    if (previous !== undefined && startedAt - previous < LIFECYCLE_INTERVAL_MS) return 0;
    // Stamped before the work rather than after, so a slow pass does not let a
    // second one start behind it.
    lastRanAt.set(channel, startedAt);

    let settings: SkillLifecycleSettings | null;
    try {
      settings = await options.settings(channel);
    } catch {
      // The resolver is documented total; this is defence rather than a path. A
      // channel whose sheet cannot be read ages nothing, which is the direction
      // `DEFAULT_SKILL_SETTINGS` already falls in.
      return 0;
    }
    if (settings === null || !settings.enabled) return 0;

    const files = options.files(channel, settings.maxSkills);
    // Already logged by the opener, with the reason it had.
    if (files === null) return 0;

    // One instant for the whole pass, ./skill-recall.ts's rule.
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
      // ./skill-embed.ts's word, for its reason: a directory this process cannot
      // read is a mount or a permission, and an operator reading the line should
      // not have to guess which half failed.
      logger.log("warn", { event: "skill_reconcile_failed", channel, reason: reasonOf(error) });
      return 0;
    }

    let clocks: readonly SkillClock[];
    try {
      clocks = store.skillClocks();
    } catch (error) {
      logger.log("warn", { event: "skills_lifecycle_failed", channel, reason: reasonOf(error) });
      return 0;
    }

    const plan = planSkillLifecycle(clocks, settings, startedAt);

    if (plan.adopt.length > 0) {
      try {
        store.adoptSkillStatus(plan.adopt, startedAt);
      } catch (error) {
        logger.log("warn", { event: "skills_lifecycle_failed", channel, reason: reasonOf(error) });
        return 0;
      }
      logger.log("info", {
        event: "skills_adopted",
        channel,
        // A count, never the names: a playbook's name is the team's own words.
        // `skills_embedded` and `skills_loaded` report through the same field.
        totalTokens: plan.adopt.length
      });
    }

    const moved: Record<SkillStatus, number> = { active: 0, stale: 0, archived: 0 };
    let written = 0;

    for (const stamp of plan.move) {
      if (options.signal?.aborted === true) break;

      let result;
      try {
        result = files.setStatus(stamp.name, stamp.status);
      } catch (error) {
        // An `EACCES` or an `ENOSPC` will meet every remaining write in this
        // pass, so one line says what twenty would. Nothing is stamped and the
        // next pass decides the same skills again.
        logger.log("warn", { event: "skills_lifecycle_failed", channel, reason: reasonOf(error) });
        break;
      }

      // The file went, or stopped parsing, between the clock read and the write.
      // No stamp, deliberately: recording a move that did not happen would let
      // the job believe it had spoken about a file it never touched.
      if (result.outcome === "unusable") continue;

      // `unchanged` is stamped too. The file already says what the clock wanted,
      // so the decision stands even though no byte moved — without the stamp the
      // job would re-decide it every pass forever.
      try {
        store.recordSkillStatus([stamp]);
      } catch (error) {
        logger.log("warn", { event: "skills_lifecycle_failed", channel, reason: reasonOf(error) });
        break;
      }

      if (result.outcome === "written") {
        written += 1;
        moved[stamp.status] += 1;
      }
    }

    if (moved.stale > 0) {
      logger.log("info", { event: "skills_marked_stale", channel, totalTokens: moved.stale });
    }
    if (moved.archived > 0) {
      logger.log("info", { event: "skills_archived", channel, totalTokens: moved.archived });
    }
    if (moved.active > 0) {
      logger.log("info", { event: "skills_reactivated", channel, totalTokens: moved.active });
    }

    // A second reconciliation, so what the pass just wrote is what retrieval
    // sees. It is cheap — a readdir and a stat per file, with only the files just
    // renamed re-read — and it costs no embedding, because a status change moves
    // no description and `description_hash` is what invalidates a vector.
    //
    // **Correctness does not depend on it.** ./skill-recall.ts reconciles at the
    // head of every task before it searches, so a skill archived here is excluded
    // on the very next task in this channel either way. What this shortens is the
    // window, from "the next task" to "the end of the pass", and it is also what
    // makes an archived skill lose its vector now rather than then.
    if (written > 0) {
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
        // The files are already right and the next reconciliation will follow
        // them, so this is not a failure of the pass.
        logger.log("warn", { event: "skill_reconcile_failed", channel, reason: reasonOf(error) });
      }
    }

    return written;
  };
}

/**
 * A reason code from an error, and never its message.
 *
 * ./skill-embed.ts's rule: a message can carry a path, a URL, or a channel's own
 * words back into a log line.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
