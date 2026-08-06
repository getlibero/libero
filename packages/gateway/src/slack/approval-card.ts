// The approval card, rendered.
//
// Pure: plain objects in, plain objects out, no clock, no SDK type, no network.
// It imports no Slack SDK because it may not — an ESLint rule keeps `@slack/*`
// to the three adapter files — so it emits structural `SlackBlock`s and
// `web-api.ts` does the one translation. That is not a workaround; it is what
// makes the renderer testable by comparing JSON.
//
// ## What this file decides, and what it does not
//
// It decides every word on the card. The caller supplies names — a tool name,
// an approver id — and nothing else. The alternative was taking a caller-worded
// sentence, and it does not survive contact with the states: the prose the
// schema's `refusalMessage` gives for `approval_required` is "The call is
// held", which is present tense and becomes a lie the moment the card goes
// green. Either the caller re-words on every render, and now owns the copy
// rule, or this file owns all four sentences. It owns them, and the design
// system's rule — plain, terse, technical, name the tool call, no emoji — is
// then one file with one test rather than a convention.
//
// It decides nothing about approval. Which tickets exist, what a click is worth,
// and whether a call may run are the proxy's, from the team sheet. This file
// draws what it is told and knows no policy.
//
// ## Two gaps, both #127's, both deliberate
//
// **`approved` means a human said yes, not that the call ran.** Redemption
// enforces the sheet again, so an approved call can still be refused — an
// operator's edit during the hold beats a click that preceded it. A caller that
// wants green to mean executed renders `approved` after the re-submission comes
// back `ran`, which costs it one line of ordering. The case with no state is
// approve-then-refused-at-redemption: green would lie and red would blame the
// human. Four states rather than a fifth invented for a path that does not
// exist yet — and the union is switched exhaustively, so adding one is a
// compile error in the places that matter.
//
// **Nothing here holds a clock or a deadline.** A ticket dies fifteen minutes
// after it is minted, and this file will render `expired` when it is told to
// and never on its own. Whoever holds the ticket holds the deadline.

import type { ApprovalTicket } from "@getlibero/schema";
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from "./approval-ids.js";
import type { SlackBlock, SlackCard } from "./types.js";

/**
 * The three status colours, as hex.
 *
 * Hex rather than a token for the reason `design/README.md` already gives where
 * it ships the Slack sidebar theme as a raw string: "Hex because Slack can't
 * read a token". These are the **dark** values of `--lb-warn`, `--lb-accent`,
 * and `--lb-danger` from `design/tokens.css`, because the workspace wears the
 * dark tokens. Change a token upstream, change these, and redo the sidebar
 * string beside them.
 *
 * Colour is status and never decoration, and there is no fourth: green is
 * allowed and executed, amber is a human who still has to click, red is
 * blocked. That is why this is a record over the closed state union rather than
 * a parameter — a caller can ask for a state and has no way to ask for a
 * colour.
 *
 * It is drawn as a message attachment's left border, which is the only way to
 * get an arbitrary colour into a Slack message at all. Attachments are legacy
 * by Slack's own documentation — "not deprecated per se, but they may change in
 * the future, in ways that reduce their visibility or utility" — and were
 * chosen anyway, on the terms below.
 *
 * **The colour is reinforcement, and never the signal.** It does not survive a
 * push notification and is invisible to a screen reader, so every state also
 * says its name in the blocks and in `fallback`. A card read with no colour at
 * all is still correct, and there is a test that strips it and checks. That is
 * also the whole cost of the day Slack drops attachments: the card degrades to
 * correct-but-grey rather than to nothing.
 */
const STATUS_COLOUR: Record<ApprovalCardState, string> = {
  awaiting: "#F5B544",
  approved: "#1BA85A",
  denied: "#FF6B5B",
  expired: "#FF6B5B"
};

/** The mono label at the top of each state. Uppercase, and the state in words. */
const STATUS_LABEL: Record<ApprovalCardState, string> = {
  awaiting: "APPROVAL REQUIRED",
  approved: "APPROVED",
  denied: "DENIED",
  expired: "EXPIRED"
};

export type ApprovalCardState = "awaiting" | "approved" | "denied" | "expired";

export type ApprovalCardStatus =
  /** Amber. Nobody has clicked. The only state that carries a ticket, so the only one that can draw a button. */
  | { state: "awaiting"; ticket: ApprovalTicket }
  /** Green. A human said yes. */
  | { state: "approved"; approver: string }
  /** Red. A human said no. */
  | { state: "denied"; approver: string }
  /** Red. The deadline passed with nobody clicking. */
  | { state: "expired" };

export interface ApprovalCardInput {
  /** `server.tool`, as the proxy named the held call. */
  toolName: string;
  /**
   * A short rendering of the call's arguments, when the caller has one.
   *
   * Optional, and nothing fills it yet. It exists now rather than later because
   * of what it is: **model-authored text on a security-decision surface**. A
   * ticket binds an argument hash, so the human is approving one exact call, and
   * a card naming only the tool is asking them to approve blind. Landing the
   * field together with the escaping below means the caller that fills it cannot
   * introduce the hole by filling it.
   */
  arguments?: string;
  status: ApprovalCardStatus;
}

