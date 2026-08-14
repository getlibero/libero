// The arm that serves a tool this process implements itself (#64).
//
// Today that is one tool, `search_channel_history`, reading the channel's own
// message store. The store is written by the gateway under `AGENT_STORE_ROOT`
// and read here under `PROXY_STORE_ROOT`; they name the same directory and the
// two services are configured separately, which is why there are two variables
// for one path.
//
// ## What this arm is allowed to hold
//
// A directory path, and nothing else. It has no vault, no client pool, no
// network. `createToolDispatcher` in ./dispatch.ts is what keeps that true: it
// hands this arm a `BuiltinToolName` and hands `HttpDispatcher` an `McpServer`,
// so neither can be given the other's work and neither needs a branch guarding
// against it.
//
// ## Why the reader is opened per call
//
// `openMessageReader` opens read-only, runs no DDL, and prepares one statement,
// so it costs less than the audit write and the meter write that bracket it. A
// pool would buy a fraction of that and cost an eviction policy, a lifetime, and
// a set of open file handles across every channel the proxy has ever served —
// which is a much worse thing for the process holding every tool credential to
// be carrying around. The handle's lifetime is one call and a `finally` closes
// it.
//
// #229 added one thing to that open: sqlite-vec is loaded into the connection,
// so a `loadExtension` now happens per call as well. `dlopen` is cached by the
// process after the first, so what recurs is vec0 registering itself on a new
// connection rather than a load from disk — small beside the two SQLite writes
// already bracketing this, and it does not change the argument above. What it
// does *not* buy this arm is a vector query: `MessageReader` is still `search`
// and `close`, and whether the proxy ever runs a nearest-neighbour search is
// #232's question rather than a settled one.
//
// ## The channel is not an argument and cannot be made one
//
// `call.channel` came off the client certificate (./identity.ts) and is the only
// channel this call can reach: `openMessageReader` closes over one file, and the
// argument parser in ./builtins.ts is `.strict()` with no channel field. There
// is no code path here that reads a channel from anything the model wrote.

import { openMessageReader } from "@getlibero/memory";
import type { ResolvedToolCall, ToolResult } from "@getlibero/schema";
import type { StoredMessage } from "@getlibero/memory";
import { SearchChannelHistoryArguments } from "./builtins.js";
import type { BuiltinDispatcher, Dispatch } from "./dispatch.js";
import type { CallLimits } from "./enforce.js";
import type { Logger } from "./log.js";
import { truncate } from "./mcp-bounds.js";

export interface BuiltinDispatcherOptions {
  /**
   * The directory holding the per-channel state directories, the same one the
   * gateway writes under. `<root>/<channel>/store.db`.
   */
  readonly storeRoot: string;
  readonly logger: Logger;
}

/** What the model is told when the channel has nothing stored at all. */
const NO_STORE = "No messages have been stored for this channel yet.";

/** And when it has messages, but none of them match. */
const NO_MATCHES = "No messages in this channel matched that search.";

/**
 * One hit, as one line.
 *
 * `ts` rather than `at`, because `ts` is when the message was sent and `at` is
 * when this store learned of it — a different clock that diverges on a backfill.
 * Seconds to a date, because the sub-second part of a Slack ts is a
 * disambiguator rather than a time and nobody reading a transcript wants it.
 *
 * The author is the `display_name` snapshot, falling back to the user id. This
 * process holds no Slack token and must never be given one, so the snapshot is
 * the only attribution available — and `<@U...>` tokens inside the text are left
 * exactly as they are, because inventing a name is worse than showing an id.
 * The tool's description tells the model both of those things.
 */
function render(message: StoredMessage): string {
  const seconds = Number.parseInt(message.ts.split(".")[0] ?? "", 10);
  const when = Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString().slice(0, 10)
    : "unknown";
  return `${when} @${message.displayName ?? message.userId}: ${message.text}`;
}

