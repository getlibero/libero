// What each built-in tool tells the model about itself.
//
// Definitions only: a description, an input schema, and a parser for the
// arguments. No I/O, nothing that opens a file, nothing that holds a path. The
// executor is ./builtin-dispatcher.ts, and the split is the same one
// `ToolCatalog` and `ToolDispatcher` already draw — one seam that can describe,
// a separate one that can run. It is what lets ./listing-route.ts import this
// while its ESLint block still bans everything that can execute a call.
//
// ## This text enters a model's context on every turn
//
// The same hazard `mcp-catalog.ts` bounds for upstream descriptions, with one
// difference that cuts the right way: this text is ours. It is not third-party,
// it cannot change without a commit, and there is no tool-poisoning surface
// here. So it is not bounded at runtime — it is reviewed, once, in the diff.
//
// What it still has to be is *accurate*, because a description is the only thing
// standing between a model and a tool call it will get wrong. The three things
// `search_channel_history` says that a model would otherwise assume the other
// way: the input is words rather than a query language, the results are ranked
// by relevance rather than recency, and the scope is this channel and is not
// negotiable.

import { MAX_TOOL_DESCRIPTION, SCHEDULE_TASK_INPUT_SCHEMA } from "@getlibero/schema";
import type { BuiltinToolName, ToolInputSchema } from "@getlibero/schema";
import { READ_MAX_LIMIT } from "@getlibero/memory";
import { z } from "zod";

/**
 * The default number of messages a search returns when the model names none.
 *
 * Well below `READ_MAX_LIMIT`, because the model can ask for more and every
 * message it did not need is charged against `max_tokens_per_task` and against
 * `[llm] max_result_chars`. A high default would spend a channel's budget on
 * answering a question nobody narrowed.
 */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * What the model may send, parsed strictly.
 *
 * **`.strict()` is the acceptance criterion in executable form.** "No argument
 * the model controls can widen the search beyond the calling channel" is true
 * here because there is no channel field to send and an unknown key is a
 * rejection rather than a silently dropped one. A model that writes
 * `{"query": "vault", "channel": "C0OTHER"}` gets an error result naming the
 * key, which is also the clearest possible signal to whoever is reading the
 * transcript that something tried.
 *
 * The channel is resolved from the client certificate and reaches the executor
 * on `ResolvedToolCall.channel`. There is no code path by which an argument
 * could reach it.
 */
export const SearchChannelHistoryArguments = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(READ_MAX_LIMIT).default(DEFAULT_SEARCH_LIMIT)
  })
  .strict();

/**
 * The most source a single `run_code` call may carry.
 *
 * A bound rather than none, for the reason every other bound in this package
 * exists: an argument the model writes is an argument a prompt injection can
 * write. 64k is far past any script worth sending and far short of a body worth
 * buffering in the process that holds every tool credential.
 *
 * It bounds the *argument*, not the run. What the run may spend is the sheet's
 * `cpus`, `memory_mb` and `timeout_seconds`, and what its output may spend is
 * `max_result_chars` — three different people's decisions, and this is none of
 * them.
 */
export const RUN_CODE_MAX_CHARS = 65_536;

/**
 * What the model may send to the sandbox, parsed strictly.
 *
 * One field. There is deliberately no `language`, no `image` and no `timeout`:
 * the toolchain is the deployment's (#393 pinned the image in the runner's own
 * environment) and the caps are the channel's (`[[builtin]]`'s sandbox fields).
 * Both would be a model argument reaching a decision somebody else made, which
 * is the shape `.strict()` exists to make loud — a model that sends
 * `{"code": "...", "image": "ubuntu"}` gets an error naming the key rather than
 * a silently dropped one.
 */
export const RunCodeArguments = z
  .object({
    code: z.string().min(1).max(RUN_CODE_MAX_CHARS)
  })
  .strict();

/**
 * The JSON Schema the model is given, beside the zod parser that enforces it.
 *
 * Same two-spellings-of-one-contract hazard as the search schema below, closed
 * the same way in `builtins.test.ts`.
 */
