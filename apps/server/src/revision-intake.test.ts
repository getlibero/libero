// The revision path, end to end against stub Slack and a real store: a message
// filed, then deleted or edited in Slack, and the file made to agree. Everything
// between the stub socket and the file is the production wiring — `createServer`
// from compose.ts, the same call index.ts makes, minus the environment.
//
// This is #177's acceptance suite, and it is the sibling of
// message-intake.test.ts by design: that file proves a message arrives, and this
// one proves it can leave. `toRevision` is tested alone in the gateway and the
// store's `remove`/`replaceText` alone in packages/memory; what only this file
// can catch is a seam that drops the baton — a revision wired to no handler, a
// session whose store the mirror does not reach, an index left holding text the
// base table no longer has.
//
// The store is read back with a second `DatabaseSync` handle rather than through
// the `MessageStore` the process is holding, so what is asserted is what landed
// in the file. **The index is read on its own**, without joining back to
// `message`: an orphaned index entry pointing at a deleted row is exactly the
// failure "index included" is about, and a join would hide it.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionResponse } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import { createGateway, createSilentLogger, createStubSlack } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
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

function storeFile(channel: string): string {
  return join(storeRoot, channel, "store.db");
}

/** Opens a channel's store with a handle the process under test does not hold. */
function read<T>(channel: string, use: (db: DatabaseSync) => T, fallback: T): T {
  if (!existsSync(storeFile(channel))) return fallback;
  const db = new DatabaseSync(storeFile(channel), { readOnly: true });
  try {
    return use(db);
  } finally {
    db.close();
  }
}

/** Every message in the file, as `ts → text`, oldest first. */
function textsIn(channel: string): Array<[string, string]> {
  return read(
    channel,
    db =>
      (db.prepare("SELECT ts, text FROM message ORDER BY ts").all() as unknown as Array<{
        ts: string;
        text: string;
      }>).map(row => [row.ts, row.text] as [string, string]),
    []
  );
}

/**
 * How many index entries match a term — the index alone, no join.
 *
 * A count rather than the rows, because the number is the whole assertion: one
 * means findable, zero means gone. An orphan left behind by a delete that missed
 * the index still counts here, which is the point.
 */
function indexHits(channel: string, term: string): number {
  return read(
    channel,
    db =>
      (
        db
          .prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH ?")
          .all(term) as unknown as unknown[]
      ).length,
    0
  );
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
    slack: ({ handler, onDecision, onMessage, onRevision }) => ({
      gateway: createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onDecision,
        onMessage,
        onRevision,
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
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-revision-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-revision-store-"));
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("revision intake", () => {
  it("takes a deleted message out of the base table and the index with it", async () => {
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "1717171717.000300",
      text: "the passphrase is hunter2"
    });
    expect(indexHits(CHANNEL, "passphrase")).toBe(1);

    await slack.deliverRevision({
      teamId: TEAM,
      channelId: CHANNEL,
      kind: "deleted",
      ts: "1717171717.000300"
    });
    await gateway.stop();

    expect(textsIn(CHANNEL)).toEqual([]);
    expect(indexHits(CHANNEL, "passphrase")).toBe(0);
  });

  it("replaces an edited message's text and makes the old text unfindable", async () => {
    // The acceptance criterion behind the issue: someone pastes a key and edits
    // it out thirty seconds later. An unmirrored edit means the store keeps what
    // was retracted, and the context assembler feeds it to the model on every
    // turn from then on.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "1717171717.000300",
      text: "the token is xoxb-000-leaked"
    });
    await slack.deliverRevision({
      teamId: TEAM,
      channelId: CHANNEL,
      kind: "edited",
      ts: "1717171717.000300",
      text: "the token is in the vault"
    });
    await gateway.stop();

    expect(textsIn(CHANNEL)).toEqual([["1717171717.000300", "the token is in the vault"]]);
    expect(indexHits(CHANNEL, "leaked")).toBe(0);
    expect(indexHits(CHANNEL, "vault")).toBe(1);
  });

  it("deletes a thread parent that Slack reports as a tombstone", async () => {
    // Slack sends a `message_changed` rather than a `message_deleted` when the
    // deleted message had replies hanging off it. Mirrored as an edit, the row
    // would survive with Slack's placeholder in it.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "1717171717.000300",
      text: "the passphrase is hunter2"
    });
    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "1717171717.000400",
      threadTs: "1717171717.000300",
      text: "noted"
    });
    await slack.deliverRevision({
      teamId: TEAM,
      channelId: CHANNEL,
      kind: "tombstone",
      ts: "1717171717.000300"
    });
    await gateway.stop();

    // The reply stays: Slack kept it, and so does the store.
    expect(textsIn(CHANNEL)).toEqual([["1717171717.000400", "noted"]]);
    expect(indexHits(CHANNEL, "passphrase")).toBe(0);
  });

  it("is a no-op, not an error, for a ts the store never held", async () => {
    // The decision the issue asks for. An edit to a message the store never saw
    // does nothing: the store's rows are what the message path agreed to record,
    // and inserting here would be a second write door with none of that path's
    // filters — an app's own message, a `channel_join`, any declined subtype,
    // all recordable by being edited afterwards. A channel provisioned today
    // also has no history from last week, and back-filling one message out of
    // it because somebody fixed a typo is an arbitrary transcript, not a fuller
    // one.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "1717171717.000300",
      text: "the deploy went out at four"
    });
    await slack.deliverRevision({
      teamId: TEAM,
      channelId: CHANNEL,
      kind: "edited",
      ts: "1717171717.000999",
      text: "a message this store never saw"
    });
    await slack.deliverRevision({
      teamId: TEAM,
      channelId: CHANNEL,
      kind: "deleted",
      ts: "1717171717.000999"
    });
    // Still dispatching: neither revision threw out of the handler and killed
    // the path behind it.
    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "1717171717.000500",
      text: "and again at five"
    });
    await gateway.stop();

    expect(textsIn(CHANNEL)).toEqual([
      ["1717171717.000300", "the deploy went out at four"],
      ["1717171717.000500", "and again at five"]
    ]);
    expect(indexHits(CHANNEL, "never")).toBe(0);
  });

  it("writes nothing for a channel with no team sheet", async () => {
    // The store is provisioning-gated on the way in, and the way out inherits
    // that: a channel the operator never authorized has no file to revise, and a
    // revision naming one must not be what creates it.
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverRevision({
      teamId: TEAM,
      channelId: UNPROVISIONED,
      kind: "deleted",
      ts: "1717171717.000300"
    });
    await gateway.stop();

    expect(existsSync(storeFile(UNPROVISIONED))).toBe(false);
  });

  it("does not touch another channel's copy of the same ts", async () => {
    // One SQLite file per channel is the isolation boundary, and a revision
    // carries a ts rather than a row id — so a mirror that reached the wrong
    // file would delete a message in a channel nobody touched. The session is
    // keyed on the channel from the envelope, and each channel's store is its
    // own file, which is what makes this structural rather than a check.
    const other = "C0OTHERCH";
    provision(other);
    const { slack, gateway } = rig();
    await gateway.start();

    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "1717171717.000300",
      text: "ours"
    });
    await slack.deliverMessage({
      teamId: TEAM,
      channelId: other,
      ts: "1717171717.000300",
      text: "theirs"
    });
    await slack.deliverRevision({
      teamId: TEAM,
      channelId: CHANNEL,
      kind: "deleted",
      ts: "1717171717.000300"
    });
    await gateway.stop();

    expect(textsIn(CHANNEL)).toEqual([]);
    expect(textsIn(other)).toEqual([["1717171717.000300", "theirs"]]);
  });
});
