// The curation turn: one extra model call after a task's reply has posted, with
// the two memory tools and nothing else.
//
// Layer 2's inner loop, and the pattern is the one the architecture credits to
// Letta. A task answers a question; this turn decides whether anything about it
// was worth keeping, and writes it into the channel's `MEMORY.md`.
//
// ## One call, and the shape is what bounds it
//
// Not a second `runAgentTask`. There is no loop here, no tool-result round trip,
// and no way to reach a proxied tool: the only definitions offered are
// `MEMORY_TOOLS`, and a name that is not one of the two is answered
// `unknown_tool` by `parseMemoryOp` and dispatched nowhere. A model that emits
// `search_channel_history` in this turn does not call it — there is no executor
// here that could.
//
// **The governance is not the instructions.** `CURATION_SYSTEM_PROMPT` below
// asks for durable team facts, and a model that ignores it is still bounded: the
// tool set is two, `MEMORY_OP_MAX_TEXT_CHARS` bounds one operation,
// `[memory] max_file_chars` bounds the file, and the turn's tokens reach the
// proxy's meter through the same per-turn report every other turn uses.
//
// ## Nothing here writes a file
//
// The operations are handed to `applyOp`, which the composition root fills. That
// is the contract every other side effect in this package already has —
// `onTurn`, `ToolSource`, `ToolExecutor`, `HeldCallPrompter` — and it is why
// `packages/agent` still depends on `@getlibero/schema` and nothing else. The
// loop has never known what is on the other end of a side effect, and a memory
// write is not the thing to change that for: it would put a state root, a path,
// and a file handle into the package whose entire job is talking to a model.
//
// ## The model is not told what its operations did
//
// `applyOp` answers a `MemoryOpResult` and this turn collects them, but nothing
// is fed back — there is no second call for the model to read them in. That is
// deliberate rather than an omission, and the reasoning is worth stating because
// `memoryOpMessage` reads like it is addressed to a model.
//
// What a failed operation needs is not a retry, it is not to have happened: the
// model is holding the file's current contents when it writes a `find`, so a
// `find_not_found` is a model that ignored what was in front of it rather than
// one that lacked information. The same goes for the cap — the prompt carries
// how large the file is and what it may reach, so compaction is something the
// model can choose before it is refused rather than after. What is left over is
// carried to the *next* task: `MEMORY.md` is in that turn's context too, so a
// failure corrects itself one task later against the real file. Results go to
// the caller's log, which is where an operator reads them.
//
// ## What the model sees of the task
//
// The transcript with its tool traffic removed — see `curationTranscript`. A
// durable fact usually reaches the reply; the whole of a twenty-five-call tool
// conversation costs a great deal to re-send in order to record one sentence.

import { MEMORY_TOOLS, MemoryToolName, memoryOpMessage, parseMemoryOp } from "@getlibero/schema";
import type { MemoryOp, MemoryOpResult } from "@getlibero/schema";
import type {
  CompletionClient,
  CompletionMessage,
  TokenUsage,
  ToolDefinition
} from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";

/**
 * Runs one memory operation and answers what it did.
 *
 * The composition root wires this to `openMemoryFile` in `@getlibero/memory`.
 * It may throw — a store whose disk is full or whose file cannot be read is an
 * operator's problem rather than a model's, and that is the memory package's
 * stated split. A throw abandons the remaining operations of this turn, which is
 * the right outcome: the second write would fail the same way.
 */
export type MemoryOpHandler = (op: MemoryOp) => MemoryOpResult | Promise<MemoryOpResult>;

/** What one operation the model asked for turned out to do. */
export interface CurationOpOutcome {
  /** The tool name as the model spelled it, which is not always one of ours. */
  readonly tool: string;
  readonly result: MemoryOpResult;
  /** The sentence `memoryOpMessage` gives for `result`, for the caller's log. */
  readonly message: string;
}

export interface CurationTurnResult {
  /** Every operation the model asked for, in the order it asked. */
  readonly ops: readonly CurationOpOutcome[];
  readonly usage: TokenUsage;
  /** The model that served the turn, when the provider echoed one. */
  readonly model?: string;
}

