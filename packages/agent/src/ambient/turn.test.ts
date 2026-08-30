// Faked at the CompletionClient seam, ../skill/merge.test.ts's reason: what is
// under test is what the turn offers, what it does with what the model asks for,
// and what it reports.
//
// The centre of gravity here is different from every other turn's, because the
// ordinary outcome is *nothing*. Most of these cases assert that a channel hears
// silence, and the ones that matter most assert it for answers that were not
// silence — a wrong tool name, a shape that does not parse, prose instead of a
// call. Fail-closed is the whole design, so it is what most of this file checks.

import { describe, it } from "node:test";
import { expect } from "expect";
import { AMBIENT_FINDING_MAX_CHARS, AMBIENT_FINDING_TOOL } from "@getlibero/schema";
import { CompletionError } from "../completion/types.js";
import type {
  CompletionClient,
  CompletionRequest,
  CompletionResponse,
  ToolCall
} from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";
import {
  AMBIENT_HEARTBEAT_SYSTEM_PROMPT,
  ambientFindingToolDefinition,
  runHeartbeatTurn
} from "./turn.js";
import type { HeartbeatTurnOptions } from "./turn.js";

const MODEL = "test-model";

const ACTIVITY = [
  { author: "priya", text: "does anyone know why staging is refusing certs?" },
  { author: "sam", text: "not me" }
] as const;

function response(partial: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text: "",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 210, outputTokens: 18 },
    ...partial
  };
}

const call = (args: Record<string, unknown>, name = AMBIENT_FINDING_TOOL): ToolCall => ({
  id: "call_1",
  name,
  arguments: args
});

function fakeCompletion(next: CompletionResponse | (() => Promise<CompletionResponse>)): {
  client: CompletionClient;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    client: {
      complete(request) {
        requests.push(request);
        return typeof next === "function" ? next() : Promise.resolve(next);
      }
    }
  };
}

function turnWith(
  next: CompletionResponse | (() => Promise<CompletionResponse>),
  over: Partial<HeartbeatTurnOptions> = {}
) {
  const { client, requests } = fakeCompletion(next);
  const reported: CompletedTurn[] = [];
  const options: HeartbeatTurnOptions = {
    completion: client,
    model: MODEL,
    messages: [...ACTIVITY],
    maxTokens: 1024,
    turn: 1,
    onTurn: turn => {
      reported.push(turn);
    },
    ...over
  };
  return { run: () => runHeartbeatTurn(options), requests, reported };
}

describe("what the heartbeat turn offers", () => {
  it("offers exactly one tool, and it writes nothing", async () => {
    const { run, requests } = turnWith(response());

    await run();

    expect(requests[0]?.tools).toEqual([ambientFindingToolDefinition()]);
    expect(requests[0]?.tools).toHaveLength(1);
  });

  it("puts the activity in a user message, attributed, oldest first", async () => {
    const { run, requests } = turnWith(response());

    await run();

    expect(requests[0]?.system).toBe(AMBIENT_HEARTBEAT_SYSTEM_PROMPT);
    expect(requests[0]?.messages).toHaveLength(1);
    const first = requests[0]?.messages[0];
    // The heartbeat's one message is a user turn, whose content is still a
    // string — only a tool result became blocks.
    const content = first?.role === "user" ? first.content : "";
    expect(content).toContain("priya: does anyone know why staging is refusing certs?");
    expect(content.indexOf("priya:")).toBeLessThan(content.indexOf("sam:"));
  });

  it("does not tell the model which threads the pregate found", async () => {
    // Handing it the answer would make the finding a formality — the model
    // reporting what the SQL already decided, and no longer looking for the case
    // the design is actually for.
    const { run, requests } = turnWith(response());

    await run();

    expect(JSON.stringify(requests[0])).not.toContain("idle");
    expect(JSON.stringify(requests[0])).not.toContain("watermark");
  });
});

