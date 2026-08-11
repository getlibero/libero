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

import { MAX_TOOL_DESCRIPTION } from "@getlibero/schema";
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
      "Search this Slack channel's own message history. " +
      "Takes plain words, not a query language: every word must appear in a message, " +
      "in any order, and word endings are matched loosely so \"decide\" finds \"decided\". " +
      "Results come back ranked by how well they match, not newest first, so ask for a " +
      "larger limit rather than assuming the top hit is the most recent. " +
      "Each line is the message's date, its author, and its text. " +
      "Only this channel is searchable — there is no argument for naming another, and " +
      "messages the app has not seen are not stored. " +
      "Author names are as they were when the message was stored, and any <@U...> " +
      "mentions inside the text are left as ids.",
    inputSchema: SEARCH_CHANNEL_HISTORY_SCHEMA
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
