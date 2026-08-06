// The approval broker's ticket store: what a held call mints, what a human's
// click resolves, and what a re-submission has to match to be served.
//
// **A ticket authorizes one call — one server, one tool, one argument hash —
// once, in one channel, until it expires.** Every clause in that sentence is a
// check below, and none of them is the whole property on its own. What a ticket
// is *not* is a permission: it never widens what a channel may call. The team
// sheet is enforced when the ticket is minted and enforced again from the live
// sheet when it is redeemed, so an operator's edit during the hold beats a click
// that preceded it. See ./server.ts, where that ordering is the code rather than
// the claim.
//
// ## In memory, and why that is a decision rather than a shortcut
//
// A restart drops every pending ticket. That degrades to expiry: the cards in
// flight go stale, the calls behind them never run, and nothing is served
// unapproved. The failure mode of losing this state is the safe one, which is
// what makes durability a thing to add when an operator hits it rather than
// scaffolding to build first. A durable store would also have to answer what
// happens to a ticket minted by a build with different enforcement, and the
// answer today is that the question cannot arise.
//
// ## What the split interfaces are for
//
// `ApprovalMinter`, `ApprovalRedeemer`, and `ApprovalDecider` are three views of
// one store, narrowed the way ./dispatch.ts narrows `SpendMeter` into
// `TokenRecorder`. The decision route gets `ApprovalDecider` and nothing else,
// and that is the most load-bearing narrowing in this file: a route that could
// mint could manufacture a ticket for any call it liked and then approve it,
// which is the whole feature turned inside out, and a route that could redeem
// could serve one. It cannot do either, and the way it cannot is that the
// methods are absent from the type it closes over.
//
// ## Two things that look like bugs and are not
//
// **A spent or expired ticket is kept, not deleted.** Deleting would make
// "you already used this" indistinguishable from "there is no such ticket", and
// a replay attempt and a proxy restart would read identically in the audit log.
// `TICKET_RETENTION_MS` is how long the corpse answers honestly.
//
// **A mismatched re-submission does not spend the ticket.** The human's decision
// stands; a client that sent the wrong arguments can send the right ones.
// Burning it would let one bad re-submission destroy an approval a human gave.
//
// No clock of its own and no timer: `now` is injected, expiry is computed at
// every read, and nothing here fires on a schedule. See `isDead`.

import { randomUUID } from "node:crypto";
import type { ApprovalVerdict, ResolvedToolCall } from "@getlibero/schema";

/**
 * How long a ticket lives. A constant, not a team-sheet field.
 *
 * Fifteen minutes is the architecture's number. It is not per-channel because
 * nobody has needed it to be, and a sheet field is a thing an operator can set
 * to a week — which turns "the broker fails closed on a restart" into "the
 * broker fails closed eventually". It becomes a field when someone hits it, and
 * the issue that adds it decides its ceiling.
 */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * How long a dead ticket is remembered after it dies.
 *
 * Not the same question as expiry, and the distinction is the point. Pruning at
 * `expiresAt` would turn every "that approval was already used" and "that
 * approval expired" into "there is no such approval" the instant the clock
 * crossed — so the honest answer would vanish exactly in the race that produced
 * the question. Keeping the record for another window means the refusal a client
 * gets says what actually happened.
 */
export const TICKET_RETENTION_MS = APPROVAL_TTL_MS;

/**
 * The most tickets one channel may hold at once.
 *
 * The bound on an otherwise unbounded sink, and it is worth being exact about
 * why one is needed here and nowhere else in this process: **a held call is not
 * metered.** `recordToolCall` runs only on the path that serves, so an agent
 * looping on a tool marked `approval = "required"` mints a ticket per iteration
 * and spends no budget doing it. Nothing else here grows on a request that was
 * refused.
 *
 * Over the cap the **oldest ticket is evicted** rather than the new mint
 * refused. Both are a denial of service the same compromised agent could cause a
 * dozen other ways; eviction is the one that fails closed on the thing that
 * matters, because an evicted ticket answers `unknown` and runs nothing.
 * Refusing the mint would mean a held call with no ticket — a hold nobody can
 * act on, and a shape the response type would have to grow a hole for.
 */
