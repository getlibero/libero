// The live checklist, rendered.
//
// Pure, on `approval-card.ts`'s terms and for its reasons: plain objects in,
// plain objects out, no clock, no SDK type, no network, and it emits structural
// `SlackBlock`s that `web-api.ts` translates once. Two card renderers side by
// side rather than one parameterised over both, because they share a shape and
// nothing else — a checklist has no ticket, no button, no deadline, and no
// human to name, and the one thing they do share (`SlackCard`) is already the
// seam.
//
// ## What this file decides, and what it does not
//
// It decides the layout, the step words, and the state labels. It does **not**
// decide the sentence a stopped task ends on: that arrives as `note`, and this
// is the one place this package takes a caller-worded line. `approval-card.ts`
// refuses to, and the difference is what the words are about — its four states
// are tenses of one claim, so a caller wording them would own a copy rule that
// drifts. A stop note is a fact about a finished task, written once, and the
// alternative is a second copy of `CAP_NOTE` living here where nothing could
// keep the two in step. It is escaped and capped like any other caller string.
//
// ## Colour
//
// Green is a task that ran to its own end, red is one a cap stopped, and a task
// still working wears **no colour** — it is not executed, no human is being
// waited on, and nothing is blocked, so it is none of the three the design
// system has. See `SlackCard.color`; this is the same decision the approval
// card's `running` face makes, and it is why that field is optional.
//
// A cancelled task is uncoloured too. Shutdown concluded nothing, and the
// checklist says so rather than claiming the task was blocked.
//
// ## One message, edited
//
// Nothing here knows that. This file renders a whole card from whole state,
// which is what makes editing in place the caller's problem and not a mutable
// object's — `CardPoster.updateCard` replaces the message anyway. The
// coalescing that keeps a twenty-call task from making twenty edits lives in
// `apps/server`, where the clock is.

import type { SlackBlock, SlackCard } from "./types.js";

/** One row. `name` is model-authored text and is escaped on the way in. */
export interface ChecklistStep {
  readonly name: string;
  readonly state: "running" | "ok" | "error" | "skipped";
}

export type ChecklistCardStatus =
  /** No colour. Tool calls are still going out. */
  | { state: "working" }
  /** Green. The task reached its own end. */
  | { state: "done" }
  /** Red. A cap or a failure stopped it; `note` says which. */
  | { state: "stopped"; note?: string }
  /** No colour. The process was shutting down, so nothing was concluded. */
  | { state: "cancelled" };

export interface ChecklistCardInput {
  readonly steps: readonly ChecklistStep[];
  readonly status: ChecklistCardStatus;
}

type ChecklistCardState = ChecklistCardStatus["state"];

/**
 * Two colours and two absences.
 *
 * A record over the closed union rather than a parameter, `STATUS_COLOUR`'s
 * argument in `approval-card.ts`: a caller asks for a state and has no way to
 * ask for a colour. The hexes are the dark `--lb-accent` and `--lb-danger`,
 * hand-transcribed because Slack cannot read a token, and pinned against
 * `design/tokens.css` by `checklist-card-tokens.test.ts`.
 */
const STATUS_COLOUR: Record<ChecklistCardState, string | undefined> = {
  working: undefined,
  done: "#1BA85A",
  stopped: "#FF6B5B",
  cancelled: undefined
};

const STATUS_LABEL: Record<ChecklistCardState, string> = {
  working: "WORKING",
  done: "DONE",
  stopped: "STOPPED",
  cancelled: "CANCELLED"
};

/**
 * Each step's own word.
 *
 * Words rather than glyphs, and no colour per row: the design system's three
 * colours are the card's status, and a green tick beside a red cross would be
 * four things coloured on a surface whose rule is that only status is. A row
 * also has to survive a push notification and a screen reader, which is the
 * same argument the approval card's labels rest on.
 */
const STEP_WORD: Record<ChecklistStep["state"], string> = {
  running: "running",
  ok: "done",
  error: "failed",
  skipped: "not run"
};

/** Slack rejects a section over 3000 characters and would reject the post with it. */
const TOOL_NAME_LIMIT = 80;
const NOTE_LIMIT = 200;
/**
 * How many rows a card shows.
 *
 * A cap because `max_tool_calls_per_task` defaults to 25 and an operator may
 * raise it, and because every row carries a model-authored name at up to 80
 * characters. Overflow is a count rather than a truncated row: "and 4 more"
 * says what is missing, where a cut list silently claims to be the whole of it.
 */
const MAX_ROWS = 20;

/** Neutralizes Slack's markup in a string this package did not author. */
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

/**
 * The fallback line: what a push notification and a screen reader get.
 *
 * It names the task's state and counts the calls rather than listing them. A
 * notification is one line on a lock screen, and twenty tool names is not a
 * line — the card itself is where the detail lives.
 */
function fallbackFor(status: ChecklistCardStatus, steps: readonly ChecklistStep[]): string {
  const done = steps.filter(step => step.state === "ok").length;
  const calls = `${String(done)} of ${String(steps.length)} tool ${steps.length === 1 ? "call" : "calls"} done`;
  switch (status.state) {
    case "working":
      return `Working: ${calls}.`;
    case "done":
      return `Done: ${calls}.`;
    case "stopped":
      return status.note === undefined ? `Stopped: ${calls}.` : `Stopped: ${calls}. ${status.note}`;
    case "cancelled":
      return `Cancelled: ${calls}. The agent was shutting down.`;
  }
}

/** Renders the checklist in one state, from the whole of what is known. Pure. */
export function renderChecklistCard(input: ChecklistCardInput): SlackCard {
  const state = input.status.state;
  const shown = input.steps.slice(0, MAX_ROWS);
  const hidden = input.steps.length - shown.length;

  const rows = shown.map(
    step => `\`${safeText(step.name, TOOL_NAME_LIMIT)}\` — ${STEP_WORD[step.state]}`
  );
  if (hidden > 0) rows.push(`and ${String(hidden)} more`);

  const blocks: SlackBlock[] = [
    section([`\`${STATUS_LABEL[state]}\``, ...rows].join("\n"))
  ];

  // The stop note is its own block rather than another row: it is a fact about
  // the task and not about any one call, and a reader scanning rows should not
  // find a sentence among them.
  if (input.status.state === "stopped" && input.status.note !== undefined) {
    blocks.push(context(safeText(input.status.note, NOTE_LIMIT)));
  }

  const colour = STATUS_COLOUR[state];
  return {
    ...(colour !== undefined ? { color: colour } : {}),
    fallback: fallbackFor(input.status, input.steps),
    blocks
  };
}
