// Turning one interactive envelope into a SlackDecision, or into a reason it is
// not one.
//
// The second of the two files that read the wire shape, and it keeps every rule
// the first one does: pure, imports no SDK type, reads `unknown` defensively,
// and fails closed. A field it cannot read confidently is a reason to ignore
// the click, never a reason to guess. It **never throws** — a malformed payload
// is a returned reason, which is why the gateway's `update_failed` sibling
// `malformed_event` does not exist.
//
// `asRecord` and `readString` are duplicated from `mention.ts` rather than
// shared. Ten lines, and each file stays the whole account of how one payload
// is read — a loosening made for one wire shape cannot reach the other by
// accident.
//
// Three things deliberately not read:
//
// **`response_url`.** It is the obvious way to update a message, and it is a
// URL with a secret in it. This package's rule is that no field of any type
// holds a token, and a `response_url` on a `SlackDecision` would be one,
// reachable by anything that logs a decision. Cards are edited with
// `chat.update` on the bot token, a credential this process already holds and
// never surfaces. If a later change makes `response_url` look like a
// simplification, this paragraph is the answer.
//
// **`token`.** The interactive payload carries Slack's legacy verification
// token, exactly as an events_api body does. Socket Mode authenticates the
// connection, so it is neither needed nor safe to start handling — the same
// note `mention.ts` makes.
//
// **`event_id`.** There isn't one. An interactive payload has no delivery id,
// so there is no dedupe key here and none is invented; see the argument beside
// the `seen` set in `gateway.ts`.

import type { ApprovalVerdict } from "@getlibero/schema";
import { isApprovalActionId, verdictForActionId } from "./approval-ids.js";
import type { SlackDecision, SlackInteractionEnvelope } from "./types.js";

/**
 * Why an envelope is not a decision. A closed set — each one is a `reason` in a
 * log line, so they double as the grep terms for "why did my click do nothing".
 */
export type DecisionIgnoreReason =
  /** Not a `block_actions` payload at all: a slash command, a view submission, a shortcut. */
  | "not_an_interaction"
  /** A real block action on a button that is not ours. Another surface's, and not an error. */
  | "not_an_approval"
  /** Our namespace, an action id this build does not publish. A card from an older build. */
  | "unknown_verdict"
  /** A field the decision depends on was missing, empty, or not a string. */
  | "missing_field";

export type DecisionResult = { decision: SlackDecision } | { ignored: DecisionIgnoreReason };

/**
 * The longest ticket id worth reading.
 *
 * `value` holds up to 2000 characters and an `ApprovalTicketId` is at most 64,
 * so anything longer did not come from a card this package drew. The cap is not
 * validation — the id is opaque here and the proxy is what resolves it — it
 * just stops a 2000-character string becoming a 2000-character log field.
 */
const TICKET_ID_LIMIT = 128;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A present, non-empty string. */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A present, non-empty string on a nested record — `body.user.id` and friends. */
function readNestedId(
  source: Record<string, unknown>,
  parent: string,
  key: string
): string | undefined {
  const nested = asRecord(source[parent]);
  return nested === undefined ? undefined : readString(nested, key);
}

/**
 * Normalizes a `block_actions` envelope.
 *
 * The verdict is recovered by looking an `action_id` up in a two-entry table,
 * never by parsing it, and the ticket id is a separate field. See
 * `approval-ids.ts` for why that split is the point rather than the layout.
 *
 * Only the first action is read. Slack sends an array because a message can
 * carry several inputs whose values are submitted together; an approval card
 * has two buttons and a click on one submits one action. A second entry would
 * mean a payload this package did not draw.
 */
export function toDecision(envelope: SlackInteractionEnvelope): DecisionResult {
  const body = asRecord(envelope.body);
  if (body === undefined) return { ignored: "not_an_interaction" };
  if (body["type"] !== "block_actions") return { ignored: "not_an_interaction" };

  const actions = body["actions"];
  if (!Array.isArray(actions)) return { ignored: "not_an_interaction" };
  const action = asRecord(actions[0]);
  if (action === undefined) return { ignored: "not_an_interaction" };

  const actionId = readString(action, "action_id");
  if (actionId === undefined) return { ignored: "not_an_interaction" };
  // Another feature's button. Not ours to have an opinion about, and not a
  // fault — which is why it is a different reason from the one below.
  if (!isApprovalActionId(actionId)) return { ignored: "not_an_approval" };

  const verdict: ApprovalVerdict | undefined = verdictForActionId(actionId);
  if (verdict === undefined) return { ignored: "unknown_verdict" };

  const ticketId = readString(action, "value");
  if (ticketId === undefined || ticketId.length > TICKET_ID_LIMIT) {
    return { ignored: "missing_field" };
  }

  const teamId = readNestedId(body, "team", "id");
  const channelId = readNestedId(body, "channel", "id");
  const approverId = readNestedId(body, "user", "id");
  const messageTs = readNestedId(body, "message", "ts");

  if (
    teamId === undefined ||
    channelId === undefined ||
    approverId === undefined ||
    messageTs === undefined
  ) {
    return { ignored: "missing_field" };
  }

  // A card posted into a thread is answered in that thread. `container` is
  // where Slack puts it for a message action; `message.thread_ts` is the same
  // answer from the message itself. A card that is somehow top-level is its own
  // thread root, which is the same fallback `toMention` makes.
  const threadTs =
    readNestedId(body, "container", "thread_ts") ??
    readNestedId(body, "message", "thread_ts") ??
    messageTs;

  return {
    decision: { teamId, channelId, approverId, ticketId, verdict, messageTs, threadTs }
  };
}