const RUN_CODE_SCHEMA = {
  type: "object",
  properties: {
    code: {
      type: "string",
      maxLength: RUN_CODE_MAX_CHARS,
      description: "The program to run. It is written to the container's tmpfs workdir and executed."
    }
  },
  required: ["code"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

/**
 * The JSON Schema the model is given, beside the zod parser that enforces it.
 *
 * Two spellings of one contract, which is a drift hazard — `builtins.test.ts`
 * closes it by round-tripping arguments the schema calls valid through the
 * parser and vice versa. The alternative, generating one from the other, would
 * pull a converter into the package that holds the vault to save a test.
 *
 * `additionalProperties: false` mirrors `.strict()`, so a well-behaved model is
 * told the rule rather than only punished for breaking it.
 */
const SEARCH_CHANNEL_HISTORY_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Words to search for. Every word must appear somewhere in a message, in any order."
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: READ_MAX_LIMIT,
      description: `Most messages to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`
    }
  },
  required: ["query"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

export interface BuiltinDefinition {
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/**
 * Every built-in, by name.
 *
 * A `Record` over `BuiltinToolName` rather than a `Map`, so adding a member to
 * the schema's enum without adding a definition here is a type error. That is
 * one half of the pair; the other is the exhaustive switch in the executor.
 */
export const BUILTIN_TOOLS: Record<BuiltinToolName, BuiltinDefinition> = {
  search_channel_history: {
    description:
      "Search this Slack channel's message history. " +
      "Takes plain words, not a query language. Use two or three distinctive words from " +
      "what you are looking for, not the question you were asked: an answer rarely repeats " +
      "a question's words, and words like \"what\" or \"did\" match only other questions. " +
      "Every word must appear in a message, in any order, and word endings are matched " +
      "loosely so \"decide\" finds \"decided\"; if no message has all of them, messages " +
      "with some come back instead. " +
      "Results are ranked by match rather than by recency, so ask for a larger limit " +
      "rather than assuming the top hit is the newest. " +
      "Each line is the message's date, its author, and its text. " +
      "Messages from the conversation you are already in are left out — you have been " +
      "shown those, and this searches the rest of the channel. " +
      "Only this channel is searchable — there is no argument for naming another, and " +
      "messages the app has not seen are not stored. " +
      "Author names are as they were when stored, and any <@U...> " +
      "mentions inside the text are left as ids.",
    inputSchema: SEARCH_CHANNEL_HISTORY_SCHEMA
  },
  // The one built-in whose input schema is not written here (#322). Its contract
  // spans both processes — this one parses the arguments, the agent parses the
  // ticket that comes back — so the whole of it lives in `@getlibero/schema`
  // beside the ticket, where `search_channel_history`'s is read by this process
  // alone and has no reason to leave.
  //
  // Four clauses below are load-bearing, because a model would assume each of
  // them the other way. **That the time is an offset and it does not need a
  // clock**, which is the whole reason this takes minutes rather than an instant.
  // **That the check runs once**, or a model asked for a daily standup reminder
  // will believe it has arranged one. **That creating one costs a person a
  // click**, or it becomes the place notes-to-self go. And **that the answer may
  // be nothing**, which is the same thing `post_finding` has to say and for the
  // same reason: a turn asked to evaluate will evaluate.
  schedule_task: {
    description:
      "Schedule one check to run later in this channel. Say what to check and how many minutes " +
      "from now; the exact time is worked out when this is approved, so you do not need to know " +
      "what time it is now. At that time the check runs once and posts here only if there is " +
      "something worth saying. It is not a recurring job — to repeat one, schedule the next from " +
      "the check that just ran. Creating one normally needs a person here to approve it, so it is " +
      "not free and it is not a way to leave yourself a note. Only this channel can be scheduled " +
      "for, and there is no argument for naming another. If the thing needs doing now, do it now " +
      "instead.",
    inputSchema: SCHEDULE_TASK_INPUT_SCHEMA
  },
  // The sandbox (#368). Named `run_code` rather than `code_execution` or
  // `code_interpreter` — the two spellings the wider ecosystem uses — because
  // both existing built-ins are verb_noun and this enum is what a team sheet
  // writes. It is deliberately **not** `run_python`: #393 put the image in the
  // runner's environment, so which language exists is a deployment fact, and a
  // name that pinned one would be a sheet-level claim about a host-level choice
  // that an operator swapping the image would silently falsify.
  //
  // Three clauses below are load-bearing because a model would assume each the
  // other way. **That there is no network unless the sheet grants one**, or
  // generated code will reach for a package index and lose the run. **That a
  // denied host ends the run rather than failing one call**, which is #393's
  // decision and the reason the allow list has to be visible rather than
  // discovered. And **that nothing survives**, or a model will write the first
  // half of a job and assume it can pick the file up next call.
  //
  // TWO THINGS #395 OWES THIS DESCRIPTION. The language sentence is a placeholder
  // until the image is pinned — it says the deployment decides, which is true and
  // not actionable, and the concrete toolchain should replace it. And the
  // channel's `[egress] allow` list should be *enumerated* here rather than
  // referred to; that needs the sheet at listing time, and it is worth nothing
  // until the hop exists to enforce what it promises. Enumerating an unenforced
  // list would be a description that lies, which is worse than one that is vague.
  run_code: {
    description:
      "Run a program in a throwaway container and get back what it printed. " +
      "Which language is available is set by this deployment's sandbox image, not by you — " +
      "there is no argument for choosing one. " +
      "The container has a read-only filesystem apart from a scratch working directory, " +
      "a cpu, memory and wall-time budget this channel set, and it is destroyed when the call " +
      "returns: nothing you write survives to the next call, so do the whole job in one program. " +
      "A run that outlives its time budget is killed and you are told so. " +
      "There is normally no network at all. If this channel allows some hosts, reaching any " +
      "other one does not merely fail — it ends the run immediately and you lose the output, " +
      "so do not try a host to find out whether it is allowed. " +
      "Output comes back bounded, and you are told when it was cut. " +
      "Running code normally needs a person here to approve it, so it is not free.",
    inputSchema: RUN_CODE_SCHEMA
  }
};

/**
 * Refuse a definition this build could not publish.
 *
 * `MAX_TOOL_DESCRIPTION` is what `PermittedTool.description` parses against, so
 * a description over it would make the whole listing fail `ToolListing.parse` on
 * the agent's side — which ends a task with "the tool proxy could not be
 * reached" rather than costing it a sentence. That is #130's `truncate` bug in
 * a different place, and the cheap fix is to never let one ship: this runs at
 * module load, so an over-long description is a process that will not start
 * rather than a channel whose listing is broken.
 */
for (const [name, definition] of Object.entries(BUILTIN_TOOLS)) {
  if (definition.description.length > MAX_TOOL_DESCRIPTION) {
    throw new Error(
      `proxy: built-in ${name} has a ${definition.description.length}-character description, ` +
        `and MAX_TOOL_DESCRIPTION is ${MAX_TOOL_DESCRIPTION}`
    );
  }
}
