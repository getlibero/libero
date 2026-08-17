// Faked at the CompletionClient seam, ./turn.test.ts's reason: what is under
// test is what the turn offers, what it does with what the model asks for, and
// what it reports — none of which is a provider's wire format.

import { describe, expect, it } from "vitest";
import { SKILL_BODY_MAX_CHARS, SKILL_MERGE_TOOL } from "@getlibero/schema";
import { CompletionError } from "../completion/types.js";
import type {
  CompletionClient,
  CompletionRequest,
  CompletionResponse,
  ToolCall
} from "../completion/types.js";
import type { CompletedTurn } from "../loop/types.js";
import {
  SKILL_MERGE_SYSTEM_PROMPT,
  runSkillMergeTurn,
  skillMergeToolDefinition
} from "./merge.js";
import type { MergeCandidate, SkillMergeTurnOptions } from "./merge.js";

const MODEL = "test-model";

const RUNBOOK: MergeCandidate = {
  name: "deploy-runbook",
  description: "When somebody asks how we ship.",
  body: "1. `make deploy`\n2. Watch the smoke test."
};

const ROLLBACK: MergeCandidate = {
  name: "deploy-rollback",
  description: "When a ship has to be undone.",
  body: "1. `make rollback`\n2. Tell the channel."
};

const DRAFT = {
  keep: "deploy-runbook",
  description: "How to ship, and how to roll back when it goes wrong.",
  body: "1. `make deploy`\n2. If the smoke test fails, `make rollback` and tell the channel."
} as const;

function response(partial: Partial<CompletionResponse> = {}): CompletionResponse {
  return {
    text: "",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 120, outputTokens: 40 },
    ...partial
  };
}

