// The card half of a hold: post amber, wait, repaint terminal, resolve.
//
// This is the `HeldCallPrompter` the tool client waits on, built per mention
// because a card needs the mention's channel and thread — the two Slack facts
// the session layer is not allowed to know. The factory captures them on the
// Slack side of the seam; what crosses the seam is a closure.
//
// **The task closes its own card.** However the wait ends — a click, the
// ticket's deadline, the task's wall clock aborting, shutdown — the repaint to
// a terminal state happens before this promise resolves, so a card is never
// left offering buttons for a wait nobody holds. The one exception is a
// repaint that fails, and it fails safe: a stale amber card's clicks find no
// registry entry and are dropped, and the proxy answers a re-submission from
// its own ticket state regardless of what any card shows.
//
// **The hold spends the task's wall clock by design** (#127): the signal this
// prompter is handed carries the task's deadline, and an abort settles the
// wait as expired. A cap sized in minutes colliding with an approval that
// takes ten of them is the operator's trade in the sheet, not a special case
// here.
//
// **The deadline is the wire's `expiresAt`, on the proxy's clock.** A local
// clock running fast expires the card early and the re-submission answers
// `approval_pending`; running slow, `approval_expired`. Both sentences are
// honest, the divergence is bounded by skew, and the proxy stays the
// authority — so there is no grace interval and no local expiry config.

import type { HeldCallPrompter, HeldToolCall } from "@getlibero/agent";
import type { CardPoster, Logger, PostedCard, Scheduler } from "@getlibero/gateway";
import { createSilentLogger, renderApprovalCard } from "@getlibero/gateway";
import type { ApprovalRegistry, ApprovalSettlement } from "./registry.js";

/** Where the card goes: the mention's channel, the mention's thread. */
export interface PromptTarget {
  readonly channelId: string;
  readonly threadTs: string;
}

export interface HeldCallPrompterOptions {
  cards: CardPoster;
  registry: ApprovalRegistry;
  logger?: Logger;
  /** Injected for tests. Omitted in production. */
  now?: () => number;
  /** Injected for tests. Omitted in production. */
  scheduler?: Scheduler;
}

export type HeldCallPrompterFactory = (target: PromptTarget) => HeldCallPrompter;

const defaultScheduler: Scheduler = (ms, fn) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** The card's terminal face for how the wait ended. */
function terminalStatus(settled: ApprovalSettlement): Parameters<typeof renderApprovalCard>[0]["status"] {
  switch (settled.state) {
    case "approved":
      return { state: "approved", approver: settled.approver };
    case "denied":
      return { state: "denied", approver: settled.approver };
    case "expired":
      return { state: "expired" };
  }
}

export function createHeldCallPrompter(options: HeldCallPrompterOptions): HeldCallPrompterFactory {
  const { cards, registry } = options;
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;
  const schedule = options.scheduler ?? defaultScheduler;

  return target =>
    (held: HeldToolCall, signal?: AbortSignal) =>
      new Promise<void>(resolve => {
        // A listener on an already-aborted signal never fires, so the check
        // comes first — and a task already ending gets no card at all.
        if (signal?.aborted === true) {
          resolve();
          return;
        }

        const ticketId = held.ticket.id;
        const toolName = `${held.server}.${held.tool}`;
        // Rendered whole; the renderer escapes it and caps it at its own
        // length. Truncating here would show a human different bytes than the
        // ticket's hash binds.
        const args = Object.keys(held.arguments).length === 0 ? undefined : JSON.stringify(held.arguments);
        const face = (status: Parameters<typeof renderApprovalCard>[0]["status"]) =>
          renderApprovalCard({
            toolName,
            ...(args !== undefined ? { arguments: args } : {}),
            status
          });

        let settled: ApprovalSettlement | undefined;
        let posted: PostedCard | undefined;
        let postFailed = false;
        let finished = false;

        // The wait ends exactly once, and everything that could end it is
        // disarmed the moment anything does.
        const settle = (outcome: ApprovalSettlement): void => {
          if (settled !== undefined) return;
          settled = outcome;
          cancelDeadline();
          signal?.removeEventListener("abort", onAbort);
          registry.remove(ticketId);
          finish();
        };

        // The repaint waits for the post: a click can settle the wait while
        // the card's own post is still in flight, and there is no message to
        // edit until the post answers with its ts.
        const finish = (): void => {
          if (finished || settled === undefined || (posted === undefined && !postFailed)) return;
          finished = true;
          if (posted === undefined) {
            resolve();
            return;
          }
          const at = posted;
          const state = settled.state;
          cards
            .updateCard({ channelId: at.channelId, messageTs: at.messageTs, card: face(terminalStatus(settled)) })
            .then(
              () => {
                logger.log("info", {
                  event: "card_updated",
                  channel: target.channelId,
                  ticket: ticketId,
                  messageTs: at.messageTs,
                  cardState: state
                });
              },
              (cause: unknown) => {
                // Fails safe: the amber card's clicks find no registry entry,
                // and the proxy answers from its own ticket state regardless.
                logger.log("error", {
                  event: "card_failed",
                  channel: target.channelId,
                  ticket: ticketId,
                  messageTs: at.messageTs,
                  cardState: state,
                  reason: cause instanceof Error ? cause.constructor.name : "unknown"
                });
              }
            )
            .then(() => {
              resolve();
            });
        };

        const onAbort = (): void => {
          settle({ state: "expired" });
        };

        // Registered before the card exists: the click that ends this wait can
        // only follow the card, but its dispatch races the post's own response,
        // and a decision must find its entry.
        registry.register(ticketId, { channel: target.channelId, settle });
        const cancelDeadline = schedule(Math.max(0, held.ticket.expiresAt - now()), () => {
          settle({ state: "expired" });
        });
        signal?.addEventListener("abort", onAbort, { once: true });

        cards.postCard({ channelId: target.channelId, threadTs: target.threadTs, card: face({ state: "awaiting", ticket: held.ticket }) }).then(
          card => {
            posted = card;
            logger.log("info", {
              event: "card_posted",
              channel: target.channelId,
              threadTs: target.threadTs,
              messageTs: card.messageTs,
              ticket: ticketId,
              task: held.taskId,
              cardState: "awaiting"
            });
            finish();
          },
          (cause: unknown) => {
            // No card means no human can ever end this wait, and holding the
            // task until expiry would spend its wall clock on a decision that
            // cannot arrive. Resolve now: the re-submission answers
            // `approval_pending`, which is the honest sentence, and the cause
            // is here for the operator.
            postFailed = true;
            logger.log("error", {
              event: "card_failed",
              channel: target.channelId,
              ticket: ticketId,
              cardState: "awaiting",
              reason: cause instanceof Error ? cause.constructor.name : "unknown"
            });
            settle({ state: "expired" });
          }
        );
      });
}
