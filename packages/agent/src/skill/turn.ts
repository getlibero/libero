// The skill-author turn: one extra model call after a tool-heavy task has
// replied, with the two skill operations and nothing else (#291).
//
// Layer 3's write half, and `curation/turn.ts`'s third sibling. That file's whole
// shape applies here unchanged and is not restated: one call rather than a second
// loop, no tool-result round trip, no reachable proxied tool, nothing in this
// package that writes a file, spend reported through `onTurn` before any
// operation runs, and a provider failure that propagates because this file has no
// logger and should not gain one.
//
// What follows is only what differs from curation.
//
// ## Most tasks must produce nothing, and this one is triggered by a count
//
// Curation runs after every task. This runs only after a task whose *served*
// tool calls exceeded `[skills] author_after_tool_calls`, and the caller applies
// that test — the threshold is a channel's policy and this package cannot read a
// team sheet. Below the line the task was a question with a lookup, and a
// playbook for that is a playbook for reading.
//
// Declining is still the ordinary outcome above the line, and there is
// deliberately no `skill_none` to say so with: `skill-op.ts` argues that a thread
// summary needs a first-class `nothing` because a row records that the thread was
// *assessed* and without it the sweep re-pays forever, whereas nothing
// re-triggers this turn — it fires once, after a task — so absence is the
// decline and a member for it would be a row nothing reads.
//
// ## What the model sees of the task is not what curation sees
//
// `curationTranscript` strips tool traffic on the argument that a durable fact
// reaches the reply. **That argument inverts here.** `SKILL_TOOLS` asks a body
// for "a sequence of tool calls that worked, in an order that matters, with the
// parts that are easy to get wrong" — which is precisely the traffic curation
// throws away. So this turn gets `skillTranscript`, and the rule it applies is
// on that function.
//
// ## The neighbours are handed in, not looked up
//
// `nearby` is what retrieval already loaded at the head of this task (#292), so
// the turn sees its nearest existing skills without a second search, a second
// embedding, or a store this package must not know about. That is what makes
// `skill_revise` usable at all: a revision replaces a body whole, and a model
// that cannot see the body it is replacing can only overwrite it blind.
//
// It is advisory and nothing more. Whether the model extends one, writes a new
// one, or declines is its own; what stops a near-copy landing is `name_taken`
// from the store, and what stops a runaway is the caps and the meter.

import { SKILL_TOOLS, SkillToolName, parseSkillOp, resultText, skillOpMessage } from "@getlibero/schema";
import type { SkillOp, SkillOpResult } from "@getlibero/schema";
import type {
  CompletionClient,
  CompletionMessage,
  TokenUsage,
  ToolDefinition
} from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";

/**
 * The most characters one rendered tool call may contribute, per side.
 *
 * Applied to an operation's arguments and to a failed call's text alike, and it
 * is this package's rather than a channel's for `MAX_TOOL_ERROR_CHARS`' reason:
 * it exists so one enormous argument object cannot spend the whole turn's input
 * on a single step, which is this package declining to relay unbounded data
 * rather than a policy a channel should be able to raise.
 */
export const SKILL_STEP_MAX_CHARS = 512;

/** Marks where a rendered step was cut, so the model does not read a value that stops. */
const TRUNCATED = "… [truncated]";

/**
 * Runs one skill operation and answers what it did.
 *
 * The composition root wires this to `openSkillFiles` in `@getlibero/memory`,
 * exactly as `MemoryOpHandler` is wired to `openMemoryFile`. It may throw for
 * that type's reason — a directory whose disk is full is an operator's problem
 * rather than a model's — and a throw abandons the remaining operations of this
 * turn, which is right because the second write would fail the same way.
 */
export type SkillOpHandler = (op: SkillOp) => SkillOpResult | Promise<SkillOpResult>;

/**
 * An existing skill, as much of it as this turn shows the model.
 *
 * **Structural, and deliberately not `SkillFile`.** That shape carries `created`
 * and `status`, and neither is the model's: the operations have no field for
 * either, a revision carries both forward from the file it replaces, and showing
 * a date the model cannot set is an invitation to try. This is the same
 * narrowing `HistorySource` makes on `MessageStore` in the server's context
 * assembler — name what is needed, so what is not cannot be reached.
 *
 * It also happens to be exactly what retrieval already resolved (#292), so the
 * caller passes what it has rather than rebuilding a file shape it discarded.
 */
