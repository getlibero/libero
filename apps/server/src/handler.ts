// The seam between the two packages: a Slack mention in, a thread reply out,
// one agent task in between.
//
// Everything channel-shaped is deliberately absent. There is no session key, no
// per-channel mutex, no thread history, no team sheet — so two mentions in one
// channel run concurrently and each task starts from nothing but the mention
// text. That is the channel router's job (#65, #66, #67), and a half-version
// here is something those issues would have to unpick first.
//
// Tools come from the proxy, over mutual TLS, and from nowhere else. One tool
// client per task, pinned to the mention's channel: the certificate it presents
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

import { randomUUID } from "node:crypto";
import {
  DEFAULT_AGENT_LOOP_CAPS,
  ProxyClientError,
  createProxySpendClient,
  createProxyToolClient,
  runAgentTask,
  totalTokens
} from "@getlibero/agent";
import type {
  AgentStopReason,
  AgentTaskResult,
  CompletionClient,
  ProxySpendClient,
  ProxyTransport,
  TokenUsage
} from "@getlibero/agent";
import { createSilentLogger } from "@getlibero/gateway";
import type { Logger, MentionHandler, SlackMention, SlackReply } from "@getlibero/gateway";

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
 * Neither sentence is a synthesized answer to what was asked — that is the
 * thing this file refuses to do, and saying "the proxy could not be reached" is
 * the opposite of it.
 */
export const PROXY_UNAVAILABLE: Record<"no_client_certificate" | "other", string> = {
  no_client_certificate:
    "This channel has no client certificate for the tool proxy, so no tool call is possible. An operator mints one with `scripts/dev-certs.sh`.",
  other:
    "The tool proxy could not be reached, so no tool call was possible. An operator has the detail in the server log."
};

/**
 * A task that produced no text at all — a model that returned an empty turn, or
 * a cap that bit before the first one. Something has to be posted, or the
 * mention goes unanswered with no way for the person who wrote it to tell the
 * difference between a broken deployment and being ignored.
 */
const NO_ANSWER = "No answer was produced.";

/**
 * The line appended when a cap ended the task rather than the model.
 *
 * Every one of these is reportable as-is, which is what `AgentStopReason` was
 * shaped for: a task that stops short must be able to say which limit stopped
 * it, because the fix for each is a different number in a different file.
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
export function replyFor(result: AgentTaskResult): SlackReply | undefined {
  // The gateway is stopping and the operator asked for quiet. Posting a
  // shutdown notice into every open thread is noise at exactly the moment
  // nobody is watching.
  if (result.stopReason === "cancelled") return undefined;

  const note = CAP_NOTE[result.stopReason];
  const text = result.text.trim();

  if (text === "") return { text: note ?? NO_ANSWER };
  return { text: note === undefined ? text : `${text}\n\n${note}` };
}

export interface HandlerOptions {
  completion: CompletionClient;
  /**
   * The mutual-TLS connection to the tool proxy. Required: there is no
   * toolless mode to fall back to, and `proxyConfigFromEnv` refuses to build
   * one from a half-set environment.
   */
  transport: ProxyTransport;
  /** Model id, passed through verbatim. */
  model: string;
  /**
   * Cancels a task in flight. One signal for the process: shutdown aborts every
   * open task, and the loop reports `cancelled` rather than throwing.
   */
  signal?: AbortSignal;
  /** Defaults to silent, so a test asserting on behaviour is not also a log sink. */
  logger?: Logger;
}

/**
 * Builds the handler the gateway dispatches to.
 *
 * It never throws for a cap, a refusal, or a proxy that cannot be reached —
 * all three are replies. It does still throw when the model provider is
 * unreachable, which the gateway logs as `handler_failed` and answers by
 * posting nothing: an operator problem is not something to paper over with a
 * synthesized answer in someone's thread.
 */