/** Slack rejects a section over 3000 characters, and would reject the whole post with it. */
const TOOL_NAME_LIMIT = 80;
const ARGUMENTS_LIMIT = 300;

/**
 * Neutralizes Slack's markup in a string this package did not author.
 *
 * The mitigation, not hygiene. `arguments` renders tool-call arguments, which a
 * prompt-injected model wrote, onto the one surface in this system whose whole
 * job is to show a human something they can trust enough to click a button
 * about. Rendered verbatim into an `mrkdwn` block, a model can put `<!channel>`
 * on an approval card and page the company, or draw a convincing
 * `Approved by <@U0BOSS>` line above the real footer, or hide a link behind
 * friendly text.
 *
 * Slack's three required escapes are the whole fix: with `<` gone there is no
 * `<!channel>`, no `<@U…>`, and no `<url|text>`, because every one of them is
 * angle-bracket syntax. Applied to `toolName` too — it is not validated on the
 * way in, and a rule that holds for one caller string should not depend on
 * which one it is.
 */
function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes, then caps. In that order: escaping can only lengthen. */
function safeText(value: string, limit: number): string {
  const escaped = escapeMrkdwn(value);
  return escaped.length <= limit ? escaped : `${escaped.slice(0, limit - 1)}…`;
}

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function button(
  actionId: string,
  label: string,
  style: "primary" | "danger",
  ticketId: string,
  accessibilityLabel: string
): SlackBlock {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: label },
    style,
    value: ticketId,
    // Replaces the button's own text for a screen reader, which "Approve once"
    // needs: two cards in one thread are two identical buttons otherwise.
    accessibility_label: accessibilityLabel
  };
}

/**
 * The deadline, as Slack's date token.
 *
 * `<!date^seconds^{time}|fallback>` — Slack renders it in each reader's own
 * timezone, which is not something this package could do and not something it
 * should try. `expiresAt` is epoch **milliseconds** and the token takes
 * **seconds**, so it is floored.
 *
 * An absolute time rather than the design mock's "expires in 12m", and the
 * deviation is deliberate: a relative time in a message that is never
 * re-rendered is wrong within the minute, and this card is only ever rewritten
 * when its state changes. Note also that dividing a number the caller handed
 * over is arithmetic, not a clock — nothing here reads the time.
 */
function deadline(expiresAt: number): string {
  const seconds = Math.floor(expiresAt / 1000);
  return `Expires <!date^${String(seconds)}^{time}|at ${String(seconds)}>`;
}

/** Renders one approval card in one state. Pure. */
export function renderApprovalCard(input: ApprovalCardInput): SlackCard {
  const tool = safeText(input.toolName, TOOL_NAME_LIMIT);
  const detail =
    input.arguments === undefined ? undefined : safeText(input.arguments, ARGUMENTS_LIMIT);
  const on = detail === undefined ? "" : ` on \`${detail}\``;
  const state = input.status.state;
  const label = `\`${STATUS_LABEL[state]}\``;

  const blocks: SlackBlock[] = [];
  let fallback: string;

  switch (input.status.state) {
    case "awaiting": {
      blocks.push(
        section(
          `${label}\nThe agent wants to call \`${tool}\`${on}. The call is held until a human decides.`
        ),
        context(deadline(input.status.ticket.expiresAt)),
        {
          type: "actions",
          elements: [
            button(
              APPROVE_ACTION_ID,
              "Approve once",
              "primary",
              input.status.ticket.id,
              `Approve one call to ${tool}`
            ),
            button(
              DENY_ACTION_ID,
              "Deny",
              "danger",
              input.status.ticket.id,
              `Deny the call to ${tool}`
            )
          ]
        }
      );
      fallback = `Awaiting a human: ${tool} is held until someone approves or denies it.`;
      break;
    }

    // Every decided state drops the actions block, which is what editing in
    // place buys beyond tidiness: a decided card cannot be clicked again, and
    // the ticket id is nowhere in the message left to scrape.
    case "approved": {
      blocks.push(
        section(`${label}\nThe agent asked to call \`${tool}\`${on}. A human approved it.`),
        // Slack resolves the display name client-side. This package never
        // learns it, and does not need to.
        context(`Approved by <@${input.status.approver}>.`)
      );
      fallback = `Approved: a human approved ${tool}.`;
      break;
    }

    case "denied": {
      blocks.push(
        section(`${label}\nThe agent asked to call \`${tool}\`${on}. The call did not run.`),
        context(`Denied by <@${input.status.approver}>.`)
      );
      fallback = `Denied: a human denied ${tool}. The call did not run.`;
      break;
    }

    case "expired": {
      blocks.push(
        section(`${label}\nThe agent asked to call \`${tool}\`${on}. The call did not run.`),
        context("No decision before the deadline. Asking again raises a new approval.")
      );
      fallback = `Expired: nobody decided ${tool} before the deadline. The call did not run.`;
      break;
    }
  }

  return { color: STATUS_COLOUR[state], fallback, blocks };
}
