// The standing region's contents, against a real shared root.
//
// The root is a real directory rather than a fake opener, for `skill-store`'s
// reason: almost everything this module does is decide what a directory and a
// team sheet's entries mean together, and a fake of the directory would let both
// sides agree with each other and with nothing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { SharedSkillEntry } from "@getlibero/schema";
import { createSharedSkillReader } from "./shared-skills.js";

const CHANNEL = "C0ENGINEERING";

let root: string;
let lines: Array<{ level: LogLevel } & LogFields>;
let logger: Logger;

/** The operator's act: a file lands in the root, from outside this process. */
function publish(name: string, body = "Say it plainly."): void {
  writeFileSync(
    join(root, `${name}.md`),
    `---\nname: ${name}\ndescription: How this company writes.\ncreated: 2026-01-01\nstatus: active\n---\n\n${body}\n`
  );
}

function always(...names: string[]): SharedSkillEntry[] {
  return names.map(name => ({ name, load: "always" as const }));
}

function read(
  entries: readonly SharedSkillEntry[],
  over: { root?: string | null; maxSkills?: number; maxChars?: number } = {}
) {
  const reader = createSharedSkillReader({
    root: over.root === undefined ? root : over.root,
    logger
  });
  return reader({
    channel: CHANNEL,
    entries,
    maxSkills: over.maxSkills ?? 2,
    maxChars: over.maxChars ?? 8_192
  });
}

