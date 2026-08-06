// The card lifecycle, driven from both ends: the wait is started the way the
// tool client starts it, and settled the way the decision handler settles it —
// through the registry entry, which is the whole seam between them. The clock
// is a manual scheduler and an injected `now`, so expiry is a test firing a
// timer rather than fifteen minutes passing.

import type { HeldToolCall } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger, Scheduler } from "@getlibero/gateway";
import { createStubSlack } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { createHeldCallPrompter, type HeldCallPrompterOptions } from "./prompter.js";
import { createApprovalRegistry } from "./registry.js";

const CHANNEL = "C024BE91L";
const THREAD = "1717171717.000001";
const NOW = Date.UTC(2026, 7, 4, 12, 0);
const EXPIRES = NOW + 15 * 60 * 1000;

const HELD: HeldToolCall = {
  server: "github",
  tool: "merge_pr",
  arguments: { pr: 42 },
  ticket: { id: "tk-7f3a", expiresAt: EXPIRES },
  requestingUser: "U024BE7LH",
  taskId: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55"
};

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

function rig(overrides: Partial<HeldCallPrompterOptions> = {}) {
  const slack = createStubSlack();
  const registry = createApprovalRegistry();
  const clock = manualClock();
  const { logger, lines } = capturingLogger();
  const factory = createHeldCallPrompter({
    cards: slack.poster,
    registry,
    logger,
    now: () => NOW,
    scheduler: clock.scheduler,
    ...overrides
  });
  const onHeld = factory({ channelId: CHANNEL, threadTs: THREAD });
  return { slack, registry, clock, lines, onHeld };
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("the amber card", () => {
  it("goes into the mention's thread, naming the call and carrying the ticket", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();

    expect(slack.cards).toHaveLength(1);
    const posted = slack.cards[0];
    expect(posted?.channelId).toBe(CHANNEL);
    expect(posted?.threadTs).toBe(THREAD);
    expect(posted?.card.color).toBe("#F5B544");
    const rendered = JSON.stringify(posted?.card);
    expect(rendered).toContain("github.merge_pr");
    expect(rendered).toContain("42");
    // The ticket travels in the button's value — that is what a click carries back.
    expect(rendered).toContain("tk-7f3a");

    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "expired" });
    await wait;
  });

  it("renders no arguments line for a call that took none", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld({ ...HELD, arguments: {} });
    await flush();

    const blocks = JSON.stringify(slack.cards[0]?.card.blocks);
    expect(blocks).not.toContain("{}");

    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "expired" });
    await wait;
  });

  // A click's dispatch races the post's own response, and a decision must find
  // its entry — so registration precedes the post.
  it("registers the wait before the card is posted, and deregisters when it settles", async () => {
    const slack = createStubSlack();
    const registry = createApprovalRegistry();
    let registeredAtPost: boolean | undefined;
    const onHeld = createHeldCallPrompter({
      cards: {
        postCard: target => {
          registeredAtPost = registry.get(CHANNEL, "tk-7f3a") !== undefined;
          return slack.poster.postCard(target);
        },
        updateCard: target => slack.poster.updateCard(target)
      },
      registry,
      now: () => NOW,
      scheduler: manualClock().scheduler
    })({ channelId: CHANNEL, threadTs: THREAD });

    const wait = onHeld(HELD);
    await flush();
    expect(registeredAtPost).toBe(true);

    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    await wait;

    expect(registry.get(CHANNEL, "tk-7f3a")).toBeUndefined();
  });
});

describe("how the wait ends", () => {
  it("approve repaints the card green, naming the approver, and resolves", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    await wait;

    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBe("#1BA85A");
    expect(JSON.stringify(card)).toContain("U0G9QF9C6");
  });

  it("deny repaints the card red, naming the approver, and resolves", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "denied", approver: "U0G9QF9C6" });
    await wait;

    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBe("#FF6B5B");
    expect(JSON.stringify(card)).toContain("U0G9QF9C6");
  });

  it("arms the deadline for the ticket's own expiry, and it repaints expired", async () => {
    const { slack, registry, clock, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();
    expect(clock.pending()).toEqual([EXPIRES - NOW]);

    clock.fire();
    await wait;

    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBe("#FF6B5B");
    expect(registry.get(CHANNEL, "tk-7f3a")).toBeUndefined();
  });

  // The task closes its own card: the wall cap and shutdown both arrive here
  // as the signal aborting, and the repaint lands before the promise resolves
  // — a card is never left amber by a task that has already moved on.
  it("an abort repaints the card before the wait resolves", async () => {
    const { slack, onHeld } = rig();
    const aborter = new AbortController();
    const order: string[] = [];

    const wait = onHeld(HELD, aborter.signal).then(() => {
      order.push("resolved");
      expect(slack.edits).toHaveLength(1);
    });
    await flush();

    aborter.abort();
    await wait;

    expect(order).toEqual(["resolved"]);
    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBe("#FF6B5B");
  });

  it("resolves without posting anything for a signal already aborted", async () => {
    const { slack, registry, onHeld } = rig();
    const aborter = new AbortController();
    aborter.abort();

    await onHeld(HELD, aborter.signal);

    expect(slack.cards).toHaveLength(0);
    expect(registry.get(CHANNEL, "tk-7f3a")).toBeUndefined();
  });

  it("settles once: a second settlement neither repaints nor re-resolves", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();
    const entry = registry.get(CHANNEL, "tk-7f3a");
    entry?.settle({ state: "approved", approver: "U0G9QF9C6" });
    entry?.settle({ state: "denied", approver: "U9IMPOSTER" });
    await wait;

    expect(slack.edits).toHaveLength(1);
    expect(slack.cardAt(slack.cards[0]?.messageTs ?? "")?.color).toBe("#1BA85A");
  });
});

describe("a card Slack would not take", () => {
  // No card means no human can ever end the wait; holding the task until
  // expiry would spend its wall clock on a decision that cannot arrive. The
  // re-submission answers `approval_pending`, which is the honest sentence.
  it("a failed post logs, deregisters, resolves immediately, and leaves no timer", async () => {
    const slack = createStubSlack({ cardPostFailure: new Error("not_in_channel") });
    const registry = createApprovalRegistry();
    const clock = manualClock();
    const { logger, lines } = capturingLogger();
    const onHeld = createHeldCallPrompter({
      cards: slack.poster,
      registry,
      logger,
      now: () => NOW,
      scheduler: clock.scheduler
    })({ channelId: CHANNEL, threadTs: THREAD });

    await onHeld(HELD);

    expect(registry.get(CHANNEL, "tk-7f3a")).toBeUndefined();
    expect(clock.pending()).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "card_failed", cardState: "awaiting" })
    );
  });

  // Fails safe: the amber card's clicks find no registry entry, and the proxy
  // answers a re-submission from its own ticket state regardless.
  it("a failed repaint still resolves the wait, and logs", async () => {
    const slack = createStubSlack({ cardUpdateFailure: new Error("message_not_found") });
    const registry = createApprovalRegistry();
    const clock = manualClock();
    const { logger, lines } = capturingLogger();
    const onHeld = createHeldCallPrompter({
      cards: slack.poster,
      registry,
      logger,
      now: () => NOW,
      scheduler: clock.scheduler
    })({ channelId: CHANNEL, threadTs: THREAD });

    const wait = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });

    await wait;

    expect(lines).toContainEqual(
      expect.objectContaining({ event: "card_failed", cardState: "approved" })
    );
  });
});
