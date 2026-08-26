// When a `[[ambient.rule]]` next fires (#461).
//
// One pure function over a rule and an instant. It holds no state, reads no
// clock of its own, and touches nothing — which is the whole design of recurring
// rules restated as a signature, and the reason is worth having here rather than
// only in `./ambient.ts`.
//
// ## Why there is no last-fired stamp
//
// The obvious way to run a recurrence is to record what fired and when, and ask
// on each wake what has been missed. That needs persistence, and persistence
// across a restart is exactly what `./ambient.ts` refuses for the heartbeat: a
// fresh process starts with an empty schedule, and *that emptiness is the
// skip-don't-replay rule* rather than a check somebody wrote.
//
// Computing the next occurrence strictly after a given instant needs none of it.
// It is a function of the rule and the wall clock, so two processes asked the
// same question give the same answer, a restart cannot double-fire, and there is
// no stamp to get out of step with reality. What it costs is stated rather than
// discovered: **a restart spanning Monday 09:00 loses that Monday's digest.**
//
// That cost is the right one to pay here, and it is where a rule differs from a
// one-shot check. A due check fires once *late*, because a person approved that
// particular instant and gets nothing else if it slips. A rule is standing — the
// next occurrence is already coming — so firing Monday's digest on Tuesday
// morning is worse than not firing it: it posts an answer about the wrong day,
// under a label saying it is Monday's.
//
// ## UTC, and what a timezone would change
//
// Everything here is UTC, because `ClockTime` in @getlibero/schema is. The honest
// consequence: a team in a DST zone sees its rules move by an hour twice a year.
//
// Adding an IANA zone later changes this file and nothing else. The arithmetic
// would go through `Intl.DateTimeFormat` with a `timeZone`, which Node has built
// in — no dependency, which is the half of the schema's original objection that
// turned out not to hold. Nothing else in the design has to move, because the
// scheduler asks only for an instant and does not care how one was arrived at.
//
// ## Why the search is eight days and not seven
//
// A rule naming one weekday, asked just after that day's last time, has its next
// occurrence a full week out — Monday 10:00 asked of a rule that fires Monday
// 09:00 answers *next* Monday. Seven candidate days would run from Monday to
// Sunday and find nothing. The eighth is that same weekday coming round again,
// which is why the loop is inclusive of `7` rather than exclusive.

import type { AmbientRule, AmbientRuleDay } from "@getlibero/schema";

/**
 * The schema's day names, in `Date.prototype.getUTCDay` order.
 *
 * Indexed by that method's own return value, so the mapping is a lookup rather
 * than arithmetic with a `+ 6 % 7` in it. The order is JavaScript's — Sunday
 * first — and deliberately not the schema enum's, which reads Monday first
 * because that is how an operator writes a working week. Two orders for one
 * concept, with the conversion in one place, beats one order and a rotation
 * every reader has to verify.
 */
const WEEKDAYS: readonly AmbientRuleDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * The rule's next firing instant strictly after `after`, or `null`.
 *
 * **Strictly after**, which is what stops a firing from re-finding itself. The
 * scheduler recomputes from the instant it fired at, so an occurrence exactly
 * equal to that instant has to be excluded or the rule fires forever at the same
 * millisecond.
 *
 * `null` is unreachable for a rule that parsed: `at` and `days` are both
 * `min(1)` in the schema, so some day in the next eight carries some time. It is
 * in the signature anyway rather than asserted away, because the alternative is a
 * non-null assertion whose justification lives in another package — and the
 * caller's handling of it (skip the rule, say nothing) is one line.
 */
export function nextRuleOccurrence(rule: AmbientRule, after: number): number | null {
  const from = new Date(after);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const date = from.getUTCDate();

  for (let offset = 0; offset <= 7; offset += 1) {
    // Midnight UTC on the candidate day. `Date.UTC` normalizes an out-of-range
    // day-of-month, so month and year rollover need no arithmetic here.
    const midnight = Date.UTC(year, month, date + offset);
    const weekday = WEEKDAYS[new Date(midnight).getUTCDay()];
    if (weekday === undefined) continue;
    if (rule.days !== undefined && !rule.days.includes(weekday)) continue;

    // The earliest time on this day that is still ahead. Days ascend, so the
    // first day carrying any candidate carries the answer — but every time on
    // that day has to be considered before answering, since `at` is not sorted
    // and the sheet is under no obligation to write it in order.
    let earliest: number | null = null;
    for (const time of rule.at) {
      const hours = Number(time.slice(0, 2));
      const minutes = Number(time.slice(3, 5));
      const instant = midnight + hours * HOUR_MS + minutes * MINUTE_MS;
      if (instant <= after) continue;
      if (earliest === null || instant < earliest) earliest = instant;
    }
    if (earliest !== null) return earliest;
  }

  return null;
}
