// The summarization turn: one model call over one thread that has gone quiet,
// producing the second corpus semantic recall reads (#231).
//
// `curation/turn.ts`'s sibling, and deliberately built to its shape — one call,
// no loop, no reachable proxied tool, spend reported through the same `onTurn`.
// Three things about it are different, and each is the reason it exists rather
// than being folded into curation.
//
// ## It is not triggered by a person
//
// Curation runs after a reply, so a task already happened and somebody was
// waiting for it. This runs when a thread has been quiet for a while, in a
// channel whose members may never have addressed the agent at all. That is the
// first model spend in the deployment that does not follow a mention, and
// `[memory] summarize` in the team sheet is where a channel says no to it.
//
// The alternative — summarizing only threads the agent took part in — was
// rejected on recall quality rather than on cost. It makes the corpus the
// agent's own history instead of the channel's conversation, and "what did we
// decide about X" is overwhelmingly a question about a decision the team reached
// without the bot in the room.
//
// ## Quiet is a correctness condition, not politeness
//
// A summary written mid-conversation is not merely premature, it is wrong in a
// way that survives: it records that the team was weighing X against Y, gets
// embedded, and is then retrieved by exactly the question it is worst at
// answering, because they went on to settle it. The thread being idle is what
// makes the summary a summary of a *conclusion*. `[memory]
// summarize_after_idle_minutes` is the operator's control over that, and the
// caller — not this turn — decides a thread is quiet.
//
// ## The shape follows the thread
//
// The obvious design asks for "a summary" and stores the paragraph. It retrieves
// badly, because work threads do not all produce the same kind of durable thing:
// some reach a decision, many more are a question that got answered, some are an
// incident, some end unresolved, and a great many produce nothing at all. One
// frame forced onto all of them either distorts the Q&A threads into decisions
// nobody made or flattens everything into topic labels that embed on top of each
// other. `SummaryShape` in `@getlibero/schema` is the vocabulary, and the whole
// argument for it lives there.
//
// **`nothing` is the load-bearing member.** A pass that must always produce a
// summary will manufacture one for "deploying now", and that vector then sits in
// the neighbourhood of every deployment question, diluting all of them. Recall
// quality is bounded as much by what the corpus keeps out as by what it holds.
//
// ## What governs it is not the prompt
//
// `SUMMARIZATION_SYSTEM_PROMPT` asks for faithfulness and for `nothing` when
// there is nothing. A model that ignores every word of it is still bounded:
// there is exactly one tool and it writes no file, `ThreadSummary` refuses text
// past `SUMMARY_MAX_TEXT_CHARS` and refuses a shape with no content, the caller
// decides whether a row is written, and the turn's tokens reach the proxy's
// meter through the same per-turn report every other turn uses.

import { SUMMARY_MAX_TEXT_CHARS, SummaryShape, ThreadSummary } from "@getlibero/schema";
import type { CompletionClient, TokenUsage, ToolDefinition } from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";

/**
 * One message of the thread, as this turn needs it.
 *
 * **Not `StoredMessage` from `@getlibero/memory`.** This package depends on
 * `@getlibero/schema` and nothing else, and that is not incidental — it is what
 * keeps the package whose job is talking to a model free of a state root, a file
 * handle and a SQLite dependency. The caller maps its rows onto this.
 *
 * `author` is a display name where one was captured and an id otherwise. Which
 * it is does not matter here: what it is for is letting the model tell speakers
 * apart, so that "who owns it" has an answer.
 */
export interface SummarizationMessage {
  readonly author: string;
  readonly text: string;
}

export interface SummarizationTurnResult {
  /**
   * What the thread produced. `shape: "nothing"` with empty text when there was
   * nothing durable — which is the ordinary answer for most threads.
   */
  readonly summary: ThreadSummary;
  /**
   * Set when the model's answer could not be used, and the summary above is the
   * `nothing` this turn fell back to.
   *
   * A separate field rather than a third outcome, because the caller does two
   * different things with it: it records the row either way — a thread whose
   * content produced garbage once will produce it again, and re-sweeping it
   * forever is the runaway this design is most exposed to — and it logs *this*,
   * so "the channel has quiet threads" and "the model cannot follow the schema"
   * are not the same line in an operator's log.
   *
   * A provider that throws is the other case entirely and is not this: that
   * propagates, the caller writes no row, and the thread is swept again later.
   */
  readonly malformed?: string;
  readonly usage: TokenUsage;
  /** The model that served the turn, when the provider echoed one. */
  readonly model?: string;
}

