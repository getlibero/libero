// The skill-purge command, against a real store and a real skills directory
// (#452).
//
// `./rebuild-cli.test.ts`'s shape — argv, env and both writers injected, so what
// is under test is the command rather than a process — with neither of that
// file's two additions: this command reaches no provider and no proxy.
//
// **The store and the directory are both real.** What the command does is delete
// index rows and leave files, and the whole claim is about which of the two moved
// — so a fake of either would prove the command agrees with itself. The rows are
// read back with `packages/memory`'s own reads and the files with `readdirSync`,
// because "the files are still there" is a filesystem fact rather than an API's
// opinion.
//
// The shared half is real too, for the case that matters most here: `origin` is
// what keeps a purge off it, and a test that planted no shared row would pass on
// a command that deleted every skill in the file.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { openMessageStore, openSharedSkillFiles, openSkillFiles, reconcileSharedSkillIndex, reconcileSkillIndex } from "@getlibero/memory";
import type { MessageStore, SkillFiles } from "@getlibero/memory";
import type { SkillPurgeCliIo } from "./skill-purge-cli.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runSkillPurgeCommand } from "./skill-purge-cli.js";

const CHANNEL = "C0ENGINEERING";
const MAX_SKILLS = 100;
const NOW = Date.UTC(2026, 7, 21, 9, 0, 0);
const DAY = 86_400_000;

let root: string;
let sharedRoot: string;
let store: MessageStore;
let files: SkillFiles;
let out: string[];
let err: string[];

/** A playbook of the channel's own, written the way a team member writes one. */
function skill(name: string, description = "When the thing breaks."): void {
  const result = files.apply({ op: "skill_create", name, description, body: "Do the thing." });
  if (result.outcome !== "written") throw new Error(`the fixture could not write ${name}`);
}

/** The operator's act, from outside every process this command runs in. */
function publish(name: string): void {
  writeFileSync(
    join(sharedRoot, `${name}.md`),
    `---\nname: ${name}\ndescription: How this company writes.\ncreated: 2026-01-01\nstatus: active\n---\n\nSay it plainly.\n`,
    "utf8"
  );
}

/** Brings the index up to date with both directories, as a task's head would. */
function reconcile(at = NOW): void {
  reconcileSkillIndex({ files, store, maxSkills: MAX_SKILLS, at, channel: CHANNEL });
  const shared = openSharedSkillFiles({ root: sharedRoot });
  reconcileSharedSkillIndex({
    files: shared,
    store,
    names: shared === null ? [] : shared.list(),
    at
  });
}

function purge(argv: readonly string[], over: Partial<SkillPurgeCliIo> = {}): number {
  return runSkillPurgeCommand({
    argv,
    env: { AGENT_STORE_ROOT: root },
    out: line => out.push(line),
    err: line => err.push(line),
    now: () => NOW + DAY,
    // The command opens its own handle; the fixture's stays open beside it, which
    // is two readers of one file and is what SQLite is for.
    open: (channel, at) => openMessageStore({ channel, root: at }),
    ...over
  });
}

/** The channel's skill files on disk, which a purge must never touch. */
const onDisk = (): string[] => readdirSync(join(root, CHANNEL, "skills")).sort();

const said = (): string => out.join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-purge-"));
  sharedRoot = mkdtempSync(join(tmpdir(), "libero-purge-shared-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
  files = openSkillFiles({ channel: CHANNEL, root, maxSkills: MAX_SKILLS, now: () => NOW });
  out = [];
  err = [];
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(sharedRoot, { recursive: true, force: true });
});

describe("what the command refuses before it opens anything", () => {
  it("answers the usage with no channel", () => {
    expect(purge([])).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("usage: skill-purge");
  });

  it("answers the usage with a second positional", () => {
    expect(purge([CHANNEL, "C0OTHER"])).toBe(EXIT_USAGE);
  });

  // The id becomes a path segment and this one came off a command line.
  it("refuses a channel id the schema does not admit", () => {
    expect(purge(["../../etc"])).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("is not a valid channel id");
  });

  it("names the variable when the store root is unset", () => {
    expect(purge([CHANNEL], { env: {} })).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("AGENT_STORE_ROOT");
  });

  // "No such channel" and "nothing to do" are different answers.
  it("says there is no store rather than nothing to do", () => {
    expect(purge(["C0NOSUCH"])).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("no store for C0NOSUCH");
  });
});

