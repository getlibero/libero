// One agent task: a request in, a reply out, run on the model and the caps the
// channel's team sheet resolved to.
//
// It takes settings rather than reading them. Which channel a task belongs to,
// which sheet it runs on, and what it had to wait for are the router's, one
// layer up — this file only runs the loop and decides what a finished task is
// worth saying.
//
// Tools come from the proxy, over mutual TLS, and from nowhere else. One tool
// client per task, pinned to the request's channel: the certificate it presents
// is what tells the proxy which channel is calling, so a task cannot reach a
// channel whose certificate this process does not hold. This process still
// holds no tool credential — the proxy owns every one of them.
//
// What the task cost goes back the same way, on the same certificate, because
// the proxy's meter cannot count tokens it was not told about: it meters tool
// calls from calls it served, and only the process that talked to the model
// knows what a turn spent. A meter that cannot be reached costs an operator a
// counter, and that is not worth a user's answer — so the report is awaited,
// its failure is a log line, and the reply goes to the thread either way.
//
// The live checklist (#68) is driven from here, for the reason the spend report
// is: this is the only layer that sees both the loop's progress and how the task
// ended. The loop deliberately reports neither — a task's ending is its
// `AgentTaskResult`, which the caller already has, and the case where the loop
// *throws* has no result at all and is exactly the one a checklist must still
// close. So every exit closes it, which is what keeps a card from being left
// reading `WORKING` for a task that is over.

import { randomUUID } from "node:crypto";
import {
  ProxyClientError,
  createProxySpendClient,
  createProxyToolClient,
  runAgentTask,
  runCurationTurn,
  runSkillAuthorTurn,
  totalTokens
} from "@getlibero/agent";
import type {
  AgentStopReason,
  AgentTaskResult,
  CompletedTurn,
  CompletionClient,
  ProxySpendClient,
  ProxyTransport,
  ToolCallStep
} from "@getlibero/agent";
import type { ChecklistOutcome } from "../checklist/checklist.js";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import { budgetWarningMessage, type BudgetWarning } from "@getlibero/schema";
import type { TaskOutcome, TaskReply, TaskRequest, TaskRunner, TaskSettings } from "./types.js";

/**
 * The outcome that posts nothing and curates nothing.
 *
 * A shared frozen literal rather than `{ reply: undefined }` at each exit: the
 * two paths that use it — a task queued into a shutdown, and a listing cancelled
 * by one — are the paths where the operator asked for quiet, and one object says
 * that once.
 */
const NOTHING: TaskOutcome = Object.freeze({ reply: undefined });

/**
 * What the model is told it is.
 *
 * Terse on purpose, and it claims no capability the process has: this agent has
 * no tools, so a prompt describing tool use would be describing something the
 * loop cannot do. It says where the answer is going, because a Slack thread is
 * not a chat window and length is the difference.
 */
export const SYSTEM_PROMPT = [
  "You are Libero, answering in a Slack thread.",
  "Your tools are whatever this channel's team sheet permits, and that list is",
  "the whole of what you can do: a tool you were not given does not exist for",
  "this channel, and there is no way to ask for one. A call may still be",
  "refused or held for a human — relay what you are told and do not retry it.",
  "Answer from what you know when no tool fits, and say plainly when you do not know.",
  "Be brief. A thread reply is a few sentences, not an essay."
].join(" ");

/**
 * What the channel is told when the tool listing could not be fetched.
 *
 * Posted rather than swallowed, which is a departure from how an unreachable
 * model provider behaves. The reason is that this failure has a class the
 * provider's does not: a channel whose client certificate was never minted will
 * never answer again, and that is a first-run configuration mistake rather than
 * an outage. Silence there is indistinguishable from being ignored, by the one
 * group of people who cannot see the log.
 *
 * No sentence here is a synthesized answer to what was asked — that is the
 * thing this file refuses to do, and saying "the proxy could not be reached" is
 * the opposite of it.
 *
 * Which is also why there are three rather than two. A rejected certificate
 * (#79) is not an unreachable proxy: the proxy answered, and said no. Both of
 * the specific sentences name a permanent, operator-fixable state, and the
 * generic one is reserved for the case where this end genuinely cannot tell.
 */
export const PROXY_UNAVAILABLE: Record<
  "no_client_certificate" | "certificate_rejected" | "other",
  string