export interface SummarizationTurnOptions {
  completion: CompletionClient;
  /** Model id, passed through verbatim, as the loop passes one. */
  model: string;
  /**
   * The thread, oldest first — the root and its replies, as `recentInThread`
   * returns them.
   */
  messages: readonly SummarizationMessage[];
  /**
   * Ceiling on this turn's output, from `[llm] max_tokens_per_turn`.
   *
   * `max_tokens_per_task` does not apply for `runCurationTurn`'s reason and one
   * more of its own: there is no task here at all. This turn belongs to a
   * thread, not to a request, and there may have been no request.
   */
  maxTokens: number;
  /**
   * The turn id's ordinal. Unlike curation's, this does not continue a task's
   * count — see the caller, which mints an id for a turn no task owns.
   */
  turn: number;
  signal?: AbortSignal;
  /**
   * What this turn cost.
   *
   * **Not optional, unlike curation's.** This turn can be started by other
   * people's conversation, so a deployment that forgot to wire the meter would
   * be one where a channel's quiet threads spend unmetered tokens. Requiring it
   * makes that a type error rather than a discovery.
   */
  onTurn: (turn: CompletedTurn) => void | Promise<void>;
}

/** The name the model calls. Module-private: nothing outside offers this tool. */
const RECORD_TOOL = "record_thread_summary";

/**
 * The one tool this turn offers, and it writes nothing.
 *
 * A tool rather than asking for JSON in prose, because a provider's tool path is
 * schema-validated on its side before it reaches ours, and this turn's whole
 * output is one small structured object. It is the structured-output idiom
 * rather than a capability: calling it hands us a value and reaches nothing.
 *
 * **The definition lives here and not in `@getlibero/schema`**, which is where
 * `MEMORY_TOOLS` lives, and the difference is who needs it. A memory op crosses
 * from `packages/agent` to `packages/memory`, two packages that cannot import
 * each other, so its description and JSON Schema have to sit in the one they
 * share. Nothing outside this module ever offers this tool. What does cross is
 * the *result* — `ThreadSummary` — and that is in schema, where the store can
 * see it.
 */
function summaryToolDefinition(): ToolDefinition {
  return {
    name: RECORD_TOOL,
    description:
      "Record what this thread produced. Call exactly once. Use shape 'nothing' when the " +
      "thread holds nothing a colleague would want to find later.",
    inputSchema: {
      type: "object",
      properties: {
        shape: {
          type: "string",
          enum: [...SummaryShape.options],
          description:
            "question_answered: someone asked and someone answered. decision: a choice was " +
            "made. incident: something broke and was diagnosed. open_question: discussed and " +
            "unresolved. nothing: no durable content."
        },
        text: {
          type: "string",
          maxLength: SUMMARY_MAX_TEXT_CHARS,
          description:
            "The summary, in terms matching the shape. Empty string when shape is 'nothing'."
        }
      },
      required: ["shape", "text"],
      additionalProperties: false
    }
  };
}

/**
 * What the model is told it is doing.
 *
 * Part of the deliverable rather than an implementation detail, and worded
 * against the failure modes this corpus actually has. Four clauses are
 * load-bearing.
 *
 * **"Most threads produce nothing"** is stated first and stated plainly, because
 * a model asked to classify will otherwise reach for the nearest non-empty
 * option, and every one it reaches for is a vector diluting the corpus.
 *
 * **"Do not describe the discussion, record what a colleague would need"** is
 * what separates a summary that retrieves from one that does not. "The team
 * discussed deployment" embeds next to every other thread about deployment.
 *
 * **"Never write that something was decided unless the thread says so"** is the
 * specific hazard of asking for shapes: a model handed a `decision` option will
 * find a decision. A summary is not editable by the team the way `MEMORY.md` is,
 * so an invented conclusion has no correction path.
 *
 * **"Write it so it can be found by someone who does not know the words used
 * here"** is the retrieval instruction, and it is why the prompt asks for the
 * question in a Q&A thread to be written out: a query is far more likely to
 * resemble the question than the answer.
 *
 * None of it is a mitigation. See the header.
 */
/**
 * **No standing region either, and for the simpler half of the reason** (#450).
 *
 * `CURATION_SYSTEM_PROMPT`'s note holds, and this turn does not even need the
 * argument about scales: its output is read back by retrieval rather than by
 * anybody. A summary has a shape this file fixes, nothing renders it to a
 * person, and operator standing text about how the agent should sound has no
 * addressee here at all.
 */
