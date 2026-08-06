// Which tickets this process is waiting on, and how to end each wait.
//
// One map at process scope, because the click arrives at process scope — the
// gateway observes it on the socket with nothing but a ticket id to say whose
// it is. The *entries* are task-scoped: the prompter registers when its hold
// starts and removes when it settles, so an entry's lifetime is exactly the
// wait's, and a ticket nobody is waiting on — a stale card after a restart, a
// click that lost a race with expiry — looks the same as one that never
// existed. That is the settled shape (#127): the proxy's fifteen-minute expiry
// bounds what an orphaned ticket can become, and this process holds nothing
// durable about approvals.
//
// This file knows nothing about Slack, cards, or the proxy. It is a map with
// names, and the names are the point: `settle` is the only verb a decision has
// here, and what settling *does* — repaint a card, resolve a wait — belongs to
// whoever registered.

/** How a wait ended. `expired` covers the deadline, an abort, and a lost ticket. */
export type ApprovalSettlement =
  | { readonly state: "approved"; readonly approver: string }
  | { readonly state: "denied"; readonly approver: string }
  | { readonly state: "expired" };

export interface PendingApproval {
  /**
   * The channel the held call belongs to — the one whose certificate minted
   * the ticket. A click observed in any other channel is dropped before it
   * reaches the proxy.
   */
  readonly channel: string;
  /**
   * Ends the wait. Idempotence is the registrant's: the registry hands the
   * decision path whatever was registered, and the prompter's first settlement
   * winning is a property of the prompter.
   */
  readonly settle: (outcome: ApprovalSettlement) => void;
}

export interface ApprovalRegistry {
  register(ticketId: string, entry: PendingApproval): void;
  get(ticketId: string): PendingApproval | undefined;
  remove(ticketId: string): void;
}

export function createApprovalRegistry(): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>();

  return {
    register(ticketId: string, entry: PendingApproval): void {
      pending.set(ticketId, entry);
    },
    get(ticketId: string): PendingApproval | undefined {
      return pending.get(ticketId);
    },
    remove(ticketId: string): void {
      pending.delete(ticketId);
    }
  };
}
