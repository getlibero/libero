// Faked at the CompletionClient seam, the way curation/turn.test.ts is and for
// the same reason: what is under test is which tools the turn offers, what it
// does with what the model asks for, and what it reports — none of which is a
// provider's wire format.

import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { SKILL_BODY_MAX_CHARS, SKILL_DESCRIPTION_MAX_CHARS, SkillToolName } from "@getlibero/schema";
import type { SkillOp, SkillOpResult } from "@getlibero/schema";
import { CompletionError } from "../completion/types.js";
import type {
  CompletionClient,
  CompletionMessage,
  CompletionRequest,
  CompletionResponse,
  ToolCall
} from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";
import {
  SKILL_AUTHOR_SYSTEM_PROMPT,
  SKILL_STEP_MAX_CHARS,
  runSkillAuthorTurn,
  skillToolDefinitions,
  skillTranscript
} from "./turn.js";
import type { NearbySkill, SkillAuthorTurnOptions } from "./turn.js";

const MODEL = "test-model";

const WRITTEN: SkillOpResult = { outcome: "written", skills: 1, limit: 100 };

const DEPLOY: NearbySkill = {
  name: "cut-a-release",
  description: "When somebody asks how a release is cut.",
  body: "1. Check the open PRs.\n2. Tag."
};

function response(partial: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text: "",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    ...partial
  };
}

/** One response, and the request that asked for it. */
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

function call(name: string, args: Record<string, unknown>, id = "call-1"): ToolCall {
  return { id, name, arguments: args };
}

/** Records what it was asked to do and answers written. */
function recordingHandler(): { applyOp: (op: SkillOp) => SkillOpResult; seen: SkillOp[] } {
  const seen: SkillOp[] = [];
  return {
    seen,
    applyOp(op) {
      seen.push(op);
      return WRITTEN;
    }
  };
}

function options(partial: Partial<SkillAuthorTurnOptions> = {}): SkillAuthorTurnOptions {
  const { client } = fakeCompletion(response());
  return {
    completion: client,
    model: MODEL,
    messages: [{ role: "user", content: "cut a release please" }],
    nearby: [],
    skills: 0,
    maxSkills: 100,
    applyOp: () => WRITTEN,
    maxTokens: 1024,
    turn: 2,
    ...partial
  };
}

/** A well-formed create, as the model would send one. */
function createArgs(name = "cut-a-release"): Record<string, unknown> {
  return {
    name,
    description: "When somebody asks how a release is cut.",
    body: "1. Check the open PRs.\n2. Tag."
  };
}

/** The last message of the request, which is where the turn's question lives. */
function question(request: CompletionRequest): string {
  const last = request.messages.at(-1);
  if (last === undefined || last.role !== "user") throw new Error("expected a user message");
  return last.content;
}

describe("what the turn offers the model", () => {
  it("offers the two skill operations and nothing else", async () => {
    // The acceptance criterion, in the same shape curation's suite states it:
    // this turn cannot reach a proxied tool, because there is nothing here that
    // could dispatch one.
    const { client, requests } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client }));

    expect(requests[0]?.tools?.map(tool => tool.name).sort()).toEqual([
      "skill_create",
      "skill_revise"
    ]);
  });

  // Built from `SKILL_TOOLS` rather than restated, so what a model reads is what
  // the schema publishes and there is no second copy to drift.
  it("takes the descriptions and schemas from the schema package", () => {
    expect(skillToolDefinitions().map(tool => tool.name)).toEqual(SkillToolName.options);
    for (const tool of skillToolDefinitions()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.required).toEqual(["name", "description", "body"]);
    }
  });

  it("sends the author prompt as the system prompt", async () => {
    const { client, requests } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client }));

    expect(requests[0]?.system).toBe(SKILL_AUTHOR_SYSTEM_PROMPT);
  });

  it("passes the per-turn output ceiling through", async () => {
    const { client, requests } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client, maxTokens: 4096 }));

    expect(requests[0]?.maxTokens).toBe(4096);
  });

  it("says how full the library is, so a model can revise instead of being refused", async () => {
    const { client, requests } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client, skills: 99, maxSkills: 100 }));

    expect(question(requests[0] as CompletionRequest)).toContain("holds 99 skills and may hold 100");
  });
});