> = {
  no_client_certificate:
    "This channel has no client certificate for the tool proxy, so no tool call is possible. An operator mints one with `scripts/dev-certs.sh`.",
  certificate_rejected:
    "The tool proxy refused this channel's client certificate, so no tool call is possible. If it was just rotated, this channel's team sheet may not list the new fingerprint.",
  other:
    "The tool proxy could not be reached, so no tool call was possible. An operator has the detail in the server log."
};

/** Which of the three a transport failure gets. Everything else is `other`. */
function unavailableKey(reason: string): keyof typeof PROXY_UNAVAILABLE {
  if (reason === "no_client_certificate") return "no_client_certificate";
  if (reason === "certificate_rejected") return "certificate_rejected";
  return "other";
}

/**
 * A task that produced no text at all — a model that returned an empty turn, or
 * a cap that bit before the first one. Something has to be posted, or the
 * request goes unanswered with no way for the person who wrote it to tell the
 * difference between a broken deployment and being ignored.
 */
const NO_ANSWER = "No answer was produced.";

/**
 * The line appended when a cap ended the task rather than the model.
 *
 * Every one of these is reportable as-is, which is what `AgentStopReason` was
 * shaped for: a task that stops short must be able to say which limit stopped
 * it, because the fix for each is a different number in a different file — and
 * now, with the sheet read, usually a different number in the *channel's* file.
 *
 * `completed` and `refusal` are absent: the model's own text is the whole
 * reply, and a refusal is the model's to word rather than this file's to
 * annotate. `cancelled` is absent because a cancelled task posts nothing.
 */
const CAP_NOTE: Partial<Record<AgentStopReason, string>> = {
  tool_call_cap: "Stopped: per-task tool call cap reached.",
  wall_time_cap: "Stopped: per-task time limit reached.",
  token_cap: "Stopped: per-task token cap reached.",
  max_tokens: "Stopped: the reply hit the per-turn output limit.",
  stopped_other: "Stopped: the model ended the turn without an answer."
};

/**
 * The reply for a finished task, or `undefined` to post nothing.
 *
 * Exported for its own tests: this is the mapping that decides what a channel
 * is told when a task does not simply succeed, and it is worth testing without
 * a loop, a model, or a socket in the way.
 */
export function replyFor(result: AgentTaskResult, warning?: BudgetWarning): TaskReply | undefined {
  // The gateway is stopping and the operator asked for quiet. Posting a
  // shutdown notice into every open thread is noise at exactly the moment
  // nobody is watching.
  if (result.stopReason === "cancelled") return undefined;

  const note = CAP_NOTE[result.stopReason];
  const text = result.text.trim();

  // Appended, in the order a reader wants them: the answer, then why it stopped
  // if it stopped, then what the channel has left. Each is a fact about a
  // different thing, which is why they are separate paragraphs and not a
  // sentence — and the budget line is last because it is the only one that is
  // not about this task.
  const trailer = [note, warning === undefined ? undefined : budgetWarningMessage(warning)].filter(
    (line): line is string => line !== undefined
  );

  const body = text === "" ? (trailer.length === 0 ? NO_ANSWER : "") : text;
  return { text: [body, ...trailer].filter(line => line !== "").join("\n\n") };
}

export interface TaskRunnerOptions {
  completion: CompletionClient;
  /**
   * The mutual-TLS connection to the tool proxy. Required: there is no
   * toolless mode to fall back to, and `proxyConfigFromEnv` refuses to build
   * one from a half-set environment.
   */
  transport: ProxyTransport;
  /**
   * Cancels a task in flight. One signal for the process: shutdown aborts every
   * open task, and the loop reports `cancelled` rather than throwing.
   */
  signal?: AbortSignal;
  /** Defaults to silent, so a test asserting on behaviour is not also a log sink. */
  logger?: Logger;
}

/**
 * Builds the runner the router drives.
 *
 * It never throws for a cap, a refusal, or a proxy that cannot be reached —
 * all three are replies. It does still throw when the model provider is
 * unreachable, which the gateway logs as `handler_failed` and answers by
 * posting nothing: an operator problem is not something to paper over with a
 * synthesized answer in someone's thread.
 *
 * There is no default for `settings`. `AgentLoopCaps` argues that a caller must
 * not be able to leave a task uncapped by omission, and defaulting the
 * parameter that carries the caps would be exactly that.
 */
