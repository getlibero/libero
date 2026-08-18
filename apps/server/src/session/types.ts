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
import type { MemoryFile, SkillFiles } from "@getlibero/memory";
import type { ChecklistReporter } from "../checklist/checklist.js";
import type { LoadedSkill } from "./skill-recall.js";

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
   * Which sub-conversation this belongs to, as an opaque id.
   *
   * `handler.test.ts` used to assert that no Slack timestamp reached this type
   * and named #66 as what would decide it; this is that decision. Two things
   * need it and neither is Slack-shaped: the transcript is read from this
   * thread rather than from the channel around it, and the thread is what a
   * completed task marks active so a reply to the answer needs no second
   * mention.
   *
   * **Opaque, and only ever compared.** Nothing here parses it, orders it, or
   * derives anything from it — it is a map key and a store argument. A Slack
   * `thread_ts` today; a second front-end supplies whatever names a
   * sub-conversation in its own world, and one with no such concept can supply
   * the request's own id, which makes every request its own thread.
   *
   * Always present. A front-end with nothing to put here would be one whose
   * every task shares one thread, which is a worse default than a distinct one.
   */
  readonly thread: string;
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
  /**
   * Where this task reports its progress, if the front-end gave it somewhere.
   *
   * `onHeld`'s shape and `onHeld`'s argument: the front-end that built the
   * request already decided where a checklist goes — a message in the mention's
   * thread — and this layer cannot see how. The type names nothing Slack-shaped,
   * which is what lets it cross into a directory whose ESLint block admits no
   * Slack type.
   *
   * Absent, a task runs exactly as it did before #68 and posts nothing but its
   * answer. That is still right for a front-end with no message to edit — a CLI,
   * an HTTP request/response.
   */
  readonly checklist?: ChecklistReporter;
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

/**
 * What a channel's `[memory]` block resolved to.
 *
 * **The one part of a sheet this process honours alone.** Everything else
 * resolved here is advisory — the tool proxy enforces the same file from its own
 * copy, which is what makes a fallback safe. The proxy never opens `MEMORY.md`
 * and holds no second copy of these two numbers, so what this resolves is not a
 * defence-in-depth restatement of a decision made elsewhere; it *is* the
 * decision. `createSheetResolver`'s fallback for this block therefore differs
 * from the schema's default, and that is argued where the fallback lives.
 */
export interface MemorySettings {
  /** `[memory] enabled`. False runs no curation turn and reads nothing back. */
  readonly enabled: boolean;
  /**
   * `[memory] summarize`. False runs no quiescence sweep in this channel.
   *
   * Separate from `enabled` above rather than folded into it, because the two
   * authorize different things. Curation writes a file after a task somebody
   * asked for; summarization spends this channel's tokens on threads nobody
   * addressed the agent about. A channel may reasonably want the first and not
   * the second.
   */
  readonly summarize: boolean;
  /** `[memory] summarize_after_idle_minutes`, in milliseconds. */
  readonly summarizeAfterIdleMs: number;
  /** `[memory] max_file_chars`, the whole file's ceiling in characters. */
  readonly maxFileChars: number;
}

/**
 * What a channel's `[skills]` block resolved to.
 *
 * **The second block this process honours alone**, and everything
 * `MemorySettings` says about that standing is true here word for word: the
 * proxy never opens a skill file and holds no second copy of these numbers, so
 * this is the decision rather than a restatement of one. The fallback therefore
 * differs from the schema's default, and it is argued where the fallback lives.
 *
 */
