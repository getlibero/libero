import type { ApprovalTicket } from "@getlibero/schema";
import { describe, it } from "node:test";
import { expect } from "expect";
import { renderApprovalCard, renderHeldCallArguments } from "./approval-card.js";
import type { ApprovalCardStatus } from "./approval-card.js";
import { APPROVE_ACTION_ID, DENY_ACTION_ID } from "./approval-ids.js";
import { toDecision } from "./decision.js";
import { blockActionsEnvelope } from "./stub-slack.js";
import type { SlackBlock, SlackCard } from "./types.js";

const TICKET: ApprovalTicket = {
  id: "0f2c9b3e-7a41-4c0d-9d2b-6e1f5a8c3b90",
  // 2025-06-15T14:25:00.123Z. Milliseconds on purpose — the date token takes
  // seconds, and the floor is a thing this file asserts.
  expiresAt: 1_749_998_700_123
};

const AWAITING: ApprovalCardStatus = { state: "awaiting", ticket: TICKET };
const RUNNING: ApprovalCardStatus = { state: "running", approver: "U0HUMAN" };
const APPROVED: ApprovalCardStatus = { state: "approved", approver: "U0HUMAN" };
const DENIED: ApprovalCardStatus = { state: "denied", approver: "U0HUMAN" };
const REFUSED: ApprovalCardStatus = {
  state: "refused",
  approver: "U0HUMAN",
  reason: "This channel's team sheet does not permit `github.pr.merge`."
};
const EXPIRED: ApprovalCardStatus = { state: "expired" };
const UNANSWERED: ApprovalCardStatus = { state: "unanswered", approver: "U0HUMAN" };

const ALL: ApprovalCardStatus[] = [AWAITING, RUNNING, APPROVED, DENIED, REFUSED, EXPIRED, UNANSWERED];
const DECIDED: ApprovalCardStatus[] = [RUNNING, APPROVED, DENIED, REFUSED, EXPIRED, UNANSWERED];

function card(status: ApprovalCardStatus, overrides: { toolName?: string; arguments?: string } = {}) {
  return renderApprovalCard({
    toolName: overrides.toolName ?? "github.pr.merge",
    ...(overrides.arguments !== undefined ? { arguments: overrides.arguments } : {}),
    status
  });
}

/** Everything a reader would see, as one string. */
function text(rendered: SlackCard): string {
  return JSON.stringify(rendered.blocks);
}

function actions(rendered: SlackCard): SlackBlock | undefined {
  return rendered.blocks.find(block => block.type === "actions");
}

/** The buttons on a card, or an empty list. Reading structural JSON needs a cast somewhere. */
function buttonsOf(rendered: SlackCard): Array<Record<string, unknown>> {
  const block = actions(rendered);
  return block === undefined ? [] : (block["elements"] as Array<Record<string, unknown>>);
}

/** The first section's rendered text. */
function sectionText(rendered: SlackCard): string {
  const block = rendered.blocks[0];
  return (block?.["text"] as { text: string }).text;
}