export function createTaskRunner(options: TaskRunnerOptions): TaskRunner {
  const logger = options.logger ?? createSilentLogger();

  return async (request: TaskRequest, settings: TaskSettings): Promise<TaskOutcome> => {
    // Work that was queued when the process was asked to stop. Without this,
    // every request behind a slow one opens a TLS connection for a tool listing
    // that is cancelled the moment it arrives.
    if (options.signal?.aborted === true) return NOTHING;

    const channel = request.key.channel;

    /**
     * The soft budget warning, if the proxy handed one back on a served call.
     *
     * Held for the reply rather than posted where it happens, and that is the
     * boundary rather than a preference: `SlackSurface` withholds
     * `postThreadReply` from this process precisely so a handler cannot post out
     * of band, and a notice is not the exception a card is — a card's lifetime
     * outlives the task that raised it, and this one does not. So it travels the
     * way every other thing a task has to say travels: on the answer.
     *
     * **First one wins.** The proxy claims a channel's warning once a day, so a
     * second is not something it can send; `??=` is what keeps that true here if
     * it ever does, rather than a last-write-wins that would depend on which
     * tool call finished last.
     */
    let warning: BudgetWarning | undefined;

    // One client per task, holding this channel's certificate and no other's.
    // Both halves come from the same object because they share the mapping from
    // the name the model calls to the (server, tool) pair the proxy takes — a
    // model can only call what this channel's sheet published. The request's
    // prompter rides along when the front-end built one: a held call is then
    // waited out against a human instead of relayed as a refusal.
    const tools = createProxyToolClient({
      transport: options.transport,
      channel,
      ...(request.onHeld !== undefined ? { onHeld: request.onHeld } : {}),
      // A tool call the client refused before the proxy was asked. It is logged
      // here rather than there because that package has no way to log and
      // should not gain one — the same split `reportSpend` below runs on — and
      // because the channel and the front-end's trace id are in scope here and
      // not in a client pinned to one task.
      //
      // `warn`, not `info`: nothing is broken, but nothing designed this
      // either. A model naming a tool this channel was never given is either a
      // confused turn or the cheapest probe there is, and the operator reading
      // the audit log sees neither — the proxy never saw the call.
      //
      // The name is model-authored text, so it goes in `tool` as a value and is
      // never part of a message. See the field's own comment in
      // @getlibero/gateway.
      onUnmappedCall: ({ name, requestingUser, taskId }) =>
        logger.log("warn", {
          event: "tool_not_permitted",
          channel,
          eventId: request.traceId,
          task: taskId,
          user: requestingUser,
          tool: name
        }),
      // The channel crossed its soft budget limit on a call that ran (#99).
      // Logged here and relayed in the reply below; the model is not told, for
      // the reason `onBudgetWarning` gives.
      //
      // `warn`, on `tool_not_permitted`'s terms: nothing is broken and nothing
      // was denied, but a channel four fifths through its day is a thing an
      // operator wants to see before the refusals start.
      onBudgetWarning: crossed => {
        warning ??= crossed;
        logger.log("warn", {
          event: "budget_warning",
          channel,
          eventId: request.traceId,
          task: taskId,
          limit: crossed.limit
        });
      }
    });

    // Same channel, same certificate, and pinned the same way: what a task cost
    // is reported as the channel that spent it, or not at all.
    const spend = createProxySpendClient({ transport: options.transport, channel });

    /**
     * How the checklist is closed, and the sentence that goes with it.
     *
     * Initialized to `failed` rather than to a hopeful default, which is what
     * makes the `finally` below total: every path that reaches an ending sets
     * it, and a path that throws before any of them — a bug here, a provider
     * that rejects in a way nothing anticipated — closes the card honestly
     * instead of leaving it mid-task.
     */
    let ending: ChecklistOutcome = "failed";
    let endingNote: string | undefined;

    /**
     * How many tool calls the proxy served and answered without an error.
     *
     * **The author turn's threshold is compared against this and not against
     * `AgentTaskResult.toolCalls` (#291), and the difference is the issue's own
     * words rather than a preference.** `[skills] author_after_tool_calls` says
     * it counts calls the proxy *served*; the loop's counter increments the
     * moment a call is dispatched, before the executor runs, so a refused tool,
     * an unmapped name and an upstream 500 are all in it. A task whose six calls
     * were all refused learned that this channel's sheet does not grant those
     * tools, and a playbook written from it would be a playbook about tools that
     * do not work here.
     *
     * The issue asks for "no new counting", and this keeps that promise where it
     * can: nothing is added to the loop, and the number comes off `onToolCall`,
     * a callback that already existed for the checklist. What it costs is that
     * the hook is now always wired rather than only when a checklist was built,
     * which is the sentence below.
     */
    let served = 0;

    // Minted here rather than by the loop, which is what `taskId` is for: a
    // turn's report has to be named before the turn happens, and the loop only
    // hands its id back when the task is over. Every turn's id derives from
    // this one, so a task's reports, its tool calls, and its log lines all
    // carry the same root.
    const taskId = randomUUID();

    // Everything from here has an ending, and the checklist is closed on
    // every one of them — including a throw, which is the path the loop cannot
    // report and the one a reader is most likely to be left staring at.
    try {
      let result: AgentTaskResult;
      try {
        result = await runAgentTask({
          taskId,
          completion: options.completion,
          toolSource: tools,
          toolExecutor: tools,
          // The channel's, out of its team sheet, with AGENT_MODEL behind it.
          model: settings.model,
          // Attribution for the audit log, not authentication: nothing in the
          // proxy decides anything from it. The requesting user as the front-end
          // sent it — display-name resolution is the context assembler's (#67),
          // and a name is not what an audit record wants anyway.
          requestingUser: request.requestingUser,
          system: SYSTEM_PROMPT,
          // The whole seed transcript, already assembled: the channel's recent
          // messages with their authors, then what was asked. Built by the router
          // from the session's store and name cache, because those are the
          // session's and this file is given one task's settings rather than a
          // channel's state.
          //
          // A copy, because `AgentTaskOptions.messages` is mutable and the loop's
          // contract is only that it does not mutate what it was handed.
          messages: [...settings.messages],
          // The channel's `[llm]` caps. Defence in depth — the proxy's meter is
          // what is authoritative — but the channel's numbers rather than the
          // process's.
          caps: settings.caps,
          // Reported as the turns happen, not when the task ends. See
          // `reportSpend`.
          onTurn: completed => reportSpend(spend, taskId, completed, request, logger),
          // Where the checklist's rows come from, and since #291 where the
          // author turn's threshold comes from too. Synchronous and not
          // awaited, which is the hook's contract: the reporter coalesces
          // behind it, so a fast loop does not wait on a Slack edit between
          // tool calls.
          //
          // **Always wired now, where it used to be omitted for a request with
          // no checklist.** Two consumers with different lifetimes: a card is
          // the front-end's and may not exist, and the count is this file's and
          // always does. The checklist half keeps its own `undefined` check, so
          // a request without one still reports nothing anywhere.
          //
          // `ok` and not `!isError`: `ToolCallState` has four members and the
          // other three — `running`, `error`, `skipped` — are each a call that
          // taught the model something about this channel's limits rather than
          // a step of a playbook. Counting `running` would also double-count
          // every call, since each one reports twice.
          onToolCall: (step: ToolCallStep) => {
            if (step.state === "ok") served += 1;
            request.checklist?.report(step);
          },
          ...(options.signal !== undefined ? { signal: options.signal } : {})
        });
        ending = result.stopReason;
        endingNote = CAP_NOTE[result.stopReason];
      } catch (error) {
        // Only the tool listing reaches here. A failed tool *call* never does —
        // the loop turns it into an error result the model relays, so the task
        // still answers — and every other throw is the provider's and stays the
        // gateway's to log.
        if (!(error instanceof ProxyClientError)) throw error;

        // A cancelled listing is the process shutting down, and shutdown posts
        // nothing: the operator asked for quiet, and this would otherwise put a
        // line into every thread open at that moment. The checklist still
        // closes — a card is not a reply, and one left reading `WORKING` after
        // a restart is worse than a quiet thread.
        if (error.reason === "cancelled") {
          ending = "cancelled";
          return NOTHING;
        }

        logger.log("error", {
          event: "tools_unavailable",
          channel,
          eventId: request.traceId,
          reason: error.reason
        });
        // `failed` already, from the initializer — the listing never came back,
        // so no tool call was ever attempted and there is usually no card at
        // all. Setting it here would be restating the default.
        return { reply: { text: PROXY_UNAVAILABLE[unavailableKey(error.reason)] } };
      }

      // The one thing the gateway's own `mention`/`replied` pair cannot show: why
      // a task ended, what it cost in total, and which model it cost that on. The
      // per-turn `spend_reported` lines say what the meter was told and sum to
      // this; a task line whose `totalTokens` is larger than its reports add up to
      // is a meter that missed something, which is worth being able to see at a
      // glance.
      logger.log("info", {
        event: "task",
        channel,
        eventId: request.traceId,
        task: result.taskId,
        model: settings.model,
        stopReason: result.stopReason,
        totalTokens: result.totalTokens,
        turns: result.turns
      });

      const reply = replyFor(result, warning);
      const afterReply = afterReplyFor({
        options,
        logger,
        request,
        settings,
        result,
        spend,
        served
      });
      return afterReply === undefined ? { reply } : { reply, afterReply };
    } finally {
      // Awaited, so the card is terminal before the reply lands under it. It
      // never rejects: `close` is total, for the reason `reportSpend` is.
      await request.checklist?.close(ending, endingNote);
    }
  };
}

