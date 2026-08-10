// Faked at the CompletionClient seam, the way the loop's own tests are. There
// is no Slack here and no model: a request is a plain object, and what comes
// back is the text the channel would see.
//
// The settings arrive as an argument rather than being resolved, because that
// is how the runner takes them. What a sheet resolves to is sheet.test.ts, and
// that a channel's own settings reach the provider is router.test.ts.

import { DEFAULT_AGENT_LOOP_CAPS, ProxyClientError } from "@getlibero/agent";
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
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { DEFAULT_FOLLOW_UP_WINDOW_MS, DEFAULT_HISTORY_BOUNDS } from "./sheet.js";
import { PROXY_UNAVAILABLE, SYSTEM_PROMPT, createTaskRunner, replyFor } from "./task.js";
import type { TaskRequest, TaskSettings } from "./types.js";

const MODEL = "test-model";

/**
 * What a channel with no `[llm]` block of its own resolves to, plus the seed
 * transcript the router would have assembled from it.
 *
 * The runner is handed a finished transcript rather than building one — that is
 * the context assembler's, one layer up in the router, where the session's
 * store and name cache are. So this is what a channel with no history looks
 * like by the time it gets here.
 */
const SETTINGS: TaskSettings = {
  model: MODEL,
  caps: { ...DEFAULT_AGENT_LOOP_CAPS },
  history: { ...DEFAULT_HISTORY_BOUNDS },
  followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
  messages: [{ role: "user", content: "@U024BE7LH asks: <@U0BOT> what is the deploy window?" }]
};