export interface NearbySkill {
  /** The filename stem, which is the skill's identity and what a revision names. */
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** What one operation the model asked for turned out to do. */
export interface SkillOpOutcome {
  /** The tool name as the model spelled it, which is not always one of ours. */
  readonly tool: string;
  readonly result: SkillOpResult;
  /** The sentence `skillOpMessage` gives for `result`, for the caller's log. */
  readonly message: string;
}

export interface SkillAuthorTurnResult {
  /** Every operation the model asked for, in the order it asked. */
  readonly ops: readonly SkillOpOutcome[];
  readonly usage: TokenUsage;
  /** The model that served the turn, when the provider echoed one. */
  readonly model?: string;
}

export interface SkillAuthorTurnOptions {
  /**
   * The standing region, when this channel has one (#450).
   *
   * The operator's own text — `[channel] description` and the `load = "always"`
   * shared skills — already composed and already bounded by `apps/server`, with
   * this turn's own prompt as its base. Absent leaves the prompt below exactly
   * as it is, which is every deployment that publishes no shared skill and every
   * channel whose sheet describes itself in no words.
   *
   * **It replaces rather than extends**, because the caller composed the base
   * from the constant this module exports: one composition in one place, rather
   * than a framing sentence written here and again there. The only caller is
   * `apps/server`, and what it may put here is the operator's text — never a
   * model's, which is what keeps a published playbook distinguishable from an
   * instruction this build wrote.
   */
  system?: string;
  completion: CompletionClient;
  /** Model id, passed through verbatim, as the loop passes one. */
  model: string;
  /**
   * The finished task's transcript. Rendered by `skillTranscript` before the
   * model sees it — this is not mutated.
   */
  messages: readonly CompletionMessage[];
  /**
   * The skills this task opened with, from retrieval at its head (#292).
   *
   * Advisory: shown in full so the turn can extend one rather than write a
   * near-copy, and so a `skill_revise` is a revision rather than a blind
   * overwrite. Empty is ordinary — a channel with no skills yet, or a task whose
   * question matched none.
   */
  nearby: readonly NearbySkill[];
  /**
   * How many skills the channel holds now, and its `[skills] max_skills`.
   *
   * Neither is enforced here — the store enforces both, which is the only place
   * they can be enforced against the directory that actually exists. They are
   * passed so the prompt can say how much room is left, which is what lets a
   * model revise rather than create when a library is full, instead of being
   * refused after the fact.
   */
  skills: number;
  maxSkills: number;
  /** Executes one operation. See `SkillOpHandler`. */
  applyOp: SkillOpHandler;
  /**
   * Ceiling on this turn's output, from `[llm] max_tokens_per_turn`.
   *
   * **`max_tokens_per_task` deliberately does not apply**, for the reason
   * `CurationTurnOptions.maxTokens` gives and one of this turn's own: it runs
   * after the reply has posted, so the task is over — and here the task most
   * worth writing a playbook about is exactly the long tool-heavy one most
   * likely to have spent its cap.
   */
  maxTokens: number;
  /**
   * Which turn of the task this is. The caller keeps one counter across every
   * post-reply turn, so `<task>.<n>` stays gapless whichever of them ran.
   */
  turn: number;
  signal?: AbortSignal;
  /**
   * What this turn cost, reported before any operation runs.
   *
   * `AgentTaskOptions.onTurn`'s contract, and the ordering matters for its
   * reason: a turn that is paid for is counted even if what it asked for fails.
   */
  onTurn?: (turn: CompletedTurn) => void | Promise<void>;
}

/**
 * The two skill operations, in the shape a provider is handed.
 *
 * Built from `SKILL_TOOLS` rather than restated, so the description a model
 * reads here is the one `@getlibero/schema` publishes and there is no second
 * copy to drift — `memoryToolDefinitions`' rule exactly.
 */
export function skillToolDefinitions(): ToolDefinition[] {
  return SkillToolName.options.map(name => ({
    name,
    description: SKILL_TOOLS[name].description,
    inputSchema: SKILL_TOOLS[name].inputSchema
  }));
}

/** One value cut to `SKILL_STEP_MAX_CHARS`, marked where it was cut. */
function clip(text: string): string {
  return text.length <= SKILL_STEP_MAX_CHARS
    ? text
    : `${text.slice(0, SKILL_STEP_MAX_CHARS)}${TRUNCATED}`;
}

/**
 * What the task did, rendered as prose the model can read.
 *
 * **The opposite of `curationTranscript`, and deliberately so.** That function
 * drops tool traffic because a durable fact reaches the reply; a playbook *is*
 * the tool traffic, so dropping it would leave this turn writing a playbook out
 * of the assistant's own summary of one.
 *
 * ## Rendered rather than replayed
 *
 * The structured form cannot be kept even in principle: `curationTranscript`'s
 * header records that a tool-use block with no matching result is not a
 * conversation a provider will accept, so keeping calls means keeping results.
 * And `providerState` is opaque replay state belonging to the conversation that
 * produced it, which this is not. So each assistant turn becomes one assistant
 * message: its own words, then a line per call it made.
 *
 * ## A success is procedure; a failure is a warning
 *
 * A successful call contributes its name and its arguments and **not its
 * result**. Two reasons, and the second is the one that decided it. A tool
 * result is the largest thing in a transcript and the only part an upstream
 * wrote, and this turn is the first that writes text into later tasks — so
 * carrying less of it is worth something, though it is a narrowing and not a
 * boundary, since the assistant's own prose relays result content anyway and the
 * only thing that actually contains a poisoned skill is the proxy's gates
 * (#293). The deciding reason is plainer: a JSON response cut at 512 characters
 * ends mid-object and teaches nothing, where a failure — a refusal sentence, a
 * 404, an expired credential — is short, complete, and exactly what `SKILL_TOOLS`
 * means by "the parts that are easy to get wrong".
 *
 * A refusal arrives here as an ordinary `isError` result, which is the reading
 * this turn wants: it is how the model learns this channel was not granted that
 * tool, so it does not write a playbook about one that does not work here.
 *
 * Exported for its own test. It is a pure function of the transcript.
 */
export function skillTranscript(messages: readonly CompletionMessage[]): CompletionMessage[] {
  // Results are needed while rendering the assistant turn that called them, and
  // they arrive after it, so one pass collects them by call id first.
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    results.set(message.toolCallId, {
      // Flattened here, deliberately. This turn asks a model to write a
      // playbook about how to call tools, and a screenshot is not a fact about
      // how to call one — the rendering below already reduces a success to
      // `ok` and clips a failure. `resultText` is the one flatten, so the
      // sentence a skill author sees for an omitted payload is the sentence the
      // model saw when it read the result.
      content: resultText(message.content),
      isError: message.isError === true
    });
  }

