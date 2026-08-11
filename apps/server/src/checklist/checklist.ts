// One message per task, edited as the task runs (#68).
//
// This is the consumer of the loop's `onToolCall`, built per request the way
// the approval prompter is and for the same reason: a card needs the mention's
// channel and thread, which are Slack facts the session layer is not allowed to
// know. The factory captures them on the Slack side of the seam; what crosses
// is a `ChecklistReporter`, which names no Slack anything.
//
// It rides `CardPoster` rather than growing a seam of its own. That interface
// is deliberately narrower than `SlackPoster` — a composing app that could
// reach `postThreadReply` could post a reply out of band — and a checklist is a
// card by exactly the definition that exception was written for: a message this
// process owns, posts once, and edits. It is not a reply, and it cannot become
// one.
//
// ## Three decisions
//
// **The card is posted on the first tool call, not at task start.** A task that
// answers from what the model knows produces one message, as it always did; the
// checklist exists for tasks that actually do something. That is also what
// makes it free of a sheet field — there is no per-channel noise to opt out of
// when an ordinary question raises no card.
//
// **Edits are coalesced, and the mechanism is a serialized chain plus a floor
// between writes.** A write renders whatever is true when it runs, so a burst of
// steps that arrives during one write is covered by the next — the queue never
// grows past one pending write, however many steps land. `MIN_EDIT_INTERVAL_MS`
// is the floor. Together they bound a task at roughly one edit a second
// regardless of how fast the loop is going, which is what Slack's rate limits
// want and what "edit, don't spam" means at the level below the message count.
//
// **The terminal write skips the floor and is awaited.** It is one write, it is
// the one a reader is left looking at, and a checklist stuck on `WORKING`
// because a task ended inside a cooldown is the failure this whole file exists
// to avoid. `close` resolves when it has landed, so the caller can order the
// reply after it.
//
// A failure anywhere is a log line and never an exception: `report` is called
// from the loop, which does not catch, and `close` is called from a task that
// has an answer to deliver.

import type { AgentStopReason, ToolCallStep } from "@getlibero/agent";
import type { CardPoster, ChecklistStep, Logger, PostedCard, Scheduler } from "@getlibero/gateway";
import { createSilentLogger, renderChecklistCard } from "@getlibero/gateway";

/** Where the checklist goes: the mention's channel, the mention's thread. */
export interface ChecklistTarget {
  readonly channelId: string;
  readonly threadTs: string;
}

/**
 * How a task ended, as the checklist is told.
 *
 * `AgentStopReason` plus `failed`, which the loop cannot report because it is
 * the case where the loop *threw* — an unreachable provider, a tool listing
 * that could not be fetched. A checklist has to close there too, and the result
 * that would have named the reason does not exist.
 */
export type ChecklistOutcome = AgentStopReason | "failed";

/**
 * What a task drives its checklist through. Names nothing Slack-shaped, so it
 * crosses into `session/` the way `HeldCallPrompter` does.
 *
 * Both methods are total. `report` must not throw because the loop calls it and
 * does not catch; `close` must not reject because a task calls it on the way to
 * delivering an answer.
 */
export interface ChecklistReporter {
  /** One tool call's progress. Coalesced; never awaited. */
  report(step: ToolCallStep): void;
  /** Paint the terminal state and stop. Resolves when the last write has landed. */
  close(outcome: ChecklistOutcome, note?: string): Promise<void>;
}

export type ChecklistReporterFactory = (target: ChecklistTarget) => ChecklistReporter;

/**
 * The floor between two edits of one card.
 *
 * The process's number rather than a channel's, on `DEFAULT_UPSTREAM_TIMEOUT_MS`'s
 * argument: it exists to stay inside Slack's rate limits, which belong to the
 * app rather than to any channel, and a sheet able to lower it would be one
 * channel spending an allowance the whole workspace shares. `chat.update` is
 * Tier 3, and one second is comfortably inside it while still reading as live.
 */
export const MIN_EDIT_INTERVAL_MS = 1_000;

/** Which outcomes are the task reaching its own end rather than being stopped. */
const COMPLETED: ReadonlySet<ChecklistOutcome> = new Set<ChecklistOutcome>(["completed", "refusal"]);

const defaultScheduler: Scheduler = (ms, fn) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export interface ChecklistReporterOptions {
  cards: CardPoster;
  logger?: Logger;
  /** Injected for tests. Omitted in production. */
  scheduler?: Scheduler;
}

