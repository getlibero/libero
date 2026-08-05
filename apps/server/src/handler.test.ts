// Faked at the CompletionClient seam, the way the loop's own tests are. There
// is no Slack here and no model: a mention is a plain object, and what comes
// back is the text the channel would see.

import type {
  AgentStopReason,
  AgentTaskResult,
  CompletionClient,
  CompletionRequest,
  CompletionResponse,
  TokenUsage
} from "@getlibero/agent";
import type { LogFields, LogLevel, Logger, SlackMention } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, createMentionHandler, replyFor } from "./handler.js";

const MODEL = "test-model";

function mention(text = "<@U0BOT> what is the deploy window?"): SlackMention {
  return {
    teamId: "T024BE7LD",
    channelId: "C024BE91L",
    userId: "U024BE7LH",
    text,
    ts: "1758000000.000100",
    threadTs: "1758000000.000100",
    eventId: "Ev0PV52K25"
  };
}

function result(partial: Partial<AgentTaskResult> = {}): AgentTaskResult {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  return {
    stopReason: "completed",
    text: "",
    messages: [],
    usage,
    totalTokens: 0,
    toolCalls: 0,
    turns: 1,
    elapsedMs: 1,
    ...partial
  };
}

/** Answers once with the given text and stop reason. */
function fakeCompletion(partial: Partial<CompletionResponse> = {}): {
  client: CompletionClient;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    client: {
      complete(request: CompletionRequest): Promise<CompletionResponse> {
        requests.push(request);
        return Promise.resolve({
          text: "",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 11, outputTokens: 7 },
          ...partial
        });
      }
    }
  };
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

describe("replyFor", () => {
  it("posts the model's text when the task completed", () => {
    expect(replyFor(result({ text: "Fridays, 14:00 UTC." }))).toEqual({
      text: "Fridays, 14:00 UTC."
    });
  });

  it("posts a refusal as the model worded it, with nothing appended", () => {
    // A refusal is the model's to word. Annotating it would be this file
    // second-guessing the answer in front of the channel.
    expect(replyFor(result({ stopReason: "refusal", text: "I can't help with that." }))).toEqual({
      text: "I can't help with that."
    });
  });

  it.each([
    ["tool_call_cap", /tool call cap/],
    ["wall_time_cap", /time limit/],
    ["token_cap", /token cap/],
    ["max_tokens", /per-turn output limit/]
  ] as Array<[AgentStopReason, RegExp]>)("names the limit that ended a %s task", (stopReason, pattern) => {
    const reply = replyFor(result({ stopReason, text: "Partial answer." }));
    expect(reply?.text).toMatch(/^Partial answer\./);
    expect(reply?.text).toMatch(pattern);
  });

  it("says only the limit when a cap left no text at all", () => {
    expect(replyFor(result({ stopReason: "wall_time_cap", text: "" }))?.text).toMatch(
      /time limit/
    );
  });

  it("posts something when a completed task produced no text", () => {
    // Silence is indistinguishable from being ignored, and the person who
    // wrote the mention has no other way to tell.
    const reply = replyFor(result({ text: "   " }));
    expect(reply?.text.trim()).not.toBe("");
  });

  it("posts nothing when the task was cancelled", () => {
    // Shutdown. Posting a notice into every open thread is noise at exactly
    // the moment nobody is watching.
    expect(replyFor(result({ stopReason: "cancelled", text: "half an answer" }))).toBeUndefined();
  });
});

describe("createMentionHandler", () => {
  it("answers a mention with the model's text", async () => {
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const handler = createMentionHandler({ completion: client, model: MODEL });

    await expect(handler(mention())).resolves.toEqual({ text: "Fridays, 14:00 UTC." });
  });

  it("sends the mention text, the system prompt, and the configured model", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({ completion: client, model: MODEL });

    await handler(mention("<@U0BOT> ping"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(MODEL);
    expect(requests[0]?.system).toBe(SYSTEM_PROMPT);
    // The `<@U…>` token is left in: stripping it and resolving display names
    // is the context assembler's job (#67).
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "<@U0BOT> ping" }]);
  });

  it("offers the model no tools", async () => {
    // The stub tool source lists nothing, and the loop omits the field rather
    // than sending an empty array. There is no tool executor in this process
    // that could reach one anyway.
    const { client, requests } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({ completion: client, model: MODEL });

    await handler(mention());

    expect(requests[0]?.tools).toBeUndefined();
  });

  it("posts nothing and calls no provider when the signal is already aborted", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const aborted = AbortSignal.abort();
    const handler = createMentionHandler({ completion: client, model: MODEL, signal: aborted });

    await expect(handler(mention())).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("logs how a task ended and what it cost, with no message text in the line", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const handler = createMentionHandler({
      completion: client,
      model: MODEL,
      logger: captured.logger
    });

    await handler(mention("<@U0BOT> what is the deploy window?"));

    const line = captured.lines.find(entry => entry.event === "task");
    expect(line).toMatchObject({
      level: "info",
      channel: "C024BE91L",
      eventId: "Ev0PV52K25",
      stopReason: "completed",
      totalTokens: 18,
      turns: 1
    });
    // A message belongs to the members of the channel it was posted in, and
    // stdout is not on that path.
    expect(JSON.stringify(line)).not.toMatch(/deploy window|Fridays/);
  });

  it("propagates a provider failure rather than inventing an answer", async () => {
    // The gateway logs this as handler_failed and posts nothing. An
    // unreachable provider is an operator problem.
    const handler = createMentionHandler({
      completion: {
        complete: () => Promise.reject(new Error("connect ECONNREFUSED"))
      },
      model: MODEL
    });

    await expect(handler(mention())).rejects.toThrow(/ECONNREFUSED/);
  });
});
