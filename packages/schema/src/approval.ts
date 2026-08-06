import { z } from "zod";
import { ApprovalTicketId, ApproverId } from "./names.js";

/**
 * The shapes a human's decision on a held call travels in.
 *
 * A tool marked `approval = "required"` is not refused and not run: the proxy
 * holds it and mints a ticket, the gateway renders a card, and a click comes
 * back on its own route. These are the three shapes that crossing takes — the
 * ticket on the way out, the decision on the way in, and what the broker did
 * with it.
 *
 * **What an approval is worth, stated here so nothing downstream overstates
 * it.** A ticket authorizes one call — one server, one tool, one argument hash —
 * once, in one channel, until it expires. It never widens what a channel may
 * call: the team sheet is enforced when the ticket is minted and again when it
 * is redeemed, so an operator's edit during the hold beats a click that preceded
 * it. And approver identity holds against a prompt-injected model, because the
 * click is observed by gateway code rather than produced by a model, but not
 * against a compromised agent process, which is the one that relays it. Say
 * *tool credentials* survive process compromise; approvals survive prompt
 * injection.
 *
 * The expiry itself is not here. Fifteen minutes is proxy policy rather than a
 * wire shape, and a client learns the deadline from `expiresAt` below rather
 * than from a constant it would have to keep in step.
 */

/**
 * The ticket a held call mints, as the `held` response carries it.
 *
 * Its own object rather than two flat fields on the response, because the pair
 * travels together everywhere downstream — the gateway puts the id in a Block
 * Kit action id and the deadline in the card's footer, and the agent puts the id
 * back on the re-submission. A shape that can be passed whole is one nobody
 * reassembles from two fields, and `.strict()` means a third field cannot appear
 * on the wire without being designed.
 */
export const ApprovalTicket = z
  .object({
    id: ApprovalTicketId,
    /**
     * Epoch milliseconds on the proxy's clock. Dead *at* this instant: the
     * window is half-open, so `now >= expiresAt` is expired.
     *
     * An absolute time rather than a duration, because the client renders a
     * deadline and the proxy is the authority on when the ticket dies. A
     * duration would leave the two clocks disagreeing about the same ticket, and
     * the disagreement would show up as a card that still offers a button for a
     * call that can no longer run.
     */
    expiresAt: z.number().int().positive()
  })
  .strict();

export type ApprovalTicket = z.infer<typeof ApprovalTicket>;

/** What a human said. Two answers; there is no third. */
export const ApprovalVerdict = z.enum(["approve", "deny"]);

export type ApprovalVerdict = z.infer<typeof ApprovalVerdict>;

/**
 * A human's decision on a held call.
 *
 * **Strict, and with no channel field**, exactly as `ToolCall` and `SpendReport`
 * are: the channel comes from the client certificate, so a body naming one fails
 * the parse rather than having the field quietly dropped. That is what binds a
 * ticket to its channel — channel A's connection cannot name channel B, so it
 * cannot decide channel B's ticket, and the proxy's ticket lookup never reaches
 * another channel's tickets to begin with.
 *
 * The ticket id is in the body rather than in the path, as `/v1/tools/call`
 * names its resource in the body. One strict parse then validates the whole
 * request; an id arriving as a path segment would reach the handler having been
 * through no schema at all, and the proxy's exact-match route table would need a
 * path-parameter mechanism it does not have and should not grow.
 */
export const ApprovalDecision = z
  .object({
    ticket: ApprovalTicketId,
    decision: ApprovalVerdict,
    /**
     * Who clicked. Attribution, never authorization — see `ApproverId`.
     *
     * Required on a deny as much as on an approve. A denial is a fact about a
     * human as much as an approval is, and an audit log that records who says
     * yes and not who says no answers half of "who decided this".
     */
    approver: ApproverId
  })
  .strict();

export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * What the broker did with the decision.
 *
 * All four are **served requests** — HTTP 200 — on the argument
 * `ToolCallResponse` makes: "there is no such ticket" is the system working, not
 * a request that failed.
 *
 * `unknown` covers a ticket that never existed, one another channel holds, and
 * one this process lost to a restart. They are deliberately one answer, and with
 * the proxy's per-channel ticket map they are *structurally* one — the lookup
 * cannot reach another channel's tickets, so there is nothing to accidentally
 * distinguish. Telling them apart would tell a caller that some other channel
 * holds an id it guessed, and no client does anything different for any of them.
 *
 * A ticket is decided **once**. A second decision — a double click, a stale
 * card, a retry — is `already_decided`, and the first answer stands even when
 * the second disagrees: a decided ticket may already have been spent, so there
 * is no coherent un-approving of it.
 */
export const ApprovalDecisionResponse = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("recorded"), ticket: ApprovalTicketId, decision: ApprovalVerdict }).strict(),
  z
    .object({ outcome: z.literal("already_decided"), ticket: ApprovalTicketId, decision: ApprovalVerdict })
    .strict(),
  z.object({ outcome: z.literal("expired"), ticket: ApprovalTicketId }).strict(),
  z.object({ outcome: z.literal("unknown"), ticket: ApprovalTicketId }).strict()
]);

export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponse>;
