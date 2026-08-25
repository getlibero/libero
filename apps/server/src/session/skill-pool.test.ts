// The retrieved half of the shared library, against a real shared root.
//
// A real directory rather than a fake opener, for ./shared-skills.test.ts's
// reason: almost everything here is deciding what a root and a sheet's entries
// mean together, and a fake of one side would let both agree with each other and
// with nothing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { openSkillFiles } from "@getlibero/memory";
import { sharedSkillRef } from "@getlibero/schema";
import type { SkillFiles } from "@getlibero/memory";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { SharedSkillEntry } from "@getlibero/schema";
import { createSharedSkillPoolOpener, membershipOf, readCandidate } from "./skill-pool.js";

const CHANNEL = "C0ENGINEERING";
const MAX_SKILLS = 100;

let root: string;
let storeRoot: string;
let channelFiles: SkillFiles;
let lines: Array<{ level: LogLevel } & LogFields>;
let logger: Logger;

/** The operator's act: a file lands in the root, from outside this process. */
function publish(name: string, description = "How this company writes."): void {
  writeFileSync(
    join(root, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ncreated: 2026-01-01\nstatus: active\n---\n\nSay it plainly.\n`
  );
}

function retrieved(...names: string[]): SharedSkillEntry[] {
  return names.map(name => ({ name, load: "retrieved" as const }));
}

function always(...names: string[]): SharedSkillEntry[] {
  return names.map(name => ({ name, load: "always" as const }));
}

function open(entries: readonly SharedSkillEntry[], over: { root?: string | null } = {}) {
  const opener = createSharedSkillPoolOpener({
    root: over.root === undefined ? root : over.root,
    logger
  });
  return opener(CHANNEL, entries);
}

/** Every log line with this event word. */
function said(event: string): Array<{ level: LogLevel } & LogFields> {
  return lines.filter(line => line.event === event);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-shared-pool-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-pool-store-"));
  mkdirSync(join(storeRoot, CHANNEL));
  channelFiles = openSkillFiles({ channel: CHANNEL, root: storeRoot, maxSkills: MAX_SKILLS });
  lines = [];
  logger = { log: (level, fields) => void lines.push({ level, ...fields }) };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("when a channel has a pool at all", () => {
  it("opens one for a retrieved entry", () => {
    publish("code-review-standards");

    expect(open(retrieved("code-review-standards"))?.names).toEqual(["code-review-standards"]);
  });

  // The standing region's half, and this one never sees it. Indexing an `always`
  // entry would put it in the retrieval pool as well, so a task near its subject
  // would pay for it twice in one prompt.
  it("answers null for a sheet naming only always entries", () => {
    publish("brand-voice");

    expect(open(always("brand-voice"))).toBeNull();
  });

  // The ordinary deployment: no third root, no shared entry, every pass. It must
  // cost one filter and no filesystem call — and, in an operator's log, nothing.
  it("touches no filesystem and says nothing when the sheet names none", () => {
    expect(open(always("brand-voice"), { root: join(root, "not-a-directory") })).toBeNull();
    expect(lines).toEqual([]);
  });

  it("names the unset root when a sheet asks for one anyway", () => {
    expect(open(retrieved("code-review-standards"), { root: null })).toBeNull();
    expect(said("shared_skills_unavailable")).toMatchObject([
      { level: "warn", channel: CHANNEL, reason: "shared_skills_root_unset" }
    ]);
  });

  it("names the missing root, and where it looked", () => {
    const missing = join(root, "not-a-directory");

    expect(open(retrieved("code-review-standards"), { root: missing })).toBeNull();
    expect(said("shared_skills_unavailable")).toMatchObject([
      { level: "warn", channel: CHANNEL, reason: "shared_skills_root_missing", file: missing }
    ]);
  });

  // A name the root does not hold is not an error here and does not empty the
  // pool: the sheet asked for it, so it is still a member, and what it resolves
  // to is the pass's to report.
  it("opens one for a name the root does not hold", () => {
    expect(open(retrieved("code-review-standards"))?.names).toEqual(["code-review-standards"]);
  });

  it("carries only the retrieved names, in sheet order", () => {
    publish("brand-voice");
    publish("code-review-standards");

    const pool = open([...always("brand-voice"), ...retrieved("code-review-standards")]);

    expect(pool?.names).toEqual(["code-review-standards"]);
  });
});

describe("scoping is the sheet", () => {
  // The rule the whole feature rests on: the root is the operator's library and
  // the sheet is this channel's subscription to part of it.
  it("does not hold a published skill this sheet did not name", () => {
    publish("brand-voice");
    publish("code-review-standards");

    const pool = open(retrieved("code-review-standards"));

    expect(pool?.has(sharedSkillRef("code-review-standards"))).toBe(true);
    expect(pool?.has(sharedSkillRef("brand-voice"))).toBe(false);
    expect(pool?.read(sharedSkillRef("brand-voice"))).toBeNull();
  });

  it("reads a member by its address", () => {
    publish("code-review-standards", "How this company reviews code.");

    expect(pool().read(sharedSkillRef("code-review-standards"))).toMatchObject({
      frontmatter: { name: "code-review-standards", description: "How this company reviews code." },
      body: "Say it plainly."
    });
  });

  // The address is not the filename, and nothing here turns one into the other
  // by inspecting it.
  it("does not answer to the bare filename", () => {
    publish("code-review-standards");

    expect(pool().read("code-review-standards")).toBeNull();
  });

  it("answers null for a member whose file is not there", () => {
    expect(pool().read(sharedSkillRef("code-review-standards"))).toBeNull();
  });
});

describe("which half a candidate belongs to", () => {
  it("reads a shared address as shared, and a bare name as the channel's", () => {
    publish("code-review-standards");
    const shared = pool();

    expect(membershipOf(sharedSkillRef("code-review-standards"), channelFiles, shared)).toBe("shared");
    expect(membershipOf("rotate-a-cert", channelFiles, shared)).toBe("channel");
  });

  // `[skills] enabled = false`: the channel half is unaddressable, so its
  // leftover rows are not pool members and must not spend a slot resolving.
  it("reads nothing as the channel's when there is no channel opener", () => {
    publish("code-review-standards");
    const shared = pool();

    expect(membershipOf(sharedSkillRef("code-review-standards"), null, shared)).toBe("shared");
    expect(membershipOf("rotate-a-cert", null, shared)).toBeNull();
    expect(readCandidate("rotate-a-cert", null, shared)).toBeNull();
  });

  it("reads nothing at all when neither half is addressable", () => {
    expect(membershipOf("rotate-a-cert", null, null)).toBeNull();
    expect(membershipOf(sharedSkillRef("brand-voice"), null, null)).toBeNull();
  });

  // The one place having no parser costs something, and it costs a slot rather
  // than a decision: a stale `shared/<name>` on a pass whose pool did not open
  // reads as a channel candidate, and `SkillFiles.read`'s own `SkillName` guard
  // is what turns it back into nothing.
  it("reads a stale shared address as the channel's, resolving to nothing", () => {
    expect(membershipOf(sharedSkillRef("brand-voice"), channelFiles, null)).toBe("channel");
    expect(readCandidate(sharedSkillRef("brand-voice"), channelFiles, null)).toBeNull();
  });

  it("resolves each half through its own opener", () => {
    publish("code-review-standards");
    channelFiles.apply({
      op: "skill_create",
      name: "rotate-a-cert",
      description: "When a certificate is expiring.",
      body: "Run dev-certs.sh --rotate."
    });
    const shared = pool();

    expect(readCandidate(sharedSkillRef("code-review-standards"), channelFiles, shared)).toMatchObject({
      origin: "shared",
      file: { frontmatter: { name: "code-review-standards" } }
    });
    expect(readCandidate("rotate-a-cert", channelFiles, shared)).toMatchObject({
      origin: "channel",
      file: { frontmatter: { name: "rotate-a-cert" } }
    });
  });

  // Both halves can hold the same stem, which is what the address exists for.
  it("keeps a channel skill and a published one of the same name apart", () => {
    publish("brand-voice", "How this company writes.");
    channelFiles.apply({
      op: "skill_create",
      name: "brand-voice",
      description: "How this channel writes.",
      body: "Say it twice."
    });
    const shared = open(retrieved("brand-voice"));

    expect(readCandidate("brand-voice", channelFiles, shared)).toMatchObject({
      origin: "channel",
      file: { frontmatter: { description: "How this channel writes." } }
    });
    expect(readCandidate(sharedSkillRef("brand-voice"), channelFiles, shared)).toMatchObject({
      origin: "shared",
      file: { frontmatter: { description: "How this company writes." } }
    });
  });
});

/** The pool this channel's sheet asks for, which the fixture always opens. */
function pool() {
  const opened = open(retrieved("code-review-standards"));
  if (opened === null) throw new Error("the fixture pool did not open");
  return opened;
}
