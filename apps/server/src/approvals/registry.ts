// Which tickets this process is waiting on, and how to end each wait.
//
// One map at process scope, because the click arrives at process scope — the
// gateway observes it on the socket with nothing but a ticket id and the
// channel it was clicked in to say whose it is. The *entries* are task-scoped:
// the prompter registers when its hold starts and removes when it settles, so
// an entry's lifetime is exactly the wait's, and a ticket nobody is waiting
// on — a stale card after a restart, a click that lost a race with expiry —
// looks the same as one that never existed. That is the settled shape (#127):
// the proxy's fifteen-minute expiry bounds what an orphaned ticket can become,
// and this process holds nothing durable about approvals.
//
// Keyed by channel and then ticket id, the same shape the proxy's ticket store
// argues for and for the same reason: a lookup that requires the channel
// cannot reach another channel's entry, structurally, where a flat map with a
// comparison after the fetch is a guard someone can forget. A click observed
// in the wrong channel finds nothing here — one answer with a ticket that
// never existed, exactly as the proxy answers a foreign ticket. The proxy
// scopes by certificate regardless; this keeps the wrong question from being
// askable in this process too.
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
   * Ends the wait. Idempotence is the registrant's: the registry hands the
   * decision path whatever was registered, and the prompter's first settlement
   * winning is a property of the prompter.
   */
  readonly settle: (outcome: ApprovalSettlement) => void;
}

export interface ApprovalRegistry {
  /** `channel` is the one whose certificate minted the ticket — the card's channel. */
  register(channel: string, ticketId: string, entry: PendingApproval): void;
  get(channel: string, ticketId: string): PendingApproval | undefined;
  remove(channel: string, ticketId: string): void;
}

export function createApprovalRegistry(): ApprovalRegistry {
  const byChannel = new Map<string, Map<string, PendingApproval>>();

  return {
    register(channel: string, ticketId: string, entry: PendingApproval): void {
      let pending = byChannel.get(channel);
      if (pending === undefined) {
        pending = new Map();
        byChannel.set(channel, pending);
      }
      pending.set(ticketId, entry);
    },
    get(channel: string, ticketId: string): PendingApproval | undefined {
      return byChannel.get(channel)?.get(ticketId);
    },
    remove(channel: string, ticketId: string): void {
      const pending = byChannel.get(channel);
      if (pending === undefined) return;
      pending.delete(ticketId);
      if (pending.size === 0) byChannel.delete(channel);
    }
  };
}
