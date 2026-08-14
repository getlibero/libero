// What a summarization pass may say about one thread, and the vocabulary it
// says it in (#231).
//
// **This lives here for `memory-op.ts`'s reason exactly**, and the shape of the
// problem is the same: the offerer is `packages/agent`, which runs the turn, and
// the executor is `packages/memory`, which stores the row — and those two must
// not import each other, because the memory package is an ESLint-enforced leaf
// that both services open. The only module both ends already see is this one.
//
// ## Why a thread has a *shape* rather than a summary
//
// The obvious design asks a model for "a summary of this thread" and stores the
// paragraph it returns. That design retrieves badly, and the reason is worth
// writing down because it is not obvious until the corpus exists.
//
// Work threads do not all produce the same kind of durable content. Some reach a
// **decision**. Many more are a **question that got answered** — someone asked
// how to rotate a certificate and someone told them — which is the single most
// retrievable kind of content a channel produces, being FAQ material by
// construction. Some are an **incident**: a symptom, a cause, a fix. Some end
// **unresolved**, and the durable fact is that the question is open and what the
// positions were. And a great many produce **nothing at all** — "deploying now",
// "PR is up", six emoji.
//
// One frame forced onto all of those fails in both directions. Ask for decisions
// and a Q&A thread is either distorted into one — "the team decided that
// rotation uses `--rotate`", when nobody decided that and it is simply how the
// tool works — or falls back to a topic label that throws the answer away, and
// the answer was the entire value of the thread. Ask for a neutral account and
// every thread about deployment embeds next to every other thread about
// deployment, which is precisely the failure semantic recall exists to avoid.
//
// So the shape follows the thread. That is not a compromise between faithfulness
// and retrievability — it dissolves the tension, because a frame that matches
// what happened is both truthful and specific, and specificity is what makes one
// vector distinguishable from another.
//
// ## `nothing` writes no row, and that is the load-bearing member
//
// A pass that must always emit a summary will manufacture one for status
// chatter, and those land in the vector store as noise that dilutes every query
// whose neighbourhood they sit in. Recall quality is bounded as much by what the
// corpus does *not* contain as by what it does.
//
// `nothing` is therefore a first-class answer rather than an error or an empty
// string, and `packages/memory` writes no summary and no vector for it. It is
// also the answer for a thread whose content is real but not durable, which the
// prompt has to say out loud — a model asked to classify will otherwise reach
// for the nearest non-empty option.
//
// ## Not a tool, and not proxied
//
// Nothing here is a `BuiltinToolName` and nothing crosses the mTLS boundary, for
// `memory-op.ts`'s reasons: the turn runs in the agent process against the store
// the agent already owns, no credential is involved, and no upstream is dialled.
// What governs it is the meter on the turn that emitted it and the sheet's
// `[memory] summarize`, both deterministic; it is not an instruction to a model.

import { z } from "zod";

/**
 * What kind of durable content a thread produced.
 *
 * A closed set, and deliberately a short one. Every member has to be a shape a
 * *retrieval* would ask for differently — that is the test for admitting a sixth.
 * "Planning" and "brainstorm" were considered and rejected on it: both retrieve
 * as either a decision or an open question, so they would add a classification
 * the model can get wrong without adding anything a query can reach.
 */
export const SummaryShape = z.enum([
  /** Someone asked, someone answered. The most retrievable kind there is. */
  "question_answered",
  /** A choice was made: what was chosen, who owns it, what was ruled out. */
  "decision",
  /** Something broke and was diagnosed: symptom, cause, fix. */
  "incident",
  /** Discussed and unresolved. The durable fact is that it is still open. */
  "open_question",
  /** No durable content. Writes no summary and no vector. */
  "nothing"
]);

/**
 * The longest a summary may be.
 *
 * A constant rather than a `[memory]` field, following
 * `MEMORY_OP_MAX_TEXT_CHARS`'s rule exactly: this bounds what the *model* may
 * write, not what a channel may spend, and that class lives in constants beside
 * `MAX_TOOL_DESCRIPTION` and `READ_MAX_LIMIT`. An operator's opinion about
 * summarization is whether it runs and how quiet a thread must be first, both of
 * which are fields.
 *
 * 2048 characters, which is half a memory op and roughly a long paragraph. The
 * figure is chosen against retrieval rather than against storage: one vector
 * stands for the whole summary, so a longer summary is a vector averaged over
 * more topics, and past a point it retrieves nothing well. A thread that cannot
 * be said in 2048 characters is one that should have been segmented into several
 * summaries — see the note in `packages/memory/README.md` on the ceiling this
 * leaves.
 */
export const SUMMARY_MAX_TEXT_CHARS = 2048;

/**
 * One thread's summary, as the turn produces it and the store takes it.
 *
 * `.strict()`, for `ToolCall`'s reason: this is parsed out of model output, and
 * a field nobody declared is a field nobody bounded.
 *
 * `text` is empty exactly when `shape` is `nothing`, which is checked below
 * rather than left as a convention — the two disagreeing is how a "nothing"
 * thread ends up with a row.
 */
export const ThreadSummary = z
  .object({
    shape: SummaryShape,
    /**
     * The summary itself, in terms appropriate to the shape.
     *
     * Bounded here, on a string, before anything opens a file — which is what
     * lets the JSON Schema handed to the model state the same figure.
     */
    text: z.string().max(SUMMARY_MAX_TEXT_CHARS).default("")
  })
  .strict()
  .check(ctx => {
    const { shape, text } = ctx.value;
    if (shape === "nothing" && text.trim() !== "") {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["text"],
        message: "a thread with nothing durable carries no text"
      });
    }
    if (shape !== "nothing" && text.trim() === "") {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        path: ["text"],
        // The failure this catches is a model answering with a shape and no
        // content, which would otherwise store an empty summary and embed it —
        // a vector standing for nothing, retrieved against everything.
        message: `a ${shape} summary must say what it was`
      });
    }
  });

export type SummaryShape = z.infer<typeof SummaryShape>;
export type ThreadSummary = z.infer<typeof ThreadSummary>;