  const kept: CompletionMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "user") {
      kept.push(message);
      continue;
    }

    const lines: string[] = [];
    if (message.content !== "") lines.push(message.content);

    for (const call of message.toolCalls ?? []) {
      const result = results.get(call.id);
      const rendered = `called ${call.name}(${clip(JSON.stringify(call.arguments))})`;
      if (result === undefined) {
        // A call the loop never answered. It cannot happen through
        // `runAgentTask`, whose transcript is well-formed by construction even
        // where a cap stopped the batch — but this takes a transcript rather
        // than a result, and inventing an outcome for a call whose fate is
        // unknown is the one thing it must not do.
        lines.push(`${rendered} → outcome unknown`);
      } else if (result.isError) {
        lines.push(`${rendered} → failed: ${clip(result.content)}`);
      } else {
        lines.push(`${rendered} → ok`);
      }
    }

    // An assistant turn that said nothing and called nothing contributes
    // nothing: an empty message is one providers reject.
    if (lines.length > 0) kept.push({ role: "assistant", content: lines.join("\n") });
  }

  return kept;
}

/**
 * What the model is told it is doing.
 *
 * Part of the deliverable rather than an implementation detail, and worded for
 * the failure modes this store actually has. Three clauses are load-bearing
 * beyond the obvious: **most tasks produce no playbook**, because a model asked
 * to write one will find something to say about every task and a library is
 * bounded as much by what it keeps out as by what it holds; **extend an existing
 * skill rather than writing a near-copy**, because a second name for one subject
 * is the failure two operations exist to prevent and the cheaper move is always
 * to write fresh; and **a revision replaces the body whole**, because a model
 * that sends only its addition silently deletes the rest.
 *
 * None of it is a mitigation. The two operations, the two caps, the library
 * ceiling and the meter hold whatever the model does with these words.
 */
