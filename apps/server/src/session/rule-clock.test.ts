import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import type { AmbientRule } from "@getlibero/schema";
import { nextRuleOccurrence } from "./rule-clock.js";

/** A rule, with the fields a case is not about left at something innocuous. */
const rule = (over: Partial<AmbientRule> = {}): AmbientRule => ({
  name: "standup-digest",
  at: ["09:00"],
  question: "What is blocked?",
  ...over
});

/** An instant, stated the way the cases read: UTC, to the minute. */
const utc = (iso: string): number => Date.parse(`${iso}Z`);

describe("the next occurrence of a rule", () => {
  // 2026-08-26 is a Wednesday. Every case below is anchored to that week so a
  // reader can check the weekday arithmetic without a calendar.
  const wednesday = "2026-08-26T";

  it("answers later today when a time is still ahead", () => {
    expect(nextRuleOccurrence(rule(), utc(`${wednesday}08:00:00`))).toBe(
      utc(`${wednesday}09:00:00`)
    );
  });

  it("answers tomorrow once today's time has passed", () => {
    expect(nextRuleOccurrence(rule(), utc(`${wednesday}09:30:00`))).toBe(
      utc("2026-08-27T09:00:00")
    );
  });

  // Strictly after, and this is the case that matters: the scheduler recomputes
  // from the instant it fired at, so an occurrence equal to it must not be the
  // answer or the rule fires forever at one millisecond.
  it("never answers the instant it was asked about", () => {
    const at = utc(`${wednesday}09:00:00`);
    expect(nextRuleOccurrence(rule(), at)).toBe(utc("2026-08-27T09:00:00"));
  });

  it("takes the earliest time still ahead, whatever order they are written in", () => {
    const times = rule({ at: ["17:00", "09:00", "13:00"] });
    expect(nextRuleOccurrence(times, utc(`${wednesday}08:00:00`))).toBe(
      utc(`${wednesday}09:00:00`)
    );
    expect(nextRuleOccurrence(times, utc(`${wednesday}10:00:00`))).toBe(
      utc(`${wednesday}13:00:00`)
    );
    expect(nextRuleOccurrence(times, utc(`${wednesday}18:00:00`))).toBe(
      utc("2026-08-27T09:00:00")
    );
  });

  it("skips the days a rule does not name", () => {
    // Wednesday, asking a Monday-and-Friday rule: Friday the 28th.
    const workdays = rule({ days: ["mon", "fri"] });
    expect(nextRuleOccurrence(workdays, utc(`${wednesday}08:00:00`))).toBe(
      utc("2026-08-28T09:00:00")
    );
  });

  // The eighth candidate day, and the reason the loop is inclusive of 7: a rule
  // naming one weekday, asked after that day's last time, is a full week out.
  it("answers a week out for a weekly rule already past its time", () => {
    const weekly = rule({ days: ["wed"] });
    expect(nextRuleOccurrence(weekly, utc(`${wednesday}09:30:00`))).toBe(
      utc("2026-09-02T09:00:00")
    );
  });

  it("treats an absent days list as every day", () => {
    const daily = rule({ at: ["06:00"] });
    // Saturday and Sunday included, where a weekday list would skip them.
    expect(nextRuleOccurrence(daily, utc("2026-08-28T07:00:00"))).toBe(
      utc("2026-08-29T06:00:00")
    );
  });

  it("crosses a month boundary without arithmetic of its own", () => {
    expect(nextRuleOccurrence(rule(), utc("2026-08-31T10:00:00"))).toBe(
      utc("2026-09-01T09:00:00")
    );
  });

  it("crosses a year boundary", () => {
    expect(nextRuleOccurrence(rule(), utc("2026-12-31T10:00:00"))).toBe(
      utc("2027-01-01T09:00:00")
    );
  });

  // Whatever the host's zone is, the answer is the same instant. The suite would
  // otherwise pass in UTC and fail for anyone running it in Europe or America,
  // which is the bug this design exists to not have.
  each([
    ["midnight", "00:00", "2026-08-27T00:00:00"],
    ["one minute past", "00:01", "2026-08-27T00:01:00"],
    ["the last minute of the day", "23:59", `${wednesday}23:59:00`]
  ])("places %s in UTC", (_label, time, expected) => {
    expect(nextRuleOccurrence(rule({ at: [time] }), utc(`${wednesday}12:00:00`))).toBe(
      utc(expected)
    );
  });

  // A rule that parsed cannot produce this — `at` and `days` are both min(1) in
  // the schema — so the case exists to pin the contract the caller relies on
  // rather than to describe a sheet anyone can write.
  it("answers null when no day the rule names can carry a time", () => {
    const impossible = { ...rule(), days: [] } as unknown as AmbientRule;
    expect(nextRuleOccurrence(impossible, utc(`${wednesday}08:00:00`))).toBeNull();
  });

  // Every occurrence a day apart, asked repeatedly, walks forward one day at a
  // time and never repeats itself — the property the scheduler's recompute-from-
  // the-firing-instant loop depends on.
  it("walks forward without repeating when asked from its own answer", () => {
    const seen: number[] = [];
    let at = utc(`${wednesday}00:00:00`);
    for (let step = 0; step < 5; step += 1) {
      const next = nextRuleOccurrence(rule(), at);
      expect(next).not.toBeNull();
      if (next === null) return;
      expect(next).toBeGreaterThan(at);
      seen.push(next);
      at = next;
    }
    expect(new Set(seen).size).toBe(5);
  });
});