/**
 * Fit as many whole messages as the channel's bound allows, and say what was cut.
 *
 * **Whole messages, never a cut one.** A dropped entry is a short answer that
 * admits it; a truncated entry is half a sentence attributed by name to a real
 * person, which is a misquote the model then reasons over. That is a different
 * trade from a tool result on the way back from an upstream — there, the content
 * is one opaque blob and #151 rightly truncates it — because here the result has
 * a structure and the structure is where the honesty lives.
 *
 * `truncate` from ./mcp-bounds.ts is still the backstop for a single message
 * longer than the whole bound, which would otherwise return the notice and
 * nothing else. It is reused rather than rewritten because #130 fixed an
 * off-by-one in it that a second copy would reintroduce.
 */
function fit(hits: readonly StoredMessage[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;

  for (const hit of hits) {
    const line = render(hit);
    // +1 for the newline this line will be joined with, except the first.
    const cost = line.length + (lines.length === 0 ? 0 : 1);
    if (used + cost > maxChars) break;
    lines.push(line);
    used += cost;
  }

  const omitted = hits.length - lines.length;
  if (omitted === 0) return lines.join("\n");

  const notice = `(${omitted} more ${omitted === 1 ? "match" : "matches"} omitted to fit this channel's result limit)`;

  // Nothing fit. One message longer than the entire bound is the only way here,
  // and answering with the notice alone would be a search that found something
  // and showed none of it.
  if (lines.length === 0) {
    const first = hits[0];
    return first === undefined ? NO_MATCHES : truncate(render(first), maxChars);
  }

  // Drop lines until the notice fits too, rather than exceeding the bound to
  // report that we stayed inside it.
  while (lines.length > 0 && used + notice.length + 1 > maxChars) {
    const dropped = lines.pop();
    used -= (dropped?.length ?? 0) + 1;
  }

  return [...lines, notice].join("\n");
}

const ran = (content: string, isError = false): Dispatch => ({
  outcome: "ran",
  result: { content, isError } satisfies ToolResult
});

export function createBuiltinDispatcher(options: BuiltinDispatcherOptions): BuiltinDispatcher {
  const { storeRoot, logger } = options;

  const searchChannelHistory = (call: ResolvedToolCall, limits: CallLimits): Dispatch => {
    const parsed = SearchChannelHistoryArguments.safeParse(call.arguments);
    if (!parsed.success) {
      // An error result rather than a refusal, and the distinction is not
      // cosmetic: `ToolRefusal` is a closed union of governance decisions with
      // no free-text member, and "your arguments were wrong" is neither a
      // governance decision nor expressible in it. MCP servers answer bad
      // arguments the same way, so the model sees one familiar shape. The call
      // has already been charged, which is correct — it reached the proxy and
      // the proxy did work on it.
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
      return ran(`search_channel_history: invalid arguments${where}.`, true);
    }

    // `call.channel` is the certificate's, and nothing in `parsed.data` can
    // reach it. See this file's header.
    const reader = openMessageReader({ channel: call.channel, root: storeRoot, logger });
    if (reader === null) return ran(NO_STORE);

    try {
      const hits = reader.search(parsed.data.query, parsed.data.limit);
      return ran(hits.length === 0 ? NO_MATCHES : fit(hits, limits.maxResultChars));
    } finally {
      reader.close();
    }
  };

  return {
    run(call, tool, limits) {
      try {
        switch (tool) {
          case "search_channel_history":
            return searchChannelHistory(call, limits);
        }
      } catch (error) {
        // A reason code, never the message: `openMessageReader` puts the file
        // path in its errors and `LogFields` has a declared place for a path.
        logger.log("error", {
          event: "builtin_failed",
          channel: call.channel,
          tool,
          reason: reasonOf(error)
        });
        // Rethrown, not degraded. `server.ts` catches it, writes an `unanswered`
        // audit row and answers a constant 500 — which is what that word is for,
        // and is honest in a way `unavailable` would not be: a built-in *is*
        // built, so "no upstream exists" is false. Every case that reaches here
        // is an operator fault (two builds disagreeing about the schema, a Node
        // without FTS5, an unreadable mount) and each should be loud.
        throw error;
      }
    }
  };
}

/** An errno or an error name, and never a message. */
function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown";
}