function taskRequest(text = "<@U0BOT> what is the deploy window?"): TaskRequest {
  return {
    key: { workspace: "T024BE7LD", channel: "C024BE91L" },
    requestingUser: "U024BE7LH",
    thread: "1758000000.000100",
    text,
    traceId: "Ev0PV52K25"
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
    spend?: (body: unknown) => ProxyResponse | Promise<ProxyResponse>;
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
        if (options.path === "/v1/spend") {
          return (await answers.spend?.(options.body)) ?? { status: 200, body: { outcome: "recorded" } };
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

/** Every route works but one. `failing` cannot say "tools work, the meter does not". */
function failingOn(path: string, reason: ProxyClientError["reason"]): ProxyTransport {
  const fake = fakeTransport();
  return {
    request: options =>
      options.path === path
        ? Promise.reject(new ProxyClientError("proxy client: nope", reason))
        : fake.transport.request(options)
  };
}

const spentTokens = (sent: ProxyRequest[]): ProxyRequest[] =>
  sent.filter(request => request.path === "/v1/spend");

const LISTED = {
  status: 200,
  body: { tools: [{ server: "github", tool: "list_prs", approval: "none" }] }
} as const;

describe("createMentionHandler", () => {
  it("answers a mention with the model's text", async () => {
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({ text: "Fridays, 14:00 UTC." });
  });

  it("sends the assembled transcript, the system prompt, and the configured model", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport
    });

    await runner(taskRequest("<@U0BOT> ping"), {
      ...SETTINGS,
      messages: [{ role: "user", content: "@alice asks: @libero ping" }]
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(MODEL);
    expect(requests[0]?.system).toBe(SYSTEM_PROMPT);
    // The settings' transcript, not the request's raw text. The runner does not
    // build one — the router does, from the session's store and name cache —
    // and this is what proves it carries rather than reinvents.
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "@alice asks: @libero ping" }]);
  });

  it("does not put the raw request text in the transcript itself", async () => {
    // The one way this could regress quietly: a runner that appended the ask to
    // what it was handed would send it twice, and every assertion above would
    // still pass.
    const { client, requests } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport
    });

    await runner(taskRequest("<@U0BOT> a very distinctive question"), {
      ...SETTINGS,
      messages: [{ role: "user", content: "@alice asks: @libero a very distinctive question" }]
    });

    expect(requests[0]?.messages).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("<@U0BOT>");
  });

  it("does not let the loop mutate the settings it was handed", async () => {
    // `AgentTaskOptions.messages` is mutable and the loop appends to a copy of
    // it — but only because the runner hands it a copy. Settings are shared
    // across nothing today, and this is what keeps that true if they ever are.
    const { client } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport
    });
    const settings: TaskSettings = {
      ...SETTINGS,
      messages: [{ role: "user", content: "@alice asks: @libero ping" }]
    };

    await runner(taskRequest(), settings);

    expect(settings.messages).toHaveLength(1);
  });

  it("offers the model exactly what the proxy listed", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport({ tools: () => LISTED }).transport
    });

    await runner(taskRequest(), SETTINGS);

    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[0]?.tools?.[0]?.name).toBe("list_prs");
  });

  it("offers no tools when the channel permits none", async () => {
    // An empty listing is a real answer — a channel with no team sheet permits
    // nothing — and the loop omits the field rather than sending an empty array.
    const { client, requests } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport
    });

    await runner(taskRequest(), SETTINGS);

    expect(requests[0]?.tools).toBeUndefined();
  });

  // The certificate is the channel identity, and it is chosen from the mention
  // rather than from anything the model wrote.
  it("presents the mention's channel to the proxy, and sends no channel in the body", async () => {
    const { client } = fakeCompletion({ text: "ok" });
    const fake = fakeTransport({ tools: () => LISTED });
    const runner = createTaskRunner({
      completion: client,
      transport: fake.transport
    });

    await runner(taskRequest(), SETTINGS);

    // Every request this handler makes, not just the listing: the channel is
    // the certificate's to assert, so none of them may carry it as a field.
    expect(fake.sent.length).toBeGreaterThan(0);
    for (const request of fake.sent) {
      expect(request.channel).toBe("C024BE91L");
      expect(JSON.stringify(request.body ?? null)).not.toContain("C024BE91L");
    }
    expect(fake.sent.filter(request => request.path === "/v1/tools")).toHaveLength(1);
  });

  it("posts nothing and calls no provider when the signal is already aborted", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const aborted = AbortSignal.abort();
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport,
      signal: aborted
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("logs how a task ended and what it cost, with no message text in the line", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport,
      logger: captured.logger
    });

    await runner(taskRequest("<@U0BOT> what is the deploy window?"), SETTINGS);

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

  // The caps are the channel's now, not the process's, so the runner has to
  // actually hand them to the loop rather than carry them past it.
  it("runs the task under the caps it was handed", async () => {
    const runner = createTaskRunner({
      completion: {
        complete: (): Promise<CompletionResponse> =>
          Promise.resolve({
            text: "",
            toolCalls: [{ id: "call-1", name: "list_prs", arguments: {} }],
            stopReason: "tool_use",
            usage: { inputTokens: 11, outputTokens: 7 }
          })
      },
      transport: fakeTransport({ tools: () => LISTED }).transport
    });

    const reply = await runner(taskRequest(), {
      ...SETTINGS,
      caps: { ...DEFAULT_AGENT_LOOP_CAPS, maxToolCalls: 0 }
    });

    expect(reply?.text).toMatch(/tool call cap/);
  });

  // The refusal the proxy never sees, and therefore never audits. Without this
  // line a model can probe name after name and the audit log shows a task that
  // made no tool calls at all (#170).
  it("logs a tool call refused before the proxy was asked", async () => {
    const captured = capturingLogger();
    const runner = createTaskRunner({
      completion: {
        complete: (): Promise<CompletionResponse> =>
          Promise.resolve({
            text: "",
            toolCalls: [{ id: "call-1", name: "force_push", arguments: { repo: "libero" } }],
            stopReason: "tool_use",
            usage: { inputTokens: 11, outputTokens: 7 }
          })
      },
      transport: fakeTransport({ tools: () => LISTED }).transport,
      logger: captured.logger
    });

    // One call, so the model answering with the same invented name every turn
    // ends the task rather than probing forever.
    await runner(taskRequest(), {
      ...SETTINGS,
      caps: { ...DEFAULT_AGENT_LOOP_CAPS, maxToolCalls: 1 }
    });

    const line = captured.lines.find(entry => entry.event === "tool_not_permitted");
    expect(line).toMatchObject({
      // Nothing is broken, but nothing designed this either — which is the one
      // level between the `task` line and `tools_unavailable`.
      level: "warn",
      channel: "C024BE91L",
      eventId: "Ev0PV52K25",
      user: "U024BE7LH",
      // The name the model wrote, as a value. A line that interpolated it into
      // a message would be putting model-authored text into a log sentence.
      tool: "force_push"
    });
    // The join key: the same root the task's own line and its spend reports
    // carry, so one grep gathers everything a task did.
    expect(line?.task).toBe(captured.lines.find(entry => entry.event === "task")?.task);
  });

  it("takes the per-turn output ceiling from the caps it was handed", async () => {
    const { client, requests } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport().transport
    });

    await runner(taskRequest(), {
      ...SETTINGS,
      caps: { ...DEFAULT_AGENT_LOOP_CAPS, maxOutputTokensPerTurn: 512 }
    });

    // The loop fills `maxTokens` from the cap, so this is the field that proves
    // the caps reached the tracker rather than merely being carried alongside.
    expect(requests[0]?.maxTokens).toBe(512);
  });

  it("propagates a provider failure rather than inventing an answer", async () => {
    // The gateway logs this as handler_failed and posts nothing. An
    // unreachable provider is an operator problem.
    const runner = createTaskRunner({
      completion: {
        complete: () => Promise.reject(new Error("connect ECONNREFUSED"))
      },
      transport: fakeTransport().transport
    });

    await expect(runner(taskRequest(), SETTINGS)).rejects.toThrow(/ECONNREFUSED/);
  });
});

