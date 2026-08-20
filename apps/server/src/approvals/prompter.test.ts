// The card lifecycle, driven from both ends: the wait is started the way the
// tool client starts it, and settled the way the decision handler settles it —
// through the registry entry, which is the whole seam between them. The clock
// is a manual scheduler and an injected `now`, so expiry is a test firing a
// timer rather than fifteen minutes passing.

import type { HeldToolCall } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger, Scheduler } from "@getlibero/gateway";
import { createStubSlack } from "@getlibero/gateway";
import { refusalMessage } from "@getlibero/schema";
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

  it("renders a partial form that says what it dropped", async () => {
    // The selection itself is `renderHeldCallArguments`'s tests' business;
    // what this asserts is that the prompter routes through it rather than
    // dumping JSON — the flag survives the blob, and the drop is named.
    const { slack, registry, onHeld } = rig();

    const wait = onHeld({ ...HELD, arguments: { body: "x".repeat(400), force: true } });
    await flush();

    const rendered = JSON.stringify(slack.cards[0]?.card);
    expect(rendered).toContain("force: true");
    expect(rendered).toContain("+1 more not shown: body");

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
  // The half of #143 that used to be the whole of it. A click is not an
  // execution: the card goes to the uncoloured running face and the wait hands
  // back the callback that will decide its colour.
  it("approve repaints the card to running — uncoloured — and resolves with a completion", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    const completion = await wait;

    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBeUndefined();
    expect(JSON.stringify(card)).toContain("U0G9QF9C6");
    expect(typeof completion).toBe("function");
  });

  it("green arrives only when the re-submission says the call ran", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    const completion = await wait;

    completion?.({ state: "ran" });
    await flush();

    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBe("#1BA85A");
    expect(JSON.stringify(card)).toContain("U0G9QF9C6");
    expect(card?.fallback).toContain("the call ran");
  });

  // The case the four states could not say, and the reason #143 exists: the
  // human's click was honoured and the call was refused anyway, because the
  // sheet is enforced again at redemption.
  it("an approved call refused at redemption goes red, names the approver, and relays the proxy's reason", async () => {
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    const completion = await wait;

    completion?.({ state: "refused", refusal: { reason: "tool_not_allowed", server: "github", tool: "merge_pr" } });
    await flush();

    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBe("#FF6B5B");
    // Not green, which is the whole acceptance criterion.
    expect(card?.color).not.toBe("#1BA85A");
    expect(JSON.stringify(card)).toContain("U0G9QF9C6");
    // The proxy's own sentence, not one composed here.
    expect(JSON.stringify(card)).toContain(
      refusalMessage({ reason: "tool_not_allowed", server: "github", tool: "merge_pr" })
    );
  });

  // A re-submission cancelled by the task's wall clock never answers, and the
  // upstream may have acted. Neither green nor red is true, so neither is used.
  it("a task ending with the re-submission in flight leaves unanswered, not running", async () => {
    const abort = new AbortController();
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD, abort.signal);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    await wait;

    abort.abort();
    await flush();

    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBeUndefined();
    expect(card?.fallback).toContain("may have run");
    expect(JSON.stringify(card)).toContain("U0G9QF9C6");
  });

  it("a completion arriving after the abandonment repaint changes nothing", async () => {
    const abort = new AbortController();
    const { slack, registry, onHeld } = rig();

    const wait = onHeld(HELD, abort.signal);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    const completion = await wait;

    abort.abort();
    await flush();
    const edits = slack.edits.length;

    completion?.({ state: "ran" });
    await flush();

    expect(slack.edits).toHaveLength(edits);
    expect(slack.cardAt(slack.cards[0]?.messageTs ?? "")?.fallback).toContain("may have run");
  });

  // The contract `HeldCallCompletion` states, enforced rather than trusted: the
  // tool client calls this synchronously and would propagate a throw, turning a
  // call that ran into an error result because a card could not be repainted.
  it("a completion whose repaint fails does not throw at its caller", async () => {
    const slack = createStubSlack({ cardUpdateFailure: new Error("message_not_found") });
    const registry = createApprovalRegistry();
    const onHeld = createHeldCallPrompter({
      cards: slack.poster,
      registry,
      now: () => NOW,
      scheduler: manualClock().scheduler
    })({ channelId: CHANNEL, threadTs: THREAD });

    const wait = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "approved", approver: "U0G9QF9C6" });
    const completion = await wait;

    expect(() => {
      completion?.({ state: "ran" });
    }).not.toThrow();
  });

  it("deny and expiry are one phase still: they resolve with no completion", async () => {
    const { registry, onHeld } = rig();

    const denied = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "denied", approver: "U0G9QF9C6" });
    expect(await denied).toBeUndefined();

    const expired = onHeld(HELD);
    await flush();
    registry.get(CHANNEL, "tk-7f3a")?.settle({ state: "expired" });
    expect(await expired).toBeUndefined();
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

    // One edit, and it is the approve's running face — the impostor's denial
    // neither repainted nor reached the card.
    expect(slack.edits).toHaveLength(1);
    const card = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(card?.color).toBeUndefined();
    expect(JSON.stringify(card)).toContain("U0G9QF9C6");
    expect(JSON.stringify(card)).not.toContain("U9IMPOSTER");
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

    const completion = await wait;

    expect(lines).toContainEqual(
      expect.objectContaining({ event: "card_failed", cardState: "running" })
    );

    // And the second phase fails the same way, independently: the wait already
    // resolved, so a failure here has nothing left to fail safe into except the
    // log line.
    completion?.({ state: "ran" });
    await flush();
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "card_failed", cardState: "approved" })
    );
  });
});
