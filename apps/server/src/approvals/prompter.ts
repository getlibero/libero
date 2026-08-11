// The card half of a hold: post amber, wait, repaint, resolve — and, for an
// approve, repaint once more when the call it authorized answers.
//
// This is the `HeldCallPrompter` the tool client waits on, built per mention
// because a card needs the mention's channel and thread — the two Slack facts
// the session layer is not allowed to know. The factory captures them on the
// Slack side of the seam; what crosses the seam is a closure.
//
// ## Two phases, because green has to mean it ran (#143)
//
// A deny or an expiry is one phase: the wait ends, the card goes red, the
// promise resolves. An approve is two, because the wait ending is not the call
// happening — the tool client re-submits afterwards, and the proxy enforces the
// live sheet again, so an operator's edit during the hold or a budget spent in
// between can refuse a call a human said yes to. Painting green at decision
// time put green above calls that never ran.
//
// So an approve repaints to `running` — the uncoloured face — and resolves with
// a `HeldCallCompletion`. The tool client calls it with the re-submission's
// outcome, and that is what paints green or red. The card's colour and the
// call's fate are then the same fact, which is what the design system's green
// already claimed.
//
// **The completion may never arrive**, and that is not a failure mode to
// tolerate but one to render: a re-submission cancelled by the task's wall
// clock or by shutdown never answers, and the upstream may have acted anyway.
// The abort listener therefore outlives the wait for exactly this window and
// paints `unanswered` — the audit log's word (#124), for the audit log's
// reason. Without it an approve on a task that then times out leaves a card
// reading "the call is running" forever, which is the lie in the other
// direction.
//
// **The task closes its own card.** However the wait ends — a click, the
// ticket's deadline, the task's wall clock aborting, shutdown — a repaint out
// of amber happens before this promise resolves, so a card is never left
// offering buttons for a wait nobody holds. The one exception is a repaint that
// fails, and it fails safe: a stale amber card's clicks find no registry entry
// and are dropped, and the proxy answers a re-submission from its own ticket
// state regardless of what any card shows.
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

import type { HeldCallCompletion, HeldCallOutcome, HeldCallPrompter, HeldToolCall } from "@getlibero/agent";
import type { CardPoster, Logger, PostedCard, Scheduler } from "@getlibero/gateway";
import { createSilentLogger, renderApprovalCard } from "@getlibero/gateway";
import { refusalMessage } from "@getlibero/schema";
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

type CardStatus = Parameters<typeof renderApprovalCard>[0]["status"];

/**
 * The card's face for a wait that ended without authorizing anything.
 *
 * Total over the two settlements that are terminal on their own. `approved` is
 * absent by construction rather than by omission — it is the settlement whose
 * card is *not* finished when the wait is, so it has no entry here and the
 * compiler says so if one is ever wanted.
 */