export interface SkillSettings {
  /**
   * `[skills] author_after_tool_calls`. **Strictly more than this many.**
   *
   * The schema pins the comparison rather than leaving two implementations to
   * discover it, and it counts calls the proxy **served** — not calls the model
   * attempted. A task whose six calls were all refused learned that this
   * channel's sheet does not grant those tools, and a playbook written from it
   * would be a playbook about tools that do not work here.
   *
   * That distinction is why `AgentTaskResult.toolCalls` is not what this is
   * compared against: the loop increments its counter for every call it
   * *dispatches*, before the executor runs, so refusals and errors are in it.
   * `session/task.ts` counts `onToolCall` steps that reached `ok` instead.
   */
  readonly authorAfterToolCalls: number;
  /**
   * `[skills] enabled`. False loads no skill into a task's context.
   *
   * One switch rather than a read half and a write half, unlike `[memory]`'s
   * pair. Curation and summarization authorize different acts — one follows a
   * task somebody asked for, the other spends on threads nobody addressed —
   * whereas both halves of skills follow a task somebody asked for. A channel
   * that wants the library read but not written has said so by not raising the
   * author threshold, which is a number rather than a second switch.
   */
  readonly enabled: boolean;
  /**
   * `[skills] curate`. False proposes no merges, and changes nothing else.
   *
   * A second switch on a block whose others are numbers, and the asymmetry with
   * `enabled` is the one `[memory]` already draws: both halves of authoring
   * follow a task somebody asked for, and this does not — it is the one skill
   * pass that spends a model call on the channel's own clock rather than on a
   * mention. A channel that wants its playbooks written and retrieved but never
   * second-guessed says so here without giving up either.
   */
  readonly curate: boolean;
  /** `[skills] top_k`. How many skills a task may open with. */
  readonly topK: number;
  /**
   * `[skills] max_skill_chars`. The longest a single skill's body may be.
   *
   * **Read here rather than in `packages/memory`, which is where #300 said it
   * would land.** That package declined the field on the grounds that what it
   * bounds is what a body may *be* once somebody has hand-written one — a fact
   * about a file nothing there wrote — and that refusing such a file "is the
   * indexer's outcome to name". This is the indexer's caller, so this names it:
   * an over-cap skill is not loaded into a task.
   *
   * No operation can produce one, because the schema's floor for this field is
   * `SKILL_BODY_MAX_CHARS`. What it bites on is a playbook the team wrote by
   * hand and then let grow.
   */
  readonly maxSkillChars: number;
  /** `[skills] max_skills`, the whole library's ceiling. */
  readonly maxSkills: number;
  /**
   * `[skills] stale_after_days`, in milliseconds. Unused this long and the
   * lifecycle job marks a skill `stale`.
   *
   * Days in the sheet and milliseconds here, the conversion
   * `summarizeAfterIdleMs` already makes and for its reason: the sheet carries
   * the unit an operator thinks in.
   *
   * What "unused" is measured from is the *index* — when a task last loaded the
   * skill, or when this store first saw it — and never `created` in the file,
   * which is model-authored text a team may edit.
   */
  readonly staleAfterMs: number;
  /**
   * `[skills] archive_after_days`, in milliseconds. Unused this long and the
   * skill leaves retrieval entirely.
   *
   * Never below `staleAfterMs`: the schema refuses a sheet that says otherwise,
   * because the wrong order makes `stale` unreachable rather than expressing a
   * policy anybody meant.
   */
  readonly archiveAfterMs: number;
}

/**
 * The `[ambient]` block: whether this channel is spoken to unbidden, and on what
 * clock (#316, first read by #317).
 *
 * Not like the rest for `MemorySettings`' reason and more sharply. The proxy
 * holds no second copy of this block — it governs a post this process makes on
 * its own initiative, and there is no tool call in it for the proxy to decide —
 * so what is resolved here *is* the decision rather than defence in depth.
 */
export interface AmbientSettings {
  /**
   * `[ambient] enabled`. Off unless the sheet says otherwise, and the one switch
   * on this sheet whose default is off: everything else here is a bound on work
   * somebody asked for, and this is work nobody did.
   */
  readonly enabled: boolean;
  /**
   * `[ambient] heartbeat_every_minutes`, in milliseconds. How often anyone
   * looks.
   *
   * Minutes on the sheet because that is the unit an operator writes;
   * milliseconds from here in, `summarizeAfterIdleMs`' conversion and its
   * reason. It is a cadence rather than a schedule — see the schema on why this
   * is an interval and not a cron expression.
   */
  readonly heartbeatEveryMs: number;
  /**
   * `[ambient] answer_after_idle_minutes`, in milliseconds. How long a question
   * sits before a heartbeat may answer it.
   *
   * **Carried and not yet read**, the standing `authorAfterToolCalls` had ahead
   * of #291: the scheduler decides *when to look*, and what counts as
   * unanswered is the evaluation turn's question (#319).
   */
  readonly answerAfterIdleMs: number;
}

