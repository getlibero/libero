// The whole message intake path, end to end against stub Slack and a real
// store: message on the socket, normalized, a session opened, a row in that
// channel's `store.db`. Everything between the stub socket and the file is the
// production wiring — `createServer` from compose.ts, the same call index.ts
// makes, minus the environment.
//
// This is #176's acceptance suite. The pieces are each tested alone —
// `toMessage` in the gateway, the opener in session/store.test.ts, the mapping
// in ingest.test.ts — and what only this file can catch is a seam that drops
// the baton: a subscription wired to the wrong listener, a session whose store
// nobody reads, a redelivery that becomes two rows because two layers each
// assumed the other deduplicated.
//
// The store is read back with a second `DatabaseSync` handle rather than
// through the `MessageStore` the process is holding, so what is asserted is
// what landed in the file.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionResponse } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import { createGateway, createSilentLogger, createStubSlack } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_AMBIENT_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  DEFAULT_HISTORY_BOUNDS,
  createMessageStoreOpener,
  createServer
} from "./compose.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";
const UNPROVISIONED = "C0NOSHEET";

let channelsRoot: string;
let storeRoot: string;

/** One row as it sits in the file, with the column names the schema uses. */
interface Row {
  ts: string;
  thread_ts: string | null;
  user_id: string;
  display_name: string | null;
  text: string;
  at: number;
}

/** Reads a channel's store with a handle the process under test does not hold. */
function rowsIn(channel: string): Row[] {
  const file = join(storeRoot, channel, "store.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // Named columns rather than `*`: the rowid is the store's own and never
    // escapes its module, so this reads what a message *is* and would not start
    // asserting on an internal the day one is added.
    return db
      .prepare(
        "SELECT ts, thread_ts, user_id, display_name, text, at FROM message ORDER BY ts"
      )
      .all() as unknown as Row[];
  } finally {
    db.close();
  }
}

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

const completion = {
  complete: (): Promise<CompletionResponse> =>
    Promise.resolve({
      text: "Done.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 }
    })
};