describe("a rule that names a zone", () => {
  // Europe/London springs forward 2027-03-28 at 01:00 UTC (local 01:00 → 02:00)
  // and falls back 2027-10-31 at 01:00 UTC (local 02:00 → 01:00). Every case
  // below is anchored to one of those two, so a reader can check the arithmetic
  // against a calendar rather than against this file.
  const zoned = (over: Partial<AmbientRule> = {}): AmbientRule =>
    rule({ timezone: "Europe/London", ...over });

  // The property the whole one-path decision rests on: a rule that names no zone
  // and one that names UTC are the same rule. Two implementations would be two
  // chances to disagree, and the disagreement would be an hour on one channel.
  it("answers identically with no zone and with UTC", () => {
    const at = utc("2026-08-26T08:00:00");
    for (const times of [["09:00"], ["23:59"], ["00:00", "12:00"]]) {
      expect(nextRuleOccurrence(rule({ at: times }), at)).toBe(
        nextRuleOccurrence(rule({ at: times, timezone: "UTC" }), at)
      );
    }
  });

  it("fires at the zone's wall clock, not at UTC's", () => {
    // Mid-summer, so London is one hour ahead: 09:00 local is 08:00 UTC.
    expect(nextRuleOccurrence(zoned(), utc("2027-07-14T06:00:00"))).toBe(
      utc("2027-07-14T08:00:00")
    );
    // Mid-winter, where the two agree.
    expect(nextRuleOccurrence(zoned(), utc("2027-01-14T06:00:00"))).toBe(
      utc("2027-01-14T09:00:00")
    );
  });

  // The point of the whole change: a 09:00 digest stays a 09:00 digest across a
  // transition, where a UTC rule drifts by an hour.
  it("keeps its wall-clock time across a spring forward", () => {
    const before = nextRuleOccurrence(zoned(), utc("2027-03-27T06:00:00"));
    const after = nextRuleOccurrence(zoned(), utc("2027-03-29T06:00:00"));
    expect(before).toBe(utc("2027-03-27T09:00:00"));
    // The day after the transition, 09:00 local is 08:00 UTC — a different
    // instant for the same wall time, which is the drift being fixed.
    expect(after).toBe(utc("2027-03-29T08:00:00"));
  });

  it("keeps its wall-clock time across a fall back", () => {
    expect(nextRuleOccurrence(zoned(), utc("2027-10-30T06:00:00"))).toBe(
      utc("2027-10-30T08:00:00")
    );
    expect(nextRuleOccurrence(zoned(), utc("2027-11-01T06:00:00"))).toBe(
      utc("2027-11-01T09:00:00")
    );
  });

  // A local time the day did not contain is a missed window, and this module's
  // standing answer to a missed window is to skip it.
  it("skips a time the spring forward deleted", () => {
    // Local 01:30 does not exist on 2027-03-28: the clock goes 00:59 to 02:00.
    const gap = zoned({ at: ["01:30"] });
    const next = nextRuleOccurrence(gap, utc("2027-03-27T23:00:00"));
    // Not that day at all — the following one, at its ordinary instant.
    expect(next).toBe(utc("2027-03-29T00:30:00"));
  });

  // The reason skipping matters beyond losing one firing: resolving a deleted
  // time anyway lands it on the instant a real one already occupies.
  it("does not collide a deleted time with a real one on the same rule", () => {
    const both = zoned({ at: ["01:30", "02:30"] });
    const next = nextRuleOccurrence(both, utc("2027-03-27T23:00:00"));
    // 02:30 local exists that day and is 01:30 UTC. The deleted 01:30 must not
    // have produced that same instant and been taken as the earlier of the two.
    expect(next).toBe(utc("2027-03-28T01:30:00"));
  });

  // Twice on the clock, once as a firing. Which of the two is arbitrary; that
  // there is exactly one is not.
  it("fires once for a time the fall back repeats", () => {
    const repeated = zoned({ at: ["01:30"] });
    const first = nextRuleOccurrence(repeated, utc("2027-10-30T23:00:00"));
    expect(first).toBe(utc("2027-10-31T01:30:00"));
    // And asking again from that answer moves to the next day rather than to the
    // hour's other reading.
    expect(nextRuleOccurrence(repeated, first ?? 0)).toBe(utc("2027-11-01T01:30:00"));
  });

  // A day is a calendar day in the rule's zone. Adding 86_400_000 across the
  // transition would land the walk an hour out and pick the wrong weekday edge.
  it("walks calendar days rather than fixed offsets", () => {
    // Sunday 2027-03-28 is the transition. A Monday rule asked on the Saturday
    // has to cross it and still land on Monday's 09:00 local.
    const monday = zoned({ days: ["mon"] });
    expect(nextRuleOccurrence(monday, utc("2027-03-27T12:00:00"))).toBe(
      utc("2027-03-29T08:00:00")
    );
  });

  // The zone decides which calendar day it is, which is not UTC's day for most
  // of the world for much of the day.
  it("reads the candidate day in the rule's zone, not in UTC", () => {
    // 2027-07-13T03:00Z is Tuesday in UTC and still Monday evening in Los
    // Angeles — 20:00 on Monday the 12th.
    const monday = rule({ days: ["mon"], at: ["21:00"], timezone: "America/Los_Angeles" });
    // So the next Monday 21:00 is an hour later on that same local Monday, not a
    // week out. A walk that took UTC's day would have read Tuesday and answered
    // the 19th.
    expect(nextRuleOccurrence(monday, utc("2027-07-13T03:00:00"))).toBe(
      utc("2027-07-13T04:00:00")
    );
  });

  it("handles a zone with no daylight saving at all", () => {
    const fixed = rule({ timezone: "Asia/Tokyo" });
    // Tokyo is UTC+9 year-round, so 09:00 local is midnight UTC, always.
    expect(nextRuleOccurrence(fixed, utc("2027-03-27T12:00:00"))).toBe(
      utc("2027-03-28T00:00:00")
    );
    expect(nextRuleOccurrence(fixed, utc("2027-10-30T12:00:00"))).toBe(
      utc("2027-10-31T00:00:00")
    );
  });
});