/** What a channel's team sheet resolved to. Everything here came out of the file. */
export interface ChannelSettings {
  /** The sheet's `[llm] model`, or `AGENT_MODEL`. Passed to the provider verbatim. */
  readonly model: string;
  /** The four per-task caps, out of the sheet's `[llm]` block. */
  readonly caps: AgentLoopCaps;
  /** The two context bounds, out of the same block. */
  readonly history: HistoryBounds;
  /**
   * How long this task's thread goes on accepting replies with no mention,
   * from `[llm] follow_up_window_seconds`. Milliseconds here, seconds in the
   * sheet — the same conversion `max_task_seconds` gets, and for the same
   * reason.
   *
   * On `ChannelSettings` rather than beside the bounds because it is neither: a
   * bound decides what one task starts with, and this decides whether there is
   * a *next* task at all. `0` is a channel that answers only when addressed.
   */
  readonly followUpWindowMs: number;
  /** The `[memory]` block. See `MemorySettings` for why it is not like the rest. */
  readonly memory: MemorySettings;
  /** The `[skills]` block, which is not like the rest for the same reason. */
  readonly skills: SkillSettings;
  /** The `[ambient]` block, which is not like the rest for a sharper one. */
  readonly ambient: AmbientSettings;
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
  /**
   * This channel's `MEMORY.md`, opened for the same serialized step.
   *
   * Optional, unlike `messages`, and the asymmetry is real rather than
   * convenience. A transcript always exists — a channel with no history still
   * produces a well-formed one — so an assembler that could be skipped would be
   * one a caller forgets. A memory file genuinely may not: the channel may have
   * disabled curation, or its sheet may name a cap the store refuses, or the
   * file may not have been openable. Absent means no curation turn runs, which
   * is a state the deployment can legitimately be in.
   *
   * Named apart from `ChannelSettings.memory`, which is what the *sheet* said.
   * This is the file itself.
   */
  readonly memoryFile?: MemoryFile;
  /**
   * This channel's `skills/` directory, opened for the same serialized step.
   *
   * `memoryFile`'s shape and its asymmetry: absent means no author turn runs,
   * which is a state the deployment can legitimately be in — the sheet disabled
   * skills, or the directory could not be opened. Named apart from
   * `ChannelSettings.skills`, which is what the *sheet* said.
   */
  readonly skillFiles?: SkillFiles;
  /**
   * The skills retrieval loaded into this task's opening context (#292).
   *
   * Carried through to the author turn rather than retrieved a second time:
   * these are already the nearest existing skills on the task's own subject, and
   * a second search would spend an embedding to answer a question that has just
   * been answered. Empty is ordinary.
   *
   * **Not the same fact as `messages`, even though they are rendered into it.**
   * The transcript holds them as one block of prose inside a `user` message; the
   * author turn needs them as structured files, because it shows each one under
   * its own name so a `skill_revise` can address it.
   */
  readonly loadedSkills?: readonly LoadedSkill[];
}

/**
 * What a finished task leaves behind: the reply, and the model work that should
 * follow it.
 *
 * **`afterReply` is a thunk rather than something the runner already did, and
 * the split is the ordering decision (#227).** Everything those turns need — the
 * task id the spend report keys on, the finished transcript, the turn count that
 * makes the next turn id `<task>.<n+1>` — is function-local to the runner and
 * escapes nowhere else. But *when* it runs is a question about the session
 * queue, which the runner cannot see and the router owns. So the runner closes
 * over the answer and the router decides when to ask for it.
 *
 * It was called `curate` until #291, when the skill-author turn became the
 * second thing that follows a reply.
 */
export interface TaskOutcome {
  /** What to post. `undefined` posts nothing. */
  readonly reply: TaskReply | undefined;
  /**
   * Every model turn that follows the reply, as one thunk, ready to run.
   *
   * **One thunk and not one per turn**, which #291 decided when the author turn
   * joined curation here. A turn id is `<task>.<n>` and is the spend meter's
   * idempotency key, so the two have to agree on a counter — and a sibling thunk
   * could not, because it cannot know whether the other one ran. It would have
   * to claim `result.turns + 2` unconditionally and leave a gap whenever
   * `[memory] enabled = false`, which is exactly what `CurationTurnOptions.turn`
   * promises will not happen. One thunk holds the counter in a closure and the
   * promise stays true whichever turns fire.
   *
   * Absent when neither turn would run. The individual reasons are the runner's;
   * from here it is one question.
   *
   * **It never rejects**, for `reportSpend`'s reason: it is invoked detached
   * from the reply that has already been produced, so a rejection would be an
   * unhandled one at the process level rather than something a caller could
   * relay. It swallows and logs where it has a logger.
   */
  readonly afterReply?: () => Promise<void>;
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
) => Promise<TaskOutcome>;