export const SUMMARIZATION_SYSTEM_PROMPT = [
  "You are recording what one Slack thread produced, for a searchable team memory. Nobody",
  "sees this step and nothing you write is posted to the channel.",
  "",
  "Most threads produce nothing worth recording. Status updates, acknowledgements, small",
  "talk, coordination that is over — all of these are shape 'nothing' with empty text, and",
  "that is the most common correct answer. Do not look for something to say.",
  "",
  "When a thread does hold something durable, record what a colleague who was not there",
  "would need, not a description of the discussion. Name the specifics: the actual answer,",
  "the actual decision, the person who owns it, the version or the command or the file.",
  "A summary that says the team discussed deployment is worth nothing to somebody searching",
  "for how deployment works.",
  "",
  "Match the shape to what actually happened:",
  "- question_answered: write the question and the answer. Write the question out in full,",
  "  in the words someone would search for, even if it was asked in shorthand.",
  "- decision: what was chosen, who owns it, and what was rejected if that was discussed.",
  "- incident: the symptom, the cause, and the fix.",
  "- open_question: what is unresolved and what the positions were. Do not invent a",
  "  conclusion for a thread that did not reach one.",
  "",
  "Never write that something was decided, agreed, or resolved unless the thread says so.",
  "A thread where someone explained how a tool already works is question_answered, not a",
  "decision — nobody decided it. Getting this wrong puts a false claim into the team's",
  "memory, and unlike a note the team can edit, nobody will see this to correct it.",
  "",
  "Write plainly and in full sentences, and keep it short enough to read at a glance."
].join("\n");

/**
 * The thread, as the model reads it.
 *
 * Speaker-prefixed lines rather than a chat transcript with roles, because none
 * of these messages is the assistant's turn and pretending otherwise would put
 * the model in a conversation it is being asked to observe. One user message,
 * which is also what makes the system prompt cacheable across every thread in
 * the deployment.
 */
function threadMessage(messages: readonly SummarizationMessage[]): string {
  return [
    "Here is the thread, oldest message first.",
    "",
    ...messages.map(message => `${message.author}: ${message.text}`),
    "",
    `Call ${RECORD_TOOL} exactly once.`
  ].join("\n");
}

/** The fallback, and the only value this module invents. */
const NOTHING: ThreadSummary = { shape: "nothing", text: "" };

/**
 * Run the summarization turn.
 *
 * Rejects when the provider does, for `runCurationTurn`'s reason: this file has
 * no logger, and swallowing here would make a broken provider indistinguishable
 * from a channel whose threads are all small talk. The caller catches — nothing
 * is waiting on this, and a failure must not reach a person.
 */
export async function runSummarizationTurn(
  options: SummarizationTurnOptions
): Promise<SummarizationTurnResult> {
  // An empty thread is answered without a call. Nothing upstream should ask, but
  // a thread whose every message was deleted between the sweep and the read is a
  // real race, and paying a model call to be told about no messages is not the
  // way to find out.
  if (options.messages.length === 0) {
    return { summary: NOTHING, malformed: "the thread had no messages", usage: emptyUsage() };
  }

  const response = await options.completion.complete({
    model: options.model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: threadMessage(options.messages) }],
    tools: [summaryToolDefinition()],
    maxTokens: options.maxTokens,
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  });

  // Before the summary is read, which is the loop's ordering and curation's: a
  // turn that was paid for is counted even if what it produced is unusable.
  await options.onTurn({
    usage: response.usage,
    turn: options.turn,
    ...(response.model === undefined ? {} : { model: response.model })
  });

  const usage = {
    usage: response.usage,
    ...(response.model === undefined ? {} : { model: response.model })
  };

  // The first call by this name, and any other name is ignored rather than
  // refused — there is no executor here that a second tool could reach, so an
  // invented name is a model talking to itself.
  const call = response.toolCalls.find(candidate => candidate.name === RECORD_TOOL);
  if (call === undefined) {
    return { summary: NOTHING, malformed: "the model recorded no summary", ...usage };
  }

  const parsed = ThreadSummary.safeParse(call.arguments);
  if (!parsed.success) {
    // The message and not the issues: this reaches a log line, and the argument
    // that failed is a channel's conversation restated by a model.
    return {
      summary: NOTHING,
      malformed: `the recorded summary did not fit the schema: ${firstIssue(parsed.error)}`,
      ...usage
    };
  }

  return { summary: parsed.data, ...usage };
}

/** The first issue's path and message, with nothing of the value in it. */
function firstIssue(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (issue === undefined) return "no reason given";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** Zero, for the one path that returns before a provider is called. */
function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}