// The proxy meters tool calls from calls it served and needs nobody's help to
// count those. Tokens are the other half, and only this process knows them.
describe("what a task cost", () => {
  it("reports the provider's counts, keyed on the task id and the turn", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "ok" });
    const fake = fakeTransport();
    const runner = createTaskRunner({
      completion: client,
      transport: fake.transport,
      logger: captured.logger
    });

    await runner(taskRequest(), SETTINGS);

    const reports = spentTokens(fake.sent);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.channel).toBe("C024BE91L");
    expect(reports[0]?.body).toEqual({
      turn: `${captured.lines.find(entry => entry.event === "task")?.task}.1`,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      }
    });
  });

  // Each turn is its own idempotency key, so a retry of one is a duplicate and
  // the next turn is not.
  it("reports each turn separately, under the same task", async () => {
    const captured = capturingLogger();
    const fake = fakeTransport({ tools: () => LISTED });
    let turn = 0;
    const runner = createTaskRunner({
      completion: {
        complete: (): Promise<CompletionResponse> => {
          turn += 1;
          return Promise.resolve(
            turn === 1
              ? {
                  text: "",
                  toolCalls: [{ id: "call-1", name: "list_prs", arguments: {} }],
                  stopReason: "tool_use",
                  usage: { inputTokens: 10, outputTokens: 5 }
                }
              : {
                  text: "Fridays, 14:00 UTC.",
                  toolCalls: [],
                  stopReason: "end_turn",
                  usage: { inputTokens: 20, outputTokens: 7 }
                }
          );
        }
      },
      transport: fake.transport,
      logger: captured.logger
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({ text: "Fridays, 14:00 UTC." });

    const task = captured.lines.find(entry => entry.event === "task")?.task;
    const reports = spentTokens(fake.sent);
    expect(reports.map(request => (request.body as { turn: string }).turn)).toEqual([
      `${task}.1`,
      `${task}.2`
    ]);
    // Each turn's own numbers. Summing is the meter's, and a second report
    // carrying the running total would double-count the first.
    expect(reports.map(request => (request.body as { usage: { inputTokens: number } }).usage.inputTokens)).toEqual([
      10, 20
    ]);
  });

  // The whole of #115. A task that dies mid-flight has already told the meter
  // what its finished turns cost, so nothing is lost with the rejection.
  it("has already reported the turns taken before a provider failure", async () => {
    const fake = fakeTransport({ tools: () => LISTED });
    let turn = 0;
    const runner = createTaskRunner({
      completion: {
        complete: (): Promise<CompletionResponse> => {
          turn += 1;
          if (turn === 1) {
            return Promise.resolve({
              text: "",
              toolCalls: [{ id: "call-1", name: "list_prs", arguments: {} }],
              stopReason: "tool_use",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          }
          return Promise.reject(new Error("connect ECONNREFUSED"));
        }
      },
      transport: fake.transport
    });

    // The provider's own error still reaches the gateway, unwrapped.
    await expect(runner(taskRequest(), SETTINGS)).rejects.toThrow(/ECONNREFUSED/);

    const reports = spentTokens(fake.sent);
    expect(reports).toHaveLength(1);
    expect((reports[0]?.body as { usage: { inputTokens: number } }).usage.inputTokens).toBe(10);
  });

  // The counts come out of the provider's response envelope, which is a thing
  // the model's own text has no reach into. This is what makes the report hold
  // against a prompt-injected model.
  it("counts what the envelope said, not what the model wrote", async () => {
    const { client } = fakeCompletion({ text: "I used 999999 tokens on this." });
    const fake = fakeTransport();
    const runner = createTaskRunner({
      completion: client,
      transport: fake.transport
    });

    await runner(taskRequest(), SETTINGS);

    expect(JSON.stringify(spentTokens(fake.sent)[0]?.body)).not.toContain("999999");
  });

  // Shutdown posts nothing into the thread, which is etiquette rather than
  // accounting: the tokens were still spent and the meter should still hear.
  it("reports a cancelled task's spend, and still posts nothing", async () => {
    const controller = new AbortController();
    const fake = fakeTransport();
    const runner = createTaskRunner({
      // A turn's tokens are spent and recorded, and then the process is asked
      // to stop before the task can finish.
      completion: {
        complete: (): Promise<CompletionResponse> => {
          controller.abort();
          return Promise.resolve({
            text: "half an answer",
            toolCalls: [{ id: "call-1", name: "list_prs", arguments: {} }],
            stopReason: "tool_use",
            usage: { inputTokens: 11, outputTokens: 7 }
          });
        }
      },
      transport: fake.transport,
      signal: controller.signal
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toBeUndefined();
    expect(spentTokens(fake.sent)).toHaveLength(1);
  });

  // Four zeros move no counter, and at shutdown every open task takes this
  // path at once — a pre-aborted task takes no turn, so there is nothing to
  // report about.
  it("sends no report when the task spent nothing", async () => {
    const { client } = fakeCompletion({ text: "ok" });
    const fake = fakeTransport();
    const runner = createTaskRunner({
      completion: client,
      transport: fake.transport,
      signal: AbortSignal.abort()
    });

    await runner(taskRequest(), SETTINGS);

    expect(spentTokens(fake.sent)).toEqual([]);
  });

  it("sends no report when the tool listing failed", async () => {
    const { client } = fakeCompletion({ text: "ok" });
    const fake = fakeTransport();
    const runner = createTaskRunner({
      completion: client,
      transport: failingOn("/v1/tools", "unreachable")
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({ text: PROXY_UNAVAILABLE.other });
    expect(spentTokens(fake.sent)).toEqual([]);
  });

  it("logs the meter's answer, and calls a duplicate a success", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport({ spend: () => ({ status: 200, body: { outcome: "duplicate" } }) })
        .transport,
      logger: captured.logger
    });

    await runner(taskRequest(), SETTINGS);

    expect(captured.lines.find(entry => entry.event === "spend_reported")).toMatchObject({
      level: "info",
      channel: "C024BE91L",
      eventId: "Ev0PV52K25",
      report: "duplicate",
      turns: 1,
      totalTokens: 18
    });
  });
});

// An operator's counter is not worth a user's reply.
describe("a meter that cannot be reached", () => {
  it("still answers the thread when the proxy refuses the report", async () => {
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const runner = createTaskRunner({
      completion: client,
      transport: fakeTransport({
        spend: () => ({
          status: 400,
          body: {
            error: {
              code: "bad_request",
              message: "the request body is not a valid spend report",
              requestId: "req-1"
            }
          }
        })
      }).transport
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({ text: "Fridays, 14:00 UTC." });
  });

  it("still answers the thread when the report could not be sent at all", async () => {
    for (const reason of ["unreachable", "timed_out", "malformed_response"] as const) {
      const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
      const runner = createTaskRunner({
        completion: client,
        transport: failingOn("/v1/spend", reason)
      });

      await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({ text: "Fridays, 14:00 UTC." });
    }
  });

  it("says in the log that the meter is running blind, and by how much", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const runner = createTaskRunner({
      completion: client,
      transport: failingOn("/v1/spend", "unreachable"),
      logger: captured.logger
    });

    await runner(taskRequest("<@U0BOT> what is the deploy window?"), SETTINGS);

    const line = captured.lines.find(entry => entry.event === "spend_report_failed");
    expect(line).toMatchObject({
      level: "error",
      channel: "C024BE91L",
      eventId: "Ev0PV52K25",
      reason: "unreachable",
      totalTokens: 18
    });
    expect(JSON.stringify(line)).not.toMatch(/deploy window|Fridays/);
  });

  // A bug in the sender must not become a lost reply, and since the report is
  // now sent from inside the loop's `onTurn` that is not a figure of speech:
  // the loop does not catch, so anything escaping here would end the task.
  it("still answers the thread when the sender fails in a way nobody planned for", async () => {
    const { client } = fakeCompletion({ text: "Fridays, 14:00 UTC." });
    const runner = createTaskRunner({
      completion: client,
      transport: {
        request: options =>
          options.path === "/v1/spend"
            ? Promise.reject(new TypeError("undefined is not a function"))
            : fakeTransport().transport.request(options)
      }
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({ text: "Fridays, 14:00 UTC." });
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
    const runner = createTaskRunner({
      completion: client,
      transport: failing("no_client_certificate")
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({
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
      const runner = createTaskRunner({
        completion: client,
        transport: failing(reason)
      });

      await expect(runner(taskRequest(), SETTINGS)).resolves.toEqual({ text: PROXY_UNAVAILABLE.other });
    }
  });

  it("logs the reason, and puts no message text in the line", async () => {
    const captured = capturingLogger();
    const { client } = fakeCompletion({ text: "ok" });
    const runner = createTaskRunner({
      completion: client,
      transport: failing("unreachable"),
      logger: captured.logger
    });

    await runner(taskRequest("<@U0BOT> what is the deploy window?"), SETTINGS);

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
    const runner = createTaskRunner({
      completion: client,
      transport: failing("cancelled")
    });

    await expect(runner(taskRequest(), SETTINGS)).resolves.toBeUndefined();
  });
});

// The seam carrying the prompter: the request's closure reaches the tool
// client, the wait happens inside the tool call, and the re-submission carries
// the ticket. What the prompter does — the card, the click — is
// ../approvals/prompter.test.ts; this is the task layer passing it through.
describe("a held call in a task", () => {
  it("waits on the request's prompter, then re-submits with the ticket", async () => {
    const prompted: string[] = [];
    const fake = fakeTransport({
      tools: () => ({
        status: 200,
        body: { tools: [{ server: "github", tool: "merge_pr", approval: "required" }] }
      }),
      call: body =>
        (body as { ticket?: string }).ticket === undefined
          ? {
              status: 200,
              body: {
                outcome: "held",
                id: "call-1",
                refusal: { reason: "approval_required", server: "github", tool: "merge_pr" },
                ticket: { id: "tk-7f3a", expiresAt: Date.UTC(2026, 7, 4, 12, 15) }
              }
            }
          : { status: 200, body: { outcome: "ran", id: "call-1", result: { content: "merged #42" } } }
    });
    let turn = 0;
    const runner = createTaskRunner({
      completion: {
        complete: (request): Promise<CompletionResponse> => {
          turn += 1;
          if (turn === 1) {
            return Promise.resolve({
              text: "",
              toolCalls: [{ id: "call-1", name: "merge_pr", arguments: { pr: 42 } }],
              stopReason: "tool_use",
              usage: { inputTokens: 10, outputTokens: 5 }
            });
          }
          // The model's second turn sees the tool's real result, not the hold.
          expect(JSON.stringify(request.messages)).toContain("merged #42");
          return Promise.resolve({
            text: "Merged.",
            toolCalls: [],
            stopReason: "end_turn",
            usage: { inputTokens: 20, outputTokens: 7 }
          });
        }
      },
      transport: fake.transport
    });

    const reply = await runner(
      { ...taskRequest(), onHeld: held => (prompted.push(held.ticket.id), Promise.resolve()) },
      SETTINGS
    );

    expect(reply).toEqual({ text: "Merged." });
    expect(prompted).toEqual(["tk-7f3a"]);
    const calls = fake.sent.filter(request => request.path === "/v1/tools/call");
    expect(calls).toHaveLength(2);
    expect((calls[1]?.body as { ticket?: string }).ticket).toBe("tk-7f3a");
  });
});
