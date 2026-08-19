// A check the agent asks for now and something runs later (#322).
//
// `schedule_task` is the second built-in, and it is the first one whose contract
// spans both processes. `search_channel_history` is answered and forgotten: the
// proxy parses arguments it alone reads and returns text nobody parses back. A
// create is different in kind — the proxy governs it and the *agent* records what
// it produced, so the ticket is a wire shape with a reader on the far side. That
// is why the whole contract is here rather than split the way that one is: the
// arguments, the schema the model is shown, the caps all three of them are
// checked against, and the ticket both processes agree on.
//
// ## The model sends an offset, not an instant
//
// `due_in_minutes`, an integer with the unit in its name, which is how this tree
// spells every duration — `heartbeat_every_minutes`, `stale_after_days`,
// `summarize_after_idle_minutes`. It is not a shape chosen for elegance; the
// alternative fails three ways at once.
//
// A model has no clock. Asking for an absolute instant means telling it what time
// it is and trusting arithmetic it does in prose, where an hour out is a check
// that fires at the wrong time and nothing catches it. It means accepting a
// zoneless string sooner or later, which every other date in this tree refuses
// (see `SkillCreated`, and the audit log's read path, which parses by rule rather
// than letting `Date.parse` read `04/08/2026` in whatever order it likes). And it
// means a date grammar in a package `packages/cli` inlines and publishes with no
// dependencies at all.
//
// An offset needs none of that. Both time caps are integer comparisons decided
// before any clock is consulted, and the one clock reading — `now() + offset`,
// in the proxy, at create — happens once and is durable from then on. **A fired
// task does no arithmetic**, which is the property #322 asks for; this is the
// shape that gets it without asking a language model to be a calendar.
//
// What it does not express is recurrence. "Every Tuesday at 09:00" is not a
// thing this can say, deliberately: a recurring check is the model re-scheduling
// from a fired one, which is a fresh create through the same gates rather than a
// loop the scheduler owns.
//
// ## Two units, and which is written where
//
// The ticket carries `dueAt` as an ISO-8601 UTC instant and the store's column
// holds milliseconds. That is `skill.ts`'s split — what a human reads and what
// the machine stamps — and it lands the same way: the string is read by a model
// (in the tool result it gets back) and by a person (in a transcript), while
// every other clock column in `packages/memory` is a number and this one has no
// business being the exception. `scheduledInstantFromMs` and
// `msFromScheduledInstant` are the one conversion, in one place, round-tripped by
// a test.
//
// The instant is second-resolution, so the proxy floors its arithmetic to the
// second when it mints one. Otherwise the two conversions would be lossy in one
// direction and a test asserting they are not would be asserting something false.
//
// ## The caps are constants here, not fields on `[ambient]`
//
// The test is the one `[skills] top_k` states against `RECALL_LIMIT`: a bound on
// what the *process assembles* is a constant, and a policy a team holds an
// opinion about is a sheet field, and the thing that decides which is who grew
// the corpus. Skills are written and owned by a team, so how many of their own
// playbooks a task opens with is theirs. Scheduled tickets are machine-grown —
// the model creates every one of them — so how many may be pending is a bound on
// this process, in the same family as `MAX_OPEN_PROPOSALS` and
// `HEARTBEAT_POST_WINDOW_MS`.
//
// `[ambient]`'s own trailing comment already refuses the sheet-field version of
// this question for the rate limit, in the same words. Nothing named
// `max_scheduled_tasks` goes on that block.
//
// ## Which failures are refusals and which are bad arguments
//
// A prompt over its cap and an unknown key are **bad arguments**: they come back
// as an error result the model can correct, which is the rule
// `packages/proxy/src/builtin-dispatcher.ts` already applies to
// `search_channel_history`. The three caps below are **governance**: they come
// back as `ToolRefusal`s, because "you may not assemble future work faster than
// this" is a decision about what a channel is permitted rather than a statement
// about the shape of a request, and a decision wants the closed set, the audit
// row and the one sentence `refusalMessage` writes.
//
// That is why `due_in_minutes` is bounded only as a positive integer below, while
// the JSON Schema states the floor and the horizon. A well-behaved model is told
// the rule; a model that ignores it meets a refusal and leaves a row. Bounding it
// twice would make both unreachable.

import { z } from "zod";
import { ScheduledTaskId, TaskId } from "./names.js";
import type { ToolInputSchema } from "./tool-listing.js";

/**
 * How many unfired checks one channel may hold.
 *
 * The flood bound, and the reason a prompt-injected model cannot turn one
 * approved create into a thousand. Ten because a channel with ten checks
 * outstanding has a scheduling problem rather than a tooling one, and because
 * every one of them was clicked through by a human — the cap is the backstop
 * behind that click, not the primary control.
 *
 * It is a *floor* on what is really pending rather than an exact count, and the
 * direction is the safe one: a create the proxy served whose row failed to land
 * is audited and uncounted, so the channel gets at most one extra slot rather
 * than one fewer.
 */
export const SCHEDULED_TASK_MAX_PENDING = 10;

