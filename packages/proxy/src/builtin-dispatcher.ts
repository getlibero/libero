// The arm that serves a tool this process implements itself (#64).
//
// Two tools. `search_channel_history` reads the channel's own message store, and
// `schedule_task` (#323) turns an offset into one future check. The store is
// written by the gateway under `AGENT_STORE_ROOT` and read here under
// `PROXY_STORE_ROOT`; they name the same directory and the two services are
// configured separately, which is why there are two variables for one path.
//
// ## What this arm is allowed to hold
//
// A directory path and a clock, and nothing else. It has no vault, no client
// pool, no network. `createToolDispatcher` in ./dispatch.ts is what keeps that
// true: it hands this arm a `BuiltinToolName` and hands `HttpDispatcher` an
// `McpServer`, so neither can be given the other's work and neither needs a
// branch guarding against it.
//
// **The code-execution built-in does not land here** (#368), and #393 decided
// that rather than leaving it to be discovered. It is a built-in in every sense
// the team sheet cares about, so the obvious move is to add a case to the switch
// below — and that case would open a network connection to the runner, which is
// the one thing the paragraph above says this arm does not do. It gets a third
// arm on `createToolDispatcher` instead, keyed off the same `BuiltinToolName`.
// The cost is one more branch in a switch that has no I/O in it; what it buys is
// that "no vault, no client pool, no network" stays a fact about this file
// rather than a sentence someone has to remember to delete.
//
// ## Neither tool writes
//
// `search_channel_history` reads, and `schedule_task` mints a ticket and returns
// it — the *agent* is what records it, because this process opens these files
// `readOnly` and a writer here would be a second writer on one file from the
// process that must not be able to repair a channel's evidence. So "this arm
// holds a directory path" stays literally true: it can read that directory and
// it cannot change it.
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

import { randomUUID } from "node:crypto";
import { openMessageReader } from "@getlibero/memory";
import {
  SCHEDULED_TASK_MAX_HORIZON_MINUTES,
  SCHEDULED_TASK_MAX_PENDING,
  SCHEDULED_TASK_MIN_LEAD_MINUTES,
  ScheduleTaskArguments,
  scheduledInstantFromMs,
  serializeScheduledTask
} from "@getlibero/schema";
import type { ResolvedToolCall, ToolRefusal, ToolResult } from "@getlibero/schema";
import type { StoredMessage } from "@getlibero/memory";
import { SearchChannelHistoryArguments } from "./builtins.js";
import type { BuiltinDispatcher, Dispatch } from "./dispatch.js";
import type { CallLimits } from "./enforce.js";
import type { Logger } from "./log.js";
import { truncate } from "./mcp-bounds.js";
import type { ZodError } from "zod";

