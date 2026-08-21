// Real directories and a real SQLite file, because everything this file decides
// is about the filesystem: whether a sheet is there, whether a directory gets
// made, and what happens when opening fails.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { createMessageStoreOpener } from "./store.js";

const CHANNEL = "C024BE91L";

let channelsRoot: string;
let storeRoot: string;
let lines: Array<{ level: LogLevel } & LogFields>;
let logger: Logger;

/** Writes a channel's sheet, which is this file's whole notion of provisioning. */
function provision(channel: string, body = "[channel]\nid = \"x\"\n"): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, "channel.toml"), body);
}

function opener(): ReturnType<typeof createMessageStoreOpener> {
  return createMessageStoreOpener({ storeRoot, channelsRoot, logger });
}

function reasonsFor(event: string): string[] {
  return lines.filter(line => line.event === event).map(line => line.reason ?? "");
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-store-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-store-root-"));
  lines = [];
  logger = { log: (level, fields) => lines.push({ level, ...fields }) };
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("createMessageStoreOpener", () => {
  it("opens a store for a channel that has a team sheet", () => {
    provision(CHANNEL);

    const store = opener()(CHANNEL);

    expect(store).not.toBeNull();
    expect(existsSync(join(storeRoot, CHANNEL, "store.db"))).toBe(true);
    store?.close();
  });

  it("creates the channel's directory under the store root, and only there", () => {
    // The store root is this process's to write. The channels root is the tool
    // proxy's authorization source and stays untouched — a run that created a
    // directory there would be the first step of the thing the split root
    // exists to prevent.
    provision(CHANNEL);

    const store = opener()(CHANNEL);

    expect(existsSync(join(storeRoot, CHANNEL))).toBe(true);
    expect(existsSync(join(channelsRoot, CHANNEL, "store.db"))).toBe(false);
    store?.close();
  });

  it("gives a channel with no team sheet no store at all", () => {
    // The app is in most channels of a workspace and provisioned for few. This
    // is where "the operator said this channel exists" is checked, now that the
    // store's directory is not the same directory as the sheet's.
    expect(opener()(CHANNEL)).toBeNull();
    expect(existsSync(join(storeRoot, CHANNEL))).toBe(false);
    expect(reasonsFor("store_unavailable")).toEqual(["no_team_sheet"]);
  });

  it("reports an unprovisioned channel at info rather than as an error", () => {
    opener()(CHANNEL);

    expect(lines[0]?.level).toBe("info");
  });

  it("opens a store for a channel whose sheet is malformed", () => {
    // Existence, not validity. This is not the authorization decision — the tool
    // proxy makes that from its own copy and refuses everything for a sheet it
    // cannot parse. A broken sheet is a provisioned channel with a mistake in
    // it, and its conversation is still its members'.
    provision(CHANNEL, "this is not toml {{{");

    const store = opener()(CHANNEL);

    expect(store).not.toBeNull();
    store?.close();
  });

  it("refuses a channel id that is not a safe path segment, touching no disk", () => {
    // The id becomes two path segments. `ChannelId` is the one rule for what may
    // be one, and it is asked before either join, exactly as sheet.ts does.
    for (const bad of ["../escape", ".", "with/slash", ""]) {
      expect(opener()(bad)).toBeNull();
    }

    expect(reasonsFor("store_unavailable")).toEqual([
      "channel_id",
      "channel_id",
      "channel_id",
      "channel_id"
    ]);
  });

  it("returns null rather than throwing when the store root cannot be written", () => {
    // The contract the registry depends on. `open()` is synchronous and outside
    // any try, so an opener that threw would turn an unwritable disk into a
    // mention that goes unanswered instead of a channel with no history.
    provision(CHANNEL);
    const blocked = createMessageStoreOpener({
      // A file where a directory has to go: mkdir fails with ENOTDIR/EEXIST.
      storeRoot: join(channelsRoot, CHANNEL, "channel.toml"),
      channelsRoot,
      logger
    });

    expect(() => blocked(CHANNEL)).not.toThrow();
    expect(blocked(CHANNEL)).toBeNull();
    expect(lines.some(line => line.event === "store_unavailable" && line.level === "error")).toBe(
      true
    );
  });

  it("puts no path or file content in the failure reason", () => {
    // A reason code from someone else's closed vocabulary. `LogFields.file` is
    // the declared place for a path, and it is not this line's field.
    provision(CHANNEL);
    const blocked = createMessageStoreOpener({
      storeRoot: join(channelsRoot, CHANNEL, "channel.toml"),
      channelsRoot,
      logger
    });

    blocked(CHANNEL);
    const failure = lines.find(line => line.event === "store_unavailable");

    expect(failure?.reason).not.toContain("/");
    expect(failure?.file).toBeUndefined();
  });

  it("gives two channels two files", () => {
    // One SQLite file per channel is the isolation boundary, and this is the
    // layer that decides which file a channel gets.
    provision(CHANNEL);
    provision("C0OTHER11");
    const open = opener();

    const a = open(CHANNEL);
    const b = open("C0OTHER11");

    expect(a).not.toBe(b);
    expect(existsSync(join(storeRoot, CHANNEL, "store.db"))).toBe(true);
    expect(existsSync(join(storeRoot, "C0OTHER11", "store.db"))).toBe(true);
    a?.close();
    b?.close();
  });
});