interface AfterReplyInputs {
  readonly options: TaskRunnerOptions;
  readonly logger: Logger;
  readonly request: TaskRequest;
  readonly settings: TaskSettings;
  readonly result: AgentTaskResult;
  readonly spend: ProxySpendClient;
  /** Tool calls this task made that the proxy served and answered. See `served`. */
  readonly served: number;
}

/**
 * Everything that follows the reply, as one thunk, or `undefined` when nothing
 * does.
 *
 * **Built here and run elsewhere, which is the ordering decision (#227).** All
 * of its inputs are local to a finished task — the task id the spend report keys
 * on, the transcript the loop produced, the turn count that makes the next turn
 * `<task>.<n+1>` — and none of them escape this file. But *when* it runs is a
 * question about the session queue, and the queue belongs to `router.ts`. So
 * this closes over the answer to "what", and hands the router the "when".
 *
 * The router enqueues it on the same per-channel mutex the task held, without
 * awaiting it: the reply is not delayed by two more model calls, and the next
 * task's context read is still serialized against these writes. What that costs
 * is stated in `apps/server/README.md` — a follow-up that queued *during* the
 * task goes ahead of this one and reads the file as it was.
 *
 * **One thunk covering both turns rather than one each (#291).** They share a
 * turn counter, and that is not tidiness: `<task>.<n>` is the spend meter's
 * idempotency key, curation takes `result.turns + 1`, and a sibling closure
 * cannot know whether curation ran — so it would have to claim `+ 2`
 * unconditionally and leave a gap whenever `[memory] enabled = false`, which
 * `CurationTurnOptions.turn` explicitly promises will not happen. A local
 * counter keeps the promise for every combination.
 *
 * **Curation first, then authoring**, and the order is only weakly load-bearing:
 * neither reads what the other writes, so what it really settles is that a
 * process asked to stop mid-way drops the newer feature rather than the shipped
 * one.
 *
 * **It never rejects.** It is invoked detached, so a rejection would be an
 * unhandled one at the process level rather than something a caller could relay,
 * and the reply it follows has already been produced. Every failure is a line.
 */
