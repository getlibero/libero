// The one thing a heartbeat evaluation may do, which is to say something (#319).
//
// Ambient mode's turn asks a question no other turn in this system asks: *is
// anything here worth interrupting a channel about?* Almost always the answer is
// no, and the shape of this file is built around that being the ordinary case.
//
// ## Silence is calling no tool, and there is no `stay_silent` member
//
// This is `./skill-merge.ts`'s rule and it matters more here than anywhere.
// Every turn in this tree expresses declining as an empty tool list, and the
// alternative — a sentinel the model emits to mean "nothing" — was rejected for
// the merge curator and is rejected again. Two reasons, and the second is the
// one specific to ambient.
//
// A sentinel has to be *recognized*, so every answer that is neither the
// sentinel nor a well-formed finding needs a rule, and "when unsure, post" is
// the wrong default for an agent speaking to a channel nobody asked. With
// absence as the silent answer that rule is not needed: a malformed call, an
// invented tool name, a paragraph of prose and an empty response all produce no
// finding, by construction rather than by a branch somebody has to write
// correctly.
//
// And a sentinel is a thing a poisoned message could talk the model *out of*
// emitting. Nothing can talk a model into a valid `post_finding` call it did not
// already decide to make, and that asymmetry is the right way round.
//
// ## What is not here
//
// **No `kind`.** "Stale thread", "approaching deadline", "unanswered question"
// are the cases the design names, and none of them changes what happens next:
// the text is posted and nothing branches on why. A vocabulary the model must
// pick from and no reader consults is a field that can only be wrong.
//
// **No thread, and no message id.** A proactive post is a channel post — there
// is no inbound event to reply into — so there is nothing for a thread reference
// to do but tempt a future reader into making one.
//
// **No handler.** The turn produces a value and its caller decides, which is the
// merge curator's shape and its guarantee: nothing in `packages/agent` can post,
// and the rate-limited surface that can is `apps/server`'s.

import { z } from "zod";
import type { ToolInputSchema } from "./tool-listing.js";

/**
 * The tool's name.
 *
 * A bare constant rather than a `z.enum`, `SKILL_MERGE_TOOL`'s reason: there is
 * one, and an enum of one is a totality check over a single key.
 */
export const AMBIENT_FINDING_TOOL = "post_finding";

/**
 * How long a finding may be.
 *
 * Under `renderProactivePost`'s own cap in `packages/gateway`, deliberately, so
 * that an ordinary finding is never truncated on the way to a channel: this is
 * what the model is told, that is the backstop, and a model told 800 whose 800
 * characters came back as 780 would be a design that trims its own output for no
 * reason a reader could see.
 *
 * Escaping can still push a pathological finding past the renderer's cap — a
 * body of nothing but ampersands quintuples — and that one is truncated, which
 * is the right outcome for text nobody would write.
 *
 * The figure itself is editorial and matches the surface's argument: an
 * unprompted message is rate-limited so the agent does not speak often, and
 * bounded so it does not speak at length. A finding that cannot be said in this
 * much has not been reduced to a finding yet.
 */
export const AMBIENT_FINDING_MAX_CHARS = 700;

/**
 * What the model may send, parsed strictly.
 *
 * `.strict()` for `SkillMergeArguments`' reason, and the input here is the same
 * kind: this turn reads a channel's own messages, so an unknown key is a field
 * somebody in that channel tried rather than one nobody bounded.
 */
export const AmbientFindingArguments = z
  .object({
    /**
     * What to say, as the channel will read it.
     *
     * One string and no structure, because the post has none — see
     * `renderProactivePost`, which adds a label and a line about the setting and
     * otherwise puts this through verbatim. It is escaped there; nothing here
     * assumes it is safe.
     */
    text: z.string().min(1).max(AMBIENT_FINDING_MAX_CHARS)
  })
  .strict();

export type AmbientFindingArguments = z.infer<typeof AmbientFindingArguments>;

/**
 * One thing worth saying in a channel nobody asked.
 *
 * A type rather than a zod object, for `SkillMergeDraft`'s reason: it is built
 * by the parser below and handed to a poster, both inside the agent process, and
 * there is no boundary at which untrusted bytes become one without going through
 * `parseAmbientFinding`.
 */
export interface AmbientFinding {
  readonly text: string;
}