/**
 * How soon a check may be asked for.
 *
 * Five minutes, and the floor exists because below it the design cannot honour
 * the time it promised. The clock rescans at most once a minute
 * (`AMBIENT_RESCAN_MS`), and a create is held for a human's click by default —
 * so a two-minute lead is a check that is already late when it is approved. A
 * check that soon is also a thing to simply do now, in the turn that is already
 * running.
 */
export const SCHEDULED_TASK_MIN_LEAD_MINUTES = 5;

/**
 * How far out a check may be asked for.
 *
 * A week, which is `answer_after_idle_minutes`' own roof and the same judgement:
 * past it the thing being waited on has not gone quiet, the channel has. It also
 * bounds the damage from the one mistake this tool cannot undo from the model's
 * side — a mis-computed offset is a check at the wrong time, and a week is how
 * wrong it can be.
 */
export const SCHEDULED_TASK_MAX_HORIZON_MINUTES = 10_080;

/**
 * How long the question may be.
 *
 * This is the *whole* context the fired turn gets: there is no thread, nobody who
 * asked, and no reply to read up from. Five hundred characters is enough to say
 * what to check and what would count as worth mentioning, and short enough that a
 * human reading it on an approval card reads all of it — which is the only place
 * anyone reviews this text before it becomes future work.
 *
 * Under `AMBIENT_FINDING_MAX_CHARS`, deliberately: that bounds an answer put in
 * front of a channel, and this bounds the question. A question longer than its
 * answer has not been reduced to a question yet.
 */
export const SCHEDULED_TASK_MAX_PROMPT_CHARS = 500;

/**
 * What the model may send, parsed strictly.
 *
 * `.strict()` is `SearchChannelHistoryArguments`' rule and carries the same
 * claim: there is no channel field to send, and an unknown key is a rejection
 * rather than a silently dropped one. It also closes two specific attempts —
 * `dueAt` and `id` are minted by the proxy, and a model that sends either gets an
 * error naming the key rather than a ticket it chose the terms of.
 */
export const ScheduleTaskArguments = z
  .object({
    /** What to check, and what would make it worth saying. See the cap above. */
    prompt: z.string().min(1).max(SCHEDULED_TASK_MAX_PROMPT_CHARS),
    /**
     * How long from now, in minutes.
     *
     * Bounded here only as a positive integer. The floor and the horizon are
     * governance and are enforced as refusals — see the header.
     */
    due_in_minutes: z.number().int().positive()
  })
  .strict();

export type ScheduleTaskArguments = z.infer<typeof ScheduleTaskArguments>;

/**
 * The JSON Schema the model is given, beside the zod parser that enforces it.
 *
 * Two spellings of one contract, which is a drift hazard, closed the way
 * `builtins.test.ts` closes it for the other built-in: arguments the schema calls
 * valid go through the parser and vice versa.
 *
 * `additionalProperties: false` mirrors `.strict()`, and the two bounds on
 * `due_in_minutes` are stated here even though the parser does not carry them —
 * a well-behaved model is told the rule rather than only punished for breaking
 * it.
 */
export const SCHEDULE_TASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: SCHEDULED_TASK_MAX_PROMPT_CHARS,
      description:
        "What to check when the time comes, and what would make it worth telling the channel. This is the only context that turn gets — there is no thread to read and nobody to ask — so write it to stand alone."
    },
    due_in_minutes: {
      type: "integer",
      minimum: SCHEDULED_TASK_MIN_LEAD_MINUTES,
      maximum: SCHEDULED_TASK_MAX_HORIZON_MINUTES,
      description: `How long from now, in minutes. At least ${SCHEDULED_TASK_MIN_LEAD_MINUTES} and at most ${SCHEDULED_TASK_MAX_HORIZON_MINUTES}. The exact time is worked out when this is approved, so you do not need to know what time it is now.`
    }
  },
  required: ["prompt", "due_in_minutes"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * An instant on the ticket: ISO-8601, UTC, to the second, ending in `Z`.
 *
 * **The zone is not optional and there is no offset form.** `SkillCreated`'s
 * argument one field wider: a zoneless instant is read as the host's time by
 * whatever parses it next, and the two processes that read this one are
 * configured separately. `+01:00` is rejected too, because two spellings of one
 * instant is one of them going untested.
 *
 * The `.check` is `SkillCreated`'s as well: the pattern admits `2026-02-30` and
 * `2026-01-01T25:00:00Z`, which `Date.UTC` would roll over into March and into
 * the next day. Re-deriving the string from the parsed components and comparing
 * is what refuses them.
 */
export const ScheduledInstant = z
  .string()
  .regex(INSTANT_PATTERN, "must be a UTC instant to the second, like 2026-08-19T09:30:00Z")
  .check(ctx => {
    const match = INSTANT_PATTERN.exec(ctx.value);
    if (match === null) return;
    if (scheduledInstantFromMs(msFromParts(match)) === ctx.value) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      message: "must be an instant that exists"
    });
  });

export type ScheduledInstant = z.infer<typeof ScheduledInstant>;

/** The six captured groups of `INSTANT_PATTERN`, as epoch milliseconds. */
function msFromParts(match: RegExpExecArray): number {
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
}