describe("renderApprovalCard", () => {
  it("draws the awaiting state amber, with both buttons carrying the ticket", () => {
    const rendered = card(AWAITING);
    const buttons = buttonsOf(rendered);

    expect(rendered.color).toBe("#F5B544");
    expect(buttons).toHaveLength(2);
    expect(buttons.map(b => b["action_id"])).toEqual([APPROVE_ACTION_ID, DENY_ACTION_ID]);
    expect(buttons.map(b => b["value"])).toEqual([TICKET.id, TICKET.id]);
    expect(buttons.map(b => (b["text"] as { text: string }).text)).toEqual([
      "Approve once",
      "Deny"
    ]);
    // Slack's own green and red on the buttons, which is the design system's
    // `lb-btn--primary` / `lb-btn--danger` pairing.
    expect(buttons.map(b => b["style"])).toEqual(["primary", "danger"]);
    // A screen reader gets "Approve once" otherwise, which does not say what.
    expect(buttons[0]?.["accessibility_label"]).toBe("Approve one call to github.pr.merge");
  });

  it("gives a decided card no buttons at all", () => {
    // What editing in place buys beyond tidiness: a decided card cannot be
    // clicked again, and the ticket id is nowhere left in the message.
    for (const status of DECIDED) {
      const rendered = card(status);
      expect(actions(rendered)).toBeUndefined();
      expect(text(rendered)).not.toContain(TICKET.id);
    }
  });

  it("uses the three status colours and no fourth", () => {
    expect(ALL.map(status => card(status).color)).toEqual([
      "#F5B544",
      // `running` — in flight is none of the three, so it wears none of them.
      undefined,
      "#1BA85A",
      "#FF6B5B",
      "#FF6B5B",
      "#FF6B5B",
      // `unanswered` — the fate of the call is unknown, so it claims nothing.
      undefined
    ]);
    const colours = ALL.map(status => card(status).color).filter(value => value !== undefined);
    expect(new Set(colours).size).toBe(3);
  });

  // The in-flight faces omit the key rather than carrying an empty string,
  // which is what the adapter turns into an attachment with no `color` at all.
  it("omits the colour key entirely for a state that has no status yet", () => {
    for (const status of [RUNNING, UNANSWERED]) {
      expect(Object.hasOwn(card(status), "color")).toBe(false);
    }
    expect(Object.hasOwn(card(APPROVED), "color")).toBe(true);
  });

  // Green is the claim that the call ran, which is the whole of #143. A human's
  // click is `running`, and only the re-submission's answer moves it.
  it("keeps green for the call that ran, and gives a click of its own its own face", () => {
    expect(card(RUNNING).color).toBeUndefined();
    expect(sectionText(card(RUNNING))).toContain("the call is running");
    expect(sectionText(card(APPROVED))).toContain("the call ran");
  });

  // Approved-then-refused names the approver: their decision was carried out,
  // and something after it stopped the call. Dropping the name would read as
  // though the click had been ignored.
  it("names the approver on an approved call that was refused anyway, with the proxy's reason", () => {
    const rendered = card(REFUSED);
    expect(rendered.color).toBe("#FF6B5B");
    expect(text(rendered)).toContain("U0HUMAN");
    expect(text(rendered)).toContain("does not permit");
    expect(sectionText(rendered)).toContain("It did not run.");
  });

  it("says only what is known when the task ended before the call answered", () => {
    const rendered = card(UNANSWERED);
    expect(text(rendered)).toContain("U0HUMAN");
    expect(sectionText(rendered)).toContain("It may have run.");
    // Neither claim is available, so neither is made.
    expect(sectionText(rendered)).not.toContain("did not run");
    expect(sectionText(rendered)).not.toContain("the call ran");
  });

  it("says the state in words as well as in colour", () => {
    // The colour is an attachment's left border: it does not survive a push
    // notification and a screen reader never sees it. Every state names itself
    // — which is what makes the two uncoloured states legible at all.
    const expected: Array<[ApprovalCardStatus, string, string]> = [
      [AWAITING, "APPROVAL REQUIRED", "Awaiting a human"],
      [RUNNING, "APPROVED — RUNNING", "the call is running"],
      [APPROVED, "APPROVED", "Approved:"],
      [DENIED, "DENIED", "Denied:"],
      [REFUSED, "APPROVED — BLOCKED", "Blocked:"],
      [EXPIRED, "EXPIRED", "Expired:"],
      [UNANSWERED, "APPROVED — UNANSWERED", "Unanswered:"]
    ];

    expect(expected).toHaveLength(ALL.length);

    for (const [status, label, fallbackWord] of expected) {
      const rendered = card(status);
      // Strip the colour: the card must still be readable without it.
      const colourless: SlackCard = { ...rendered, color: "" };
      expect(text(colourless)).toContain(`\`${label}\``);
      expect(rendered.fallback).toContain(fallbackWord);
      expect(rendered.fallback).toContain("github.pr.merge");
    }
  });

  it("carries no emoji, in any state", () => {
    // `design/README.md`: no exclamation marks, no emoji, no "AI magic".
    const emoji = /[☀-➿]|[\u{1F000}-\u{1FAFF}]/u;
    for (const status of ALL) {
      const rendered = card(status);
      expect(emoji.test(`${text(rendered)}${rendered.fallback}`)).toBe(false);
    }
  });

  it("renders the deadline through Slack's clock, never its own", () => {
    // Two renders being byte-identical is the assertion: a `Date.now()`
    // anywhere in the file would make them differ, or would make the seconds
    // below depend on when the suite ran.
    expect(card(AWAITING)).toEqual(card(AWAITING));
    // 1_749_998_700_123 ms floors to 1_749_998_700 s.
    expect(text(card(AWAITING))).toContain("<!date^1749998700^");
  });

  it("neutralizes markup in text it did not author", () => {
    // `arguments` renders tool-call arguments, which a prompt-injected model
    // wrote, onto the surface a human is about to click a button on. Every one
    // of `<!channel>`, `<@U…>`, and `<url|text>` is angle-bracket syntax.
    const rendered = card(AWAITING, {
      toolName: "a<b&c",
      arguments: "<!channel> Approved by <@U0BOSS> <https://evil|click here>"
    });
    const rendered_text = `${text(rendered)}${rendered.fallback}`;

    expect(rendered_text).not.toContain("<!channel>");
    expect(rendered_text).not.toContain("<@U0BOSS>");
    expect(rendered_text).toContain("&lt;!channel&gt;");
    expect(rendered_text).toContain("a&lt;b&amp;c");
    // The one angle bracket that is ours: the date token the renderer wrote.
    expect(rendered_text.match(/<(?!!date\^)/gu)).toBeNull();
  });

  // `refused`'s reason is `refusalMessage`'s today, which this project writes —
  // but it is a caller string of type `string`, and the rule that holds for one
  // caller string must not depend on which one it is. The approver's own `<@…>`
  // is the renderer's and survives.
  it("neutralizes markup in the relayed refusal reason too", () => {
    const rendered = card({
      state: "refused",
      approver: "U0HUMAN",
      reason: "<!channel> the sheet <https://evil|says no>"
    });
    const rendered_text = `${text(rendered)}${rendered.fallback}`;

    expect(rendered_text).not.toContain("<!channel>");
    expect(rendered_text).toContain("&lt;!channel&gt;");
    expect(rendered_text).toContain("<@U0HUMAN>");
  });

  it("neutralizes the backtick that would end the code span", () => {
    // `arguments` and the tool name render inside code spans. A backtick ends
    // the span and hands the rest of the string to mrkdwn as live markup — a
    // bold forged approver line needs nothing more — so it is substituted, not
    // rendered.
    const rendered = card(AWAITING, {
      arguments: 'branch: "x` *Approved by admin* `"'
    });
    const rendered_text = `${text(rendered)}${rendered.fallback}`;

    // The renderer's own code-span backticks survive; the input's do not.
    expect(rendered_text).not.toContain("x`");
    expect(rendered_text).toContain("x' *Approved by admin* '");
  });

  it("truncates an argument that would blow Slack's section limit", () => {
    const rendered = card(AWAITING, { arguments: "x".repeat(5000) });

    expect(sectionText(rendered).length).toBeLessThan(3000);
    expect(sectionText(rendered)).toContain("…");
  });

  it("emits plain JSON and nothing an SDK type would have smuggled in", () => {
    for (const status of ALL) {
      const rendered = card(status);
      expect(JSON.parse(JSON.stringify(rendered))).toEqual(rendered);
    }
  });

  it("draws a card this package can read back", () => {
    // The contract between the renderer and the decoder, asserted rather than
    // left as two constants that happen to match: take the card's own button,
    // put it on the wire, and decode it.
    const buttons = buttonsOf(card(AWAITING));

    for (const [index, verdict] of (["approve", "deny"] as const).entries()) {
      const button = buttons[index];
      expect(button).toBeDefined();
      const envelope = blockActionsEnvelope({
        // Straight off the rendered button rather than from a constant, so a
        // renamed action id fails here rather than in a workspace.
        verdict,
        ticketId: String(button?.["value"])
      });
      const result = toDecision(envelope);

      expect(result).toEqual({
        decision: expect.objectContaining({ verdict, ticketId: TICKET.id })
      });
      expect(button?.["action_id"]).toBe(
        verdict === "approve" ? APPROVE_ACTION_ID : DENY_ACTION_ID
      );
    }
  });
});