/**
 * Why a call produced no finding.
 *
 * Ambient-local rather than members on a shared reason set, for
 * `SkillMergeFailure`'s stated reason: nothing here reaches the tool proxy
 * service, is decided by a gate, or writes an audit row.
 *
 * Note what is *not* a member: there is no failure for "the model said nothing".
 * That is the ordinary outcome and it is expressed by there being no call to
 * parse at all — a member for it would be a second spelling of silence, and the
 * caller's log would then have two words for the thing that happens almost every
 * time.
 */
export const AmbientFindingFailure = z.enum([
  /** The model called something other than `post_finding`. */
  "unknown_tool",
  /** The arguments did not parse: a missing field, a wrong type, an unknown key. */
  "malformed_arguments",
  /** The text was longer than `AMBIENT_FINDING_MAX_CHARS`. */
  "text_too_long"
]);

export type AmbientFindingFailure = z.infer<typeof AmbientFindingFailure>;

/** What `parseAmbientFinding` answers. Never an exception. */
export type AmbientFindingParse =
  | { readonly ok: true; readonly finding: AmbientFinding }
  | { readonly ok: false; readonly reason: AmbientFindingFailure };

/**
 * One tool call into a finding, or the reason it is not one.
 *
 * Two gates in order: an unrecognized tool, then the shape. Never throws — a
 * model emitting nonsense is an ordinary outcome of asking a model for
 * something, and here it is an outcome with a *safe* default, because everything
 * this function refuses means the channel hears nothing.
 */
export function parseAmbientFinding(tool: string, args: unknown): AmbientFindingParse {
  if (tool !== AMBIENT_FINDING_TOOL) return { ok: false, reason: "unknown_tool" };

  const parsed = AmbientFindingArguments.safeParse(args);
  if (!parsed.success) return { ok: false, reason: failureOf(parsed.error) };

  return { ok: true, finding: { text: parsed.data.text } };
}

/**
 * Which of the two shape failures a failed parse was.
 *
 * `parseSkillMerge`'s `failureOf`, narrowed to one field because there is one
 * field. Pinned by its own test, which is what keeps a zod major from quietly
 * reporting every over-long finding as malformed.
 */
function failureOf(error: z.ZodError): "malformed_arguments" | "text_too_long" {
  const allTooBig = error.issues.every(issue => issue.code === "too_big");
  if (allTooBig && error.issues.every(issue => issue.path[0] === "text")) return "text_too_long";
  return "malformed_arguments";
}

const AMBIENT_FINDING_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: AMBIENT_FINDING_MAX_CHARS,
      description:
        "What to post in the channel, in full. A few sentences at most. Write it for the people in the channel, not as a report: say what you noticed and what you think should happen, and name the thread or the person if that is what makes it actionable."
    }
  },
  required: ["text"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

/**
 * The tool the heartbeat turn is offered, and the only one.
 *
 * ## This text enters a model's context on every heartbeat
 *
 * It is ours, it cannot change without a commit, and there is no tool-poisoning
 * surface — so it is bounded by review in the diff. What it has to be is
 * *accurate*, and three clauses are load-bearing because a model would otherwise
 * assume each of them the other way.
 *
 * **That calling this interrupts people.** Every other tool a model here is
 * handed reads or writes something a person asked for. This one puts a message
 * into a channel that did not ask for one, and a model that believes it is
 * filing a note will file a great many.
 *
 * **That saying nothing is the ordinary answer and costs nothing.** The turn
 * runs on a clock, so most of the time the honest answer is that nothing has
 * changed. A model asked to evaluate will evaluate, and one that believes an
 * empty answer is a failure will manufacture a finding.
 *
 * **That the channel has already been told once.** A finding is offered at most
 * once per silence — the pregate's watermark sees to it — so "nobody has replied
 * to this yet" is not a reason to raise the same thread again, and the model does
 * not need to be relied on for that.
 */
export const AMBIENT_FINDING_TOOL_DEFINITION = {
  name: AMBIENT_FINDING_TOOL,
  description:
    "Post a message into this channel, unprompted. Call this ONLY if something in the recent activity genuinely merits interrupting the people here — an unanswered question that has sat, a deadline nobody has picked up, a thread that stalled on something you can unblock. Posting is not free: the channel did not ask for this, and at most one such message is allowed per channel every few hours. If nothing merits it, call no tool and answer nothing. That is the expected outcome and it is not a failure.",
  inputSchema: AMBIENT_FINDING_SCHEMA
} as const;