describe("a preview", () => {
  it("says what would go and deletes nothing", () => {
    skill("cut-a-release");
    skill("rotate-a-cert");
    reconcile();
    store.recordSkillUse(["cut-a-release"], NOW);

    expect(purge([CHANNEL])).toBe(EXIT_OK);

    expect(said()).toContain("2 skills in the index");
    expect(said()).toContain("first seen 2026-08-21");
    expect(said()).toContain("One has been loaded by a task");
    expect(said()).toContain("Nothing was deleted");
    // The claim: a preview is a read.
    expect(store.skillClocks()).toHaveLength(2);
    expect(onDisk()).toEqual(["cut-a-release.md", "rotate-a-cert.md"]);
  });

  // The loss worth naming out loud, because nothing re-derives it.
  it("names the stamps that go with the rows", () => {
    skill("cut-a-release");
    reconcile();

    purge([CHANNEL]);

    expect(said()).toContain("use counts, last-used and first-seen");
    expect(said()).toContain("nothing re-derives them");
  });

  it("says so and stops when the channel has none of its own", () => {
    publish("brand-voice");
    reconcile();

    expect(purge([CHANNEL, "--yes"])).toBe(EXIT_OK);

    expect(said()).toContain("no skills of its own");
    expect(store.listSkills("shared")).toHaveLength(1);
  });
});

describe("a purge", () => {
  it("empties the channel half and says how much went", () => {
    skill("cut-a-release");
    skill("rotate-a-cert");
    reconcile();

    expect(purge([CHANNEL, "--yes"])).toBe(EXIT_OK);

    expect(said()).toContain("Purged 2 rows");
    expect(store.listSkills("channel")).toEqual([]);
    expect(store.skillClocks()).toEqual([]);
  });

  // The files are the team's. What this drops is the index built over them.
  it("leaves the skills directory alone, and the index rebuilds from it", () => {
    skill("cut-a-release");
    reconcile();

    purge([CHANNEL, "--yes"]);

    expect(onDisk()).toEqual(["cut-a-release.md"]);
    // The next task's head, which is what "rebuilds from skills/" means.
    reconcile(NOW + 2 * DAY);
    expect(store.listSkills("channel").map(row => row.name)).toEqual(["cut-a-release"]);
  });

  // **The case that would pass on a command that deleted everything.** `origin`
  // is what keeps a purge off the operator's half, and it is a column rather
  // than a filter this command applies.
  it("leaves the shared half untouched", () => {
    skill("cut-a-release");
    publish("brand-voice");
    reconcile();

    purge([CHANNEL, "--yes"]);

    expect(store.listSkills("channel")).toEqual([]);
    expect(store.listSkills("shared").map(row => row.name)).toEqual(["shared/brand-voice"]);
    // And the shared skill is still retrievable, which is the point of leaving it.
    expect(store.searchSkills("how this company writes", 5)).toEqual(["shared/brand-voice"]);
  });

  // The clocks are the loss, and a rebuilt index starts them again — which is
  // what the preview says will happen and is worth pinning rather than implying.
  it("restarts the clocks when the index is rebuilt", () => {
    skill("cut-a-release");
    reconcile();
    store.recordSkillUse(["cut-a-release"], NOW);
    expect(store.skillClocks()[0]).toMatchObject({ firstSeenAt: NOW, lastUsedAt: NOW });

    purge([CHANNEL, "--yes"]);
    reconcile(NOW + 2 * DAY);

    expect(store.skillClocks()[0]).toMatchObject({
      firstSeenAt: NOW + 2 * DAY,
      lastUsedAt: null
    });
  });

  // An operator who previewed and then retried appends the flag.
  it("takes --yes on either side of the channel id", () => {
    skill("cut-a-release");
    reconcile();

    expect(purge(["--yes", CHANNEL])).toBe(EXIT_OK);
    expect(store.listSkills("channel")).toEqual([]);
  });
});