function afterReplyFor(inputs: AfterReplyInputs): (() => Promise<void>) | undefined {
  const curate = curationFor(inputs);
  const author = authoringFor(inputs);
  if (curate === undefined && author === undefined) return undefined;

  const { options, result } = inputs;

  // The shared counter, and the reason this is one function. Curation takes the
  // task's turn count plus one; whichever runs next takes the one after that.
  let turn = result.turns;
  const next = (): number => {
    turn += 1;
    return turn;
  };

  return async (): Promise<void> => {
    // Queued when the process was asked to stop. The reply these follow may not
    // have posted at all — the gateway drops one when it is no longer running —
    // so spending two model calls on it is work nobody asked for. Checked once
    // here rather than in each half, because a shutdown between them is not a
    // state worth distinguishing.
    if (options.signal?.aborted === true) return;

    if (curate !== undefined) await curate(next());
    if (author !== undefined) await author(next());
  };
}

/**
 * The curation turn, closed over everything but its turn number, or `undefined`
 * when this channel does not curate.
 *
 * It takes the number rather than closing over one because `afterReplyFor` owns
 * the counter — see there for why that has to be shared. Everything else about
 * where this is built and when it runs is on `afterReplyFor` too.
 */
function curationFor(inputs: AfterReplyInputs): ((turn: number) => Promise<void>) | undefined {
  const { options, logger, request, settings, result, spend } = inputs;
  const file = settings.memoryFile;

  // Three ways not to curate, and only the first is a policy. The sheet said no;
  // the file could not be opened, which `session/memory.ts` has already logged;
  // or the task ran no turns at all, so there is no conversation to draw a
  // durable fact out of.
  if (!settings.memory.enabled || file === undefined || result.turns === 0) return undefined;

  const channel = request.key.channel;

  return async (turn: number): Promise<void> => {
    try {
      const curated = await runCurationTurn({
        completion: options.completion,
        model: settings.model,
        messages: result.messages,
        // Read here rather than when the task ended: a hand edit, or the previous
        // task's own curation, may have landed in between.
        memory: file.read(),
        maxFileChars: settings.memory.maxFileChars,
        applyOp: op => file.apply(op),
        // The per-turn ceiling, never `max_tokens_per_task`: this runs after the
        // task is over, and a task that ended by spending its cap is the one most
        // worth remembering.
        maxTokens: settings.caps.maxOutputTokensPerTurn,
        // Continues the task's own numbering, so the spend report's idempotency
        // key stays `<task>.<n>` with no gap and no collision. The number is
        // `afterReplyFor`'s to hand out, because the author turn shares it.
        turn,
        onTurn: completed => reportSpend(spend, result.taskId, completed, request, logger),
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });

      logger.log("info", {
        event: "curated",
        channel,
        eventId: request.traceId,
        task: result.taskId,
        // How many operations the model asked for, not how many landed. What each
        // one *did* is deliberately not logged: the arguments are the channel's
        // own text, and `LogFields` has no member that could carry them and
        // should not grow one.
        ops: curated.ops.length
      });
    } catch (error) {
      // Swallowed, and this is the only place it can be. The reply has been
      // produced, nothing above is awaiting this, and a provider outage during
      // curation must not become an unhandled rejection that ends the process.
      logger.log("error", {
        event: "curation_failed",
        channel,
        eventId: request.traceId,
        task: result.taskId,
        reason: error instanceof Error ? error.name : "unknown"
      });
    }
  };
}