export function createChecklistReporter(
  options: ChecklistReporterOptions
): ChecklistReporterFactory {
  const { cards } = options;
  const logger = options.logger ?? createSilentLogger();
  const schedule = options.scheduler ?? defaultScheduler;

  return target => {
    /** Every call the task attempted, by ordinal, in the order they were dispatched. */
    const steps = new Map<number, ChecklistStep>();
    let posted: PostedCard | undefined;
    /** Set once the card cannot be posted. Nothing is retried; the task is unaffected. */
    let broken = false;
    let closed = false;
    let terminal: { outcome: ChecklistOutcome; note?: string } | undefined;

    /** Something changed since the last write started. */
    let dirty = false;
    /** Inside the floor between writes. */
    let cooling = false;
    let cancelCooldown: (() => void) | undefined;
    /** Every write, serialized. It never rejects, so the chain cannot break. */
    let chain: Promise<void> = Promise.resolve();

    const status = (): Parameters<typeof renderChecklistCard>[0]["status"] => {
      if (terminal === undefined) return { state: "working" };
      if (terminal.outcome === "cancelled") return { state: "cancelled" };
      if (COMPLETED.has(terminal.outcome)) return { state: "done" };
      return { state: "stopped", ...(terminal.note !== undefined ? { note: terminal.note } : {}) };
    };

    /**
     * One post or edit, rendering whatever is true right now.
     *
     * Rendering at write time rather than at enqueue time is what makes the
     * coalescing free: a write that was queued behind another picks up every
     * step that landed in between, so N steps never cost N writes.
     */
    const write = async (): Promise<void> => {
      if (broken) return;
      dirty = false;
      const card = renderChecklistCard({ steps: [...steps.values()], status: status() });
      try {
        if (posted === undefined) {
          posted = await cards.postCard({
            channelId: target.channelId,
            threadTs: target.threadTs,
            card
          });
          logger.log("info", {
            event: "checklist_posted",
            channel: target.channelId,
            threadTs: target.threadTs,
            messageTs: posted.messageTs
          });
          return;
        }
        await cards.updateCard({
          channelId: posted.channelId,
          messageTs: posted.messageTs,
          card
        });
      } catch (cause) {
        // A checklist that cannot be drawn costs a reader a progress view and
        // costs the task nothing. A failed *post* is terminal for this card —
        // there is no message to edit and retrying every step would turn one
        // broken call into dozens — where a failed edit may well be transient,
        // so only the post gives up.
        if (posted === undefined) broken = true;
        logger.log("error", {
          event: "checklist_failed",
          channel: target.channelId,
          threadTs: target.threadTs,
          reason: cause instanceof Error ? cause.constructor.name : "unknown"
        });
      }
    };

    /** Queues a write behind whatever is already writing. Never rejects. */
    const enqueue = (): Promise<void> => {
      chain = chain.then(write, write);
      return chain;
    };

    /** After a write, hold the floor; if steps arrived meanwhile, write once more. */
    const cool = (): void => {
      cooling = true;
      cancelCooldown = schedule(MIN_EDIT_INTERVAL_MS, () => {
        cooling = false;
        cancelCooldown = undefined;
        if (dirty && !closed) {
          void enqueue().then(cool);
        }
      });
    };

    return {
      report(step: ToolCallStep): void {
        try {
          if (closed || broken) return;
          steps.set(step.ordinal, { name: step.name, state: step.state });
          dirty = true;
          // Inside the floor, or with a write already going: the next write
          // will render this step along with anything else that arrives.
          if (cooling) return;
          void enqueue().then(cool);
        } catch {
          // The loop does not catch, and a progress report must never end a
          // task. This is the only swallow here; `write` logs its own failures.
        }
      },

      async close(outcome: ChecklistOutcome, note?: string): Promise<void> {
        if (closed) return;
        closed = true;
        terminal = { outcome, ...(note !== undefined ? { note } : {}) };
        cancelCooldown?.();
        cooling = false;

        // Nothing was ever posted and no call was ever made: a task that
        // answered from what the model knew leaves no card behind.
        if (posted === undefined && steps.size === 0) return;

        // Queued behind any write still going, and not behind the floor: this
        // is the state a reader is left looking at.
        await enqueue();
      }
    };
  };
}
