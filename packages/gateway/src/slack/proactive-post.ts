// The proactive post, rendered (#318).
//
// Pure, on `approval-card.ts`'s terms and for its reasons: plain values in, a
// plain value out, no clock, no SDK type, no network. It is here rather than in
// `apps/server` because rendering is this package's job — the cards and the
// checklist are here, and a message this app writes should not be worded in two
// places by two conventions.
//
// ## A string, not a card
//
// The two card renderers answer `SlackCard`; this one answers `string`. A card
// is the proxy's mechanic for a held tool call — it carries a status colour, it
// is posted once and edited in place, and something holds its `ts` to edit it.
// A proactive post is none of that. Nothing repaints it, there is no status to
// colour, and `ChannelPoster.postToChannel` deliberately returns no handle. So
// what this file produces is the text of a message, and the absence of a card
// type is the same decision stated in the renderer.
//
// ## The label says what authorized the message
//
// A reader meeting an unprompted message needs one thing first: why is this
// here. The three answers are the three wake reasons, and they are genuinely
// different claims — one is the agent having noticed something on a clock
// nobody watched, one is a check somebody scheduled and a human approved,
// arriving when they asked for it, and one is a standing rule in the team sheet
// that fires every week at this time. `NOTICED`, `SCHEDULED CHECK` and
// `STANDING RULE` are those three sentences compressed, in the mono-uppercase
// style `STATUS_LABEL` already uses on the cards.
//
// `STANDING RULE` rather than a second `SCHEDULED` anything (#461), because what
// a reader needs to predict is **whether this happens again**. A scheduled check
// arrived once and is spent; a standing rule will be back next Monday, and a
// team that reads the two as the same thing either waits for a repeat that never
// comes or is surprised by one they did not expect.
//
// This is the same `source` discriminant `ProactivePoster` takes and that
// `DueEntry.kind` in `apps/server/src/session/ambient.ts` names. One word list:
// what wakes the process, what governs the post, and what the channel is told are
// three views of the same three cases, and none of them should need a
// translation table.
//
// ## Only a heartbeat names the switch
//
// A `NOTICED` post carries one closing line saying where the setting is. An
// agent that speaks unprompted and does not say how to stop it is asking a team
// to go and find out, and the window means a reader sees the line at most twice
// a working day. Neither of the other two carries that line, and the asymmetry
// is not an oversight: both posts were asked for. A `SCHEDULED CHECK`'s off
// switch was a governed, approved `schedule_task` create, and a `STANDING RULE`'s
// is an edit to the team sheet — so naming `[ambient]` on either would point a
// reader at a knob that is not the one that produced this.
//
// A rule is the sharper case of that, because it *does* have a block on that
// sheet and pointing at it would still be wrong: switching `[ambient]` off to
// stop one weekly digest would take the channel's heartbeat with it, and the
// edit a reader actually wants is to the rule's own entry.
//
// ## What it does not decide
//
// The body. That is the evaluation turn's sentence (#319), the fired task's
// (#324), or the proposal notice's (#320), and it arrives here as caller text —
// `checklist-card.ts`'s `note` case, which states when this package accepts a
// caller-worded line and why. It is escaped and capped like every other string
// this package did not author.

/** Why this message exists. The wake reason, and `ProactivePoster`'s discriminant. */
export type ProactiveSource = "heartbeat" | "task" | "rule";

export interface ProactivePostInput {
  readonly source: ProactiveSource;
  /**
   * What to say. Model-authored, so escaped and capped on the way through.
   *
   * One string rather than blocks, because a proactive post has no structure to
   * render: it is a paragraph, and the two things around it are this file's.
   */
  readonly text: string;
}

/** The mono label at the top. Uppercase, and what authorized the post in words. */
const SOURCE_LABEL: Record<ProactiveSource, string> = {
  heartbeat: "NOTICED",
  task: "SCHEDULED CHECK",
  rule: "STANDING RULE"
};

/**
 * How much of a body survives.
 *
 * Well under Slack's own limits, and the bound is editorial rather than
 * technical. A long unprompted message is the failure this whole surface is
 * rate-limited against, in a second form: the window stops the agent speaking
 * often and this stops it speaking at length. A finding that cannot be said in
 * this much has not been reduced to a finding yet.
 */
const BODY_LIMIT = 800;

/** Neutralizes Slack's markup in a string this package did not author. */
function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes, then caps. In that order: escaping can only lengthen. */
function safeText(value: string, limit: number): string {
  const escaped = escapeMrkdwn(value);
  return escaped.length <= limit ? escaped : `${escaped.slice(0, limit - 1)}…`;
}

/**
 * The line a `NOTICED` post ends on.
 *
 * Names the sheet block rather than describing a procedure, which is this
 * tree's voice rule: it says what the setting is called, and someone who holds
 * the team sheet knows what to do with that. Nobody else can act on it anyway —
 * the sheet is the operator's file and the agent process cannot write there.
 */
const SWITCH_NOTE = "_Unprompted posts are `[ambient]` in this channel's team sheet._";

/** Renders one proactive post. Pure. */
export function renderProactivePost(input: ProactivePostInput): string {
  const label = `\`${SOURCE_LABEL[input.source]}\``;
  const body = safeText(input.text, BODY_LIMIT);
  const lines = [`${label}\n${body}`];
  if (input.source === "heartbeat") lines.push(SWITCH_NOTE);
  return lines.join("\n\n");
}