function refusedStatus(settled: Exclude<ApprovalSettlement, { state: "approved" }>): CardStatus {
  switch (settled.state) {
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
      // `undefined` rather than `void` in the union, though `HeldCallPrompter`
      // spells it `void`: a `Promise<T | void>` has no zero-argument `resolve`
      // overload, and `Promise<T | undefined>` is assignable to it.
      new Promise<HeldCallCompletion | undefined>(resolve => {
        // A listener on an already-aborted signal never fires, so the check
        // comes first — and a task already ending gets no card at all.
        if (signal?.aborted === true) {
          resolve(undefined);
          return;
        }

        const ticketId = held.ticket.id;
        const toolName = `${held.server}.${held.tool}`;
        // Rendered whole; the renderer escapes it and caps it at its own
        // length. Truncating here would show a human different bytes than the
        // ticket's hash binds.
        const args = Object.keys(held.arguments).length === 0 ? undefined : JSON.stringify(held.arguments);
        const face = (status: CardStatus) =>
          renderApprovalCard({
            toolName,
            ...(args !== undefined ? { arguments: args } : {}),
            status
          });

        let settled: ApprovalSettlement | undefined;
        let posted: PostedCard | undefined;
        let postFailed = false;
        let finished = false;
        /**
         * Whether the second phase is over — painted, or abandoned to an abort.
         * Only ever set on the approve path, where it is what makes the race
         * between the re-submission answering and the task ending resolvable
         * either way round, once.
         */
        let completed = false;
        /** Set when the wait settles `approved`, so the abandonment path can name the approver. */
        let approvedBy: string | undefined;

        /** One repaint. Logs both ways and never rejects, so a caller can drop the promise. */
        const repaint = (at: PostedCard, status: CardStatus): Promise<void> =>
          cards
            .updateCard({ channelId: at.channelId, messageTs: at.messageTs, card: face(status) })
            .then(
              () => {
                logger.log("info", {
                  event: "card_updated",
                  channel: target.channelId,
                  ticket: ticketId,
                  messageTs: at.messageTs,
                  cardState: status.state
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
                  cardState: status.state,
                  reason: cause instanceof Error ? cause.constructor.name : "unknown"
                });
              }
            );

        // The wait ends exactly once, and everything that could end it is
        // disarmed the moment anything does.
        const settle = (outcome: ApprovalSettlement): void => {
          if (settled !== undefined) return;
          settled = outcome;
          cancelDeadline();
          signal?.removeEventListener("abort", onAbort);
          registry.remove(target.channelId, ticketId);
          finish();
        };

        // The repaint waits for the post: a click can settle the wait while
        // the card's own post is still in flight, and there is no message to
        // edit until the post answers with its ts.
        const finish = (): void => {
          if (finished || settled === undefined || (posted === undefined && !postFailed)) return;
          finished = true;
          const decided = settled;
          const at = posted;

          // No card, so nothing to repaint and nothing a completion could do
          // with one. The wait still ends: the re-submission answers
          // `approval_pending` or the result, and the model is told either way.
          if (at === undefined) {
            resolve(undefined);
            return;
          }

          // A deny or an expiry is the end of the card as well as of the wait.
          if (decided.state !== "approved") {
            void repaint(at, refusedStatus(decided)).then(() => {
              resolve(undefined);
            });
            return;
          }

          // An approve is half the story. Paint the uncoloured running face and
          // hand back the callback that will finish it.
          //
          // The abandonment listener is armed *before* the repaint rather than
          // after: the repaint is a network call, and a task aborting during it
          // must still find something to run — otherwise the exact window this
          // guards is the one that has no guard.
          const approver = decided.approver;
          approvedBy = approver;
          signal?.addEventListener("abort", onAbandoned, { once: true });
          void repaint(at, { state: "running", approver }).then(() => {
            resolve(completionFor(at, approver));
          });
        };

        /**
         * The callback the tool client calls with what the re-submission became.
         *
         * **It must not throw**, which is `HeldCallCompletion`'s contract and is
         * enforced here rather than trusted: `repaint` never rejects, but
         * `logger.log` writes to a stream and can fail on EPIPE, and a card that
         * could not be repainted must not turn a call that ran into an error
         * result for the model.
         */
        const completionFor =
          (at: PostedCard, approver: string): HeldCallCompletion =>
          (outcome: HeldCallOutcome): void => {
            try {
              if (completed) return;
              completed = true;
              signal?.removeEventListener("abort", onAbandoned);
              void repaint(
                at,
                outcome.state === "ran"
                  ? { state: "approved", approver }
                  : // The proxy's own sentence for its own refusal, relayed. A
                    // human who clicked approve is owed the reason their click
                    // did not produce a call, and this process is not the one
                    // that knows it.
                    { state: "refused", approver, reason: refusalMessage(outcome.refusal) }
              );
            } catch {
              // Swallowed on purpose, and it is the only swallow here: the
              // alternative is a repaint failure ending a task that succeeded.
            }
          };

        const onAbort = (): void => {
          settle({ state: "expired" });
        };

        /**
         * The task ended with the re-submission in flight.
         *
         * The call was dispatched and may have run, so this paints `unanswered`
         * rather than guessing. It is armed only for the approve path's second
         * phase and disarmed the moment a completion arrives.
         */
        const onAbandoned = (): void => {
          if (completed || posted === undefined || approvedBy === undefined) return;
          completed = true;
          void repaint(posted, { state: "unanswered", approver: approvedBy });
        };

        // Registered before the card exists: the click that ends this wait can
        // only follow the card, but its dispatch races the post's own response,
        // and a decision must find its entry.
        registry.register(target.channelId, ticketId, { settle });
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
