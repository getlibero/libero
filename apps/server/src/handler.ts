// The seam between the two packages: a Slack mention in, a thread reply out,
// one agent task in between.
//
// Everything channel-shaped is deliberately absent. There is no session key, no
// per-channel mutex, no thread history, no team sheet — so two mentions in one
// channel run concurrently and each task starts from nothing but the mention
// text. That is the channel router's job (#65, #66, #67), and a half-version
// here is something those issues would have to unpick first.
//
// No tools. The stub tool source lists none and the executor refuses every
// call, so the model answers or it does not. The real pair are network clients
// against the tool proxy service, which is what keeps this process's
// compromise worth no tool credential.

import {
  DEFAULT_AGENT_LOOP_CAPS,
  createStubToolSource,
  createUnavailableToolExecutor,
  runAgentTask
} from "@getlibero/agent";
import type { AgentStopReason, AgentTaskResult, CompletionClient } from "@getlibero/agent";
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
  "You have no tools available: answer from what you know, and say plainly when you do not know.",
  "Be brief. A thread reply is a few sentences, not an essay."
].join(" ");

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
 * It never throws for a cap or a refusal — those are replies. It does throw
 * when the provider is unreachable, which the gateway logs as `handler_failed`
 * and answers by posting nothing: an operator problem is not something to
 * paper over with a synthesized answer in someone's thread.
 */
export function createMentionHandler(options: HandlerOptions): MentionHandler {
  const logger = options.logger ?? createSilentLogger();

  return async (mention: SlackMention): Promise<SlackReply | undefined> => {
    const result = await runAgentTask({
      completion: options.completion,
      // Both stubs. Listing no tools is what makes this a hello-world agent;
      // the executor pairs with it so a model that invents a call gets a
      // refusal in the shape the real path uses rather than a dropped task.
      toolSource: createStubToolSource(),
      toolExecutor: createUnavailableToolExecutor(),
      model: options.model,
      system: SYSTEM_PROMPT,
      // The mention text as it arrived, `<@U…>` token and all. Stripping it,
      // resolving display names, and prepending thread history are the context
      // assembler's (#67).
      messages: [{ role: "user", content: mention.text }],
      // The team sheet's `[llm]` caps are not read here — see the file header.
      // These are what a caller with no sheet gets.
      caps: DEFAULT_AGENT_LOOP_CAPS,
      ...(options.signal !== undefined ? { signal: options.signal } : {})
    });

    // The one thing the gateway's own `mention`/`replied` pair cannot show: why
    // a task ended, and what it cost. Worth a line while nothing meters tokens
    // — no proxy client sends a spend report yet, so this is the only place a
    // token count is visible at all.
    logger.log("info", {
      event: "task",
      channel: mention.channelId,
      eventId: mention.eventId,
      stopReason: result.stopReason,
      totalTokens: result.totalTokens,
      turns: result.turns
    });

    return replyFor(result);
  };
}
