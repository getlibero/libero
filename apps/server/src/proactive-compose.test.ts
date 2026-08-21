// The proactive post surface through the production composition (#318).
//
// The permit's own behaviour is `proactive/proactive.test.ts`'s. What only this
// file can catch is the wiring claim the issue actually gates on: that the
// capability is minted once inside `createServer`, reaches the heartbeat and
// nothing else, and carries its window with it all the way to Slack.
//
// So the assertions here are about the *composition*, not about the clock: the
// heartbeat factory is called with a poster, a channel with no `channel` verb on
// its surface gets no heartbeat at all, and the window holds across two
// heartbeats driven through the real scheduler.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionResponse } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import { STUB_WORKSPACE_ID, createGateway, createSilentLogger, createStubSlack } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import {
  DEFAULT_AMBIENT_SETTINGS,
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  HEARTBEAT_POST_WINDOW_MS,
  createMessageStoreOpener,
  createServer
} from "./compose.js";
import type { AmbientHeartbeatFactory, ProactivePoster } from "./compose.js";
import { createChannelLister } from "./session/channels.js";

const CHANNEL = "C024BE91L";
const CADENCE_MS = 15 * 60_000;
const NOW = 1_700_000_000_000;

let channelsRoot: string;
let storeRoot: string;

/** Writes a channel's sheet — this process's whole notion of provisioning. */
function provision(channel: string): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, "channel.toml"), '[channel]\nid = "x"\n');
}

const transport: ProxyTransport = {
  request(options: ProxyRequest): Promise<ProxyResponse> {
    if (options.path === "/v1/tools") return Promise.resolve({ status: 200, body: { tools: [] } });
    return Promise.resolve({ status: 200, body: { outcome: "recorded" } });
  }
};

const completion = {
  complete: (): Promise<CompletionResponse> =>
    Promise.resolve({
      text: "Done.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 }
    })
};

interface RigOptions {
  /** Omitted, the surface exposes no channel-post verb — the degraded front-end. */
  withChannelPoster?: boolean;
  heartbeat?: AmbientHeartbeatFactory;
  /** The window's clock. The scans below state their own instant separately. */
  proactiveClock?: () => number;
}

/** The production composition over stub Slack, with a real store and sheet root. */
function rig(options: RigOptions = {}) {
  const slack = createStubSlack();
  const logger = createSilentLogger();
  const withChannelPoster = options.withChannelPoster ?? true;

  const { gateway, ambient } = createServer({
    slack: ({ handler, onDecision, onMessage, onRevision }) => ({
      gateway: createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onDecision,
        onMessage,
        onRevision,
        // Wired because the ambient clock needs a workspace to key a session
        // with, and that arrives from `auth.test` inside `start()`.
        identity: slack.identity,
        logger
      }),
      cards: slack.poster,
      // The one thing these cases vary. `createSlackSurface` always returns it.
      ...(withChannelPoster ? { channel: slack.poster } : {})
    }),
    completion,
    transport,
    sheets: () =>
      Promise.resolve({
        model: "test-model",
        description: "",
        caps: { ...DEFAULT_AGENT_LOOP_CAPS },
        history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
        memory: { ...DEFAULT_MEMORY_SETTINGS },
        skills: { ...DEFAULT_SKILL_SETTINGS },
        ambient: { ...DEFAULT_AMBIENT_SETTINGS, enabled: true, heartbeatEveryMs: CADENCE_MS }
      }),
    store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
    channels: createChannelLister({ channelsRoot, logger }),
    ...(options.heartbeat !== undefined ? { heartbeat: options.heartbeat } : {}),
    ...(options.proactiveClock !== undefined ? { proactiveClock: options.proactiveClock } : {}),
    logger
  });

  return { slack, gateway, ambient };
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-proactive-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-proactive-store-"));
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("the proactive post surface, composed", () => {
  it("mints one poster and hands it to the heartbeat factory", async () => {
    const handed: ProactivePoster[] = [];
    const { slack, gateway } = rig({
      heartbeat: post => {
        handed.push(post);
        return () => Promise.resolve();
      }
    });
    await gateway.start();

    expect(handed).toHaveLength(1);

    // And it is a live capability rather than a shape: what it posts reaches the
    // stub's channel verb, which is the one Slack call with no thread on it.
    await handed[0]?.post({ channel: CHANNEL, text: "a finding", source: "heartbeat" });
    expect(slack.channelPosts).toEqual([
      { channelId: CHANNEL, text: expect.stringContaining("a finding") as unknown as string }
    ]);
    // Not a reply, and not a card. The three are different verbs on purpose.
    expect(slack.posted).toHaveLength(0);
    expect(slack.cards).toHaveLength(0);
  });

  it("builds no heartbeat for a surface that cannot post to a channel", async () => {
    // Everything a heartbeat produces is a post, so a turn wired without a
    // poster would spend model calls to reach a surface it does not have.
    let built = 0;
    const { gateway, ambient } = rig({
      withChannelPoster: false,
      heartbeat: () => {
        built += 1;
        return () => Promise.resolve();
      }
    });
    await gateway.start();

    // The clock still runs and still finds the channel due — it is the reader
    // that is absent, which is the state #317 shipped in.
    await ambient?.scan(NOW);
    const scan = await ambient?.scan(NOW + CADENCE_MS);

    expect(built).toBe(0);
    expect(scan?.fired).toBe(1);
  });

  it("carries the window through the real clock: two due heartbeats, one post", async () => {
    // The cadence is fifteen minutes and the window is four hours, so a channel
    // that has something to say every single tick still speaks twice a day. This
    // drives the production scheduler rather than the poster directly, because
    // the claim is that nothing between the two loosens it.
    let at = NOW;
    const { slack, gateway, ambient } = rig({
      proactiveClock: () => at,
      heartbeat: post => async channel => {
        await post.post({ channel, text: "still unanswered", source: "heartbeat" });
      }
    });
    await gateway.start();

    await ambient?.scan(at);
    for (let tick = 0; tick < 8; tick += 1) {
      at += CADENCE_MS;
      await ambient?.scan(at);
    }

    expect(slack.channelPosts).toHaveLength(1);

    // Past the window, it speaks again.
    at = NOW + HEARTBEAT_POST_WINDOW_MS + CADENCE_MS;
    await ambient?.scan(at);
    expect(slack.channelPosts).toHaveLength(2);
  });

  it("reaches the channel the clock enumerated, on that channel's session", async () => {
    const seen: string[] = [];
    const { slack, gateway, ambient } = rig({
      heartbeat: post => async channel => {
        seen.push(channel);
        await post.post({ channel, text: "hello", source: "heartbeat" });
      }
    });
    await gateway.start();

    await ambient?.scan(NOW);
    await ambient?.scan(NOW + CADENCE_MS);

    expect(seen).toEqual([CHANNEL]);
    expect(slack.channelPosts[0]?.channelId).toBe(CHANNEL);
    // The workspace the session was keyed on is Slack's, never one this process
    // invented — the reason `ambient.ts` refuses to scan before `auth.test`.
    expect(gateway.workspace).toBe(STUB_WORKSPACE_ID);
  });
});
