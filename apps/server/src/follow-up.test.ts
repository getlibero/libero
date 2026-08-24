// #66's acceptance suite: a reply in a thread the agent is working in reaches
// it with no mention, a reply anywhere else does not, and a thread that has gone
// quiet needs a mention again.
//
// Wired through `createServer` from compose.ts — the same call index.ts makes,
// minus the environment — over stub Slack and a real store, the way
// message-intake.test.ts is. The pieces are each tested alone: the deadline
// arithmetic in session/threads.test.ts, the three routing conditions in
// ingest.test.ts, the reply-into-the-thread rule in the gateway's own tests.
// What only this file can catch is a seam that drops the baton — an ingest
// wired to a second router with its own sessions, a thread activated on one
// clock and read on another, or a mention answered twice because both
// subscriptions routed it.
//
// The clock is `sessionClock`, injected, so "the window passed" is a statement
// rather than a wait. Everything else is the production graph.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionResponse } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import {
  STUB_APP_USER_ID,
  createGateway,
  createSilentLogger,
  createStubSlack
} from "@getlibero/gateway";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import {
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_AMBIENT_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  createMessageStoreOpener,
  createServer
} from "./compose.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";

/** The mention that starts everything, and the thread it starts. */
const MENTION_TS = "1717171717.000100";
const WINDOW_MS = 60_000;

let channelsRoot: string;
let storeRoot: string;
let clock: number;

/** Writes a channel's sheet — this process's whole notion of provisioning. */
function provision(channel: string): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, "channel.toml"), '[channel]\nid = "x"\n');
}

/** A transport that answers the two paths a task takes and records nothing. */
const transport: ProxyTransport = {
  request(options: ProxyRequest): Promise<ProxyResponse> {
    if (options.path === "/v1/tools") return Promise.resolve({ status: 200, body: { tools: [] } });
    return Promise.resolve({ status: 200, body: { outcome: "recorded" } });
  }
};

/** The production composition over the stubs, with a real store root. */
function rig(followUpWindowMs = WINDOW_MS): {
  slack: ReturnType<typeof createStubSlack>;
  gateway: ReturnType<typeof createServer>["gateway"];
  /** Every transcript the model was asked about, in order. */
  asked: string[];
} {
  const slack = createStubSlack();
  const logger = createSilentLogger();
  const asked: string[] = [];

  const completion = {
    complete: (request: { messages: ReadonlyArray<{ role: string; content: unknown }> }): Promise<CompletionResponse> => {
      const seed = request.messages.find(message => message.role === "user");
      asked.push(typeof seed?.content === "string" ? seed.content : "");
      return Promise.resolve({
        text: `answer ${String(asked.length)}`,
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    }
  };

  const { gateway } = createServer({
    slack: ({ handler, onDecision, onMessage }) => ({
      gateway: createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onDecision,
        onMessage,
        // The real thing wires this from `auth.test`. Without it every message
        // carrying any mention token reads as addressing the app, which is the
        // fail-closed path and not what this suite is about.
        identity: slack.identity,
        logger
      }),
      cards: slack.poster
    }),
    completion,
    transport,
    sheets: () =>
      Promise.resolve({
        model: "test-model",
        description: "",
        sharedSkills: [],
        caps: { ...DEFAULT_AGENT_LOOP_CAPS },
        history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs,
        memory: { ...DEFAULT_MEMORY_SETTINGS },
        skills: { ...DEFAULT_SKILL_SETTINGS },
        ambient: { ...DEFAULT_AMBIENT_SETTINGS }
      }),
    store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
    sessionClock: () => clock,
    logger
  });

  return { slack, gateway, asked };
}

/**
 * A mention, delivered the way Slack delivers one: **twice**.
 *
 * Once as `app_mention`, which is answered, and once as `message`, which is
 * recorded — two events with different ids and no way for anything downstream
 * to tell they are one message. Every test here goes through this rather than
 * through `deliverMention` alone, because a suite that delivered one copy would
 * be a suite in which the duplicate-answer bug does not exist.
 */
