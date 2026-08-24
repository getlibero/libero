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
   * "team_sheet_unreadable", "channels_unreadable" — the last being the
   * directory the other two read one file out of, which fails as a mount rather
   * than as a sheet. Message store: "store_opened",
   * "store_unavailable", "store_write_failed". Memory: "memory_file_opened",
   * "memory_unavailable", "curated", "curation_failed". Embeddings:
   * "embeddings_ready", "embeddings_unconfigured". Shared skills:
   * "shared_skills_ready", "shared_skills_unconfigured" (#433) — the same two
   * words for the same reason one root up, because a deployment that publishes
   * no shared skills and a deployment whose shared root was never mounted look
   * identical from a channel and want different answers from whoever reads the
   * log. Then four more for the standing region (#435):
   * "shared_skill_loaded" is **one line per skill**, `recall_hit`'s shape and
   * for the operator's version of its reason — this is the whole answer to "what
   * is this channel standing on", and a count does not give the names.
   * "shared_skill_missing" is a name the sheet asked for that the root does not
   * hold, "shared_skill_oversize" is one dropped whole for the region's
   * character ceiling, and "shared_skills_unavailable" is the root itself being
   * unset or absent. Three words for three ways to load nothing, because the
   * fixes are three different acts: publish the file, raise the cap or shorten
   * the skill, and mount the root. Thread summaries:
   * "summarized", "summary_failed", "summary_unusable", "summary_embed_failed".
   * Recall: "recalled", "recall_hit", "recall_failed", "query_embedding_failed"
   * — and the summaries' middle two are deliberately distinct words, because
   * "the provider is down" and "the model cannot follow the schema" want
   * different answers from whoever is reading. "recall_hit" is one line per
   * nearest-neighbour hit and the only word in this vocabulary written for an
   * analysis rather than for an operator (#427); `distance` below says what it
   * is for, and `recall.ts` says why it is a line rather than a table. Skills: "skills_opened", "skills_unavailable",
   * "skills_loaded", "skills_over_cap", "skill_reconcile_failed",
   * "skill_recall_failed", "skill_oversize", "skill_file_unusable",
   * "skill_file_misnamed", "authored", "authoring_failed", "skills_embedded",
   * "skill_embed_failed", "skills_adopted", "skills_marked_stale",
   * "skills_archived", "skills_reactivated", "skills_lifecycle_failed"
   * — the last five are the lifecycle job (#294), and they are four words for
   * four outcomes rather than one with a field because what an operator wants to
   * grep for is a library ageing, a library being adopted after a restore, and a
   * job that could not write. "skills_adopted" is the line that explains a run
   * that moved nothing. The pair before them is the skill-embedding pass (#305),
   * which is separate from "summary_embed_failed" because the two corpora fail
   * for different reasons and an operator grepping one is not asking about the
   * other. "authored"/"authoring_failed" is
   * "curated"/"curation_failed"'s counterpart for the skill-author turn, and the
   * two failures above are separate words for that same
   * reason, since a directory this process cannot read is a mount or a
   * permission where a store that cannot answer is a database, and
   * "query_embedding_failed" is separate from "recall_failed" because one of
   * those now costs a task its summaries *and* its playbooks. Ambient (#317): "ambient_due",
   * "ambient_failed", "ambient_overrun", "ambient_unidentified" — a heartbeat
   * fired for a channel, one threw, one was still running when its next came
   * due, and a scan that found due channels with no workspace to key a session
   * on. Four words rather than one with a field, because the three failures
   * want different answers from whoever is reading: a throwing heartbeat is a
   * channel, a run of overruns is a cadence set too tight, and the last is this
   * process not having got through `auth.test` yet. The heartbeat evaluation
   * (#319): "heartbeat_deferred", "heartbeat_silent", "heartbeat_posted",
   * "heartbeat_unposted", "heartbeat_unusable", "heartbeat_failed" — the rate
   * window was shut so nothing was evaluated, the model weighed the channel and
   * said nothing, it said something and the channel heard it, it said something
   * the surface then refused, it answered something that did not parse, and a
   * sheet or a store or a provider that could not be reached. Six words rather
   * than one with a field, because silence is the *expected* outcome here and
   * the four that are not silence must be greppable without wading through it —
   * "heartbeat_unusable" in particular is how a broken prompt shows up, and it
   * would otherwise be indistinguishable from the channel being quiet.
   * Proactive posts (#318):
   * "proactive_posted", "proactive_throttled", "proactive_failed" — the agent
   * started a message in a channel, the rate window refused one, and one Slack
   * would not take. `proactive_throttled` is deliberately its own word rather
   * than a `reason` on the failure line, because a refusal is the surface
   * working and a failure is not: an operator grepping for a channel the app
   * cannot post in must not have to read past the throttle. Firing a scheduled
   * check (#324): "ambient_check_due", "check_posted", "check_unposted",
   * "check_silent", "check_declined", "check_failed" — the clock found a ticket
   * due, the check answered and the channel heard it, it answered and the post
   * did not land, it ran and had nothing to say, it was not run because the
   * channel is over its budget, and it could not be run. Six words for the
   * heartbeat's reason and one of its own: here `check_silent` is the *good*
   * outcome of a conditional check, where `check_declined` and `check_failed`
   * both put a notice in a channel, so an operator asking "did anyone get told
   * something they should not have" greps two words and not six. Scheduled checks
   * (#323): "scheduled_task_recorded", "scheduled_task_unrecorded" — a governed
   * create left a ticket that will fire, and one that did not. Two words rather
   * than one with a field, because the second is the only direction the audit log
   * and the channel's store can disagree in: a create the proxy served and
   * audited whose row never landed, which is a human's approval having bought
   * nothing. Attribution:
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
  /**
   * The thread a reply went to, as a Slack ts.
   *
   * On `recall_hit` it is the thread a retrieved summary covers, which is the
   * same kind of fact reached from the other end. It stays one field because a
   * thread id means one thing here however the line came to carry it — and it is
   * an id, so the rule at the top of this file about message text is untouched:
   * it says which conversation was matched, never what was said in it.
   */
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
  /**
   * What authorized a proactive post: `heartbeat` or `task` (#318).
   *
   * A code from a two-member closed set, `revision`'s kind of field and never
   * prose. It is a field rather than two event words because the two are one
   * act governed in two places — the heartbeat's bound is the rate window, the
   * task's was its governed create — and an operator asking "is this thing
   * talking too much" wants both lines with one grep. Never content: it says
   * why a message existed, never what it said.
   */
  source?: string;
  /**
   * How much longer a refused proactive post would have had to wait.
   *
   * On `proactive_throttled` alone. The remaining window rather than when the
   * last post went out, because the question being asked is whether the window
   * is nearly open or just shut, and the second spelling makes a reader do the
   * subtraction against a clock they do not have.
   */
  waitMs?: number;
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
   * Carried on three lines and nowhere else — `task`, `spend_reported`,
   * `spend_report_failed` — and it means a *task* on one of them and a *turn*
   * on the other two. On `task` it is the whole task, summed. On
   * `spend_reported` and `spend_report_failed` it is the one turn that line is
   * about, because spend is reported per turn. A task whose reports do not add
   * up to its `task` line is a meter that missed something, which is the shape
   * an operator greps for when a channel's budget stops adding up.
   *
   * **Not the general count field** — that is `count` below, and reaching for
   * this one because a line needed a number is what #429 fixed. It had spread
   * to nine event words, six of which counted summaries, skills, proposals and
   * embeddings, and every one of those was a term in the sum above: the
   * discrepancy that means "the meter missed something" and the one that means
   * "a sweep embedded eleven things" had become the same number in the same
   * field. The rule that follows is `count`'s.
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
   * How many of the thing the `event` word names (#429).
   *
   * Summaries recalled, skills loaded, proposals waiting or pruned, skills
   * adopted or moved between statuses, embeddings stored. One field for nine
   * meanings, as the tool proxy service's own logger has one for its listings,
   * because six named fields would be six ways of writing the same declaration
   * and the reader needs the `event` word to make sense of the line regardless.
   *
   * **The line between this and a named field is whether summing across events
   * is meaningful.** `totalTokens`, `ops` and `dispatches` each mean one thing
   * everywhere they appear, so an operator can grep the field and add the values
   * up — which for `totalTokens` is the entire point of it. `count` means
   * something different on every line, so nothing sums it and a reader has to
   * say which event they are asking about. A number that would be wrong to add
   * to the number on the line above it belongs here; a number that would be
   * right to add belongs in a field of its own.
   *
   * `turns` is the field that field-tests the rule: it is a count on `task` and
   * an ordinal on the two spend lines, so it sums on one line and not the other
   * two. It stays named because both meanings are turns and its own doc says
   * which is which — but a second field wanting that shape should be two.
   *
   * A count and never the content, which is the part that was always right:
   * a summary is a channel's conversation distilled, a playbook's name is the
   * team's own words, and neither goes in a log line.
   */
  count?: number;
  /**
   * Which corpus a nearest-neighbour hit came from: `summary` or `skill`. On
   * `recall_hit` and nothing else (#427).
   *
   * `EmbeddingSource.kind`'s vocabulary less the member nothing writes — `fact`
   * is in that union and no corpus produces one, because curated facts reach a
   * task through `<channel-memory>` whole. A code from a closed set, and content
   * in neither direction: it says which index answered, never what the answer
   * said.
   *
   * A field rather than two event words, which is the opposite of the call made
   * for the summary and skill *embedding* failures above. Those are two words
   * because the two corpora fail for different reasons and an operator grepping
   * one is not asking about the other. This is one word because the two corpora
   * succeed the same way — one k-NN over one vector table — and the question
   * these lines exist to answer is precisely how their distances compare to each
   * other. Two words would make that comparison a join.
   */
  kind?: string;
  /**
   * Where a hit sat in the answer that produced its distance, counting from one.
   * On `recall_hit` and nothing else (#427).
   *
   * The rank *within the vector leg*, not within what the task finally loaded.
   * Skills fuse two rank lists, so a skill's position in the block is a fact
   * about the lexical leg as much as this one; `disposition` is what says
   * whether it survived, and this stays the number the distance is paired with.
   *
   * An ordinal, like `turns` on the two spend lines, and it belongs in a named
   * field for `distance`'s reason rather than `count`'s: it means the same thing
   * on every line that carries it.
   */
  rank?: number;
  /**
   * How far a nearest-neighbour hit was, as the L2 distance `packages/memory`
   * answers with. On `recall_hit` and nothing else (#427).
   *
   * **The one field here recorded for an analysis rather than for an operator.**
   * Nothing acts on it today: retrieval applies no distance cutoff, and #283
   * cannot decide on one — absolute, relative to the nearest hit, or per-provider
   * — without a distribution from a real corpus under more than one provider.
   * The distances were being computed and dropped, so however long a deployment
   * ran it produced no such distribution. This is the field that keeps them.
   *
   * It is not a count, so `count`'s rule does not sort it. That rule asks
   * whether adding a number to the one on the line above is meaningful, which
   * separates `totalTokens` from the nine things that were wrongly spelled as
   * it; nobody sums distances. What makes this a named field is the other half
   * of the same reasoning: `count` is the bag for a number whose meaning changes
   * with the `event` word, and a distance means one thing everywhere it appears
   * — L2 in the units of whatever the configured provider emits. The whole use
   * of the field is an aggregate over lines that carry it, which is exactly what
   * `count` cannot support.
   *
   * A number and never content. What it measures is a channel's own text, but
   * the measurement is not the text: a distance is not invertible into a summary
   * any more than a length is.
   *
   * The provider is deliberately not repeated on the line. It is a per-process
   * constant already on `embeddings_ready` through `embeddingModel`, and putting
   * it here would suggest this line can tell which model produced the *stored*
   * vector, which it cannot — a deployment that changed models without
   * re-embedding is a hazard the query's model would not reveal either.
   */
  distance?: number;
  /**
   * What became of a nearest-neighbour hit: `loaded`, `dropped_chars`,
   * `dropped_rank`, `oversize`, or `unresolved`. On `recall_hit` and nothing
   * else (#427).
   *
   * A code from a closed set. It is what makes the distances analysable rather
   * than merely present, because the cases are not one case: a hit that was near
   * and got cut for length says something about the character budget, and a hit
   * that was far says something about the cutoff #283 is trying to find. Reading
   * a distribution with the two collapsed would answer neither question.
   *
   * `unresolved` is the summary that was invalidated between being embedded and
   * being read, or the skill file that is gone; `dropped_rank` is a vector hit
   * the skill fusion never reached, which is the lexical leg outranking it
   * rather than anything about its distance.
   *
   * **Not `outcome`**, which is the tool proxy service's spelling for what it
   * did with a call — the audit log's vocabulary. Where the two loggers share a
   * field name (`verdict`, `report`, `count`) they share the fact, so that one
   * grep spans both ends; a second meaning for `outcome` would spend that
   * property for a synonym.
   *
   * Spelled as a union rather than as a `string`, which `sheet` is the
   * precedent for and most of this vocabulary is not. The others are codes a
   * reviewer checks; this one is a set an analysis groups by, so a sixth member
   * arriving by typo would not be a bad line, it would be a bucket. Widening it
   * is an edit here, which is the review this file exists to get.
   */
  disposition?: "loaded" | "dropped_chars" | "dropped_rank" | "oversize" | "unresolved";
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