/**
 * The skill-author turn, or `undefined` when this task earned no playbook (#291).
 *
 * `curationFor`'s shape, with a different set of ways not to run. Two of them
 * are the same — the sheet said no, and the directory could not be opened, which
 * `session/skills.ts` has already logged — and the third is this turn's own.
 *
 * **The threshold is strictly greater**, which the schema pins rather than
 * leaving two implementations to discover, and it is compared against tool calls
 * the proxy *served* rather than against `AgentTaskResult.toolCalls`. See
 * `served` in the runner for why those are different numbers.
 *
 * There is deliberately no `result.turns === 0` clause to mirror curation's. A
 * task that ran no turns served no tool calls either, so the threshold has
 * already refused it, and a second guard on a state the first makes unreachable
 * would be a mechanism implying a hazard it cannot reach.
 */
function authoringFor(inputs: AfterReplyInputs): ((turn: number) => Promise<void>) | undefined {
  const { options, logger, request, settings, result, spend, served } = inputs;
  const files = settings.skillFiles;

  if (!settings.skills.enabled || files === undefined) return undefined;
  if (served <= settings.skills.authorAfterToolCalls) return undefined;

  const channel = request.key.channel;

  return async (turn: number): Promise<void> => {
    try {
      const authored = await runSkillAuthorTurn({
        completion: options.completion,
        model: settings.model,
        messages: result.messages,
        // What retrieval already loaded at the head of this task (#292), rather
        // than a second search. These are the nearest existing skills on this
        // task's own subject by construction, and they are what makes a
        // `skill_revise` a revision instead of a blind overwrite.
        nearby: settings.loadedSkills ?? [],
        // Counted here rather than when the task started: the previous task's
        // own authoring, or a team member with an editor, may have landed in
        // between. `list` answers names and opens no file, which is what makes
        // it cheap enough to read per turn.
        skills: files.list().length,
        maxSkills: settings.skills.maxSkills,
        applyOp: op => files.apply(op),
        // The per-turn ceiling, never `max_tokens_per_task` — and here the task
        // most worth a playbook is exactly the long tool-heavy one most likely
        // to have spent that cap.
        maxTokens: settings.caps.maxOutputTokensPerTurn,
        turn,
        onTurn: completed => reportSpend(spend, result.taskId, completed, request, logger),
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });

      logger.log("info", {
        event: "authored",
        channel,
        eventId: request.traceId,
        task: result.taskId,
        // How many operations the model asked for, not how many landed, and
        // never what any of them said: a playbook is the team's own text and
        // `LogFields` has no member that could carry it. `curated` logs its
        // count the same way and through the same field.
        ops: authored.ops.length
      });
    } catch (error) {
      // Swallowed, for `curationFor`'s reason: the reply has been produced,
      // nothing above is awaiting this, and a provider outage here must not
      // become an unhandled rejection that ends the process.
      logger.log("error", {
        event: "authoring_failed",
        channel,
        eventId: request.traceId,
        task: result.taskId,
        reason: error instanceof Error ? error.name : "unknown"
      });
    }
  };
}

