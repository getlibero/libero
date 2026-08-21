import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { SKILL_BODY_MAX_CHARS, SKILL_DESCRIPTION_MAX_CHARS } from "@getlibero/schema";
import type { SkillOp, SkillOpResult } from "@getlibero/schema";
import { openSkillFiles, planSkillOp } from "./skill-file.js";
import type { SkillFiles } from "./skill-file.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";

/** Small enough that a test can fill the library. */
const MAX_SKILLS = 4;

/** Fixed clock, so a stamped `created` date is a decision rather than today's. */
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

let root: string;
let directory: string;
let skills: SkillFiles;

const open = (over: Record<string, unknown> = {}): SkillFiles =>
  openSkillFiles({ channel: CHANNEL, root, maxSkills: MAX_SKILLS, now: () => NOW, ...over });

const create = (name: string, description = "When the thing breaks.", body = "Do the thing."): SkillOpResult =>
  skills.apply({ op: "skill_create", name, description, body });

const revise = (name: string, description = "Revised.", body = "Do it differently."): SkillOpResult =>
  skills.apply({ op: "skill_revise", name, description, body });

/** The file as a second process would read it, or null when there is none. */
const onDisk = (name: string): string | null => {
  const file = join(directory, `${name}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

/** Writes behind the store's back. The team's text editor. */
const handWrite = (filename: string, text: string): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), text, "utf8");
};

/** Everything in `skills/`. A leftover temporary file is what this catches. */
const entries = (): string[] => (existsSync(directory) ? readdirSync(directory).sort() : []);

const skillFile = (name: string, over: Record<string, string> = {}): string => {
  const front = {
    name,
    description: "When the thing breaks.",
    created: "2026-01-01",
    status: "active",
    ...over
  };
  return `---\n${Object.entries(front)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n\nDo the thing.\n`;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-skills-"));
  // The store does not create this — that is a tested property below, so here
  // the test does the operator's job of declaring the channel exists.
  mkdirSync(join(root, CHANNEL));
  directory = join(root, CHANNEL, "skills");
  skills = open();
});

afterEach(() => {
  // No close: there is no handle.
  rmSync(root, { recursive: true, force: true });
});

describe("opening", () => {
  // The isolation boundary is a path segment, so the character class is the
  // boundary. Each of these would climb out of `root` or collide if it did not
  // throw.
  each([
    ["a parent traversal", ".."],
    ["a separator", "a/b"],
    ["empty", ""],
    ["a leading dot", ".hidden"]
  ])("refuses %s as a channel id", (_label, channel) => {
    expect(() => open({ channel })).toThrow(/not a valid channel id/);
  });

  it("refuses a channel id past the length bound", () => {
    expect(() => open({ channel: "C".repeat(65) })).toThrow(/not a valid channel id/);
  });

  // A channel that may hold no skills is one where every legal operation is
  // unwritable — the "parses, then cannot serve a call" class, caught at open
  // rather than as a model retrying an operation that can never succeed.
  each([
    ["zero", 0],
    ["negative", -1],
    ["a fraction", 2.5]
  ])("refuses %s as a library cap", (_label, maxSkills) => {
    expect(() => open({ maxSkills })).toThrow(/max_skills/);
  });

  // Not the store's to create: the channel's directory existing is the
  // operator's statement that the channel exists.
  it("refuses a channel with no state directory", () => {
    expect(() => open({ channel: OTHER })).toThrow(/no state directory/);
  });

  it("creates no directory merely by being opened", () => {
    open();
    expect(existsSync(directory)).toBe(false);
  });

  // Every method, and nothing that could name another channel or hold a handle.
  // No `close`, because there is none to hold.
  it("offers five operations and no way to name a channel", () => {
    expect(Object.keys(skills).sort()).toEqual([
      "apply",
      "fingerprints",
      "list",
      "read",
      "setStatus"
    ]);
  });

  // The fifth is the lifecycle job's, and what it is not is the point: there is
  // still no delete, and `setStatus` is the only writer that is not `apply`.
  it("offers no way to delete a skill", () => {
    expect(Object.keys(skills)).not.toContain("delete");
    expect(Object.keys(skills)).not.toContain("remove");
  });
});

describe("the directory listing", () => {
  it("is empty before anything is written", () => {
    expect(skills.list()).toEqual([]);
  });

  it("names every skill, sorted", () => {
    create("rotate-a-cert");
    create("deploy-to-staging");

    expect(skills.list()).toEqual(["deploy-to-staging", "rotate-a-cert"]);
  });

  // The filter is a name rule and not a suffix rule, which is what keeps the
  // temporary file `replaceFileAtomically` plants mid-write out of the listing —
  // along with everything else in the directory that is not a skill.
  each([
    ["a capital", "Deploy-Runbook.md"],
    ["an underscore", "deploy_runbook.md"],
    ["a leading dot", ".hidden.md"],
    ["a doubled extension", "deploy.md.md"],
    ["a trailing dash", "deploy-.md"],
    ["no extension", "deploy"],
    ["another extension", "deploy.txt"],
    ["an atomic-write leftover", ".deploy.md.tmp-1234-abcd"],
    ["a name past the bound", `${"a".repeat(65)}.md`]
  ])("ignores %s", (_label, filename) => {
    handWrite(filename, skillFile("deploy"));

    expect(skills.list()).toEqual([]);
  });

  it("counts a hand-written file that a person added", () => {
    handWrite("hand-written.md", skillFile("hand-written"));

    expect(skills.list()).toEqual(["hand-written"]);
  });

  // Listing is by filename, so a file that does not parse is still a name that
  // is taken. `read` is where the contents are judged.
  it("lists a file whose contents do not parse", () => {
    handWrite("broken.md", "not a skill at all");

    expect(skills.list()).toEqual(["broken"]);
    expect(skills.read("broken")).toBeNull();
  });

  // Two openers under one root, each seeing only its own channel.
  it("sees only its own channel's skills", () => {
    mkdirSync(join(root, OTHER));
    const other = open({ channel: OTHER });

    create("mine");
    other.apply({ op: "skill_create", name: "theirs", description: "d", body: "b" });

    expect(skills.list()).toEqual(["mine"]);
    expect(other.list()).toEqual(["theirs"]);
  });
});

describe("creating a skill", () => {
  it("writes a file that parses back", () => {
    expect(create("rotate-a-cert")).toEqual({ outcome: "written", skills: 1, limit: MAX_SKILLS });

    const skill = skills.read("rotate-a-cert");
    expect(skill?.frontmatter).toEqual({
      name: "rotate-a-cert",
      description: "When the thing breaks.",
      created: "2026-08-15",
      status: "active"
    });
    expect(skill?.body).toBe("Do the thing.");
  });

  it("creates the skills directory on the first write", () => {
    expect(existsSync(directory)).toBe(false);
    create("rotate-a-cert");
    expect(existsSync(directory)).toBe(true);
  });

  // The model has no field for either, and the store stamps them.
  it("stamps today's date and an active status", () => {
    create("rotate-a-cert");

    expect(onDisk("rotate-a-cert")).toContain("created: 2026-08-15");
    expect(onDisk("rotate-a-cert")).toContain("status: active");
  });

  it("refuses a name that is already taken, and writes nothing", () => {
    create("rotate-a-cert", "first", "original body");

    expect(create("rotate-a-cert", "second", "replacement body")).toEqual({
      outcome: "failed",
      reason: "name_taken",
      name: "rotate-a-cert"
    });
    expect(onDisk("rotate-a-cert")).toContain("original body");
  });

  // The name is taken by a file the team owns, whatever is in it.
  it("refuses a name taken by a file that does not parse", () => {
    handWrite("broken.md", "not a skill at all");

    expect(create("broken")).toMatchObject({ outcome: "failed", reason: "name_taken" });
    expect(onDisk("broken")).toBe("not a skill at all");
  });

  it("refuses to grow the library past its cap", () => {
    for (let index = 0; index < MAX_SKILLS; index += 1) create(`skill-${String(index)}`);

    expect(create("one-too-many")).toEqual({
      outcome: "failed",
      reason: "library_full",
      skills: MAX_SKILLS,
      limit: MAX_SKILLS
    });
    expect(skills.list()).toHaveLength(MAX_SKILLS);
  });

  it("counts a hand-written skill against the cap", () => {
    for (let index = 0; index < MAX_SKILLS - 1; index += 1) create(`skill-${String(index)}`);
    handWrite("hand-written.md", skillFile("hand-written"));

    expect(create("one-too-many")).toMatchObject({ outcome: "failed", reason: "library_full" });
  });
});

describe("revising a skill", () => {
  it("replaces the body and the description whole", () => {
    create("rotate-a-cert", "old description", "old body");

    expect(revise("rotate-a-cert", "new description", "new body")).toEqual({
      outcome: "written",
      skills: 1,
      limit: MAX_SKILLS
    });

    const skill = skills.read("rotate-a-cert");
    expect(skill?.frontmatter.description).toBe("new description");
    expect(skill?.body).toBe("new body");
  });

  // Neither is the model's to set — the operation has no field for either — so a
  // revision must not reset a date the team can see or un-archive a skill the
  // lifecycle job retired.
  it("carries the created date and the status forward", () => {
    handWrite("rotate-a-cert.md", skillFile("rotate-a-cert", { created: "2025-03-04", status: "archived" }));

    revise("rotate-a-cert");

    expect(skills.read("rotate-a-cert")?.frontmatter).toMatchObject({
      created: "2025-03-04",
      status: "archived"
    });
  });

  it("refuses a name that does not exist, and writes nothing", () => {
    expect(revise("never-written")).toEqual({
      outcome: "failed",
      reason: "skill_not_found",
      name: "never-written"
    });
    expect(onDisk("never-written")).toBeNull();
  });

  // A revision replaces the whole document, so repairing a broken file is what
  // it is for. Deciding this the other way would leave a name on which neither
  // operation could run.
  it("repairs a file that does not parse", () => {
    handWrite("broken.md", "not a skill at all");

    expect(revise("broken")).toMatchObject({ outcome: "written" });
    expect(skills.read("broken")?.frontmatter.name).toBe("broken");
    // Nothing to carry forward, so it is stamped as a create would be.
    expect(skills.read("broken")?.frontmatter.created).toBe("2026-08-15");
  });

  it("does not grow the library, so it works at the cap", () => {
    for (let index = 0; index < MAX_SKILLS; index += 1) create(`skill-${String(index)}`);

    expect(revise("skill-0")).toMatchObject({ outcome: "written" });
  });
});

describe("what an operation may carry", () => {
  // `SkillOp` is a plain type with no zod object, so nothing structurally forces
  // a caller through the schema's parser. These are this module's own
  // preconditions, and a hand-built operation is exactly what they are for.
  each([
    ["a parent traversal", ".."],
    ["a separator", "deploy/runbook"],
    ["a leading dot", ".hidden"],
    ["an extension", "deploy.md"],
    ["a capital", "Deploy"],
    ["an underscore", "deploy_runbook"],
    ["a space", "deploy runbook"],
    ["a trailing dash", "deploy-"],
    ["empty", ""],
    ["past the bound", "a".repeat(65)]
  ])("refuses %s as a name, and touches no disk", (_label, name) => {
    expect(skills.apply({ op: "skill_create", name, description: "d", body: "b" })).toEqual({
      outcome: "failed",
      reason: "name_invalid"
    });
    expect(existsSync(directory)).toBe(false);
  });

  it("refuses an oversize body whole", () => {
    expect(create("rotate-a-cert", "d", "b".repeat(SKILL_BODY_MAX_CHARS + 1))).toEqual({
      outcome: "failed",
      reason: "body_too_long"
    });
    expect(existsSync(directory)).toBe(false);
  });

  it("accepts a body at the cap", () => {
    expect(create("rotate-a-cert", "d", "b".repeat(SKILL_BODY_MAX_CHARS))).toMatchObject({
      outcome: "written"
    });
  });

  it("refuses an oversize description whole", () => {
    expect(create("rotate-a-cert", "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1))).toEqual({
      outcome: "failed",
      reason: "description_too_long"
    });
    expect(existsSync(directory)).toBe(false);
  });

  each([
    ["an empty description", { description: "" }],
    ["an empty body", { body: "" }]
  ])("refuses %s", (_label, over) => {
    const op = {
      op: "skill_create" as const,
      name: "rotate-a-cert",
      description: "d",
      body: "b",
      ...over
    };
    expect(skills.apply(op)).toEqual({ outcome: "failed", reason: "malformed_arguments" });
  });

  // Nothing shortened, ever. A silently truncated playbook is a procedure the
  // team believes it recorded, and there is no way to tell from reading it.
  it("leaves an existing skill untouched when a revision is refused", () => {
    create("rotate-a-cert", "keep me", "keep this body");

    expect(revise("rotate-a-cert", "d", "b".repeat(SKILL_BODY_MAX_CHARS + 1))).toMatchObject({
      outcome: "failed"
    });
    expect(skills.read("rotate-a-cert")?.body).toBe("keep this body");
  });
});

describe("reading a skill", () => {
  it("answers null for a name nobody wrote", () => {
    expect(skills.read("never-written")).toBeNull();
  });

  it("answers null for a name that could never be a filename", () => {
    expect(skills.read("../escape")).toBeNull();
  });

  it("answers null for a file that does not parse", () => {
    handWrite("broken.md", "no frontmatter here");

    expect(skills.read("broken")).toBeNull();
  });

  // The stem wins. Re-keying it would make two names for one skill, and
  // repairing it would edit a file the team wrote.
  it("answers null when the frontmatter names a different skill", () => {
    handWrite("deploy.md", skillFile("rollback"));

    expect(skills.read("deploy")).toBeNull();
    expect(onDisk("deploy")).toContain("name: rollback");
  });

  it("reads a hand-edit back on the next call, with no cache in the way", () => {
    create("rotate-a-cert", "before", "original");
    handWrite("rotate-a-cert.md", skillFile("rotate-a-cert", { description: "after" }));

    expect(skills.read("rotate-a-cert")?.frontmatter.description).toBe("after");
  });
});

describe("moving a skill's status", () => {
  it("writes the new status and nothing else", () => {
    create("rotate-a-cert");
    const before = onDisk("rotate-a-cert") ?? "";

    expect(skills.setStatus("rotate-a-cert", "stale")).toEqual({
      outcome: "written",
      from: "active"
    });

    // The whole point of `serializeSkillFile`'s fixed field order: one line
    // moved and the rest of the document — description, created, body, the
    // trailing newline — is byte for byte what it was.
    const after = onDisk("rotate-a-cert") ?? "";
    const changed = before
      .split("\n")
      .map((line, index) => [line, after.split("\n")[index]] as const)
      .filter(([was, is]) => was !== is);
    expect(changed).toEqual([["status: active", "status: stale"]]);
  });

  it("reads the new status back", () => {
    create("rotate-a-cert");
    skills.setStatus("rotate-a-cert", "archived");

    expect(skills.read("rotate-a-cert")?.frontmatter.status).toBe("archived");
  });

  // The outcome that keeps a steady-state pass free: no rename, so no
  // fingerprint moves and nothing re-indexes.
  it("writes nothing at all when the file already says so", () => {
    create("rotate-a-cert");
    const before = statSync(join(directory, "rotate-a-cert.md"));

    expect(skills.setStatus("rotate-a-cert", "active")).toEqual({
      outcome: "unchanged",
      status: "active"
    });

    const after = statSync(join(directory, "rotate-a-cert.md"));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  each([
    ["a name nobody wrote", "never-written"],
    ["a name that could never be a filename", "../escape"]
  ])("answers unusable for %s", (_label, name) => {
    expect(skills.setStatus(name, "stale")).toEqual({ outcome: "unusable" });
  });

  // The property that protects a half-saved edit: a clock never overwrites a
  // file it could not read.
  it("leaves a file that does not parse exactly as it found it", () => {
    handWrite("broken.md", "no frontmatter here");

    expect(skills.setStatus("broken", "archived")).toEqual({ outcome: "unusable" });
    expect(onDisk("broken")).toBe("no frontmatter here");
  });

  it("leaves a misnamed file alone", () => {
    handWrite("deploy.md", skillFile("rollback"));

    expect(skills.setStatus("deploy", "archived")).toEqual({ outcome: "unusable" });
    expect(onDisk("deploy")).toContain("status: active");
  });

  // A status write only ever lands on a file that exists, so it can never be
  // what creates `skills/` for a channel whose sheet turned the feature off.
  it("creates no directory", () => {
    expect(skills.setStatus("never-written", "archived")).toEqual({ outcome: "unusable" });
    expect(existsSync(directory)).toBe(false);
  });

  it("gives a hand-written file with no status line one, keeping everything else", () => {
    handWrite(
      "deploy.md",
      "---\nname: deploy\ndescription: How we ship.\ncreated: 2026-01-01\n---\n\nRun the script.\n"
    );

    expect(skills.setStatus("deploy", "stale")).toEqual({ outcome: "written", from: "active" });

    const after = skills.read("deploy");
    expect(after?.frontmatter).toEqual({
      name: "deploy",
      description: "How we ship.",
      created: "2026-01-01",
      status: "stale"
    });
    expect(after?.body).toBe("Run the script.");
  });

  // It is a status change, not an operation: nothing about it is decided
  // against the library's ceiling.
  it("works on a full library", () => {
    for (let index = 0; index < MAX_SKILLS; index += 1) create(`skill-${String(index)}`);

    expect(skills.setStatus("skill-0", "archived")).toMatchObject({ outcome: "written" });
  });

  it("carries a revision's status forward rather than resetting it", () => {
    create("rotate-a-cert");
    skills.setStatus("rotate-a-cert", "archived");

    revise("rotate-a-cert");

    expect(skills.read("rotate-a-cert")?.frontmatter.status).toBe("archived");
  });

  it("leaves no temporary file behind", () => {
    create("rotate-a-cert");
    skills.setStatus("rotate-a-cert", "stale");

    expect(entries()).toEqual(["rotate-a-cert.md"]);
  });
});

describe("a reader never sees a torn file", () => {
  it("replaces the file rather than writing into it", () => {
    create("rotate-a-cert");
    const before = statSync(join(directory, "rotate-a-cert.md")).ino;

    revise("rotate-a-cert");

    // The observable signature of write-temp-then-rename. It fails for
    // writeFileSync, appendFileSync, and anything opening O_TRUNC.
    expect(statSync(join(directory, "rotate-a-cert.md")).ino).not.toBe(before);
  });

  it("leaves no temporary file behind a successful write", () => {
    create("rotate-a-cert");

    expect(entries()).toEqual(["rotate-a-cert.md"]);
  });

  it("leaves no temporary file behind a refused operation", () => {
    create("rotate-a-cert");

    expect(revise("rotate-a-cert", "d", "b".repeat(SKILL_BODY_MAX_CHARS + 1))).toMatchObject({
      outcome: "failed"
    });
    expect(entries()).toEqual(["rotate-a-cert.md"]);
  });
});

// The whole of what an operation means, on two facts and two numbers, so the
// rules can be read without a filesystem.
describe("planSkillOp", () => {
  const op = (over: Partial<SkillOp> = {}): SkillOp => ({
    op: "skill_create",
    name: "rotate-a-cert",
    description: "d",
    body: "b",
    ...over
  } as SkillOp);

  it("writes a create into a directory that does not hold the name", () => {
    expect(planSkillOp({ exists: false, count: 0 }, op(), 10)).toEqual({
      write: true,
      result: { outcome: "written", skills: 1, limit: 10 }
    });
  });

  it("refuses a create at the cap and a revise never", () => {
    expect(planSkillOp({ exists: false, count: 10 }, op(), 10).write).toBe(false);
    expect(planSkillOp({ exists: true, count: 10 }, op({ op: "skill_revise" }), 10).write).toBe(true);
  });

  it("reports the count it refused on", () => {
    expect(planSkillOp({ exists: false, count: 10 }, op(), 10).result).toEqual({
      outcome: "failed",
      reason: "library_full",
      skills: 10,
      limit: 10
    });
  });

  // Before the directory is consulted at all, so a traversal never reaches a
  // path join and an oversize body never reaches a cap comparison.
  it("checks the operation's own bounds first", () => {
    expect(planSkillOp({ exists: true, count: 99 }, op({ name: ".." }), 1).result).toEqual({
      outcome: "failed",
      reason: "name_invalid"
    });
  });
});