/** Every log line with this event word. */
function said(event: string): Array<{ level: LogLevel } & LogFields> {
  return lines.filter(line => line.event === event);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-standing-"));
  lines = [];
  logger = { log: (level, fields) => void lines.push({ level, ...fields }) };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("what reaches the standing region", () => {
  it("loads an always entry, addressed as shared/<name>", () => {
    publish("brand-voice");

    expect(read(always("brand-voice"))).toEqual([
      {
        name: "shared/brand-voice",
        description: "How this company writes.",
        body: "Say it plainly."
      }
    ]);
  });

  // The consistency case the whole design exists for is `always`; a `retrieved`
  // entry belongs to the pool (#436) and must not also stand, or a task near its
  // subject would pay for it twice in the same prompt.
  it("ignores a retrieved entry entirely", () => {
    publish("code-review-standards");

    expect(read([{ name: "code-review-standards", load: "retrieved" }])).toEqual([]);
  });

  it("keeps the sheet's own order", () => {
    publish("brand-voice");
    publish("house-style");

    expect(read(always("house-style", "brand-voice")).map(skill => skill.name)).toEqual([
      "shared/house-style",
      "shared/brand-voice"
    ]);
  });

  it("answers nothing when the sheet names none", () => {
    publish("brand-voice");

    expect(read([])).toEqual([]);
    expect(lines).toEqual([]);
  });

  // Read fresh per task, which is what lets an operator publish a skill or fix a
  // mount without restarting the process.
  it("sees a file published after the reader was built", () => {
    const reader = createSharedSkillReader({ root, logger });
    const ask = { channel: CHANNEL, entries: always("brand-voice"), maxSkills: 2, maxChars: 8_192 };

    expect(reader(ask)).toEqual([]);
    publish("brand-voice");

    expect(reader(ask)).toHaveLength(1);
  });
});

describe("the count bound", () => {
  // The schema's root check refuses a sheet naming more `always` entries than
  // the cap, so this is the second application rather than the only one — and
  // what it buys is a region that bounds itself whatever it is assembled from.
  it("takes the first max_always_skills and no more", () => {
    publish("a-voice");
    publish("b-style");
    publish("c-review");

    expect(read(always("a-voice", "b-style", "c-review"), { maxSkills: 2 })).toHaveLength(2);
  });

  it("takes them in the sheet's order rather than the directory's", () => {
    publish("a-voice");
    publish("b-style");

    expect(read(always("b-style", "a-voice"), { maxSkills: 1 }).map(s => s.name)).toEqual([
      "shared/b-style"
    ]);
  });
});

describe("the character ceiling", () => {
  it("drops a skill that would breach it, whole", () => {
    publish("brand-voice", "x".repeat(500));

    const loaded = read(always("brand-voice"), { maxChars: 100 });

    expect(loaded).toEqual([]);
    expect(said("shared_skill_oversize")[0]?.file).toBe("shared/brand-voice");
  });

  // Never truncated: half a playbook reads as complete, and the sentence that
  // mattered may be the one that went.
  it("never truncates one", () => {
    publish("brand-voice", "x".repeat(500));

    for (const skill of read(always("brand-voice"), { maxChars: 100 })) {
      expect(skill.body).toContain("x".repeat(500));
    }
  });

  // Not a `break`: the entries are in the sheet's order rather than in size
  // order, so which skills load must not depend on where an operator put a long
  // one in the file.
  it("goes on to a later skill that still fits", () => {
    publish("a-long", "x".repeat(500));
    publish("b-short", "brief");

    const loaded = read(always("a-long", "b-short"), { maxChars: 100 });

    expect(loaded.map(skill => skill.name)).toEqual(["shared/b-short"]);
  });

  it("measures the region and not one file", () => {
    publish("a-voice", "x".repeat(40));
    publish("b-style", "y".repeat(40));

    // Either alone fits; together they do not.
    expect(read(always("a-voice"), { maxChars: 70 })).toHaveLength(1);
    expect(read(always("a-voice", "b-style"), { maxChars: 70 })).toHaveLength(1);
  });
});

describe("three ways to load nothing, and all of them are log lines", () => {
  // The outcome `packages/schema/src/team-sheet.ts`'s `shared_skill` header
  // settled: a dangling name is dropped where the text is assembled, with a log
  // line naming it, and the channel is told nothing. `libero doctor` is what
  // catches this before a deploy.
  it("drops a name the root does not hold, naming it", () => {
    expect(read(always("brand-voice"))).toEqual([]);
    expect(said("shared_skill_missing")[0]).toMatchObject({
      level: "warn",
      channel: CHANNEL,
      file: "shared/brand-voice"
    });
  });

  it("drops a file that does not parse, for the same reason", () => {
    writeFileSync(join(root, "brand-voice.md"), "half a deploy\n");

    expect(read(always("brand-voice"))).toEqual([]);
    expect(said("shared_skill_missing")).toHaveLength(1);
  });

  each([
    ["the root is unset", null, "shared_skills_root_unset"],
    ["the root is not there", "/nonexistent/shared-skills", "shared_skills_root_missing"]
  ])("says so when %s", (_label, over, reason) => {
    expect(read(always("brand-voice"), { root: over as string | null })).toEqual([]);
    expect(said("shared_skills_unavailable")[0]).toMatchObject({ level: "warn", reason });
  });

  // A deployment that publishes none and names none is not a finding.
  it("says nothing about an unset root when no sheet names one", () => {
    expect(read([], { root: null })).toEqual([]);
    expect(said("shared_skills_unavailable")).toEqual([]);
  });

  // The answer to "what is this channel standing on", which is what the use
  // counter was asked for and could not be: an always-loaded skill is never in
  // the index, so there is no row for one to sit on.
  it("names each loaded skill on its own line", () => {
    publish("brand-voice");
    publish("house-style");

    read(always("brand-voice", "house-style"));

    expect(said("shared_skill_loaded").map(line => line.file)).toEqual([
      "shared/brand-voice",
      "shared/house-style"
    ]);
  });

  it("logs nothing for a skill it dropped", () => {
    publish("brand-voice");

    read(always("brand-voice", "never-published"));

    expect(said("shared_skill_loaded")).toHaveLength(1);
    expect(said("shared_skill_missing")).toHaveLength(1);
  });
});

describe("a root that is not a directory of skills", () => {
  it("passes over a file whose stem is not a skill name", () => {
    writeFileSync(join(root, "README.md"), "# Shared skills\n");

    expect(read(always("README"))).toEqual([]);
  });

  it("passes over a subdirectory", () => {
    mkdirSync(join(root, "marketing"));

    expect(read(always("marketing"))).toEqual([]);
  });
});
