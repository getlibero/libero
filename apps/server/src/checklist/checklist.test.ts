// The coalescer, driven the way the loop and the task drive it: steps in
// through `report`, an ending in through `close`. The scheduler is manual, so
// the edit floor is a test firing a timer rather than a second passing.

import type { ToolCallStep } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger, Scheduler } from "@getlibero/gateway";
import { createStubSlack } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { createChecklistReporter, MIN_EDIT_INTERVAL_MS } from "./checklist.js";

const CHANNEL = "C024BE91L";
const THREAD = "1717171717.000001";

/** A scheduler whose timers only fire when a test says so. */
function manualClock(): { scheduler: Scheduler; pending: () => number[]; fire: () => void } {
  const queue: Array<{ ms: number; fn: () => void }> = [];
  return {
    scheduler: (ms, fn) => {
      const entry = { ms, fn };
      queue.push(entry);
      return () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    pending: () => queue.map(entry => entry.ms),
    fire: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("no timer was pending");
      next.fn();
    }
  };
}

function capturingLogger(): { logger: Logger; lines: Array<{ level: LogLevel } & LogFields> } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { logger: { log: (level, fields) => lines.push({ level, ...fields }) }, lines };
}

function rig(overrides: { cardPostFailure?: Error; cardUpdateFailure?: Error } = {}) {
  const slack = createStubSlack(overrides);
  const clock = manualClock();
  const { logger, lines } = capturingLogger();
  const checklist = createChecklistReporter({ cards: slack.poster, logger, scheduler: clock.scheduler })({
    channelId: CHANNEL,
    threadTs: THREAD
  });
  return { slack, clock, lines, checklist };
}

const step = (ordinal: number, name: string, state: ToolCallStep["state"]): ToolCallStep => ({
  ordinal,
  name,
  state
});

