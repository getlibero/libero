// #68's acceptance criteria, end to end through the production composition:
// mention in, tool calls, one checklist message edited in place, a terminal
// state that names the cap when a cap ended the task.
//
// `held-call.test.ts`'s rig with the approval broker taken out — every call is
// served, so nothing holds and the only card in the thread is the checklist.
// That is what makes "exactly one message" assertable here and not there.
//
// The edit floor runs on the real clock, deliberately: `compose.ts` does not
// route `deps.scheduler` into the checklist, because that scheduler is the
// approval deadline's and a test firing the next pending timer must not find an
// edit floor instead. What this file asserts is the terminal state, which
// `close` writes without waiting for the floor.

import type { CompletionResponse, ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import { createGateway, createSilentLogger, createStubSlack } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  createServer
} from "./compose.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";
const THREAD = "1758000000.000100";

const GREEN = "#1BA85A";
const RED = "#FF6B5B";

/** Serves every call. No holds, so the checklist is the thread's only card. */
const transport: ProxyTransport = {
  request(options: ProxyRequest): Promise<ProxyResponse> {
    if (options.path === "/v1/tools") {
      return Promise.resolve({
        status: 200,
        body: {
          // `approval` is required on a listing entry: the sheet's field is
          // optional and the proxy resolves it, so what arrives is always
          // decided. Both are `none` here — this file is about the checklist,
          // and a hold would put a second card in the thread.
          tools: [
            { server: "github", tool: "list_pull_requests", approval: "none" },
            { server: "github", tool: "merge_pr", approval: "none" }
          ]
        }
      });
    }
    if (options.path === "/v1/spend") return Promise.resolve({ status: 200, body: { outcome: "recorded" } });
    return Promise.resolve({
      status: 200,
      body: { outcome: "ran", id: (options.body as { id: string }).id, result: { content: "ok" } }
    });
  }
};

/**
 * A task of `turns` tool-calling turns, one call each, then a text answer.
 * `perTurn` names which tool each turn calls.
 */
function scriptedModel(perTurn: string[]) {
  let turn = 0;
  return {
    complete: (): Promise<CompletionResponse> => {
      const name = perTurn[turn];
      turn += 1;
      if (name === undefined) {
        return Promise.resolve({
          text: "Done.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 }
        });
      }
      return Promise.resolve({
        text: "",
        toolCalls: [{ id: `call-${String(turn)}`, name, arguments: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    }
  };
}

function rig(perTurn: string[], maxToolCalls = 25) {
  const slack = createStubSlack();
  const logger = createSilentLogger();
  const { gateway } = createServer({
    slack: ({ handler }) => ({
      gateway: createGateway({ source: slack.source, poster: slack.poster, handler, logger }),
      cards: slack.poster
    }),
    completion: scriptedModel(perTurn),
    transport,
    sheets: () =>
      Promise.resolve({
        model: "test-model",
        caps: { ...DEFAULT_AGENT_LOOP_CAPS, maxToolCalls },
        history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
        memory: { ...DEFAULT_MEMORY_SETTINGS },
        skills: { ...DEFAULT_SKILL_SETTINGS }
      }),
    logger
  });
  return { slack, gateway };
}

const mention = (text: string, eventId: string) => ({
  teamId: TEAM,
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text,
  ts: THREAD,
  threadTs: THREAD,
  eventId
});

describe("the live checklist", () => {
  // "A multi-step task produces exactly one checklist message in the thread,
  // updated in place."
  it("is one message for a six-call task, edited rather than reposted", async () => {
    const calls = ["list_pull_requests", "merge_pr", "list_pull_requests", "merge_pr", "list_pull_requests", "merge_pr"];
    const { slack, gateway } = rig(calls);
    await gateway.start();

    await slack.deliverMention(mention("<@U0BOT> tidy the PRs", "Ev001"));

    expect(slack.cards).toHaveLength(1);
    // Six calls, and nothing like six messages. The edits are bounded by the
    // floor rather than by the call count, which is what "edit, don't spam"
    // means below the message level.
    expect(slack.edits.length).toBeLessThan(calls.length);

    const shown = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(shown?.color).toBe(GREEN);
    expect(shown?.fallback).toContain("6 of 6 tool calls done");
    // The flat name the model called, not the `(server, tool)` pair the
    // approval card shows. The loop is what reports progress and only the tool
    // client holds the mapping — and the flat name is the better one here
    // anyway: a checklist is a view of what the model did, so a name that
    // decodes to no tool at all still gets a row (#170).
    expect(JSON.stringify(shown)).toContain("`merge_pr` — done");

    // The answer is its own message, under the checklist.
    expect(slack.posted).toEqual([{ channelId: CHANNEL, threadTs: THREAD, text: "Done." }]);

    await gateway.stop();
  });

  // The decision behind "on the first tool call": an ordinary question is one
  // message in the thread, exactly as it was before #68.
  it("posts no card at all for a task that calls no tool", async () => {
    const { slack, gateway } = rig([]);
    await gateway.start();

    await slack.deliverMention(mention("<@U0BOT> what is our deploy cadence?", "Ev002"));

    expect(slack.cards).toHaveLength(0);
    expect(slack.posted).toHaveLength(1);

    await gateway.stop();
  });

  // "A task stopped by a cap shows which cap in the checklist."
  it("goes red and names the cap that stopped the task", async () => {
    const { slack, gateway } = rig(["merge_pr", "merge_pr", "merge_pr"], 2);
    await gateway.start();

    await slack.deliverMention(mention("<@U0BOT> merge everything", "Ev003"));

    const shown = slack.cardAt(slack.cards[0]?.messageTs ?? "");
    expect(shown?.color).toBe(RED);
    expect(JSON.stringify(shown)).toContain("per-task tool call cap reached");
    // The reply says it too — the two surfaces share one sentence rather than
    // each wording the same fact.
    expect(slack.posted[0]?.text).toContain("per-task tool call cap reached");

    await gateway.stop();
  });

  // The steps are what the loop actually did, so a call the cap refused shows
  // as never having run rather than as a failure.
  it("distinguishes the calls that ran from the one the cap refused", async () => {
    const { slack, gateway } = rig(["merge_pr", "merge_pr", "merge_pr"], 2);
    await gateway.start();

    await slack.deliverMention(mention("<@U0BOT> merge everything", "Ev004"));

    const shown = JSON.stringify(slack.cardAt(slack.cards[0]?.messageTs ?? ""));
    expect(shown).toContain("`merge_pr` — done");
    expect(shown).toContain("`merge_pr` — not run");

    await gateway.stop();
  });
});