export interface CurationTurnOptions {
  completion: CompletionClient;
  /** Model id, passed through verbatim, as the loop passes one. */
  model: string;
  /**
   * The finished task's transcript. Tool traffic is stripped before the model
   * sees it — this is not mutated.
   */
  messages: readonly CompletionMessage[];
  /** The channel's `MEMORY.md` as it is now. `""` when there is none yet. */
  memory: string;
  /**
   * The channel's `[memory] max_file_chars`.
   *
   * Not enforced here — the store enforces it, which is the only place it can be
   * enforced against the file that actually exists. It is passed so the prompt
   * can tell the model how much room it has, which is what lets a model compact
   * before it is refused rather than after.
   */
  maxFileChars: number;
  /** Executes one operation. See `MemoryOpHandler`. */
  applyOp: MemoryOpHandler;
  /**
   * Ceiling on this turn's output, from `[llm] max_tokens_per_turn`.
   *
   * **`max_tokens_per_task` deliberately does not apply.** This turn runs after
   * the reply has posted, so the task it belongs to is over — and a task that
   * ended by spending its cap is exactly the one most worth remembering, which
   * is the task a per-task cap would silently skip. One call, bounded per turn,
   * and the proxy's daily meter is what catches anything runaway.
   */
  maxTokens: number;
  /**
   * Which turn of the task this is — the loop's turn count plus one, so the id
   * the caller mints stays `<task>.<n>` with no gap and no collision.
   */
  turn: number;
  signal?: AbortSignal;
  /**
   * What this turn cost, reported before any operation runs.
   *
   * The ordering matches the loop's and matters for the same reason: a turn that
   * is paid for is counted even if what it asked for then fails. Awaited, and it
   * must not throw — see `AgentTaskOptions.onTurn`, whose contract this is.
   */
  onTurn?: (turn: CompletedTurn) => void | Promise<void>;
}

/**
 * The two memory tools, in the shape a provider is handed.
 *
 * Built from `MEMORY_TOOLS` rather than restated, so the description a model
 * reads here is the one `@getlibero/schema` publishes and there is no second
 * copy to drift. Exported because a caller assembling its own turn — a test, or
 * a future surface — should not have to rebuild it either.
 */
export function memoryToolDefinitions(): ToolDefinition[] {
  return MemoryToolName.options.map(name => ({
    name,
    description: MEMORY_TOOLS[name].description,
    inputSchema: MEMORY_TOOLS[name].inputSchema
  }));
}

/**
 * The task's transcript with its tool traffic removed.
 *
 * Three things go, and the third is why the first two cannot be kept: `tool`
 * messages, the `toolCalls` on an assistant message, and any assistant message
 * that had nothing but tool calls in it. **A tool-use block with no matching
 * result is not a conversation a provider will accept**, so dropping results
 * forces dropping the calls that produced them, and an assistant turn that was
 * only calls becomes an empty message — which providers reject too.
 *
 * `providerState` goes with them. It is opaque replay state belonging to the
 * conversation that produced it, and this is a different conversation.
 *
 * What survives is what was asked, what the model said in its own words, and the
 * reply. A fact that appeared only inside a tool result and never reached the
 * model's own prose is not visible to curation, which is the price of not
 * re-sending a whole tool conversation to record one sentence.
 *
 * Exported for its own test. It is a pure function of the transcript.
 */
export function curationTranscript(
  messages: readonly CompletionMessage[]
): CompletionMessage[] {
  const kept: CompletionMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "user") {
      kept.push(message);
      continue;
    }
    if (message.content === "") continue;
    kept.push({ role: "assistant", content: message.content });
  }

  return kept;
}