/** The production composition over the stubs, with a real store root. */
function rig() {
  const slack = createStubSlack();
  const logger = createSilentLogger();

  const { gateway } = createServer({
    // The whole of what differs from index.ts: the surface is built over the
    // stub rather than over a socket and a Web API client.
    slack: ({ handler, onDecision, onMessage, onRevision }) => ({
      gateway: createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onDecision,
        onMessage,
        // Wired even though nothing here delivers a revision, so this rig stays
        // the production composition rather than a subset of it.
        onRevision,
        logger
      }),
      cards: slack.poster
    }),
    completion,
    transport,
    sheets: () => Promise.resolve({
          model: "test-model",
          description: "",
          caps: { ...DEFAULT_AGENT_LOOP_CAPS },
          history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
        memory: { ...DEFAULT_MEMORY_SETTINGS },
        skills: { ...DEFAULT_SKILL_SETTINGS },
        ambient: { ...DEFAULT_AMBIENT_SETTINGS }
        }),
    store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
    logger
  });

  return { slack, gateway };
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-intake-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-intake-store-"));
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("message intake", () => {
  it("stores a non-mention message with its user, thread, timestamp and text", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U0ALICE",
      text: "the deploy went out at four",
      ts: "1717171717.000300"
    });
    await gateway.stop();

    expect(rowsIn(CHANNEL)).toEqual([
      {
        ts: "1717171717.000300",
        thread_ts: null,
        user_id: "U0ALICE",
        display_name: null,
        text: "the deploy went out at four",
        // When the store learned of it. Asserted as a number rather than a
        // value, because it is this process's clock and not Slack's.
        at: expect.any(Number)
      }
    ]);
  });

  it("stores a top-level message with a null thread and a reply with its parent's ts", async () => {
    // The distinction the mention path destroys: `toMention` coalesces
    // `thread_ts ?? ts` because it is picking a reply target, so a top-level
    // mention and a self-threaded one are indistinguishable by the time it is
    // done. Reusing that here would make a store that cannot answer "was this in
    // a thread".
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000300" });
    await slack.deliverMessage({
      channelId: CHANNEL,
      ts: "1717171717.000400",
      threadTs: "1717171717.000300"
    });
    await gateway.stop();

    expect(rowsIn(CHANNEL).map(row => row.thread_ts)).toEqual([null, "1717171717.000300"]);
  });

  it("does not produce a second row for a redelivered event", async () => {
    // Slack redelivers an event it believes went unacknowledged, and a
    // redelivery can arrive on a new socket with a new `event_id`. The store's
    // `ts` is UNIQUE and its insert is `ON CONFLICT DO NOTHING`, which is the
    // authoritative dedupe and the one that survives a restart — so the same
    // message twice under two event ids is still one row.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000300", eventId: "Ev0A" });
    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000300", eventId: "Ev0B" });
    await gateway.stop();

    expect(rowsIn(CHANNEL)).toHaveLength(1);
  });

  it("stores a message arriving in a channel with no live session", async () => {
    // Ingest is not request-scoped. A quiet channel — one nobody has mentioned
    // the app in, or one whose session was evicted after thirty idle minutes —
    // still has its conversation recorded, which means ingest opens a session
    // rather than requiring one.
    const { slack, gateway } = rig();
    await gateway.start();

    // No mention has been delivered, so no session exists yet.
    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000300" });
    await gateway.stop();

    expect(rowsIn(CHANNEL)).toHaveLength(1);
  });

  it("stores nothing for a channel with no team sheet, and does not fail", async () => {
    // The app is in most channels of a workspace and provisioned for few. An
    // unprovisioned one is not an error and gets no file: a store created there
    // would be a channel with no authorization at all, quietly logging a
    // conversation.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({ channelId: UNPROVISIONED, ts: "1717171717.000300" });
    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000400" });
    await gateway.stop();

    expect(rowsIn(UNPROVISIONED)).toEqual([]);
    expect(existsSync(join(storeRoot, UNPROVISIONED))).toBe(false);
    // And the provisioned channel beside it is unaffected.
    expect(rowsIn(CHANNEL)).toHaveLength(1);
  });

  it("writes nothing into the channels root", async () => {
    // The split root, asserted from the outside. The channels directory is
    // where the tool proxy reads its authorization; this process writing there
    // is the thing the separate `AGENT_STORE_ROOT` exists to prevent.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000300" });
    await gateway.stop();

    expect(existsSync(join(channelsRoot, CHANNEL, "store.db"))).toBe(false);
  });

  it("keeps two channels in two files", async () => {
    // One SQLite file per channel is the isolation boundary, and there is no
    // channel column for a query to forget to filter on.
    provision("C0OTHER11");
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000300", text: "ours" });
    await slack.deliverMessage({ channelId: "C0OTHER11", ts: "1717171717.000400", text: "theirs" });
    await gateway.stop();

    expect(rowsIn(CHANNEL).map(row => row.text)).toEqual(["ours"]);
    expect(rowsIn("C0OTHER11").map(row => row.text)).toEqual(["theirs"]);
  });

  it("stores the allowed subtypes and drops the rest", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({
      channelId: CHANNEL,
      ts: "1717171717.000300",
      subtype: "thread_broadcast",
      threadTs: "1717171717.000100",
      text: "broadcast"
    });
    await slack.deliverMessage({
      channelId: CHANNEL,
      ts: "1717171717.000400",
      subtype: "file_share",
      text: "with a file"
    });
    await slack.deliverMessage({
      channelId: CHANNEL,
      ts: "1717171717.000500",
      subtype: "channel_join",
      text: "someone joined"
    });
    // A revision is not a new message, and the assertion is that it writes no
    // row here. What it *does* write is #177's, and is revision-intake.test.ts's
    // — this one only proves the message path does not treat one as an arrival.
    await slack.deliverMessage({
      channelId: CHANNEL,
      ts: "1717171717.000600",
      subtype: "message_changed"
    });
    await slack.deliverMessage({
      channelId: CHANNEL,
      ts: "1717171717.000700",
      botId: "B0BOT",
      text: "from an app"
    });
    await gateway.stop();

    expect(rowsIn(CHANNEL).map(row => row.text)).toEqual(["broadcast", "with a file"]);
  });

  it("records the mention that arrives on the message subscription too", async () => {
    // A message that mentions the app fires both `app_mention` and `message`.
    // Both are kept: one answers, one records, and only the message path writes
    // — so a mention is one row, not two, and the transcript has it in it.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMention({ channelId: CHANNEL, ts: "1717171717.000300" });
    await slack.deliverMessage({
      channelId: CHANNEL,
      ts: "1717171717.000300",
      text: "<@U0BOT> what is the deploy status"
    });
    await gateway.stop();

    expect(rowsIn(CHANNEL).map(row => row.text)).toEqual([
      "<@U0BOT> what is the deploy status"
    ]);
    // The mention was still answered.
    expect(slack.posted).toHaveLength(1);
  });

  it("stores a message that arrives while a task is running in the same channel", async () => {
    // The mutex decision, from the outside. The router holds a channel's session
    // for the length of a model turn; a store write behind that lock would sit
    // unwritten for up to the channel's whole wall-clock cap.
    const slack = createStubSlack();
    const logger = createSilentLogger();
    // The turn announces that it has the session's mutex, then waits for the
    // test to say it may finish. `messageWritten` is what the test resolves,
    // so the model turn cannot complete before the message has been through.
    let release = (): void => {};
    const turnStarted = new Promise<void>(resolve => {
      release = resolve;
    });
    let letTurnFinish = (): void => {};
    const messageWritten = new Promise<void>(resolve => {
      letTurnFinish = resolve;
    });

    const { gateway } = createServer({
      slack: ({ handler, onDecision, onMessage }) => ({
        gateway: createGateway({
          source: slack.source,
          poster: slack.poster,
          handler,
          onDecision,
          onMessage,
          logger
        }),
        cards: slack.poster
      }),
      completion: {
        complete: async (): Promise<CompletionResponse> => {
          release();
          await messageWritten;
          return {
            text: "Done.",
            toolCalls: [],
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 5 }
          };
        }
      },
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
        ambient: { ...DEFAULT_AMBIENT_SETTINGS }
        }),
      store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
      logger
    });
    await gateway.start();

    const mention = slack.deliverMention({ channelId: CHANNEL, ts: "1717171717.000100" });
    await turnStarted;

    // The model turn is in flight, so the session's mutex is held. Behind it,
    // this would deadlock — the write waits for the turn and the turn waits for
    // the write.
    await slack.deliverMessage({ channelId: CHANNEL, ts: "1717171717.000300" });
    expect(rowsIn(CHANNEL)).toHaveLength(1);

    letTurnFinish();
    await mention;
    await gateway.stop();
  });
});