/**
 * Milliseconds to the instant a ticket carries.
 *
 * Truncating to the second rather than rounding, so that the instant is never
 * later than the millisecond it came from: a check is allowed to be a fraction of
 * a second early and is not allowed to be minted late.
 */
export function scheduledInstantFromMs(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * The instant a ticket carries, back to milliseconds.
 *
 * `Date.UTC` over parsed components and never `Date.parse` — the audit reader's
 * rule, for its reason. Throws on a string that is not a `ScheduledInstant`,
 * because every caller has one that parsed and a failure here is a wiring bug.
 */
export function msFromScheduledInstant(instant: string): number {
  const match = INSTANT_PATTERN.exec(instant);
  if (match === null) throw new Error("schedule: not a scheduled instant");
  return msFromParts(match);
}

/**
 * One future check, as the proxy minted it and the agent stores it.
 *
 * What is **not** here is most of the design.
 *
 * **No `channel`.** It comes from the client certificate at create and from the
 * file the ticket lives in at fire, which is how everything else in this tree
 * gets one. There is no field for a hostile argument blob to reach.
 *
 * **No `requestingUser` and no thread.** A fired task has nobody who asked — that
 * is what ambient means — and there is no inbound event to reply into. Both are
 * `AmbientFinding`'s reasons for having neither.
 *
 * **No status.** A ticket's terminal state is written when it fires, by the
 * process that fires it, and this is what crosses the wire at create. Pending is
 * not a value here; it is a row with no fire stamp on it, in the store.
 */
export const ScheduledTask = z
  .object({
    /**
     * The proxy minted it, and the model did not choose it.
     *
     * A bearer of nothing — it identifies a row in one channel's store so the
     * firing can mark it done. `ApprovalTicketId`'s alphabet and its reason: the
     * mint's format is the proxy's business and pinning it here would make
     * changing it a schema change.
     */
    id: ScheduledTaskId,
    /**
     * The task that created it: the join from this row into the audit log's
     * create.
     *
     * Asserted by the agent and read by no decision — `requestingUser`'s
     * standing, stated on that field in ./tool-call.ts. What it buys is that an
     * operator holding a ticket can find the governed create that made it.
     */
    task: TaskId,
    /** The question, bounded at create. Model-authored; a human read it on the card. */
    prompt: z.string().min(1).max(SCHEDULED_TASK_MAX_PROMPT_CHARS),
    /** When to check. Absolute, resolved once, by the proxy's clock. */
    dueAt: ScheduledInstant,
    /** When the create was served. */
    createdAt: ScheduledInstant
  })
  .strict();

export type ScheduledTask = z.infer<typeof ScheduledTask>;

/**
 * Why a result was not a ticket.
 *
 * Local to this module rather than members on a shared reason set, for
 * `AmbientFindingFailure`'s stated reason: nothing here is decided by a gate or
 * writes an audit row. Both members mean the same thing to the model — the check
 * was permitted and is not recorded — and are kept apart because they mean
 * different things to whoever is reading the log: one is a truncated or corrupted
 * result, the other is two halves of a deployment that do not agree.
 */
export const ScheduledTaskFailure = z.enum(["malformed_json", "schema_invalid"]);

export type ScheduledTaskFailure = z.infer<typeof ScheduledTaskFailure>;

/** Where a field went wrong. Paths and zod codes, never messages. */
export interface ScheduledTaskIssue {
  readonly path: string;
  readonly code: string;
}

/** What `parseScheduledTask` answers. Never an exception. */
export type ScheduledTaskParse =
  | { readonly ok: true; readonly task: ScheduledTask }
  | {
      readonly ok: false;
      readonly reason: ScheduledTaskFailure;
      readonly issues?: readonly ScheduledTaskIssue[];
    };

/**
 * The ticket, as the proxy puts it in a tool result.
 *
 * JSON rather than a sentence, and indented rather than compact. It is read by
 * two audiences and serves both: the agent parses it back with the schema above,
 * so the due instant the model is told is the due instant that was stored; and
 * the model reads the same bytes as its confirmation, where a wall of one-line
 * JSON is worse than a shape it can see.
 *
 * A prose confirmation was rejected outright. It would have to be re-parsed by
 * regular expression on the far side, which is a second definition of a format —
 * exactly what `parseSkillFile`'s grammar exists to avoid having two of.
 */
export function serializeScheduledTask(task: ScheduledTask): string {
  return `${JSON.stringify(task, null, 2)}\n`;
}

/**
 * A tool result back into a ticket, or the reason it is not one.
 *
 * Never throws. The caller is the agent's tool client, which has to answer the
 * model either way, and a rejection there would end a task over a confirmation.
 */
export function parseScheduledTask(text: string): ScheduledTaskParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }

  const parsed = ScheduledTask.safeParse(value);
  if (parsed.success) return { ok: true, task: parsed.data };

  return {
    ok: false,
    reason: "schema_invalid",
    issues: parsed.error.issues.map(issue => ({
      path: issue.path.join("."),
      code: issue.code
    }))
  };
}
