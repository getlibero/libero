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
   * "identified", "reconnecting", "disconnected", "auth_rejected", "stopping",
   * "drained", "drain_timeout".
   * Dispatch: "mention", "replied", "follow_up", "ignored", "handler_failed",
   * "post_failed", "message_failed", "revision_failed". Tools: "task", "tools_unavailable",
   * "tool_not_permitted". Spend: "spend_reported", "spend_report_failed",
   * "budget_warning".
   * Sessions: "queued", "session_evicted", "team_sheet_invalid",
   * "team_sheet_unreadable". Message store: "store_opened",
   * "store_unavailable", "store_write_failed". Memory: "memory_file_opened",
   * "memory_unavailable", "curated", "curation_failed". Embeddings:
   * "embeddings_ready", "embeddings_unconfigured". Thread summaries:
   * "summarized", "summary_failed", "summary_unusable", "summary_embed_failed"
   * — and the middle two are deliberately distinct words, because "the provider
   * is down" and "the model cannot follow the schema" want different answers
   * from whoever is reading. Attribution:
   * "user_lookup_failed". Approvals: "decision",
   * "decision_failed", "card_posted", "card_updated", "card_failed",
   * "approval_ignored", "approval_unknown".
   *
   * There is no word here for an ordinary message arriving, and that is a
   * decision rather than an omission — see `dispatchMessage`. "follow_up" is
   * not that word: it marks the rare message that became a task, which is a
   * thing an operator counts rather than a record of who spoke.
   */
  event: string;
  /** Slack team id. An id, never a token. */
  team?: string;
  /** Slack channel id — the same id a team sheet is keyed on. */
  channel?: string;
  /**
   * A Slack user — who mentioned the app, who clicked, who could not be looked
   * up, or which id this app itself resolved to. **An id, never a display
   * name**: a name is content in a way an id is not, being something a person
   * chose to be called.
   */
  user?: string;
  /** Slack's `event_id`. Stable across delivery retries, so a duplicate is greppable. */
  eventId?: string;
  /** The thread a reply went to, as a Slack ts. */
  threadTs?: string;
  /**
   * A card message's own ts — the message `chat.update` edits.
   *
   * Distinct from `threadTs`, which names the thread the card sits in. Two
   * different ids: an operator asking which card went stale wants this one and
   * cannot derive it from the other.
   */
  messageTs?: string;
  /**
   * An approval ticket id. The join key between a card, a click, and the audit
   * row the proxy writes for the same decision.
   *
   * Safe to log, and the reason is what a ticket is worth: it authorizes one
   * call, once, in one channel, and spending one needs the channel's client
   * certificate *and* a byte-for-byte matching call. It is an id in the same
   * sense a channel id is, and without it a card and its decision cannot be
   * correlated across the two processes.
   */
  ticket?: string;
  /**
   * What a human said: `approve` or `deny`. A code from a two-member closed set
   * (`ApprovalVerdict`), never prose, and the same word the proxy's own log and
   * the audit row use — so one grep spans both ends.
   */
  verdict?: string;
  /**
   * Which state a card was rendered in: `awaiting`, `approved`, `denied`, or
   * `expired`. A code from a closed set, and the state a human would have seen,
   * so a card that never left amber is greppable without opening Slack.
   */
  cardState?: string;
  /**
   * A path this process was configured with — the message store's file.
   *
   * Configuration rather than content: an operator wrote it into the
   * environment, and it is the first thing they need when a store will not
   * open. Never a path derived from anything a channel's members said.
   *
   * It is here because `packages/memory` logs its own `store_opened` line
   * through whatever `Logger` it is handed, and this is the one it is handed.
   * That package duplicates this interface rather than importing it (see the
   * block on `packages/memory/**` in eslint.config.mjs), so the two vocabularies
   * have to be kept compatible by hand — the alternative is a line whose field
   * appears on stdout without being declared anywhere.
   */
  file?: string;
  /**
   * Which kind of revision a line is about: `deleted` or `edited`.
   *
   * A code from a two-member closed set, and content in neither direction — it
   * says that a message was retracted or rewritten, never what it said. It is
   * its own field rather than folded into `reason` because the two answer
   * different questions on the same line: `revision` is what was being
   * mirrored, `reason` is why it did not land, and an operator asking whether
   * deletions specifically are failing needs to grep for one without the other.
   */
  revision?: string;
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
   *
   * **What was asked for.** Since #62 the model that actually *served* a turn is
   * `servedModel` below, and the two are not the same field because they are not
   * the same fact.
   */
  model?: string;
  /**
   * The model that served one turn, as the provider echoed it back (#62).
   *
   * Distinct from `model` above rather than folded into it, because a router —
   * the LiteLLM sidecar is the case — is asked for an alias and answers with
   * whatever it resolved. Collapsing them would lose exactly the distinction the
   * dollar cap exists for, and an operator writing a price table needs this
   * spelling and not the other one.
   *
   * Also a configuration value and never content: it comes out of the provider's
   * HTTP response envelope, not from anything the model wrote.
   */
  servedModel?: string;
  /**
   * The model this deployment embeds with, as `AGENT_EMBEDDING_MODEL` names it.
   *
   * A third field rather than a third use of `model`, for the reason
   * `servedModel` is a second one: they are different facts about different
   * calls. A deployment ordinarily completes against one vendor and embeds
   * against another — Anthropic publishes no embeddings endpoint — so an
   * operator asking "what is this process embedding with" is not asking what a
   * task ran on, and folding the two would make the answer depend on which line
   * you happened to grep.
   *
   * A configuration value, never content, exactly as the other two are.
   */
  embeddingModel?: string;
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
   * How many memory operations a curation turn asked for (#227).
   *
   * A count and never the operations themselves. What a `memory_append` carries
   * is a channel's own text, and the rule this file keeps about display names
   * covers it for the same reason: an operator needs to know curation is doing
   * something, not what a team decided to remember.
   */
  ops?: number;
  /**
   * The task id every tool call in a task was attributed to. An id the agent
   * minted, not content, and the one field that will tie this line to the audit
   * records the proxy writes for the same task (#97).
   */
  task?: string;
  /**
   * The flat tool name a model called, on a call refused before the proxy was
   * asked — `tool_not_permitted` and nothing else (#170).
   *
   * **The one field in this vocabulary whose value the model wrote.** Every
   * other field here is an id this system or Slack minted; this is text that
   * arrived in a completion, and it is a named field precisely so it can never
   * be interpolated into a message. A reviewer adding a second model-authored
   * field should expect to argue for it: the two rules at the top of this file
   * are about what a line may not carry, and this is the one line where the
   * value is not ours to vouch for.
   *
   * Not content, in the sense the second rule means: a name the model invented
   * is not a message a channel's members wrote. It is here because "what did
   * that task try to call" has no other answer — the proxy never saw the call
   * and writes no audit row for it, correctly.
   */
  tool?: string;
  /**
   * Which daily budget limit a channel was warned about — `daily_tokens` or
   * `daily_tool_calls`, on `budget_warning` and nothing else (#99).
   *
   * A code from a closed set (`BudgetLimit`), and the same word the sheet's
   * `[budget]` block uses, so the line names the field an operator would edit.
   * The channel's position against it is deliberately not here: it is in the
   * thread, where the people who can ask for a larger number are, and the
   * meter's own file is what an operator queries for a count.
   */
  limit?: string;
  /**
   * How long `stop()` was willing to wait for in-flight dispatches, on
   * `drain_timeout` and nothing else (#118).
   *
   * The bound, not the elapsed time — `durationMs` carries that on the line
   * where the drain finished. It is here because the remedy for a repeated
   * `drain_timeout` is a longer bound and a longer `stop_grace_period` above
   * it, and neither number is guessable from the line without this one.
   */
  drainMs?: number;
  /**
   * How many dispatches a drain waited for, or abandoned when it timed out.
   *
   * A count, not content. One field across both outcomes on purpose: an
   * operator asking how much work a restart is costing greps `drain_timeout`
   * and reads this, and the same word on `drained` is what says a normal
   * shutdown had anything to wait for at all.
   */
  dispatches?: number;
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