export interface BuiltinDispatcherOptions {
  /**
   * The directory holding the per-channel state directories, the same one the
   * gateway writes under. `<root>/<channel>/store.db`.
   */
  readonly storeRoot: string;
  readonly logger: Logger;
  /**
   * Injected so a test states the clock rather than faking timers.
   *
   * It exists for `schedule_task` and for nothing else: an offset from the model
   * becomes an absolute instant exactly here, once, and every later reader of
   * that ticket does no arithmetic at all.
   */
  readonly now?: () => number;
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

const refused = (refusal: ToolRefusal): Dispatch => ({ outcome: "refused", refusal });

/**
 * Where a bad-argument error result points.
 *
 * **Unrecognized keys are named, and that is a fix rather than a flourish.** Both
 * argument parsers are `.strict()` precisely so that a model reaching for a field
 * it was not given — `channel` above all — is rejected rather than quietly
 * stripped, and ./builtins.ts has always claimed the model "gets an error result
 * naming the key, which is also the clearest possible signal to whoever is
 * reading the transcript that something tried". It did not: zod reports
 * `unrecognized_keys` with an empty `path`, so every such call answered
 * `at (root)` and the key it tried appeared nowhere. The case that covered it
 * asserted only `isError`, which is how a claim in a comment outlived the
 * behaviour.
 *
 * The keys come from the *parser's* own list of what it did not recognize, not
 * from arbitrary text off the request: an unknown key is a short identifier or it
 * would not be a key, and it goes back to the model that wrote it and into a
 * transcript — never into a log line or a channel.
 */
function argumentFault(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "";
  if (issue.code === "unrecognized_keys") {
    const named = issue.keys.map(key => `\`${key}\``).join(", ");
    return `: unrecognized ${issue.keys.length === 1 ? "key" : "keys"} ${named}`;
  }
  const path = issue.path.join(".");
  return path === "" ? "" : ` at ${path}`;
}

export function createBuiltinDispatcher(options: BuiltinDispatcherOptions): BuiltinDispatcher {
  const { storeRoot, logger } = options;
  const now = options.now ?? Date.now;

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
      return ran(`search_channel_history: invalid arguments${argumentFault(parsed.error)}.`, true);
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

  /**
   * One future check, minted (#323).
   *
   * ## Why the caps refuse here rather than in `decide`
   *
   * `Dispatch` has had a `refused` arm since the vault landed, for "a refusal
   * discovered while serving" — `credential_unresolved` needs a vault lookup that
   * a pure decision cannot make. These three are the same kind of thing: two read
   * the model's *arguments*, which `decide` deliberately never touches, and the
   * third reads the channel's store. Putting them in `decide` would mean handing
   * enforcement the arguments, and the first per-tool argument rule there is the
   * one that makes the second one obvious.
   *
   * `server.ts` audits a dispatch refusal exactly as it audits a decision's, so
   * nothing about the record changes: one row, the reason on it, and the sentence
   * `refusalMessage` writes.
   *
   * **What it costs, said rather than discovered: a refused create is metered.**
   * `recordToolCall` runs before dispatch, so a model probing the caps spends the
   * channel's tool-call budget. That is where `credential_unresolved` already sits
   * and it is the right direction — `daily_tool_calls` is the backstop a cap
   * enforced in code is not.
   *
   * ## Cheapest first
   *
   * The two arithmetic caps decide before the store is opened, so a probe that is
   * trivially out of range costs no file handle. The pending count is last of the
   * three because it is the only one that opens anything.
   *
   * ## What the model cannot choose
   *
   * The id and the instant, both minted here. `ScheduleTaskArguments` is
   * `.strict()`, so a call carrying `id` or `dueAt` is an unknown-key error rather
   * than a ticket on the model's terms — and the channel is not a field at all.
   *
   * ## This writes nothing
   *
   * The ticket goes back as the result and the *agent* records it, which is not a
   * convenience: this process opens these files `readOnly`, and a writer here
   * would be a second writer on one file from the process that must not be able
   * to repair a channel's evidence. The honest consequence is that an audited
   * create can exist whose row never landed — the agent tells the model so, and
   * the count below is a floor rather than an exact tally.
   */
  const scheduleTask = (call: ResolvedToolCall): Dispatch => {
    const parsed = ScheduleTaskArguments.safeParse(call.arguments);
    if (!parsed.success) {
      return ran(`schedule_task: invalid arguments${argumentFault(parsed.error)}.`, true);
    }

    const minutes = parsed.data.due_in_minutes;
    if (minutes < SCHEDULED_TASK_MIN_LEAD_MINUTES) return refused({ reason: "schedule_too_soon" });
    if (minutes > SCHEDULED_TASK_MAX_HORIZON_MINUTES) return refused({ reason: "schedule_too_far" });

    const reader = openMessageReader({ channel: call.channel, root: storeRoot, logger });
    try {
      // No store is no tickets, which is the same answer the reader gives for a
      // file whose writer predates the table.
      const pending = reader?.pendingScheduledTasks() ?? 0;
      if (pending >= SCHEDULED_TASK_MAX_PENDING) return refused({ reason: "schedule_full" });
    } finally {
      reader?.close();
    }

    const at = now();
    return ran(
      serializeScheduledTask({
        id: randomUUID(),
        task: call.task,
        prompt: parsed.data.prompt,
        dueAt: scheduledInstantFromMs(at + minutes * 60_000),
        createdAt: scheduledInstantFromMs(at)
      })
    );
  };

  return {
    run(call, tool, limits) {
      try {
        switch (tool) {
          case "search_channel_history":
            return searchChannelHistory(call, limits);
          case "schedule_task":
            return scheduleTask(call);
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
