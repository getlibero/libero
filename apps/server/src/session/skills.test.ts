// Real directories, for ./memory.test.ts's reason: everything this file decides
// is about the filesystem — whether a sheet is there, and what happens when
// `openSkillFiles` throws.
//
// The throwing is the part worth the file. `openSkillFiles` refuses three things
// outright, and every one of them has to arrive here as `null` and a log line:
// the path a mention takes is synchronous and uncaught, so a channel whose sheet
// carries a bad `max_skills` must lose its skills rather than stop answering.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { createSkillFilesOpener } from "./skills.js";

const CHANNEL = "C024BE91L";
const MAX_SKILLS = 100;

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

function opener(): ReturnType<typeof createSkillFilesOpener> {
  return createSkillFilesOpener({ storeRoot, channelsRoot, logger });
}

function reasonsFor(event: string): string[] {
  return lines.filter(line => line.event === event).map(line => line.reason ?? "");
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-skills-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-skills-root-"));
  lines = [];
  logger = { log: (level, fields) => lines.push({ level, ...fields }) };
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("createSkillFilesOpener", () => {
  it("opens a directory for a provisioned channel", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);

    const files = opener()(CHANNEL, MAX_SKILLS);

    expect(files).not.toBeNull();
    expect(files?.list()).toEqual([]);
  });

  // The rule #300 landed and this opener must not undo: the directory appears on
  // the first write and never on a read, so a channel that only ever reads — or
  // one whose sheet turns skills off — acquires nothing it did not ask for.
  it("creates no skills directory just by being opened", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);

    opener()(CHANNEL, MAX_SKILLS);

    expect(existsSync(join(storeRoot, CHANNEL, "skills"))).toBe(false);
  });

  // The sheet gate. Without it, retrieval would file a channel nobody authorized
  // — and, once the author turn lands, write into it.
  it("answers null for a channel with no team sheet", () => {
    stateDirectory(CHANNEL);

    expect(opener()(CHANNEL, MAX_SKILLS)).toBeNull();
    expect(reasonsFor("skills_unavailable")).toEqual(["no_team_sheet"]);
  });

  // `info` rather than `error`: an unprovisioned channel is expected, and a line
  // that alarms about the expected case is a line people stop reading.
  it("says so at info, because an unprovisioned channel is not a fault", () => {
    stateDirectory(CHANNEL);

    opener()(CHANNEL, MAX_SKILLS);

    expect(lines.map(line => line.level)).toEqual(["info"]);
  });

  it("answers null for an id that is not a channel id, without touching the filesystem", () => {
    expect(opener()("../../etc", MAX_SKILLS)).toBeNull();
    expect(reasonsFor("skills_unavailable")).toEqual(["channel_id"]);
  });

  // A mistyped `[skills] max_skills` costs the channel its skills and not its
  // replies. `openSkillFiles` throws on anything that is not a positive integer.
  it("answers null for a library cap the store refuses", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);

    expect(opener()(CHANNEL, 0)).toBeNull();
    expect(lines.filter(line => line.event === "skills_unavailable")).toHaveLength(1);
  });

  // No state directory means no message store either, which is a deployment to
  // look at rather than a directory for this file to create.
  //
  // The reason is `Error` rather than `ENOENT`, which ./memory.test.ts asserts
  // for the same two refusals: `openSkillFiles` checks the directory with
  // `existsSync` and throws a plain `Error`, so there is no errno to carry. The
  // event word and the channel are what an operator acts on either way.
  it("answers null when the channel has no state directory", () => {
    provision(CHANNEL);

    expect(opener()(CHANNEL, MAX_SKILLS)).toBeNull();
    expect(reasonsFor("skills_unavailable")).toEqual(["Error"]);
  });

  it("never puts the cap or the directory path in a log line", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);

    opener()(CHANNEL, -7);

    expect(JSON.stringify(lines)).not.toContain("-7");
    expect(JSON.stringify(lines)).not.toContain(storeRoot);
  });

  // One directory per channel, and no method on what comes back takes a channel
  // id — so this opener is the only place a channel is chosen.
  it("gives two channels their own directories", () => {
    provision(CHANNEL);
    stateDirectory(CHANNEL);
    provision("C0OTHER");
    stateDirectory("C0OTHER");

    const open = opener();
    const first = open(CHANNEL, MAX_SKILLS);
    const second = open("C0OTHER", MAX_SKILLS);

    first?.apply({
      op: "skill_create",
      name: "cut-a-release",
      description: "When somebody asks for a release.",
      body: "Tag, then watch the workflow."
    });

    expect(first?.list()).toEqual(["cut-a-release"]);
    expect(second?.list()).toEqual([]);
  });
});