describe("what it does with the answer", () => {
  it("carries a finding back", async () => {
    const { run } = turnWith(
      response({ toolCalls: [call({ text: "Priya's cert question has had no reply since Friday." })] })
    );

    expect((await run()).finding).toEqual({
      text: "Priya's cert question has had no reply since Friday."
    });
  });

  // The ordinary outcome, and the one most heartbeats produce.
  it("is silent when the model calls nothing", async () => {
    const result = await turnWith(response()).run();

    expect(result.finding).toBeNull();
    expect(result.unusable).toBeUndefined();
  });

  it("is silent for prose with no call in it", async () => {
    // A model that answers in words rather than calling the tool has said
    // nothing, and there is no rule needed for that beyond this one.
    const result = await turnWith(response({ text: "Nothing here seems urgent." })).run();

    expect(result.finding).toBeNull();
    expect(result.unusable).toBeUndefined();
  });

  it("is silent for a tool it was never offered, and does not call that unusable", async () => {
    // `runSummarizationTurn`'s rule: there is no executor here a second tool
    // could reach, so an invented name is a model talking to itself.
    const result = await turnWith(
      response({ toolCalls: [call({ text: "post this" }, "send_message")] })
    ).run();

    expect(result.finding).toBeNull();
    expect(result.unusable).toBeUndefined();
  });

  // The acceptance criterion, and the reason silence is absence rather than a
  // sentinel: every one of these is neither a finding nor a declared silence,
  // and the channel hears nothing for all of them without a branch per case.
  it("is silent for every answer that is not a well-formed finding", async () => {
    const answers: Array<Record<string, unknown>> = [
      {},
      { text: "" },
      { text: 42 },
      { text: "fine", channel: "C0OTHER" },
      { text: "x".repeat(AMBIENT_FINDING_MAX_CHARS + 1) }
    ];

    for (const args of answers) {
      const result = await turnWith(response({ toolCalls: [call(args)] })).run();

      expect(result.finding).toBeNull();
      // But it *is* reported as unusable, which is the half that keeps a broken
      // prompt from hiding inside the expected silence.
      expect(result.unusable).toBeDefined();
    }
  });

  it("tells an over-long finding from a malformed one", async () => {
    const long = await turnWith(
      response({ toolCalls: [call({ text: "x".repeat(AMBIENT_FINDING_MAX_CHARS + 1) })] })
    ).run();
    const broken = await turnWith(response({ toolCalls: [call({ text: 42 })] })).run();

    expect(long.unusable).toBe("text_too_long");
    expect(broken.unusable).toBe("malformed_arguments");
  });

  it("takes the first finding when a model calls twice", async () => {
    const { run } = turnWith(
      response({ toolCalls: [call({ text: "first" }), call({ text: "second" })] })
    );

    expect((await run()).finding).toEqual({ text: "first" });
  });
});

describe("what it costs", () => {
  it("reports the turn before the answer is read", async () => {
    const { run, reported } = turnWith(
      response({ toolCalls: [call({ text: "something" })], model: "served-model" })
    );

    const result = await run();

    expect(reported).toEqual([
      { usage: { inputTokens: 210, outputTokens: 18 }, turn: 1, model: "served-model" }
    ]);
    expect(result.model).toBe("served-model");
  });

  it("reports a silent turn too, because it was paid for", async () => {
    // The case that matters for the meter: almost every heartbeat is silent, and
    // a turn that reported only when it spoke would under-count ambient by
    // roughly everything.
    const { run, reported } = turnWith(response());

    await run();

    expect(reported).toHaveLength(1);
    expect(reported[0]?.usage).toEqual({ inputTokens: 210, outputTokens: 18 });
  });

  it("reports a turn whose answer was unusable", async () => {
    const { run, reported } = turnWith(response({ toolCalls: [call({ text: 42 })] }));

    await run();

    expect(reported).toHaveLength(1);
  });

  it("omits the served model when the provider echoed none", async () => {
    const { run, reported } = turnWith(response());

    const result = await run();

    expect(reported[0]).not.toHaveProperty("model");
    expect(result.model).toBeUndefined();
  });
});

describe("when the provider fails", () => {
  it("rejects rather than answering silence", async () => {
    // The one failure this turn is least able to notice on its own: silence is
    // what it produces almost every time, so a swallowed provider error would be
    // indistinguishable from a quiet channel forever.
    const { run, reported } = turnWith(() =>
      Promise.reject(new CompletionError("provider is down", "unavailable"))
    );

    await expect(run()).rejects.toThrow(/provider is down/);
    expect(reported).toEqual([]);
  });
});