const call = (args: Record<string, unknown>, name = SKILL_MERGE_TOOL): ToolCall => ({
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

/** The turn, plus what it reported and in what order relative to the draft. */
function turnWith(
  next: CompletionResponse | (() => Promise<CompletionResponse>),
  over: Partial<SkillMergeTurnOptions> = {}
) {
  const { client, requests } = fakeCompletion(next);
  const reported: CompletedTurn[] = [];
  const options: SkillMergeTurnOptions = {
    completion: client,
    model: MODEL,
    pair: [ROLLBACK, RUNBOOK],
    maxTokens: 2048,
    turn: 3,
    onTurn: turn => {
      reported.push(turn);
    },
    ...over
  };
  return { run: () => runSkillMergeTurn(options), requests, reported };
}

describe("what the merge turn offers", () => {
  it("offers exactly one tool, and it is the merge one", async () => {
    const { run, requests } = turnWith(response());
    await run();

    expect(requests[0]?.tools?.map(tool => tool.name)).toEqual([SKILL_MERGE_TOOL]);
    expect(skillMergeToolDefinition().name).toBe(SKILL_MERGE_TOOL);
  });

  it("offers no proxied tool and no way to write", async () => {
    const { run, requests } = turnWith(response());
    await run();

    const names = requests[0]?.tools?.map(tool => tool.name) ?? [];
    for (const forbidden of ["skill_create", "skill_revise", "memory_append", "memory_replace"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("frames the pair as the closest two rather than as two that overlap", () => {
    expect(SKILL_MERGE_SYSTEM_PROMPT).toContain("were not chosen because anybody judged them similar");
    expect(SKILL_MERGE_SYSTEM_PROMPT).toContain("call no tool at all");
    expect(SKILL_MERGE_SYSTEM_PROMPT).toContain("Nothing you do changes");
  });

  // A merge replaces the kept body outright, so a model that cannot see the body
  // it is replacing can only overwrite it blind.
  it("shows both playbooks in full, and names both", async () => {
    const { run, requests } = turnWith(response());
    await run();

    const sent = requests[0]?.messages[0]?.content ?? "";
    expect(sent).toContain(RUNBOOK.body);
    expect(sent).toContain(ROLLBACK.body);
    expect(sent).toContain(RUNBOOK.description);
    expect(sent).toContain(ROLLBACK.description);
    expect(sent).toContain("`deploy-rollback`");
    expect(sent).toContain("`deploy-runbook`");
  });

  // `created` and `status` are not the model's, they play no part in whether two
  // playbooks are one, and the merged skill inherits them from whichever name
  // survives.
  it("shows neither skill's clock or status", async () => {
    const { run, requests } = turnWith(response());
    await run();

    const sent = requests[0]?.messages[0]?.content ?? "";
    expect(sent).not.toContain("created");
    expect(sent).not.toContain("status");
  });

  it("sends one message and the system prompt, and nothing else", async () => {
    const { run, requests } = turnWith(response());
    await run();

    expect(requests[0]?.system).toBe(SKILL_MERGE_SYSTEM_PROMPT);
    expect(requests[0]?.messages).toHaveLength(1);
    expect(requests[0]?.messages[0]?.role).toBe("user");
  });
});

describe("what the merge turn answers", () => {
  it("answers the draft, with the other name derived", async () => {
    const { run } = turnWith(response({ toolCalls: [call({ ...DRAFT })] }));

    await expect(run()).resolves.toMatchObject({
      draft: { keep: "deploy-runbook", drop: "deploy-rollback", body: DRAFT.body }
    });
  });

  // The ordinary outcome, and it is not a failure: `unusable` stays absent so a
  // caller can tell "the model declined" from "the model could not follow the
  // schema".
  it("answers a decline when the model calls nothing", async () => {
    const { run } = turnWith(response({ text: "These are two different playbooks." }));

    const result = await run();
    expect(result.draft).toBeNull();
    expect(result.unusable).toBeUndefined();
  });

  it("ignores a tool it does not offer rather than reporting it", async () => {
    const { run } = turnWith(response({ toolCalls: [call({ name: "x" }, "skill_create")] }));

    const result = await run();
    expect(result.draft).toBeNull();
    expect(result.unusable).toBeUndefined();
  });

  it.each([
    ["a name that is neither of the two", { ...DRAFT, keep: "something-else" }, "keep_not_nominated"],
    ["a traversal for a name", { ...DRAFT, keep: "../../etc/passwd" }, "name_invalid"],
    ["an oversize body", { ...DRAFT, body: "b".repeat(SKILL_BODY_MAX_CHARS + 1) }, "body_too_long"],
    ["an unknown key", { ...DRAFT, channel: "C0OTHER" }, "malformed_arguments"]
  ])("names %s as unusable, and drafts nothing", async (_label, args, reason) => {
    const { run } = turnWith(response({ toolCalls: [call(args)] }));

    await expect(run()).resolves.toMatchObject({ draft: null, unusable: reason });
  });

  it("takes the first call by its own name", async () => {
    const { run } = turnWith(
      response({
        toolCalls: [
          call({ name: "x" }, "some_other_tool"),
          call({ ...DRAFT }),
          call({ ...DRAFT, keep: "deploy-rollback" })
        ]
      })
    );

    await expect(run()).resolves.toMatchObject({ draft: { keep: "deploy-runbook" } });
  });
});

describe("what the merge turn costs", () => {
  it("reports its spend before the draft is read", async () => {
    const { run, reported } = turnWith(response({ toolCalls: [call({ ...DRAFT })], model: "served" }));

    const result = await run();
    expect(reported).toEqual([
      { usage: { inputTokens: 120, outputTokens: 40 }, turn: 3, model: "served" }
    ]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(result.model).toBe("served");
  });

  // A turn that was paid for is counted even when what it produced is unusable —
  // otherwise the cheapest way to spend a channel's budget invisibly would be to
  // emit nonsense.
  it.each([
    ["declined", response()],
    ["unusable", response({ toolCalls: [call({ ...DRAFT, keep: "elsewhere" })] })]
  ])("reports its spend on a %s turn too", async (_label, answer) => {
    const { run, reported } = turnWith(answer);
    await run();

    expect(reported).toHaveLength(1);
    expect(reported[0]?.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("omits the model when the provider echoed none", async () => {
    const { run, reported } = turnWith(response());
    await run();

    expect(reported[0]).not.toHaveProperty("model");
  });

  // This file has no logger, so swallowing would make a broken provider
  // indistinguishable from a library with no overlaps in it.
  it("propagates a provider failure rather than answering a decline", async () => {
    const { run } = turnWith(() => Promise.reject(new CompletionError("upstream is down", "test")));

    await expect(run()).rejects.toThrow(/upstream is down/);
  });

  it("forwards an abort signal to the provider", async () => {
    const controller = new AbortController();
    const { run, requests } = turnWith(response(), { signal: controller.signal });
    await run();

    expect(requests[0]?.signal).toBe(controller.signal);
  });
});