describe("the neighbours it is shown", () => {
  // The whole reason `nearby` exists: a revision replaces a body outright, so a
  // model that cannot see the body it is replacing can only overwrite it blind.
  it("renders each nearby skill in full, name and description and body", async () => {
    const { client, requests } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client, nearby: [DEPLOY] }));

    const text = question(requests[0] as CompletionRequest);
    expect(text).toContain("## cut-a-release");
    expect(text).toContain("When somebody asks how a release is cut.");
    expect(text).toContain("2. Tag.");
  });

  it("says so plainly when there are none", async () => {
    const { client, requests } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client, nearby: [] }));

    expect(question(requests[0] as CompletionRequest)).toContain("no skills on this subject yet");
  });

  // The question changes every call and the system prompt does not, which is what
  // keeps the system prompt cacheable.
  it("puts them in a user message rather than in the system prompt", async () => {
    const { client, requests } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client, nearby: [DEPLOY] }));

    expect(requests[0]?.system).not.toContain("cut-a-release");
    expect(requests[0]?.messages.at(-1)?.role).toBe("user");
  });
});

describe("the transcript the model sees", () => {
  const TASK: CompletionMessage[] = [
    { role: "user", content: "cut a release please" },
    {
      role: "assistant",
      content: "I'll look at the open PRs first.",
      toolCalls: [call("github.list_pull_requests", { state: "open" }, "c1")],
      providerState: { thinking: "secret" }
    },
    { role: "tool", toolCallId: "c1", content: '[{"number":301,"title":"the index"}]' },
    {
      role: "assistant",
      content: "",
      toolCalls: [call("github.merge_pull_request", { number: 301 }, "c2")]
    },
    {
      role: "tool",
      toolCallId: "c2",
      content: "refused: approval required for merge_pull_request",
      isError: true
    },
    { role: "assistant", content: "#301 needs a human click before I can merge it." }
  ];

  // The inversion of `curationTranscript`, and the reason this function exists:
  // a playbook *is* the tool traffic, so a turn that could not see it would be
  // writing a playbook out of the assistant's summary of one.
  it("keeps the calls the task made, in order, with their arguments", () => {
    const rendered = skillTranscript(TASK)
      .map(message => message.content)
      .join("\n");

    expect(rendered).toContain('called github.list_pull_requests({"state":"open"})');
    expect(rendered).toContain('called github.merge_pull_request({"number":301})');
    expect(rendered.indexOf("list_pull_requests")).toBeLessThan(rendered.indexOf("merge_pull"));
  });

  // A success is procedure and a failure is a warning. A truncated JSON response
  // ends mid-object and teaches nothing; a refusal is short and complete, and is
  // exactly what SKILL_TOOLS means by the parts that are easy to get wrong.
  it("elides a successful result and keeps a failed one", () => {
    const rendered = skillTranscript(TASK)
      .map(message => message.content)
      .join("\n");

    expect(rendered).toContain("→ ok");
    expect(rendered).not.toContain('"title":"the index"');
    expect(rendered).toContain("→ failed: refused: approval required for merge_pull_request");
  });

  it("keeps the assistant's own words and the question", () => {
    const rendered = skillTranscript(TASK)
      .map(message => message.content)
      .join("\n");

    expect(rendered).toContain("cut a release please");
    expect(rendered).toContain("I'll look at the open PRs first.");
    expect(rendered).toContain("#301 needs a human click");
  });

  // Opaque replay state belonging to the conversation that produced it, and this
  // is a different conversation.
  it("drops providerState and every tool message", () => {
    const kept = skillTranscript(TASK);

    expect(kept.every(message => message.role !== "tool")).toBe(true);
    expect(JSON.stringify(kept)).not.toContain("secret");
    expect(kept.every(message => !("toolCalls" in message))).toBe(true);
  });

  // An assistant turn that was only calls still contributes, because the calls
  // are the point — unlike curation, where such a turn is dropped entirely.
  it("keeps an assistant turn that said nothing but called something", () => {
    const kept = skillTranscript(TASK);

    expect(kept.some(message => message.content.startsWith("called github.merge"))).toBe(true);
  });

  it("drops an assistant turn that said nothing and called nothing", () => {
    const kept = skillTranscript([
      { role: "user", content: "hello" },
      { role: "assistant", content: "" }
    ]);

    expect(kept).toEqual([{ role: "user", content: "hello" }]);
  });

  it("cuts an enormous argument object rather than relaying it whole", () => {
    const kept = skillTranscript([
      {
        role: "assistant",
        content: "",
        toolCalls: [call("github.create_issue", { body: "x".repeat(5000) }, "c1")]
      },
      { role: "tool", toolCallId: "c1", content: "ok" }
    ]);

    expect(kept[0]?.content.length).toBeLessThan(SKILL_STEP_MAX_CHARS + 100);
    expect(kept[0]?.content).toContain("[truncated]");
  });

  it("cuts an enormous failure the same way", () => {
    const kept = skillTranscript([
      {
        role: "assistant",
        content: "",
        toolCalls: [call("github.create_issue", {}, "c1")]
      },
      { role: "tool", toolCallId: "c1", content: "y".repeat(5000), isError: true }
    ]);

    expect(kept[0]?.content.length).toBeLessThan(SKILL_STEP_MAX_CHARS + 100);
  });

  // It cannot happen through `runAgentTask`, whose transcript is well-formed by
  // construction — but this takes a transcript rather than a result, and
  // inventing an outcome for a call whose fate is unknown is the one thing it
  // must not do.
  it("says so rather than guessing when a call has no result", () => {
    const kept = skillTranscript([
      { role: "assistant", content: "", toolCalls: [call("github.merge_pull_request", {}, "c9")] }
    ]);

    expect(kept[0]?.content).toContain("→ outcome unknown");
  });

  it("does not mutate what it was handed", () => {
    const before = JSON.stringify(TASK);
    skillTranscript(TASK);
    expect(JSON.stringify(TASK)).toBe(before);
  });
});