/**
 * What the model is told it is doing.
 *
 * Part of the deliverable rather than an implementation detail, and worded for
 * the failure modes the store actually has. Two clauses are load-bearing beyond
 * the obvious: **prefer replacing a stale fact over appending a competing one**,
 * because appending is always the cheaper move for a model and a file that
 * accretes contradictions is the failure this design is most exposed to; and
 * **doing nothing is a valid outcome**, because a model asked to curate will
 * otherwise find something to say about every task.
 *
 * None of it is a mitigation. The tool set, the two caps and the meter hold
 * whatever the model does with these words.
 */
export const CURATION_SYSTEM_PROMPT = [
  "You are updating one Slack channel's long-term memory, after the assistant has already",
  "replied to the person who asked. Nobody sees this step and nothing you write here is",
  "posted to the channel.",
  "",
  "MEMORY.md is a plain markdown file the team can read and edit. It holds durable facts",
  "about how this team works: decisions they have made, conventions they follow, names and",
  "roles, standing preferences. It is not a log, not a summary of the conversation, and not",
  "a place for the answer that was just given.",
  "",
  "Record something only if it will still be true next week and would be useful to somebody",
  "who was not in this conversation. Most tasks produce nothing worth recording, and doing",
  "nothing is the right outcome for those — call no tool at all.",
  "",
  "When something you are about to record contradicts or refines a fact already in the file,",
  "replace that fact rather than appending a competing one. A file holding both is worse",
  "than a file holding the old one, because a later reader cannot tell which is current.",
  "",
  "`memory_replace` matches literal text exactly once, so copy the text you are replacing",
  "out of the file as it appears there. If the file is close to its size limit, make room by",
  "replacing something with a shorter version of itself; nothing is written when an",
  "operation would take the file past the limit."
].join("\n");

/**
 * Run the curation turn.
 *
 * Rejects when the provider does — the same way `runAgentTask` does, and for the
 * same reason: this file has no logger and swallowing it here would make a
 * broken provider look like a channel that never remembers anything. The caller
 * catches, because the reply has already posted and a curation failure must not
 * reach it.
 */
export async function runCurationTurn(
  options: CurationTurnOptions
): Promise<CurationTurnResult> {
  const response = await options.completion.complete({
    model: options.model,
    system: CURATION_SYSTEM_PROMPT,
    messages: [...curationTranscript(options.messages), currentMemory(options)],
    tools: memoryToolDefinitions(),
    maxTokens: options.maxTokens,
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  });

  // Before the operations run, which is the loop's ordering: a turn that was
  // paid for is counted even if what it asked for then fails.
  await options.onTurn?.({
    usage: response.usage,
    turn: options.turn,
    ...(response.model === undefined ? {} : { model: response.model })
  });

  const ops: CurationOpOutcome[] = [];

  for (const call of response.toolCalls) {
    const parsed = parseMemoryOp(call.name, call.arguments);
    // A name that is not one of the two never reaches `applyOp`, and there is
    // nothing else here it could reach. That is the whole of "this turn cannot
    // invoke a proxied tool".
    const result: MemoryOpResult = parsed.ok
      ? await options.applyOp(parsed.op)
      : { outcome: "failed", reason: parsed.reason };

    ops.push({ tool: call.name, result, message: memoryOpMessage(result) });
  }

  return {
    ops,
    usage: response.usage,
    ...(response.model === undefined ? {} : { model: response.model })
  };
}

/**
 * The last message: the file as it stands, and how much room is left in it.
 *
 * A user message rather than part of the system prompt, because it changes on
 * every call and a system prompt that changes every call is one no provider can
 * cache. It is also the thing the model is being asked to act on, which is where
 * the turn's question belongs.
 */
function currentMemory(options: CurationTurnOptions): CompletionMessage {
  const body =
    options.memory === ""
      ? "This channel has no MEMORY.md yet. It is empty."
      : `This channel's MEMORY.md, in full:\n\n${options.memory}`;

  return {
    role: "user",
    content: [
      body,
      "",
      `It currently holds ${options.memory.length} characters and may hold ${options.maxFileChars}.`,
      "",
      "Update it if this conversation produced a durable fact about how this team works.",
      "Call no tool if it did not."
    ].join("\n")
  };
}