export function createMentionHandler(options: HandlerOptions): MentionHandler {
  const logger = options.logger ?? createSilentLogger();

  return async (mention: SlackMention): Promise<SlackReply | undefined> => {
    // One client per task, holding this channel's certificate and no other's.
    // Both halves come from the same object because they share the mapping from
    // the name the model calls to the (server, tool) pair the proxy takes — a
    // model can only call what this channel's sheet published.
    const tools = createProxyToolClient({
      transport: options.transport,
      channel: mention.channelId
    });

    // Same channel, same certificate, and pinned the same way: what a task cost
    // is reported as the channel that spent it, or not at all.
    const spend = createProxySpendClient({
      transport: options.transport,
      channel: mention.channelId
    });

    // Minted here rather than by the loop, which is what `taskId` is for: a
    // turn's report has to be named before the turn happens, and the loop only
    // hands its id back when the task is over. Every turn's id derives from
    // this one, so a task's reports, its tool calls, and its log lines all
    // carry the same root.
    const taskId = randomUUID();

    let result: AgentTaskResult;
    try {
      result = await runAgentTask({
        taskId,
        completion: options.completion,
        toolSource: tools,
        toolExecutor: tools,
        model: options.model,
        // Attribution for the audit log, not authentication: nothing in the
        // proxy decides anything from it. The mention's user id as Slack sent
        // it — display-name resolution is the context assembler's (#67), and a
        // name is not what an audit record wants anyway.
        requestingUser: mention.userId,
        system: SYSTEM_PROMPT,
        // The mention text as it arrived, `<@U…>` token and all. Stripping it,
        // resolving display names, and prepending thread history are the
        // context assembler's (#67).
        messages: [{ role: "user", content: mention.text }],
        // The team sheet's `[llm]` caps are not read here — see the file
        // header. These are what a caller with no sheet gets.
        caps: DEFAULT_AGENT_LOOP_CAPS,
        // Reported as the turns happen, not when the task ends. See
        // `reportSpend`.
        onTurn: (usage, turn) => reportSpend(spend, taskId, turn, usage, mention, logger),
        ...(options.signal !== undefined ? { signal: options.signal } : {})
      });
    } catch (error) {
      // Only the tool listing reaches here. A failed tool *call* never does —
      // the loop turns it into an error result the model relays, so the task
      // still answers — and every other throw is the provider's and stays the
      // gateway's to log.
      if (!(error instanceof ProxyClientError)) throw error;

      // A cancelled listing is the process shutting down, and shutdown posts
      // nothing: the operator asked for quiet, and this would otherwise put a
      // line into every thread open at that moment.
      if (error.reason === "cancelled") return undefined;

      logger.log("error", {
        event: "tools_unavailable",
        channel: mention.channelId,
        eventId: mention.eventId,
        reason: error.reason
      });
      return {
        text:
          error.reason === "no_client_certificate"
            ? PROXY_UNAVAILABLE.no_client_certificate
            : PROXY_UNAVAILABLE.other
      };
    }

    // The one thing the gateway's own `mention`/`replied` pair cannot show: why
    // a task ended, and what it cost in total. The per-turn `spend_reported`
    // lines say what the meter was told and sum to this; a task line whose
    // `totalTokens` is larger than its reports add up to is a meter that missed
    // something, which is worth being able to see at a glance.
    logger.log("info", {
      event: "task",
      channel: mention.channelId,
      eventId: mention.eventId,
      task: result.taskId,
      stopReason: result.stopReason,
      totalTokens: result.totalTokens,
      turns: result.turns
    });

    return replyFor(result);
  };
}

/**
 * Tell the meter what one turn cost, and never let that cost the user an answer.
 *
 * **Per turn, not per task**, which is the loop's `onTurn` contract and the
 * reason it exists. A report that waits for the task means a long task spends
 * its whole cost before the meter hears any of it — so a channel already over
 * its cap is refused starting with the *next mention* rather than this task's
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
  turn: number,
  usage: TokenUsage,
  mention: SlackMention,
  logger: Logger
): Promise<void> {
  const spent = totalTokens(usage);
  if (spent === 0) return;

  try {
    const outcome = await spend.report(`${taskId}.${turn}`, usage);
    logger.log("info", {
      event: "spend_reported",
      channel: mention.channelId,
      eventId: mention.eventId,
      task: taskId,
      turns: turn,
      report: outcome,
      totalTokens: spent
    });
  } catch (error) {
    // Everything, including what is not a `ProxyClientError`. A bug in the
    // sender must not become a lost reply — and here that is not a figure of
    // speech, because the loop propagates whatever this throws.
    logger.log("error", {
      event: "spend_report_failed",
      channel: mention.channelId,
      eventId: mention.eventId,
      task: taskId,
      turns: turn,
      totalTokens: spent,
      reason: error instanceof ProxyClientError ? error.reason : "unknown"
    });
  }
}