describe("a model that emits valid operations", () => {
  it("runs each one in the order it asked", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({
        toolCalls: [
          call("skill_create", createArgs("cut-a-release"), "c1"),
          call("skill_revise", createArgs("roll-back-a-release"), "c2")
        ],
        stopReason: "tool_use"
      })
    );

    const result = await runSkillAuthorTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([
      { op: "skill_create", ...createArgs("cut-a-release") },
      { op: "skill_revise", ...createArgs("roll-back-a-release") }
    ]);
    expect(result.ops.map(op => op.tool)).toEqual(["skill_create", "skill_revise"]);
  });

  it("carries the store's refusal through verbatim, with its sentence", async () => {
    const refusal: SkillOpResult = {
      outcome: "failed",
      reason: "name_taken",
      name: "cut-a-release"
    };
    const { client } = fakeCompletion(
      response({ toolCalls: [call("skill_create", createArgs())], stopReason: "tool_use" })
    );

    const result = await runSkillAuthorTurn(options({ completion: client, applyOp: () => refusal }));

    expect(result.ops[0]?.result).toEqual(refusal);
    expect(result.ops[0]?.message).toContain("already exists");
  });
});

describe("a model that emits nothing", () => {
  // The ordinary path above the threshold, and the one the prompt asks for.
  // There is no `skill_none` to say it with — absence is the decline.
  it("writes nothing and reports no operations", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(response({ text: "Nothing reusable here." }));

    const result = await runSkillAuthorTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(handler.seen).toEqual([]);
    expect(result.ops).toEqual([]);
  });
});

describe("a model that emits garbage", () => {
  // The acceptance criterion, stated the way curation's suite states it: this
  // turn cannot invoke a proxied tool, because a name that is not one of the two
  // is answered by the parser and dispatched nowhere.
  each([["search_channel_history"], ["merge_pull_request"], ["memory_append"]])(
    "refuses %s without reaching the store",
    async name => {
      const handler = recordingHandler();
      const { client } = fakeCompletion(
        response({ toolCalls: [call(name, createArgs())], stopReason: "tool_use" })
      );

      const result = await runSkillAuthorTurn(
        options({ completion: client, applyOp: handler.applyOp })
      );

      expect(result.ops[0]?.result).toEqual({ outcome: "failed", reason: "unknown_tool" });
      expect(handler.seen).toEqual([]);
    }
  );

  each([
    ["a missing field", { name: "cut-a-release", description: "d" }],
    ["a wrong type", { name: "cut-a-release", description: "d", body: 7 }],
    ["an unknown key", { ...createArgs(), colour: "green" }],
    ["a traversal in the name", { ...createArgs(), name: "../../etc/passwd" }],
    ["an empty body", { ...createArgs(), body: "" }]
  ])("refuses %s without reaching the store", async (_case, args) => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({ toolCalls: [call("skill_create", args)], stopReason: "tool_use" })
    );

    const result = await runSkillAuthorTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(result.ops[0]?.result.outcome).toBe("failed");
    expect(handler.seen).toEqual([]);
  });

  it("still runs a well-formed operation beside a bad one", async () => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({
        toolCalls: [
          call("nonsense", {}, "c1"),
          call("skill_create", createArgs(), "c2")
        ],
        stopReason: "tool_use"
      })
    );

    await runSkillAuthorTurn(options({ completion: client, applyOp: handler.applyOp }));

    expect(handler.seen).toHaveLength(1);
  });

  each([
    ["a body", { ...createArgs(), body: "x".repeat(SKILL_BODY_MAX_CHARS + 1) }],
    ["a description", { ...createArgs(), description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) }]
  ])("refuses an oversize %s before the store is asked", async (_case, args) => {
    const handler = recordingHandler();
    const { client } = fakeCompletion(
      response({ toolCalls: [call("skill_create", args)], stopReason: "tool_use" })
    );

    const result = await runSkillAuthorTurn(
      options({ completion: client, applyOp: handler.applyOp })
    );

    expect(result.ops[0]?.result.outcome).toBe("failed");
    expect(handler.seen).toEqual([]);
  });
});