async function mention(
  slack: ReturnType<typeof createStubSlack>,
  fields: { ts?: string; text?: string; suffix?: string } = {}
): Promise<void> {
  const ts = fields.ts ?? MENTION_TS;
  const text = `<@${STUB_APP_USER_ID}> ${fields.text ?? "what is the deploy window?"}`;
  const common = {
    teamId: TEAM,
    channelId: CHANNEL,
    userId: "U0ALICE",
    text,
    ts,
    threadTs: MENTION_TS
  };

  await slack.deliverMention({ ...common, eventId: `Ev0MENTION${fields.suffix ?? ""}` });
  await slack.deliverMessage({ ...common, eventId: `Ev0MESSAGE${fields.suffix ?? ""}` });
}

/** A plain message, addressed to nobody, in whichever thread. */
async function reply(
  slack: ReturnType<typeof createStubSlack>,
  fields: { ts: string; threadTs?: string; text?: string; userId?: string }
): Promise<void> {
  await slack.deliverMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    userId: fields.userId ?? "U0ALICE",
    text: fields.text ?? "no, the other cluster",
    ts: fields.ts,
    eventId: `Ev${fields.ts}`,
    ...(fields.threadTs !== undefined ? { threadTs: fields.threadTs } : {})
  });
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-followup-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-followup-store-"));
  clock = 1_700_000_000_000;
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("a thread the agent is working in", () => {
  it("answers a reply with no mention in it", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await mention(slack);
    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });
    await gateway.stop();

    expect(slack.posted).toEqual([
      { channelId: CHANNEL, threadTs: MENTION_TS, text: "answer 1" },
      { channelId: CHANNEL, threadTs: MENTION_TS, text: "answer 2" }
    ]);
  });

  it("answers a reply from somebody who was not the one who asked", async () => {
    // The thread is what is active, not the person. A colleague joining the
    // conversation is part of it.
    const { slack, gateway } = rig();
    await gateway.start();

    await mention(slack);
    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS, userId: "U0BOB" });
    await gateway.stop();

    expect(slack.posted).toHaveLength(2);
  });

  it("goes on answering, refreshing the window each time", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await mention(slack);
    clock += WINDOW_MS - 1_000;
    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });
    clock += WINDOW_MS - 1_000;
    await reply(slack, { ts: "1717171717.000300", threadTs: MENTION_TS });
    await gateway.stop();

    // Three answers over roughly two windows, because each one moved the
    // deadline. A window measured from the first mention would have stopped at
    // two.
    expect(slack.posted).toHaveLength(3);
  });

  it("seeds each answer from the thread rather than from the channel around it", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();

    await mention(slack);
    await reply(slack, { ts: "1717171717.000150", text: "who is on call today" });
    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });
    await gateway.stop();

    const followUp = asked[1];
    expect(followUp).toContain("what is the deploy window?");
    expect(followUp).not.toContain("who is on call today");
  });
});

describe("a thread the agent is not working in", () => {
  it("does not answer a reply in another thread", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await mention(slack);
    await reply(slack, { ts: "1717171717.000200", threadTs: "1717171717.000900" });
    await gateway.stop();

    expect(slack.posted).toHaveLength(1);
  });

  it("does not answer a top-level message in the same channel", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await mention(slack);
    await reply(slack, { ts: "1717171717.000200" });
    await gateway.stop();

    expect(slack.posted).toHaveLength(1);
  });

  it("does not answer anything in a channel it has never been mentioned in", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });
    await gateway.stop();

    expect(slack.posted).toEqual([]);
  });
});

describe("after the window has passed", () => {
  it("needs a mention again", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await mention(slack);
    clock += WINDOW_MS;
    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });
    await gateway.stop();

    expect(slack.posted).toHaveLength(1);
  });

  it("answers again once mentioned, and goes on answering after that", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await mention(slack);
    clock += WINDOW_MS;
    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });

    await mention(slack, { ts: "1717171717.000300", text: "still there?", suffix: "2" });
    await reply(slack, { ts: "1717171717.000400", threadTs: MENTION_TS });
    await gateway.stop();

    // The first mention, the second mention, and the reply after it. The one in
    // between fell in the dead window.
    expect(slack.posted).toHaveLength(3);
  });

  it("still files every message it declined to answer", async () => {
    // Declining to answer is not declining to remember. The transcript the next
    // task assembles has to hold what was said while the agent was quiet.
    const { slack, gateway, asked } = rig();
    await gateway.start();

    await mention(slack);
    clock += WINDOW_MS;
    await reply(slack, {
      ts: "1717171717.000200",
      threadTs: MENTION_TS,
      text: "the rollback finished"
    });
    await mention(slack, { ts: "1717171717.000300", text: "what happened?", suffix: "2" });
    await gateway.stop();

    expect(asked[1]).toContain("the rollback finished");
  });
});

