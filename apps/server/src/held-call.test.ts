// The whole held-call path, end to end against stub Slack and a manual clock:
// mention in, hold, amber card, click (or deadline), terminal card, ticket on
// the re-submission, one real tool result in the model's transcript, reply in
// the thread. Everything between the stub socket and the fake transport is the
// production wiring — the same composition index.ts builds, minus the
// environment.
//
// This is #127's acceptance suite. The pieces are each tested alone in
// approvals/, session/, and packages/agent; what only this file can catch is a
// seam that drops the baton — a registry entry a click cannot find, a card
// repainted after the reply, a queued mention running during a hold.

import type { CompletionResponse } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS, createProxyApprovalsClient } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import type { Scheduler } from "@getlibero/gateway";
import { createGateway, createSilentLogger, createStubSlack } from "@getlibero/gateway";
import { describe, expect, it, vi } from "vitest";
import { createDecisionHandler } from "./approvals/decisions.js";
import { createHeldCallPrompter } from "./approvals/prompter.js";
import { createApprovalRegistry } from "./approvals/registry.js";
import { createMentionHandler } from "./handler.js";
import { createChannelRouter } from "./session/router.js";
import { createTaskRunner } from "./session/task.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";
const THREAD = "1758000000.000100";
const TICKET = "tk-7f3a";
const NOW = Date.UTC(2026, 7, 4, 12, 0);
const EXPIRES = NOW + 15 * 60 * 1000;

const AMBER = "#F5B544";
const GREEN = "#1BA85A";
const RED = "#FF6B5B";

/** A scheduler whose timers only fire when a test says so. */
function manualClock(): { scheduler: Scheduler; pending: () => number[]; fire: () => void } {
  const queue: Array<{ ms: number; fn: () => void }> = [];
  return {
    scheduler: (ms, fn) => {
      const entry = { ms, fn };
      queue.push(entry);
      return () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    pending: () => queue.map(entry => entry.ms),
    fire: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("no timer was pending");
      next.fn();
    }
  };
}

/**
 * The proxy, faked at the transport seam, with the broker's whole vocabulary:
 * a first submission is held, a re-submission is answered per scenario, and a
 * decision is recorded.
 */
function fakeProxy(redeemed: () => ProxyResponse): {
  transport: ProxyTransport;
  sent: ProxyRequest[];
} {
  const sent: ProxyRequest[] = [];
  return {
    sent,
    transport: {
      async request(options: ProxyRequest): Promise<ProxyResponse> {
        sent.push(options);
        if (options.path === "/v1/tools") {
          return {
            status: 200,
            body: { tools: [{ server: "github", tool: "merge_pr", approval: "required" }] }
          };
        }
        if (options.path === "/v1/spend") {
          return { status: 200, body: { outcome: "recorded" } };
        }
        if (options.path === "/v1/approvals") {
          const body = options.body as { ticket: string; decision: "approve" | "deny" };
          return {
            status: 200,
            body: { outcome: "recorded", ticket: body.ticket, decision: body.decision }
          };
        }
        const body = options.body as { ticket?: string };
        if (body.ticket === undefined) {
          return {
            status: 200,
            body: {
              outcome: "held",
              id: "call-1",
              refusal: { reason: "approval_required", server: "github", tool: "merge_pr" },
              ticket: { id: TICKET, expiresAt: EXPIRES }
            }
          };
        }
        return redeemed();
      }
    }
  };
}

const RAN: ProxyResponse = {
  status: 200,
  body: { outcome: "ran", id: "call-1", result: { content: "merged #42" } }
};

const refusedWith = (reason: string): ProxyResponse => ({
  status: 200,
  body: {
    outcome: "refused",
    id: "call-1",
    refusal: { reason, server: "github", tool: "merge_pr" }
  }
});

/**
 * The production composition over the stubs: gateway → handler → router → task,
 * with the completion client scripted per test. One tool-calling task is turn 1
 * `tool_use` then turn 2 text; a mention whose text asks for no tool answers in
 * one turn.
 */