describe("what the turn reports", () => {
  it("reports its cost exactly once, with the turn number it was given", async () => {
    const turns: CompletedTurn[] = [];
    const { client } = fakeCompletion(
      response({ usage: { inputTokens: 900, outputTokens: 120 }, model: "served-model" })
    );

    await runSkillAuthorTurn(
      options({ completion: client, turn: 3, onTurn: turn => void turns.push(turn) })
    );

    expect(turns).toEqual([
      { usage: { inputTokens: 900, outputTokens: 120 }, turn: 3, model: "served-model" }
    ]);
  });

  it("omits the model rather than inventing one when the provider echoed none", async () => {
    const turns: CompletedTurn[] = [];
    const { client } = fakeCompletion(response());

    await runSkillAuthorTurn(options({ completion: client, onTurn: turn => void turns.push(turn) }));

    expect("model" in (turns[0] as CompletedTurn)).toBe(false);
  });

  // The loop's ordering, and its reason: a turn that was paid for is counted
  // even if what it asked for then fails.
  it("reports the spend before it runs an operation", async () => {
    const order: string[] = [];
    const { client } = fakeCompletion(
      response({ toolCalls: [call("skill_create", createArgs())], stopReason: "tool_use" })
    );

    await runSkillAuthorTurn(
      options({
        completion: client,
        onTurn: () => void order.push("reported"),
        applyOp: () => {
          order.push("applied");
          return WRITTEN;
        }
      })
    );

    expect(order).toEqual(["reported", "applied"]);
  });

  it("still reports the spend when the store throws", async () => {
    const turns: CompletedTurn[] = [];
    const { client } = fakeCompletion(
      response({ toolCalls: [call("skill_create", createArgs())], stopReason: "tool_use" })
    );

    await expect(
      runSkillAuthorTurn(
        options({
          completion: client,
          onTurn: turn => void turns.push(turn),
          applyOp: () => {
            throw new Error("disk full");
          }
        })
      )
    ).rejects.toThrow("disk full");

    expect(turns).toHaveLength(1);
  });

  // The caller catches, because the reply has already posted and an authoring
  // failure must not reach it. Swallowing here would make a broken provider look
  // like a channel that never learns anything.
  it("rejects when the provider does", async () => {
    const { client } = fakeCompletion(() =>
      Promise.reject(new CompletionError("upstream down", "anthropic"))
    );

    await expect(runSkillAuthorTurn(options({ completion: client }))).rejects.toBeInstanceOf(
      CompletionError
    );
  });
});

describe("the author prompt", () => {
  // Three clauses carry what a library is worth, and each is here rather than
  // only in the tool descriptions because this is the text framing the decision.
  each([
    ["most tasks produce nothing", /Most tasks produce nothing worth writing down/u],
    ["extend rather than duplicate", /extend that one with\nskill_revise/u],
    ["a revision replaces the body whole", /replaces\nthe description and the body outright/u],
    ["a failed tool is not a playbook", /Do not\nwrite a playbook around a tool that did not work here/u]
  ])("says %s", (_case, pattern) => {
    expect(SKILL_AUTHOR_SYSTEM_PROMPT).toMatch(pattern);
  });

  // A skill is a playbook and MEMORY.md is a fact about the team. A turn that
  // confused them would fill the library with things the curation turn already
  // records.
  it("says where a fact about the team goes instead", () => {
    expect(SKILL_AUTHOR_SYSTEM_PROMPT).toContain("MEMORY.md");
  });
});
