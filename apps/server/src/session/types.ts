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

import type { AgentLoopCaps, HeldCallPrompter } from "@getlibero/agent";

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
   * What was asked, verbatim. Stripping the mention token, resolving display
   * names, and prepending thread history are the context assembler's (#67).
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
 * What a channel's team sheet resolved to for one task.
 *
 * An object rather than two positional arguments because #67 adds `messages`
 * to it: the assembled context is resolved from the same channel, in the same
 * serialized step, and would otherwise be a third parameter.
 */
export interface TaskSettings {
  /** The sheet's `[llm] model`, or `AGENT_MODEL`. Passed to the provider verbatim. */
  readonly model: string;
  /** The four per-task caps, out of the sheet's `[llm]` block. */
  readonly caps: AgentLoopCaps;
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