export const MAX_TICKETS_PER_CHANNEL = 64;

/**
 * One held call, and what became of it.
 *
 * Never leaves this module: `redeem` hands it back so the caller can read the
 * approver and the fields an audit row needs, and nothing outside constructs
 * one. It carries everything a `denied` or `expired` row must record, because
 * those rows are written by a request that has no tool call in its hands — the
 * ticket is the only description of the call they have.
 */
export interface ApprovalTicketRecord {
  readonly id: string;
  readonly channel: string;
  readonly server: string;
  readonly tool: string;
  readonly argumentsSha256: string;
  readonly requestingUser: string;
  readonly task: string;
  readonly callId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Null until a human decides. Set once; a second decision does not overwrite. */
  verdict: ApprovalVerdict | null;
  approver: string | null;
  decidedAt: number | null;
  /** Single use. Not deletion from the map — see the header. */
  spentAt: number | null;
  /**
   * Whether an `expired` audit row has already been written for this ticket.
   *
   * What makes "one terminal row per ticket" true. Without it, N re-submissions
   * of an expired ticket write N `expired` rows and any count of expiries is
   * wrong by however many times a client retried.
   */
  expiryObserved: boolean;
}

/** Why a re-submission was not served, or that it was. */
export type RedeemResult =
  | { readonly outcome: "redeemed"; readonly ticket: ApprovalTicketRecord }
  | { readonly outcome: "unknown" }
  | { readonly outcome: "pending"; readonly ticket: ApprovalTicketRecord }
  | { readonly outcome: "denied"; readonly ticket: ApprovalTicketRecord }
  | { readonly outcome: "spent"; readonly ticket: ApprovalTicketRecord }
  | { readonly outcome: "mismatch"; readonly ticket: ApprovalTicketRecord }
  | {
      readonly outcome: "expired";
      readonly ticket: ApprovalTicketRecord;
      /** False when something already wrote this ticket's `expired` row. */
      readonly firstObserved: boolean;
    };

/** What recording a human's click did. */
export type DecideResult =
  | { readonly outcome: "recorded"; readonly ticket: ApprovalTicketRecord }
  | { readonly outcome: "already_decided"; readonly ticket: ApprovalTicketRecord }
  | { readonly outcome: "unknown" }
  | {
      readonly outcome: "expired";
      readonly ticket: ApprovalTicketRecord;
      readonly firstObserved: boolean;
    };

/** What the enforcement path holds to raise a hold. It mints; it cannot decide. */
export interface ApprovalMinter {
  mint(call: ResolvedToolCall, argumentsSha256: string): ApprovalTicketRecord;
}

/** What the enforcement path holds to serve one. It spends; it cannot decide. */
export interface ApprovalRedeemer {
  redeem(channel: string, id: string, call: ResolvedToolCall, argumentsSha256: string): RedeemResult;
}

/**
 * What the decision route holds, and all of it. See the header for why this is
 * the narrowing that matters most.
 */
export interface ApprovalDecider {
  decide(channel: string, id: string, verdict: ApprovalVerdict, approver: string): DecideResult;
}

export interface ApprovalStore extends ApprovalMinter, ApprovalRedeemer, ApprovalDecider {}

export interface ApprovalStoreOptions {
  /**
   * The clock, injected. The server passes its own, so one process has one
   * clock and a test can cross an expiry without waiting fifteen minutes.
   */
  readonly now?: () => number;
}

