// Faked at the CompletionClient seam, the way the loop's own tests are. There
// is no Slack here and no model: a mention is a plain object, and what comes
// back is the text the channel would see.

import { ProxyClientError } from "@getlibero/agent";
import type {
  AgentStopReason,
  AgentTaskResult,
  CompletionClient,
  CompletionRequest,
  CompletionResponse,
  ProxyRequest,
  ProxyResponse,
  ProxyTransport,
  TokenUsage
} from "@getlibero/agent";
import type { LogFields, LogLevel, Logger, SlackMention } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { PROXY_UNAVAILABLE, SYSTEM_PROMPT, createMentionHandler, replyFor } from "./handler.js";

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
    taskId: "b9d5a2f0-0000-4000-8000-000000000001",
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

/**
 * The proxy, faked at the transport seam.
 *
 * One level below the tool client, so the client's own mapping — the listing to
 * definitions, a call to a (server, tool) pair — is exercised here rather than
 * stubbed past. What is not exercised is TLS, which needs a real handshake and
 * is tested against a real listener in packages/agent.
 */
function fakeTransport(
  answers: {
    tools?: () => ProxyResponse | Promise<ProxyResponse>;
    call?: (body: unknown) => ProxyResponse | Promise<ProxyResponse>;
  } = {}
): { transport: ProxyTransport; sent: ProxyRequest[] } {
  const sent: ProxyRequest[] = [];
  return {
    sent,
    transport: {
      async request(options: ProxyRequest): Promise<ProxyResponse> {
        sent.push(options);
        if (options.path === "/v1/tools") {
          return (await answers.tools?.()) ?? { status: 200, body: { tools: [] } };
        }
        return (
          (await answers.call?.(options.body)) ?? {
            status: 200,
            body: { outcome: "ran", id: "call-1", result: { content: "upstream said so" } }
          }
        );
      }
    }
  };
}

const LISTED = {
  status: 200,
  body: { tools: [{ server: "github", tool: "list_prs", approval: "none" }] }
} as const;

describe("createMentionHandler", () => {
  it("answers a mention with the model's text", async () => {
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const handler = createMentionHandler({
      completion: client,
      transport: fakeTransport().transport,
      model: MODEL
    });

    await expect(handler(mention())).resolves.toEqual({ text: "Fridays, 14:00 UTC." });
  });

  it("sends the mention text, the system prompt, and the configured model", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({
      completion: client,
      transport: fakeTransport().transport,
      model: MODEL
    });

    await handler(mention("<@U0BOT> ping"));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(MODEL);
    expect(requests[0]?.system).toBe(SYSTEM_PROMPT);
    // The `<@U…>` token is left in: stripping it and resolving display names
    // is the context assembler's job (#67).
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "<@U0BOT> ping" }]);
  });

  it("offers the model exactly what the proxy listed", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({
      completion: client,
      transport: fakeTransport({ tools: () => LISTED }).transport,
      model: MODEL
    });

    await handler(mention());

    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[0]?.tools?.[0]?.name).toBe("list_prs");
  });

  it("offers no tools when the channel permits none", async () => {
    // An empty listing is a real answer — a channel with no team sheet permits
    // nothing — and the loop omits the field rather than sending an empty array.
    const { client, requests } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({
      completion: client,
      transport: fakeTransport().transport,
      model: MODEL
    });

    await handler(mention());

    expect(requests[0]?.tools).toBeUndefined();
  });

  // The certificate is the channel identity, and it is chosen from the mention
  // rather than from anything the model wrote.
  it("presents the mention's channel to the proxy, and sends no channel in the body", async () => {
    const { client } = fakeCompletion({ text: "ok" });
    const fake = fakeTransport({ tools: () => LISTED });
    const handler = createMentionHandler({
      completion: client,
      transport: fake.transport,
      model: MODEL
    });

    await handler(mention());

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.channel).toBe("C024BE91L");
    expect(fake.sent[0]?.body).toBeUndefined();
  });

  it("posts nothing and calls no provider when the signal is already aborted", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const aborted = AbortSignal.abort();
    const handler = createMentionHandler({
      completion: client,
      transport: fakeTransport().transport,
      model: MODEL,
      signal: aborted
    });

    await expect(handler(mention())).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("logs how a task ended and what it cost, with no message text in the line", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const handler = createMentionHandler({
      completion: client,
      transport: fakeTransport().transport,
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
      transport: fakeTransport().transport,
      model: MODEL
    });

    await expect(handler(mention())).rejects.toThrow(/ECONNREFUSED/);
  });
});

// The departure from the rule above, and why: a channel whose client
// certificate was never minted will never answer again, which is a first-run
// configuration mistake rather than an outage. Silence there is
// indistinguishable from being ignored, by the people who cannot see the log.
describe("a tool proxy that cannot be reached", () => {
  const failing = (reason: ProxyClientError["reason"]): ProxyTransport => ({
    request: () => Promise.reject(new ProxyClientError("proxy client: nope", reason))
  });

  it("tells the channel when this channel has no client certificate", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({
      completion: client,
      transport: failing("no_client_certificate"),
      model: MODEL
    });

    await expect(handler(mention())).resolves.toEqual({
      text: PROXY_UNAVAILABLE.no_client_certificate
    });
    // No model turn was taken: the listing runs before the first one, so this
    // costs the operator nothing beyond the failed connection.
    expect(requests).toHaveLength(0);
  });

  it("tells the channel when the proxy is unreachable or refused the certificate", async () => {
    for (const reason of [
      "unreachable",
      "tls_rejected",
      "connection_reset",
      "timed_out",
      "malformed_response"
    ] as const) {
      const { client } = fakeCompletion({ text: "ok" });
      const handler = createMentionHandler({
        completion: client,
        transport: failing(reason),
        model: MODEL
      });

      await expect(handler(mention())).resolves.toEqual({ text: PROXY_UNAVAILABLE.other });
    }
  });

  it("logs the reason, and puts no message text in the line", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({
      completion: client,
      transport: failing("unreachable"),
      model: MODEL,
      logger: captured.logger
    });

    await handler(mention("<@U0BOT> what is the deploy window?"));

    expect(captured.lines.find(entry => entry.event === "tools_unavailable")).toMatchObject({
      level: "error",
      channel: "C024BE91L",
      eventId: "Ev0PV52K25",
      reason: "unreachable"
    });
    expect(JSON.stringify(captured.lines)).not.toMatch(/deploy window/);
  });

  // Shutdown, not a failure. Posting here would put a line into every thread
  // open at the moment the operator asked for quiet.
  it("posts nothing when the listing was cancelled", async () => {
    const { client } = fakeCompletion({ text: "ok" });
    const handler = createMentionHandler({
      completion: client,
      transport: failing("cancelled"),
      model: MODEL
    });

    await expect(handler(mention())).resolves.toBeUndefined();
  });
});