describe("renderHeldCallArguments", () => {
  /** The escaped length, which is the budget the function promises to hold. */
  function costOf(value: string): number {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`/g, "'").length;
  }

  it("renders nothing for a call that took no arguments", () => {
    expect(renderHeldCallArguments({})).toBeUndefined();
  });

  it("keeps the model's order when everything fits", () => {
    // A complete rendering cannot mislead by omission, so it is not reordered.
    expect(renderHeldCallArguments({ repo: "a/b", number: 123, force: true })).toBe(
      'repo: "a/b", number: 123, force: true'
    );
  });

  it("puts the sharp argument ahead of the blob and names what it dropped", () => {
    // The issue's own hazard: `force: true` clipped off the end of a long body
    // reads as the whole call. Shortest-first is what makes the flag survive,
    // and the dropped key is named so the body is visible as existing.
    const rendered = renderHeldCallArguments({ body: "x".repeat(400), force: true });

    expect(rendered).toBe("force: true — +1 more not shown: body");
    expect(costOf(rendered ?? "")).toBeLessThanOrEqual(300);
  });

  it("degrades to a count when the dropped names do not fit either", () => {
    const args: Record<string, unknown> = { ok: 1 };
    for (let i = 0; i < 40; i++) args[`long_argument_name_${String(i).padStart(2, "0")}`] = "y".repeat(400);
    const rendered = renderHeldCallArguments(args) ?? "";

    expect(rendered).toContain("ok: 1");
    expect(rendered).toContain("+40 more not shown");
    expect(rendered).not.toContain("not shown:");
    expect(costOf(rendered)).toBeLessThanOrEqual(300);
  });

  it("cuts inside a value only when no whole entry fits, and says so", () => {
    const rendered = renderHeldCallArguments({ body: "z".repeat(400) }) ?? "";

    expect(rendered).toContain("body: ");
    expect(rendered).toContain("…");
    expect(rendered).toContain("— truncated");
    expect(rendered).not.toContain("not shown");
    expect(costOf(rendered)).toBeLessThanOrEqual(300);
  });

  it("counts the budget in escaped characters, so the note survives the cap", () => {
    // 120 `<`s escape fourfold. Measured raw they would fit; measured escaped
    // they cannot, and the renderer's own cap would then eat the suffix off
    // whatever this returned. The promise is that what this returns still
    // fits after escaping.
    const rendered = renderHeldCallArguments({ a: "<".repeat(120), force: true }) ?? "";

    expect(rendered).toContain("force: true");
    expect(costOf(rendered)).toBeLessThanOrEqual(300);
  });

  it("through the card: a partial rendering reaches the reader intact", () => {
    // End to end through `renderApprovalCard`: the partiality note is inside
    // the section, not eaten by `safeText`'s cap.
    const detail = renderHeldCallArguments({ body: "x".repeat(400), force: true });
    const rendered = card(AWAITING, { ...(detail !== undefined ? { arguments: detail } : {}) });

    expect(sectionText(rendered)).toContain("force: true");
    expect(sectionText(rendered)).toContain("+1 more not shown: body");
  });
});