export function createApprovalStore(options: ApprovalStoreOptions = {}): ApprovalStore {
  const now = options.now ?? Date.now;

  /**
   * Keyed by channel first, then by id, so a lookup for one channel **cannot
   * reach** another channel's tickets: no code path below holds two of the inner
   * maps at once. The flat `Map<id, record>` with a `record.channel === channel`
   * guard was the obvious alternative and is rejected on the grounds
   * ./budget-db.ts states for `WHERE channel = ?` — a guard is a line someone
   * can forget, and this is why a foreign ticket and a nonexistent one are
   * genuinely one answer rather than two answers chosen to look alike.
   */
  const byChannel = new Map<string, Map<string, ApprovalTicketRecord>>();

  /** Dead at `expiresAt`, not after it: the window is half-open. */
  const isDead = (ticket: ApprovalTicketRecord): boolean => now() >= ticket.expiresAt;

  const find = (channel: string, id: string): ApprovalTicketRecord | undefined =>
    byChannel.get(channel)?.get(id);

  /** Marks the expiry seen, and says whether this caller is the one that saw it. */
  const observeExpiry = (ticket: ApprovalTicketRecord): boolean => {
    if (ticket.expiryObserved) return false;
    ticket.expiryObserved = true;
    return true;
  };

  return {
    mint(call, argumentsSha256) {
      let tickets = byChannel.get(call.channel);
      if (tickets === undefined) {
        tickets = new Map();
        byChannel.set(call.channel, tickets);
      }

      // Prune and cap here and nowhere else: minting is the only operation that
      // grows the map, so it is the only one that has to shrink it.
      const at = now();
      for (const [id, held] of tickets) {
        if (at >= held.expiresAt + TICKET_RETENTION_MS) tickets.delete(id);
      }
      while (tickets.size >= MAX_TICKETS_PER_CHANNEL) {
        // Insertion order is creation order, so the first key is the oldest.
        const oldest = tickets.keys().next();
        if (oldest.done === true) break;
        tickets.delete(oldest.value);
      }

      const ticket: ApprovalTicketRecord = {
        id: randomUUID(),
        channel: call.channel,
        server: call.server,
        tool: call.tool,
        argumentsSha256,
        requestingUser: call.requestingUser,
        task: call.task,
        callId: call.id,
        createdAt: at,
        expiresAt: at + APPROVAL_TTL_MS,
        verdict: null,
        approver: null,
        decidedAt: null,
        spentAt: null,
        expiryObserved: false
      };
      tickets.set(ticket.id, ticket);
      return ticket;
    },

    redeem(channel, id, call, argumentsSha256) {
      const ticket = find(channel, id);
      if (ticket === undefined) return { outcome: "unknown" };

      // Expiry first: a dead ticket is dead whatever a human said about it.
      if (isDead(ticket)) return { outcome: "expired", ticket, firstObserved: observeExpiry(ticket) };
      if (ticket.spentAt !== null) return { outcome: "spent", ticket };
      if (ticket.verdict === null) return { outcome: "pending", ticket };
      if (ticket.verdict === "deny") return { outcome: "denied", ticket };

      // The match, and the whole of it: the server, the tool, and the hash of
      // the arguments. Not `callId`, not `requestingUser`, not `task` — a human
      // approved a call, not a tool-use id, and requiring the id would refuse a
      // legitimate re-submission that minted a fresh one. The consequence,
      // stated rather than hidden: the `ran` row records the re-submission's
      // attribution, which a hostile agent could make disagree with the held
      // row's. Neither is authorization, both rows exist, and the disagreement
      // is itself visible to whoever reads them.
      if (
        call.server !== ticket.server ||
        call.tool !== ticket.tool ||
        argumentsSha256 !== ticket.argumentsSha256
      ) {
        // Deliberately does not spend it. See the header.
        return { outcome: "mismatch", ticket };
      }

      ticket.spentAt = now();
      return { outcome: "redeemed", ticket };
    },

    decide(channel, id, verdict, approver) {
      const ticket = find(channel, id);
      if (ticket === undefined) return { outcome: "unknown" };
      if (isDead(ticket)) return { outcome: "expired", ticket, firstObserved: observeExpiry(ticket) };

      // The first verdict stands, including when the second disagrees. A decided
      // ticket may already have been spent, so there is no coherent un-approving
      // of it — and a store that let a later click overwrite an earlier one
      // would have to answer what that means for a call that already ran.
      if (ticket.verdict !== null) return { outcome: "already_decided", ticket };

      ticket.verdict = verdict;
      ticket.approver = approver;
      ticket.decidedAt = now();
      return { outcome: "recorded", ticket };
    }
  };
}