function rig(redeemed: () => ProxyResponse) {
  const slack = createStubSlack();
  const clock = manualClock();
  const registry = createApprovalRegistry();
  const proxy = fakeProxy(redeemed);
  const logger = createSilentLogger();

  /** Every request the model saw, across all tasks, in order. */
  const modelSaw: Array<{ messages: unknown }> = [];
  const completion = {
    complete: (request: { messages: Array<{ content: unknown }> }): Promise<CompletionResponse> => {
      modelSaw.push({ messages: request.messages });
      const text = JSON.stringify(request.messages);
      if (text.includes('"role":"tool"') || !text.includes("merge")) {
        // Turn 2 of a tool task, or a task that never called one.
        return Promise.resolve({
          text: "Done.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 }
        });
      }
      return Promise.resolve({
        text: "",
        toolCalls: [{ id: "call-1", name: "merge_pr", arguments: { pr: 42 } }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    }
  };

  const gateway = createGateway({
    source: slack.source,
    poster: slack.poster,
    handler: createMentionHandler(
      createChannelRouter({
        sheets: () => Promise.resolve({ model: "test-model", caps: { ...DEFAULT_AGENT_LOOP_CAPS } }),
        task: createTaskRunner({ completion, transport: proxy.transport, logger }),
        logger
      }),
      createHeldCallPrompter({
        cards: slack.poster,
        registry,
        logger,
        now: () => NOW,
        scheduler: clock.scheduler
      })
    ),
    onDecision: createDecisionHandler({
      registry,
      approvals: createProxyApprovalsClient({ transport: proxy.transport }),
      logger
    }),
    logger
  });

  return { slack, clock, registry, proxy, modelSaw, gateway };
}

const mentionFields = (text: string, eventId: string, ts = THREAD) => ({
  teamId: TEAM,
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text,
  ts,
  threadTs: THREAD,
  eventId
});

describe("hold → card → decision → run", () => {
  it("a destructive call raises an amber card, and a click runs it", async () => {
    const { slack, gateway, modelSaw } = rig(() => RAN);
    await gateway.start();

    const pending = slack.deliverMention(mentionFields("<@U0BOT> merge pr 42", "Ev001"));

    // The amber card is up while the task waits — the model has seen one turn
    // and the thread has no reply yet.
    await vi.waitFor(() => {
      expect(slack.cards).toHaveLength(1);
    });
    const card = slack.cards[0];
    expect(card?.card.color).toBe(AMBER);
    expect(card?.threadTs).toBe(THREAD);
    expect(slack.posted).toHaveLength(0);

    await slack.deliverDecision({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U0G9QF9C6",
      ticketId: TICKET,
      verdict: "approve",
      messageTs: card?.messageTs ?? "",
      threadTs: THREAD
    });
    await pending;

    // Green card naming the approver, and the tool's real result in the
    // model's transcript — never the hold, never the ticket.
    const shown = slack.cardAt(card?.messageTs ?? "");
    expect(shown?.color).toBe(GREEN);
    expect(JSON.stringify(shown)).toContain("U0G9QF9C6");
    const transcript = JSON.stringify(modelSaw);
    expect(transcript).toContain("merged #42");
    expect(transcript).not.toContain(TICKET);
    expect(slack.posted).toEqual([{ channelId: CHANNEL, threadTs: THREAD, text: "Done." }]);

    await gateway.stop();
  });

  it("a deny turns the card red and hands the model the proxy's refusal", async () => {
    const { slack, gateway, modelSaw } = rig(() => refusedWith("approval_denied"));
    await gateway.start();

    const pending = slack.deliverMention(mentionFields("<@U0BOT> merge pr 42", "Ev002"));
    await vi.waitFor(() => {
      expect(slack.cards).toHaveLength(1);
    });

    await slack.deliverDecision({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U0G9QF9C6",
      ticketId: TICKET,
      verdict: "deny",
      messageTs: slack.cards[0]?.messageTs ?? "",
      threadTs: THREAD
    });
    await pending;

    expect(slack.cardAt(slack.cards[0]?.messageTs ?? "")?.color).toBe(RED);
    // The refusal is the tool result the model relays; the task completed and
    // the thread got its reply rather than a hang.
    expect(JSON.stringify(modelSaw)).toContain("A human declined");
    expect(slack.posted).toHaveLength(1);

    await gateway.stop();
  });

  it("an expiry turns the card red and the task completes on the proxy's refusal", async () => {
    const { slack, clock, gateway, modelSaw } = rig(() => refusedWith("approval_expired"));
    await gateway.start();

    const pending = slack.deliverMention(mentionFields("<@U0BOT> merge pr 42", "Ev003"));
    await vi.waitFor(() => {
      expect(slack.cards).toHaveLength(1);
    });

    // Nobody clicks. The deadline is the ticket's own expiresAt.
    expect(clock.pending()).toEqual([EXPIRES - NOW]);
    clock.fire();
    await pending;

    expect(slack.cardAt(slack.cards[0]?.messageTs ?? "")?.color).toBe(RED);
    expect(JSON.stringify(modelSaw)).toContain("expired before the call was made");
    expect(slack.posted).toHaveLength(1);

    await gateway.stop();
  });

  // The session mutex working as specified: the channel is busy while held, so
  // a second mention queues behind the approval rather than interleaving.
  it("a mention during a hold queues, and runs after the decision", async () => {
    const { slack, gateway, modelSaw } = rig(() => RAN);
    await gateway.start();

    const first = slack.deliverMention(mentionFields("<@U0BOT> merge pr 42", "Ev004"));
    await vi.waitFor(() => {
      expect(slack.cards).toHaveLength(1);
    });

    const second = slack.deliverMention(
      mentionFields("<@U0BOT> what is the deploy window?", "Ev005", "1758000000.000200")
    );
    // Queued, not started: the model has seen only the first task's turn.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(modelSaw).toHaveLength(1);

    await slack.deliverDecision({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U0G9QF9C6",
      ticketId: TICKET,
      verdict: "approve",
      messageTs: slack.cards[0]?.messageTs ?? "",
      threadTs: THREAD
    });
    await first;
    await second;

    // Both answered, in order.
    expect(slack.posted.map(reply => reply.text)).toEqual(["Done.", "Done."]);

    await gateway.stop();
  });
});
