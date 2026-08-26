// When a `[[ambient.rule]]` next fires (#461, zoned in #470).
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
// ## Zones, and the one path
//
// A rule reads its times in `timezone`, or in UTC when it names none. There is
// **one code path** and UTC is simply the default zone, rather than a fast exact
// path beside a zoned one — two implementations of "the next Monday at 09:00"
// are two chances for them to disagree, and the disagreement would show up as a
// digest an hour out on one channel and not another. A case asserts that a rule
// with no zone and one that says `"UTC"` answer identically, which is the cheap
// way to keep that true.
//
// The arithmetic is `Intl`'s, which Node has built in — so this costs no
// dependency, and the CLI's dependency-free bundle was never what stood in the
// way of zones. Formatters are memoized per zone because this runs per rule per
// scan, and constructing one is the expensive part.
//
// ## The two days a year that need a decision
//
// A wall-clock time is not a function of an instant when a zone shifts, and both
// directions need a stated answer rather than whatever the arithmetic falls out
// as.
//
// **A time that does not exist is skipped.** On a spring forward, local 01:30
// never happens: the clock goes 00:59 → 02:00. Resolving it anyway lands 01:30
// *after the jump* — a "01:30 digest" arriving at 02:30 — and can collide with
// an `at` entry that genuinely is 02:30, making two occurrences one instant. So
// the resolution is checked, and a local time that did not round-trip is not an
// occurrence. That is this module's own rule rather than a new one: **a missed
// window is skipped and the next occurrence is already coming**, and a wall-clock
// time the day did not contain is a missed window in the purest form.
//
// **A time that happens twice fires once, at the later reading.** On a fall
// back, local 01:30 occurs at both offsets. One firing is the invariant that
// matters — two would break "one post per occurrence" — and which of the two is
// arbitrary, so it is the one the offset resolution produces rather than an
// extra pass to prefer the earlier. The visible cost is an hour of elapsed time,
// once a year, on a rule whose time falls inside the repeated hour.
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

/** The zone a rule that names none is read in. */
const DEFAULT_ZONE = "UTC";

/**
 * One formatter per zone, kept.
 *
 * This runs per rule per scan — up to eight rules for every enabled channel,
 * every minute — and constructing an `Intl.DateTimeFormat` is far and away the
 * expensive part of what follows. The map is bounded by how many distinct zones
 * a deployment's sheets name, which is a small number an operator chose, so
 * there is nothing here to evict.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const held = formatters.get(zone);
  if (held !== undefined) return held;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  formatters.set(zone, made);
  return made;
}

/** What the wall clock in `zone` reads at `instant`. */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(instant: number, zone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instant))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
    second: Number(parts["second"])
  };
}

/**
 * How far `zone` is from UTC at `instant`, in milliseconds.
 *
 * Read off the wall clock rather than parsed out of an offset name, because the
 * name is localized text and the arithmetic is not.
 */
function offsetAt(instant: number, zone: string): number {
  const wall = wallClockAt(instant, zone);
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instant
  );
}

/**
 * The instant at which `zone`'s wall clock reads the given local time, or `null`
 * when it never does.
 *
 * Two passes, and the second is the one that matters: the offset *at the guess*
 * can differ from the offset *at the answer* when the guess falls on the far
 * side of a transition, and applying it once would land an hour out. Converging
 * twice is exact everywhere except inside a gap, which is what the round-trip
 * check below detects.
 *
 * `null` is a local time the day did not contain — see the header. It is a
 * separate answer from "no occurrence today", and the caller treats them the
 * same on purpose.
 */
function instantOfWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string
): number | null {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  const once = asIfUtc - offsetAt(asIfUtc, zone);
  const instant = asIfUtc - offsetAt(once, zone);

  // Did the clock in that zone really read what was asked for? On a spring
  // forward it did not, and the resolution above will have produced the same
  // instant a *later* wall time resolves to.
  const wall = wallClockAt(instant, zone);
  const round = wall.year === year && wall.month === month && wall.day === day;
  return round && wall.hour === hour && wall.minute === minute ? instant : null;
}

/**
 * The rule's next firing instant strictly after `after`, or `null`.
 *
 * **Strictly after**, which is what stops a firing from re-finding itself. The
 * scheduler recomputes from the instant it fired at, so an occurrence exactly
 * equal to that instant has to be excluded or the rule fires forever at the same
 * millisecond.
 *
 * `null` is all but unreachable for a rule that parsed: `at` and `days` are both
 * `min(1)` in the schema, so some day in the next eight carries some time — the
 * exception being a rule every one of whose times falls in a DST gap on every
 * day it names, which no real sheet describes. It is in the signature rather
 * than asserted away because the caller's handling of it (skip the rule, say
 * nothing) is one line.
 */
export function nextRuleOccurrence(rule: AmbientRule, after: number): number | null {
  const zone = rule.timezone ?? DEFAULT_ZONE;
  // The candidate days are the rule's *own* days, so the walk starts from the
  // date it is in that zone rather than the date it is in UTC — which are
  // different for most of the day in most of the world.
  const from = wallClockAt(after, zone);

  for (let offset = 0; offset <= 7; offset += 1) {
    // Midnight UTC on the candidate day, used only to name the calendar date and
    // its weekday. `Date.UTC` normalizes an out-of-range day-of-month, so month
    // and year rollover need no arithmetic here — and because both the date and
    // the weekday are read off the same construction, a day is a calendar day in
    // the rule's zone rather than a fixed number of milliseconds. That is what
    // makes the walk survive a transition, where adding 86_400_000 would not.
    const marker = new Date(Date.UTC(from.year, from.month - 1, from.day + offset));
    const weekday = WEEKDAYS[marker.getUTCDay()];
    if (weekday === undefined) continue;
    if (rule.days !== undefined && !rule.days.includes(weekday)) continue;

    // The earliest time on this day that is still ahead. Days ascend, so the
    // first day carrying any candidate carries the answer — but every time on
    // that day has to be considered before answering, since `at` is not sorted
    // and the sheet is under no obligation to write it in order.
    let earliest: number | null = null;
    for (const time of rule.at) {
      const instant = instantOfWallClock(
        marker.getUTCFullYear(),
        marker.getUTCMonth() + 1,
        marker.getUTCDate(),
        Number(time.slice(0, 2)),
        Number(time.slice(3, 5)),
        zone
      );
      if (instant === null || instant <= after) continue;
      if (earliest === null || instant < earliest) earliest = instant;
    }
    if (earliest !== null) return earliest;
  }

  return null;
}
