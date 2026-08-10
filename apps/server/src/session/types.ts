// What the router works in, and it is not Slack's vocabulary.
//
// A mention arrives as a `SlackMention`, and handler.ts turns it into a
// `TaskRequest` before anything under this directory sees it. That mapping is
// six lines and it is the whole of what a second front-end has to write: a
// Teams adapter, an HTTP entrypoint, or a CLI reaches the same router by
// producing the same four fields. An ESLint rule on this directory enforces it
// rather than a comment asserting it — nothing here may import a Slack type.
//
// The names are deliberately not Slack's. `workspace` is what Slack calls
// `team_id`, and this name propagates into session identity, log lines, and
// eventually the per-channel message store (#63); renaming it later is the
// expensive kind of rename. `channel` needs no translation — it is already what
// the team sheet is keyed on and what the client certificate's `CN=channel:<id>`
// carries.

import type { AgentLoopCaps, CompletionMessage, HeldCallPrompter } from "@getlibero/agent";

/**
 * Which session a request belongs to.
 *
 * **This key is wider than everything beneath it**, and that is worth knowing
 * before something relies on it. The client certificate, the team sheet's path,
 * and the message store's file (#63) are all keyed on the channel id alone. If
 * one channel id ever appeared under two workspaces, this key would produce two
 * sessions holding two mutexes over one channel's state — defeating exactly the
 * serialization it exists to provide.
 *
 * It cannot happen today: a Slack channel id is unique within the workspace the
 * app is installed in, and the certificate layout already treats the channel id
 * as the whole principal. The pair is what the architecture asks for and what
 * keeps two workspaces' sessions from sharing a mutex. But #63 is the issue
 * that would suffer if the assumption ever broke, so the session log lines
 * carry `team` and a collision would at least be visible.
 */
export interface SessionKey {
  readonly workspace: string;
  readonly channel: string;
}

/** One unit of work for a channel: what was asked, by whom, in which session. */
export interface TaskRequest {
  readonly key: SessionKey;
  /**
   * Who asked, as an id. Attribution for the audit log, not authentication —
   * nothing decides anything from it. Display-name resolution is #67's, and a
   * name is not what an audit record wants anyway.
   */
  readonly requestingUser: string;
  /**
   * What was asked, verbatim — the mention token still in it.
   *
   * Verbatim is what makes it usable: the context assembler resolves every
   * `<@U…>` in it to a name, and it cannot resolve a token something upstream
   * already stripped. It is also what the assembler matches against to keep the
   * ask from appearing twice, since the same message is usually already in the
   * channel's store.
   */
  readonly text: string;
  /**
   * The front-end's own id for this request, for correlating log lines with the
   * thing a person did. Slack's `event_id` today — stable across delivery
   * retries, which is what makes a duplicate greppable.
   */
  readonly traceId: string;
  /**
   * Asks a human about a held tool call and resolves when the wait is over.
   *
   * A closure, not a Slack anything: the front-end that built the request
   * already decided where the question gets asked — a card in the mention's
   * thread, today — and the router cannot see how, which is the same seam the
   * reply crosses in the other direction. The type is the agent package's,
   * because the tool client is what awaits it; this layer only carries it.
   *
   * Absent, a held call is relayed to the model as a refusal — the pre-#127
   * behaviour, and still the right one for a front-end with no one to ask.
   */
  readonly onHeld?: HeldCallPrompter;
}

/** What goes back to whoever asked. `undefined` from a runner posts nothing. */
export interface TaskReply {
  readonly text: string;
}

/**
 * How much of a channel's conversation a task starts with.
 *
 * Not `AgentLoopCaps`, and the difference is what each one stops. A cap ends a
 * task that is already running. These decide what the task is handed before it
 * runs at all — and the loop never sees them, because the assembler is above it
 * and gives it a finished transcript.
 *
 * Both come from the sheet's `[llm]` block and both spend the channel's own
 * token budget, which is why they are the channel's to set: raising them buys
 * context and costs `max_tokens_per_task`, and neither can widen a permission.
 * Zero is a real answer and means the model sees the question alone.
 */
export interface HistoryBounds {
  /** `[llm] max_history_messages`. Also the store read's limit. */
  readonly maxMessages: number;
  /** `[llm] max_history_chars`, across the whole rendered block. */
  readonly maxChars: number;
}

/** What a channel's team sheet resolved to. Everything here came out of the file. */
export interface ChannelSettings {
  /** The sheet's `[llm] model`, or `AGENT_MODEL`. Passed to the provider verbatim. */
  readonly model: string;
  /** The four per-task caps, out of the sheet's `[llm]` block. */
  readonly caps: AgentLoopCaps;
  /** The two context bounds, out of the same block. */
  readonly history: HistoryBounds;
}

/**
 * What one task runs on: the channel's settings, plus the context assembled
 * from the same channel in the same serialized step.
 *
 * An object rather than positional arguments, which is what let `messages` join
 * it without changing `TaskRunner`. It is a superset of `ChannelSettings` and
 * not the same type, because the two are produced by different things:
 * `SheetResolver` takes a channel id and has neither the session's store nor
 * the request, so the router assembles the transcript and adds it.
 */
export interface TaskSettings extends ChannelSettings {
  /**
   * The whole seed transcript, assembled and attributed.
   *
   * Required, and the runner hands it to the loop unchanged. There is no "just
   * the question" fallback here on purpose: an assembler that could be skipped
   * is one a caller can forget, and a channel with no history already produces
   * a well-formed single message through the same path.
   */
  readonly messages: readonly CompletionMessage[];
}

/**
 * Runs one task and produces its reply.
 *
 * `settings` is required and has no default. `AgentLoopCaps` argues that a
 * caller must not be able to leave a task uncapped by omission, and a defaulted
 * settings parameter here would be exactly that with an extra step.
 */
export type TaskRunner = (
  request: TaskRequest,
  settings: TaskSettings
) => Promise<TaskReply | undefined>;
