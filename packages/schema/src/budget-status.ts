// Whether a channel can afford to be spent for, asked before spending (#335).
//
// The answer to `GET /v1/budget`, and the thing that lets a background turn
// decline. The tool proxy service enforces `[budget]` on a tool call, which is
// the only spend it ever sees: a model completion does not pass through it, so a
// turn that calls no tool meets no gate at all. This shape is how such a turn
// asks anyway.
//
// ## It is addressed to a process, and `BudgetWarning` is addressed to people
//
// The obvious question is why this carries no `spent`/`cap` pair when
// ./budget-warning.ts carries exactly that, over an argument — *"'you are near
// your limit' without a number is a sentence nobody can act on"* — which looks
// like it should apply here too.
//
// It does not, and the distinguishing question is who the message is for. A
// `BudgetWarning` goes to the members of a channel, who need a figure because
// what they do with it is decide whether to raise a cap. This goes to a process
// deciding whether to make one more call, and the only thing it does with the
// answer is make the call or not. Handing it figures would invite it to do
// arithmetic the proxy has already done — which is how a second definition of
// "is this channel over" arrives, and the whole point of this route is that
// there is exactly one.
//
// ## `refusalMessage` is not this surface's wording layer
//
// `ToolRefusal` is reused rather than restated — a second enum would be the
// duplication the repository's rules warn about, and every reason here is one
// the tool gate already words. But only the *shape* is reused. Every sentence
// `refusalMessage` produces is written for a call that was attempted: "The call
// was not made", "no tool call is permitted", "No further calls run until the
// budget resets". None of that is true of a summarization turn that asked
// whether to start.
//
// So a consumer wanting a log line writes its own, or logs the reason code. Do
// not reach for `refusalMessage` here.
//
// ## The shape is not narrowed to the reasons this route can produce
//
// A budget read answers a strict subset — the two sheet reasons, the three
// budget and pricing ones — and never `credential_unresolved` or an approval
// member. The union is left whole anyway: narrowing it would restate members
// that already exist one file away, and what constrains the answer is the
// function that computes it rather than the schema that carries it. A consumer
// reduces this to "may I spend" and reads no further.

import { z } from "zod";
import { ToolRefusal } from "./refusal.js";

/**
 * What the meter says about spending in this channel right now.
 *
 * A discriminated union rather than a nullable `refusal`, matching
 * `ToolCallResponse` and the proxy's own `SheetState` and `Decision`. The two
 * are isomorphic and the difference is what they read as: this is a *status* a
 * caller asked for, where `{ refusal: null }` reads as the proxy having refused
 * something, which is exactly the over-claim this route has to avoid — nothing
 * was attempted and nothing was denied.
 *
 * **A read can be stale by the calls in flight beside it**, and that is
 * tolerable here in a way it would not be for a gate: the caller is deciding
 * whether to start optional work, so overshooting by one background turn is the
 * same overshoot two concurrent tool calls already permit.
 */
export const BudgetStatus = z.discriminatedUnion("spendable", [
  z.object({ spendable: z.literal(true) }).strict(),
  z
    .object({
      spendable: z.literal(false),
      /**
       * Why not, in the vocabulary the tool gate already answers in.
       *
       * The same reason code an operator would see in the audit log for a call
       * refused at the same moment, which is what makes "the read and the gate
       * agree" a thing a test can assert rather than a thing to hope for.
       */
      refusal: ToolRefusal
    })
    .strict()
]);

export type BudgetStatus = z.infer<typeof BudgetStatus>;