/** Lets the write chain settle. Every write is a resolved-promise hop or two. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("when the card appears", () => {
  // The decision that keeps an ordinary question to one message: a task that
  // calls no tool posts nothing but its answer, exactly as before #68.
  it("posts nothing for a task that never called a tool", async () => {
    const { slack, checklist } = rig();

    await checklist.close("completed");
    await flush();

    expect(slack.cards).toHaveLength(0);
    expect(slack.edits).toHaveLength(0);
  });

  it("posts on the first tool call, into the request's thread", async () => {
    const { slack, checklist } = rig();

    checklist.report(step(1, "github.merge_pr", "running"));
    await flush();

    expect(slack.cards).toHaveLength(1);
    expect(slack.cards[0]?.channelId).toBe(CHANNEL);
    expect(slack.cards[0]?.threadTs).toBe(THREAD);
    expect(JSON.stringify(slack.cards[0]?.card)).toContain("github.merge_pr");

    await checklist.close("completed");
  });

  it("is one message for the whole task, edited — never a second post", async () => {
    const { slack, clock, checklist } = rig();

    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      checklist.report(step(ordinal, `github.tool_${String(ordinal)}`, "running"));
      await flush();
      checklist.report(step(ordinal, `github.tool_${String(ordinal)}`, "ok"));
      await flush();
      if (clock.pending().length > 0) clock.fire();
      await flush();
    }
    await checklist.close("completed");
    await flush();

    expect(slack.cards).toHaveLength(1);
    expect(slack.edits.length).toBeGreaterThan(0);
  });
});

describe("the edit floor", () => {
  it("holds the floor between writes, and covers the burst with one edit", async () => {
    const { slack, clock, checklist } = rig();

    // The first step posts immediately — a reader should see the card go up
    // when the work starts, not a second later.
    checklist.report(step(1, "github.a", "running"));
    await flush();
    expect(slack.cards).toHaveLength(1);
    expect(clock.pending()).toEqual([MIN_EDIT_INTERVAL_MS]);

    // Everything that lands inside the floor writes nothing.
    checklist.report(step(1, "github.a", "ok"));
    checklist.report(step(2, "github.b", "running"));
    checklist.report(step(2, "github.b", "ok"));
    checklist.report(step(3, "github.c", "running"));
    await flush();
    expect(slack.edits).toHaveLength(0);

    // And one edit covers all of it, because a write renders what is true when
    // it runs rather than what was true when it was queued.
    clock.fire();
    await flush();
    expect(slack.edits).toHaveLength(1);
    const shown = JSON.stringify(slack.cardAt(slack.cards[0]?.messageTs ?? ""));
    expect(shown).toContain("`github.a` — done");
    expect(shown).toContain("`github.b` — done");
    expect(shown).toContain("`github.c` — running");

    await checklist.close("completed");
  });

  it("does not arm another timer when nothing changed during the floor", async () => {
    const { slack, clock, checklist } = rig();

    checklist.report(step(1, "github.a", "running"));
    await flush();
    clock.fire();
    await flush();

    expect(slack.edits).toHaveLength(0);
    expect(clock.pending()).toEqual([]);

    await checklist.close("completed");
  });
});

describe("closing", () => {
  // The floor exists to stay inside a rate limit across a task; the terminal
  // write is one write, and it is the state a reader is left looking at.
  it("skips the floor and lands before close resolves", async () => {
    const { slack, checklist } = rig();

    checklist.report(step(1, "github.a", "running"));
    await flush();
    checklist.report(step(1, "github.a", "ok"));

    // No timer fired: close is not waiting for the floor.
    await checklist.close("completed");

    const shown = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(shown?.color).toBe("#1BA85A");
    expect(shown?.fallback).toContain("1 of 1 tool call done");
  });

  it("cancels the pending floor timer, so nothing is left armed", async () => {
    const { clock, checklist } = rig();

    checklist.report(step(1, "github.a", "running"));
    await flush();
    expect(clock.pending()).toHaveLength(1);

    await checklist.close("completed");
    expect(clock.pending()).toEqual([]);
  });

  // The acceptance criterion: a task stopped by a cap says which cap.
  it("names the cap in the terminal card and goes red", async () => {
    const { slack, checklist } = rig();

    checklist.report(step(1, "github.a", "running"));
    await flush();

    await checklist.close("tool_call_cap", "Stopped: per-task tool call cap reached.");

    const shown = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(shown?.color).toBe("#FF6B5B");
    expect(JSON.stringify(shown)).toContain("per-task tool call cap reached");
  });

  it("treats a model's own refusal as the task reaching its end, not as a block", async () => {
    const { slack, checklist } = rig();

    checklist.report(step(1, "github.a", "ok"));
    await flush();
    await checklist.close("refusal");

    expect(slack.cardAt(slack.cards[0]?.messageTs ?? "")?.color).toBe("#1BA85A");
  });

  // Shutdown concluded nothing. Green would claim a task finished and red would
  // claim it was blocked; the card says cancelled and wears no colour.
  it("leaves a cancelled task uncoloured", async () => {
    const { slack, checklist } = rig();

    checklist.report(step(1, "github.a", "running"));
    await flush();
    await checklist.close("cancelled");

    const shown = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(shown?.color).toBeUndefined();
    expect(shown?.fallback).toContain("shutting down");
  });

  it("closes once: a second close neither writes nor changes the card", async () => {
    const { slack, checklist } = rig();

    checklist.report(step(1, "github.a", "ok"));
    await flush();
    await checklist.close("completed");
    const edits = slack.edits.length;

    await checklist.close("tool_call_cap", "Stopped: per-task tool call cap reached.");

    expect(slack.edits).toHaveLength(edits);
    expect(slack.cardAt(slack.cards[0]?.messageTs ?? "")?.color).toBe("#1BA85A");
  });

  it("ignores a step reported after the task ended", async () => {
    const { slack, checklist } = rig();

    checklist.report(step(1, "github.a", "ok"));
    await flush();
    await checklist.close("completed");
    const edits = slack.edits.length;

    checklist.report(step(2, "github.b", "running"));
    await flush();

    expect(slack.edits).toHaveLength(edits);
    expect(JSON.stringify(slack.cardAt(slack.cards[0]?.messageTs ?? ""))).not.toContain("github.b");
  });
});

describe("a card Slack would not take", () => {
  // A checklist that cannot be drawn costs a reader a progress view and costs
  // the task nothing. Neither method may throw: the loop calls `report` and
  // does not catch, and `close` is on the way to delivering an answer.
  it("gives up on the card when the post fails, and neither call throws", async () => {
    const { slack, lines, checklist } = rig({ cardPostFailure: new Error("not_in_channel") });

    expect(() => {
      checklist.report(step(1, "github.a", "running"));
    }).not.toThrow();
    await flush();

    // Retrying every step would turn one broken call into dozens.
    checklist.report(step(2, "github.b", "running"));
    await flush();
    await expect(checklist.close("completed")).resolves.toBeUndefined();

    expect(slack.cards).toHaveLength(0);
    expect(lines.filter(line => line["event"] === "checklist_failed")).toHaveLength(1);
  });

  // A failed edit may well be transient, so only the post gives up.
  it("keeps trying later edits when one fails", async () => {
    const { slack, lines, checklist } = rig({ cardUpdateFailure: new Error("message_not_found") });

    checklist.report(step(1, "github.a", "running"));
    await flush();
    expect(slack.cards).toHaveLength(1);

    await checklist.close("completed");

    expect(lines.filter(line => line["event"] === "checklist_failed")).toHaveLength(1);
  });
});