/**
 * Tell the meter what one turn cost, and never let that cost the user an answer.
 *
 * **Per turn, not per task**, which is the loop's `onTurn` contract and the
 * reason it exists. A report that waits for the task means a long task spends
 * its whole cost before the meter hears any of it — so a channel already over
 * its cap is refused starting with the *next request* rather than this task's
 * next tool call — and a task that dies mid-flight spends silently, because
 * `runAgentTask` rejects and everything counted so far goes with the rejection.
 * Reporting as the turns happen fixes both (#115).
 *
 * **The turn id is `<task>.<n>`.** The root is the task id this process minted
 * and the model never saw, so a task's reports sit next to its tool calls and
 * its `task` log line under one grep, and the audit records the proxy will
 * write (#97) join on the same root. The suffix is what makes each turn its own
 * idempotency key: a retry of turn 3 is a `duplicate`, and turn 4 is not.
 *
 * **Awaited**, which the loop does on this function's behalf. A detached send
 * would let the next turn start before this one was recorded, and would usually
 * be killed anyway — the process does not drain in-flight work before exiting.
 * The client carries its own short deadline, so the worst a proxy that accepts
 * a connection and then goes quiet can do is delay each turn by it.
 *
 * **It never throws**, and that is load-bearing rather than tidy: the loop does
 * not catch, so a rejection here would end the task and lose the user's answer
 * because a *counter* could not be written. A turn that spent nothing reports
 * nothing — four zeros move no counter.
 *
 * **No retry.** The report is idempotent, so one would be safe — but the
 * failures worth retrying are the ones that do not clear in milliseconds, a 400
 * is a bug in what was sent, and the only retry that survives a restart is a
 * durable one this process does not have. The log line is the remedy: it says
 * the meter is running blind, and by how much.
 */
async function reportSpend(
  spend: ProxySpendClient,
  taskId: string,
  completed: CompletedTurn,
  request: TaskRequest,
  logger: Logger
): Promise<void> {
  const { usage, turn, model } = completed;
  const spent = totalTokens(usage);
  if (spent === 0) return;

  try {
    const outcome = await spend.report(`${taskId}.${turn}`, usage, model);
    logger.log("info", {
      event: "spend_reported",
      channel: request.key.channel,
      eventId: request.traceId,
      task: taskId,
      turns: turn,
      report: outcome,
      totalTokens: spent,
      // The model that *served* the turn, which is not the `model` on this
      // task's own log line — that one is what the sheet asked for. Under a
      // router they differ, and it is this one a price table is keyed by.
      ...(model === undefined ? {} : { servedModel: model })
    });
  } catch (error) {
    // Everything, including what is not a `ProxyClientError`. A bug in the
    // sender must not become a lost reply — and here that is not a figure of
    // speech, because the loop propagates whatever this throws.
    logger.log("error", {
      event: "spend_report_failed",
      channel: request.key.channel,
      eventId: request.traceId,
      task: taskId,
      turns: turn,
      totalTokens: spent,
      reason: error instanceof ProxyClientError ? error.reason : "unknown"
    });
  }
}