describe("a channel that turned follow-ups off", () => {
  it("answers only when addressed", async () => {
    const { slack, gateway } = rig(0);
    await gateway.start();

    await mention(slack);
    await reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });
    await gateway.stop();

    expect(slack.posted).toEqual([
      { channelId: CHANNEL, threadTs: MENTION_TS, text: "answer 1" }
    ]);
  });
});

describe("a mention delivered on both subscriptions", () => {
  it("runs one task and posts one answer", async () => {
    // The failure this guards is not subtle and not rare: Slack sends a message
    // that mentions the app twice, with a different event_id on each, so
    // nothing downstream can dedupe it. Both copies routing means two model
    // turns, two charges against the channel's budget, and two replies.
    const { slack, gateway, asked } = rig();
    await gateway.start();

    await mention(slack);
    await gateway.stop();

    expect(asked).toHaveLength(1);
    expect(slack.posted).toHaveLength(1);
  });

  it("answers a later mention in an active thread exactly once", async () => {
    // The same hazard one step on: by now the thread is genuinely active, so
    // the message copy has an active thread to be routed into. This is the case
    // the first one only *nearly* covers — there, the thread was made active by
    // the very mention being duplicated.
    const { slack, gateway, asked } = rig();
    await gateway.start();

    await mention(slack);
    await mention(slack, { ts: "1717171717.000200", text: "and the rollback?", suffix: "2" });
    await gateway.stop();

    expect(asked).toHaveLength(2);
    expect(slack.posted).toHaveLength(2);
  });
});

describe("a follow-up arriving mid-task", () => {
  it("queues behind the task rather than interleaving with it", async () => {
    // #66 adds a route into a session, not a way around its serialization. The
    // mention's task is still running when the follow-up arrives, and the two
    // must not have model turns in flight at once.
    const slack = createStubSlack();
    const logger = createSilentLogger();
    let running = 0;
    let maxRunning = 0;
    let releaseFirst = (): void => {};
    const firstTurn = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let turns = 0;

    const completion = {
      complete: async (): Promise<CompletionResponse> => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        turns += 1;
        if (turns === 1) await firstTurn;
        running -= 1;
        return {
          text: "ok",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    };

    const { gateway } = createServer({
      slack: ({ handler, onDecision, onMessage }) => ({
        gateway: createGateway({
          source: slack.source,
          poster: slack.poster,
          handler,
          onDecision,
          onMessage,
          identity: slack.identity,
          logger
        }),
        cards: slack.poster
      }),
      completion,
      transport,
      sheets: () =>
        Promise.resolve({
          model: "test-model",
          description: "",
          sharedSkills: [],
          caps: { ...DEFAULT_AGENT_LOOP_CAPS },
          history: { ...DEFAULT_HISTORY_BOUNDS },
          followUpWindowMs: WINDOW_MS,
          memory: { ...DEFAULT_MEMORY_SETTINGS },
          skills: { ...DEFAULT_SKILL_SETTINGS },
        ambient: { ...DEFAULT_AMBIENT_SETTINGS }
        }),
      store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
      sessionClock: () => clock,
      logger
    });

    await gateway.start();
    const held = mention(slack);
    // The gateway dispatches concurrently — it has to, to acknowledge inside
    // Slack's window — so this really does arrive while the first task is in
    // its model turn.
    const followUp = reply(slack, { ts: "1717171717.000200", threadTs: MENTION_TS });
    releaseFirst();
    await Promise.all([held, followUp]);
    await gateway.stop();

    expect(maxRunning).toBe(1);
    expect(slack.posted).toHaveLength(2);
  });
});
