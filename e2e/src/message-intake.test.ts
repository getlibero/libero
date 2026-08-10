// One SQLite file per channel, asserted against real files.
//
// #176's own acceptance criteria are proved in `apps/server`'s
// message-intake.test.ts, over the same `createServer` composition. This file
// exists for the one claim that suite cannot make: that the isolation boundary
// is a filesystem fact rather than a property of a query.
//
// The architecture invariant is that a channel's content lives in its own file
// and no schema or query can join across channels — `packages/memory` has no
// `channel` column, and no operation takes a channel id. That is a shape rather
// than a rule, so the honest way to check it is from outside: run two real
// channels through the composed pair, then open each file with a handle nobody
// in the process holds and look at what is in it.
//
// The second claim here is the split root. `AGENT_STORE_ROOT` is separate from
// `AGENT_CHANNELS_ROOT` because the channels directory is where the tool proxy
// reads its authorization from, and an agent that could write there could widen
// its own permissions. Both roots are real directories in this rig, so "nothing
// was written to the other one" is something a test can look at.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CHANNEL, OTHER_CHANNEL, rigOf, says, startRig } from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const TEAM = "T024BE7LD";
const UNPROVISIONED = "C0NOSHEET";

let rig: Rig | undefined;

/**
 * A channel's stored messages, read with a handle this process does not hold.
 *
 * Deliberately `node:sqlite` and not `@getlibero/memory`: reading through the
 * same module that wrote would prove the writer and the reader agree, which is
 * a weaker claim than the row being in the file.
 */
function storedIn(storeRoot: string, channel: string): Array<{ ts: string; text: string }> {
  const file = join(storeRoot, channel, "store.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT ts, text FROM message ORDER BY ts").all() as unknown as Array<{
      ts: string;
      text: string;
    }>;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  rig = await startRig({
    // Two provisioned channels. The rig mints a certificate for each, which is
    // what makes them two real channels rather than two strings.
    sheets: {
      [CHANNEL]: { credential: "github_token", tools: [{ name: "list_prs", approval: "none" }] },
      [OTHER_CHANNEL]: {
        credential: "github_token",
        tools: [{ name: "list_prs", approval: "none" }]
      }
    },
    script: [says("Noted.")]
  });
}, SETUP_MS);

afterAll(async () => {
  await rig?.stop();
}, SETUP_MS);

it(
  "keeps each channel's messages in its own file, with no way to read across",
  async () => {
    const { agent, storeRoot } = rigOf(rig);

    await agent.slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "the release is cut",
      ts: "1758000000.000300"
    });
    await agent.slack.deliverMessage({
      teamId: TEAM,
      channelId: OTHER_CHANNEL,
      userId: "U0OTHER11",
      text: "the incident is closed",
      ts: "1758000000.000400"
    });

    // Each file has its own channel's message and nothing else. There is no
    // query that could have returned the other one: the file is the channel, so
    // there is no column a statement could have forgotten to filter on.
    expect(storedIn(storeRoot, CHANNEL).map(row => row.text)).toEqual(["the release is cut"]);
    expect(storedIn(storeRoot, OTHER_CHANNEL).map(row => row.text)).toEqual([
      "the incident is closed"
    ]);
  },
  CASE_MS
);

it(
  "writes nothing into the channels root, which is the proxy's authorization source",
  async () => {
    // The reason `AGENT_STORE_ROOT` exists. Both services mount the channels
    // directory and the proxy re-reads a sheet per call, so an agent able to
    // write there could rewrite `channel.toml` and widen what its own channel
    // may do. The mount is read-only in the composed deployment; this is the
    // same claim from the code's side.
    const { agent, channelsRoot, storeRoot } = rigOf(rig);

    await agent.slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "still here",
      ts: "1758000000.000500"
    });

    expect(existsSync(join(storeRoot, CHANNEL, "store.db"))).toBe(true);
    expect(existsSync(join(channelsRoot.path, CHANNEL, "store.db"))).toBe(false);
    // And the sheet the proxy reads is exactly what the harness wrote.
    expect(existsSync(join(channelsRoot.path, CHANNEL, "channel.toml"))).toBe(true);
  },
  CASE_MS
);

it(
  "gives a channel with no team sheet no file at all",
  async () => {
    // The app is in most channels of a workspace and provisioned for few. A
    // store created for an unprovisioned channel would be a conversation logged
    // under an id with no authorization behind it — and, under the split root,
    // nothing else would have refused it, because the directory the store opens
    // in is this process's own to create.
    const { agent, storeRoot } = rigOf(rig);

    await agent.slack.deliverMessage({
      teamId: TEAM,
      channelId: UNPROVISIONED,
      userId: "U024BE7LH",
      text: "somewhere nobody provisioned",
      ts: "1758000000.000600"
    });

    expect(existsSync(join(storeRoot, UNPROVISIONED))).toBe(false);
    expect(storedIn(storeRoot, UNPROVISIONED)).toEqual([]);
  },
  CASE_MS
);
