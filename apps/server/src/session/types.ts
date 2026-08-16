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
import type { MemoryFile } from "@getlibero/memory";
import type { ChecklistReporter } from "../checklist/checklist.js";

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
 * `author_after_tool_calls` is deliberately absent. It bounds the author turn
 * (#291), which nothing here runs yet, and a field with no reader is a field a
 * test cannot tell from a typo.
 */
export interface SkillSettings {
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
}

/**
 * What a finished task leaves behind: the reply, and the memory work that should
 * follow it.
 *
 * **`curate` is a thunk rather than something the runner already did, and the
 * split is the ordering decision (#227).** Everything curation needs — the task
 * id the spend report keys on, the finished transcript, the turn count that
 * makes the next turn id `<task>.<n+1>` — is function-local to the runner and
 * escapes nowhere else. But *when* it runs is a question about the session
 * queue, which the runner cannot see and the router owns. So the runner closes
 * over the answer and the router decides when to ask for it.
 *
 * Absent when the channel's sheet disables curation, when the task produced
 * nothing to curate, or when there is no memory file to write.
 */
export interface TaskOutcome {
  /** What to post. `undefined` posts nothing. */
  readonly reply: TaskReply | undefined;
  /**
   * The curation turn, ready to run.
   *
   * **It never rejects**, for `reportSpend`'s reason: it is invoked detached
   * from the reply that has already been produced, so a rejection would be an
   * unhandled one at the process level rather than something a caller could
   * relay. It swallows and logs where it has a logger.
   */
  readonly curate?: () => Promise<void>;
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
