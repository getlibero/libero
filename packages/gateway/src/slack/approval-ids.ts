// The two action ids an approval card publishes, and the verdict each means.
//
// One table, read in both directions: the renderer stamps an id onto a button,
// and the decoder recognizes that id and nothing else. Its own file because the
// pairing *is* the contract between those two, and putting it in either would
// make one depend on the other. A round-trip test over this file is what makes
// "the card the gateway drew is the card the gateway can read" a fact rather
// than two constants that happen to match.
//
// **The verdict travels in the `action_id` and the ticket travels in the
// `value`.** Not packed into one string, and that is a decision rather than a
// style: `ApprovalTicketId` permits `.`, `-`, and `_`, so any separator worth
// picking is a separator a ticket id may contain, and a packed id would have to
// be split by something. This way the security-relevant half — which of the two
// things a human said — is never parsed at all. It is a map lookup against two
// constants, and an id that is not one of them is not a verdict. The `action_id`
// only has to be unique within a message, and there is one card per ticket, so
// embedding the ticket id would buy nothing to pay for that.
//
// Namespaced, because a Slack app's action ids share one space across every
// message it has ever posted: an unprefixed id would eventually collide with
// another surface's, and the collision would look like an approval decided by a
// click on something else.

import type { ApprovalVerdict } from "@getlibero/schema";

export const APPROVE_ACTION_ID = "libero_approval_approve";
export const DENY_ACTION_ID = "libero_approval_deny";

/** The prefix everything this feature publishes shares. */
const APPROVAL_ACTION_PREFIX = "libero_approval_";

const VERDICTS: ReadonlyMap<string, ApprovalVerdict> = new Map<string, ApprovalVerdict>([
  [APPROVE_ACTION_ID, "approve"],
  [DENY_ACTION_ID, "deny"]
]);

/**
 * Whether an action id is one of ours at all.
 *
 * Separate from `verdictForActionId` so the decoder can tell two different
 * things apart: another surface's button, which is not an error and not ours to
 * have an opinion about, and one of ours that this build does not publish,
 * which means a card from an older build is still on screen.
 */
export function isApprovalActionId(actionId: string): boolean {
  return actionId.startsWith(APPROVAL_ACTION_PREFIX);
}

/** The verdict an action id means, or `undefined` if it means none. */
export function verdictForActionId(actionId: string): ApprovalVerdict | undefined {
  return VERDICTS.get(actionId);
}

/** The action id a verdict's button carries. The other direction of one table. */
export function actionIdForVerdict(verdict: ApprovalVerdict): string {
  return verdict === "approve" ? APPROVE_ACTION_ID : DENY_ACTION_ID;
}
