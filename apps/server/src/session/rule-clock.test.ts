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
