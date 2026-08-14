// Real directories and a real file, for ./store.test.ts's reason: everything
// this file decides is about the filesystem — whether a sheet is there, and what
// happens when `openMemoryFile` throws.
//
// The throwing is the part worth the file. `openMemoryFile` refuses three things
// outright, and every one of them has to arrive here as `null` and a log line:
// the path a mention takes is synchronous and uncaught, so a channel whose sheet
// carries a bad number must lose its memory rather than stop answering.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_OP_MAX_TEXT_CHARS } from "@getlibero/schema";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryFileOpener } from "./memory.js";

const CHANNEL = "C024BE91L";
const CAP = 8_192;

let channelsRoot: string;
let storeRoot: string;
let lines: Array<{ level: LogLevel } & LogFields>;
let logger: Logger;

/** Writes a channel's sheet, which is this file's whole notion of provisioning. */
function provision(channel: string, body = '[channel]\nid = "x"\n'): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, "channel.toml"), body);
}

/** The state directory the message store's opener would already have made. */
function stateDirectory(channel: string): void {
  mkdirSync(join(storeRoot, channel), { recursive: true });
}

function opener(): ReturnType<typeof createMemoryFileOpener> {
  return createMemoryFileOpener({ storeRoot, channelsRoot, logger });
}

function reasonsFor(event: string): string[] {
  return lines.filter(line => line.event === event).map(line => line.reason ?? "");
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-memory-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-memory-root-"));
  lines = [];
  logger = { log: (level, fields) => lines.push({ level, ...fields }) };
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("createMemoryFileOpener", () => {
  it("opens a file for a provisioned channel", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);

    const memory = opener()(CHANNEL, CAP);

    expect(memory).not.toBeNull();
    expect(memory?.read()).toBe("");
  });

  it("writes where the message store lives, not where the sheets do", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);

    opener()(CHANNEL, CAP)?.apply({ op: "memory_append", text: "- A fact." });

    expect(existsSync(join(storeRoot, CHANNEL, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(channelsRoot, CHANNEL, "MEMORY.md"))).toBe(false);
  });

  // The gate, and the reason this wrapper exists at all: `packages/memory` asks
  // no question about whether a channel is real.
  it("refuses a channel with no team sheet", () => {
    stateDirectory(CHANNEL);

    expect(opener()(CHANNEL, CAP)).toBeNull();
    expect(reasonsFor("memory_unavailable")).toEqual(["no_team_sheet"]);
    // Expected rather than alarming: an unprovisioned channel is an ordinary
    // state, and a line that alarms about it is a line people stop reading.
    expect(lines[0]?.level).toBe("info");
  });

  it.each([
    ["a parent traversal", "../../etc"],
    ["a separator", "a/b"],
    ["a leading dot", ".hidden"],
    ["empty", ""]
  ])("refuses %s as a channel id without touching the filesystem", (_name, channel) => {
    expect(opener()(channel, CAP)).toBeNull();
    expect(reasonsFor("memory_unavailable")).toEqual(["channel_id"]);
  });

  // The three throws `openMemoryFile` makes, each of which has to arrive as
  // `null` here. This is the contract the memory package's README asks its
  // caller for by name.
  it("answers null rather than throwing when the cap is below one operation", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);

    expect(() => opener()(CHANNEL, MEMORY_OP_MAX_TEXT_CHARS - 1)).not.toThrow();
    expect(opener()(CHANNEL, MEMORY_OP_MAX_TEXT_CHARS - 1)).toBeNull();
    expect(reasonsFor("memory_unavailable")).toEqual(["Error", "Error"]);
  });

  it("answers null rather than throwing when the channel has no state directory", () => {
    provision(CHANNEL);

    expect(() => opener()(CHANNEL, CAP)).not.toThrow();
    expect(opener()(CHANNEL, CAP)).toBeNull();
    expect(lines.every(line => line.event === "memory_unavailable")).toBe(true);
  });

  // Never the message. `openMemoryFile` puts the file path and the cap in its
  // errors, and `LogFields` has a place for a path and none for a number.
  it("logs a reason code and never the error's text", () => {
    provision(CHANNEL);

    opener()(CHANNEL, CAP);

    const line = lines.find(entry => entry.event === "memory_unavailable");
    expect(line?.reason).toBe("Error");
    expect(JSON.stringify(line)).not.toContain("MEMORY.md");
  });

  // Unlike the store's opener, which creates one. Two places deciding a channel
  // is real is one too many, and a missing state directory means the store never
  // opened either — a deployment to look at rather than a directory to make.
  it("creates no directory", () => {
    provision(CHANNEL);

    opener()(CHANNEL, CAP);

    expect(existsSync(join(storeRoot, CHANNEL))).toBe(false);
  });

  it("keeps one channel's memory out of another's", () => {
    provision(CHANNEL);
    provision("C0OTHER");
    stateDirectory(CHANNEL);
    stateDirectory("C0OTHER");

    opener()(CHANNEL, CAP)?.apply({ op: "memory_append", text: "ours" });
    opener()("C0OTHER", CAP)?.apply({ op: "memory_append", text: "theirs" });

    expect(opener()(CHANNEL, CAP)?.read()).toBe("ours\n");
    expect(opener()("C0OTHER", CAP)?.read()).toBe("theirs\n");
  });
});
