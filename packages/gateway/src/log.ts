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
   * "mention", "replied", "ignored", "handler_failed", "post_failed".
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
   * Why an agent task ended — `completed`, `refusal`, or the cap that stopped
   * it. A code from a closed set, and the field an operator greps when threads
   * start ending short.
   */
  stopReason?: string;
  /**
   * Tokens the provider reported for a task, summed across its turns. A count,
   * not content. Worth carrying while nothing else meters tokens: no proxy
   * client sends a spend report yet, so this is the only place the number is
   * visible.
   */
  totalTokens?: number;
  /** Model turns in a task. Tells a token count that ran long from one that ran wide. */
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
