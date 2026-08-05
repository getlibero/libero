// Structured logging for the gateway.
//
// The same closed-vocabulary rule the proxy's own logger keeps, and a separate
// module for the same reason the boundary exists: the gateway may not import
// across it. There is no `message` field and no metadata bag — if something new
// needs logging it gets a named field here and a reviewer looks at it.
//
// (The duplication is deliberate. A shared logger would need the union of both
// vocabularies, which is exactly what a closed vocabulary exists to prevent: the
// field naming a credential has no business being reachable from here.)
//
// Two rules for that reviewer. No field may hold a token value, or a prefix,
// suffix, or hash of one: this is the process that holds the Slack app and bot
// tokens, and a log line is the cheapest way for one to escape. And no field may
// hold message text. A message belongs to the members of the channel it was
// posted in, and it is read on their behalf — stdout is not on that path. Ids
// (channel, user, ts, event id) are not content and are what an operator needs
// to correlate a line with a thread.
//
// One JSON object per line on stdout — the shape a container log collector
// wants, and greppable without a parser.

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  /**
   * Fixed vocabulary. Connection lifecycle: "connecting", "connected",
   * "reconnecting", "disconnected", "auth_rejected", "stopping". Dispatch:
   * "mention", "replied", "ignored", "handler_failed", "post_failed". Tools:
   * "task", "tools_unavailable". Spend: "spend_reported",
   * "spend_report_failed". Sessions: "queued", "session_evicted",
   * "team_sheet_invalid", "team_sheet_unreadable".
   */
  event: string;
  /** Slack team id. An id, never a token. */
  team?: string;
  /** Slack channel id — the same id a team sheet is keyed on. */
  channel?: string;
  /** The Slack user who mentioned the app. An id, never a display name. */
  user?: string;
  /** Slack's `event_id`. Stable across delivery retries, so a duplicate is greppable. */
  eventId?: string;
  /** The thread a reply went to, as a Slack ts. */
  threadTs?: string;
  /** Why something was ignored or failed. A code, not prose, and never an SDK message. */
  reason?: string;
  /**
   * Slack's own error code from a Web API response — `not_in_channel`,
   * `channel_not_found`. Slack's closed vocabulary, carrying nothing of ours,
   * and the field that answers "why did my reply not appear" on a first run.
   */
  slackError?: string;
  /** Which consecutive reconnect attempt this is. Resets when a connection holds. */
  attempt?: number;
  /** How long the reconnect loop waited before this attempt. */
  delayMs?: number;
  /** How long a handler took, for the one case where slowness is the symptom. */
  durationMs?: number;
  /**
   * How long a request waited for another task in the same channel to finish.
   *
   * Present only when it waited — an uncontended session logs nothing, because
   * a zero on every line is not information. It exists because `durationMs`
   * quietly changed meaning when mentions started queueing: without this field,
   * a channel backed up behind a slow task is indistinguishable from a slow
   * model, and the two have different fixes.
   */
  queuedMs?: number;
  /**
   * The model a task ran on, after the channel's `[llm] model` override.
   *
   * A configuration value, never content. It is here because "which model is
   * this deployment using" stopped having one answer per process the moment
   * team sheets could name their own.
   */
  model?: string;
  /**
   * Why an agent task ended — `completed`, `refusal`, or the cap that stopped
   * it. A code from a closed set, and the field an operator greps when threads
   * start ending short.
   */
  stopReason?: string;
  /**
   * Tokens the provider reported for a task, summed across its turns. A count,
   * not content.
   *
   * Carried on three lines, and it means a *task* on one of them and a *turn*
   * on the other two. On `task` it is the whole task, summed. On
   * `spend_reported` and `spend_report_failed` it is the one turn that line is
   * about, because spend is reported per turn. A task whose reports do not add
   * up to its `task` line is a meter that missed something, which is the shape
   * an operator greps for when a channel's budget stops adding up.
   */
  totalTokens?: number;
  /**
   * What the proxy's meter made of a spend report: `recorded` or `duplicate`.
   *
   * `duplicate` is a success rather than a warning — the turn had already been
   * counted, which is the right answer to a retry under the same id and the
   * reason retrying is safe. An outcome code from a closed set, and the same
   * word the proxy's own logger uses for it, so one grep spans both ends of the
   * connection.
   */
  report?: string;
  /**
   * Model turns. On `task`, how many the task took — which tells a token count
   * that ran long from one that ran wide. On the two spend lines, which turn
   * that report was for, numbered from one, so the reports of a task can be put
   * back in order and a missing one is visible as a gap.
   */
  turns?: number;
  /**
   * The task id every tool call in a task was attributed to. An id the agent
   * minted, not content, and the one field that will tie this line to the audit
   * records the proxy writes for the same task (#97).
   */
  task?: string;
}

export interface Logger {
  log(level: LogLevel, fields: LogFields): void;
}

/**
 * The default logger. `write` is injected so tests can capture lines and assert
 * on what the gateway does and does not emit.
 */
export function createJsonLogger(
  write: (line: string) => void = line => process.stdout.write(line)
): Logger {
  return {
    log(level: LogLevel, fields: LogFields): void {
      write(`${JSON.stringify({ ts: new Date().toISOString(), level, ...fields })}\n`);
    }
  };
}

/** Drops everything. For tests that are not asserting on log output. */
export function createSilentLogger(): Logger {
  return { log: () => {} };
}