export const SKILL_AUTHOR_SYSTEM_PROMPT = [
  "You are deciding whether the task that just finished left behind a reusable playbook",
  "for one Slack channel. The assistant has already replied to the person who asked.",
  "Nobody sees this step and nothing you write here is posted to the channel.",
  "",
  "A skill is a playbook: how a kind of work is done here, in the order it has to be done,",
  "with the commands and the parts that are easy to get wrong. It is not a record of what",
  "happened in this particular task, not a fact about the team — those belong in MEMORY.md",
  "— and not a summary of the conversation.",
  "",
  "Write one only if somebody doing this same kind of work next month would move faster for",
  "having read it. Most tasks produce nothing worth writing down, and doing nothing is the",
  "right outcome for those — call no tool at all.",
  "",
  "If one of the existing skills below already covers this subject, extend that one with",
  "skill_revise rather than writing a second skill under another name. A revision replaces",
  "the description and the body outright, so restate everything worth keeping, not only",
  "what you are adding. Use skill_create only for a subject none of them covers.",
  "",
  "A tool call that was refused or failed tells you what this channel cannot do. Do not",
  "write a playbook around a tool that did not work here."
].join("\n");

/**
 * Run the skill-author turn.
 *
 * Rejects when the provider does, for `runCurationTurn`'s reason: this file has
 * no logger, and swallowing it would make a broken provider look like a channel
 * that never learns anything. The caller catches, because the reply has already
 * posted and an authoring failure must not reach it.
 */
export async function runSkillAuthorTurn(
  options: SkillAuthorTurnOptions
): Promise<SkillAuthorTurnResult> {
  const response = await options.completion.complete({
    model: options.model,
    system: options.system ?? SKILL_AUTHOR_SYSTEM_PROMPT,
    messages: [...skillTranscript(options.messages), currentLibrary(options)],
    tools: skillToolDefinitions(),
    maxTokens: options.maxTokens,
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  });

  // Before the operations run, which is the loop's ordering: a turn that was
  // paid for is counted even if what it asked for then fails.
  await options.onTurn?.({
    usage: response.usage,
    turn: options.turn,
    ...(response.model === undefined ? {} : { model: response.model }),
    ...(response.costNanoUsd === undefined ? {} : { costNanoUsd: response.costNanoUsd })
  });

  const ops: SkillOpOutcome[] = [];

  for (const call of response.toolCalls) {
    const parsed = parseSkillOp(call.name, call.arguments);
    // A name that is not one of the two never reaches `applyOp`, and there is
    // nothing else here it could reach. That is the whole of "this turn cannot
    // invoke a proxied tool".
    const result: SkillOpResult = parsed.ok
      ? await options.applyOp(parsed.op)
      : { outcome: "failed", reason: parsed.reason };

    ops.push({ tool: call.name, result, message: skillOpMessage(result) });
  }

  return {
    ops,
    usage: response.usage,
    ...(response.model === undefined ? {} : { model: response.model })
  };
}

/**
 * The last message: the skills this task had in hand, and how much room is left.
 *
 * A user message rather than part of the system prompt, for `currentMemory`'s
 * reason — it changes on every call, and a system prompt that changes every call
 * is one no provider can cache. It is also the thing the model is being asked to
 * act on, which is where the turn's question belongs.
 *
 * The neighbours are rendered **in full**, description and body. A list of names
 * would be cheaper and would be worse than useless: it would tell the model which
 * names exist without telling it what they say, which is exactly enough to make a
 * `skill_revise` that overwrites a playbook it never read.
 */
function currentLibrary(options: SkillAuthorTurnOptions): CompletionMessage {
  const nearby =
    options.nearby.length === 0
      ? ["This channel has no skills on this subject yet."]
      : [
          "Skills this channel already holds that bear on this task, in full:",
          "",
          ...options.nearby.map(skill =>
            [`## ${skill.name}`, skill.description, "", skill.body].join("\n")
          )
        ];

  return {
    role: "user",
    content: [
      ...nearby,
      "",
      `This channel holds ${String(options.skills)} skills and may hold ${String(options.maxSkills)}.`,
      "",
      "Write or extend a skill if this task left behind a reusable playbook.",
      "Call no tool if it did not."
    ].join("\n")
  };
}
