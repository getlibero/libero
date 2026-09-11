// The shared root, read.
//
// `skill-file.test.ts`'s shape over a directory with no channel in its path and
// no writer at all. Most of what it asserts is the same — the `SkillName`
// round-trip on the stem, the three nulls `read` collapses — because it is the
// same helper underneath (./skill-dir.ts). What is new, and what is worth the
// file, is the two things this opener does differently: `null` for a root that is
// not there, and an interface that cannot write.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { openSharedSkillFiles } from "./shared-skill-file.js";
import type { SharedSkillFiles } from "./shared-skill-file.js";
import type { LogFields, LogLevel } from "./log.js";

let root: string;
let shared: SharedSkillFiles;
let logged: { level: LogLevel; fields: LogFields }[];

/**
 * The operator's act: a skill lands in the root, from outside this package.
 *
 * A directory per skill since #567 — `<name>/SKILL.md`, the Agent Skills layout
 * — so the helper writes what a `git subtree` or a `skill vendor` would.
 */
const publish = (name: string, text: string): void => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), text, "utf8");
};

/** The layout this root had before #567. Written only to assert it is not read. */
const publishFlat = (filename: string, text: string): void => {
  writeFileSync(join(root, filename), text, "utf8");
};

const skillText = (name: string, over: Record<string, string> = {}, body = "Say it plainly.\n"): string => {
  const front = {
    name,
    description: "How this company writes.",
    created: "2026-01-01",
    status: "active",
    ...over
  };
  return `---\n${Object.entries(front)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n\n${body}`;
};

/** Opens the root, failing the test rather than the assertion when it is absent. */
const open = (at: string = root): SharedSkillFiles => {
  const files = openSharedSkillFiles({
    root: at,
    logger: { log: (level, fields) => logged.push({ level, fields }) }
  });
  if (files === null) throw new Error(`the fixture root ${at} did not open`);
  return files;
};

/** Every event of one name, so an assertion names what it is looking for. */
const events = (name: string): LogFields[] =>
  logged.filter(line => line.fields.event === name).map(line => line.fields);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-shared-skills-"));
  logged = [];
  shared = open();
});

afterEach(() => {
  // No close: there is no handle.
  rmSync(root, { recursive: true, force: true });
});

describe("opening", () => {
  // The distinction the `null` exists for. An operator who scaffolded the
  // directory and published nothing is a working deployment with no shared
  // skills; a root that is not there is a mount that did not happen, and the two
  // must not answer the same thing.
  it("answers null for a root that is not there", () => {
    expect(openSharedSkillFiles({ root: join(root, "not-mounted") })).toBeNull();
  });

  it("opens a root that holds nothing yet", () => {
    expect(shared.list()).toEqual([]);
  });

  it("creates no directory merely by being opened", () => {
    openSharedSkillFiles({ root: join(root, "still-not-mounted") });
    expect(() => statSync(join(root, "still-not-mounted"))).toThrow();
  });

  // The read-only shape, asserted structurally rather than promised in a
  // comment: three reads, and nothing that writes. `SkillFiles` has five.
  it("offers three reads and no writer", () => {
    expect(Object.keys(shared).sort()).toEqual(["fingerprints", "list", "read"]);
  });

  each([["apply"], ["setStatus"], ["create"], ["delete"], ["remove"]])(
    "offers no %s",
    method => {
      expect(Object.keys(shared)).not.toContain(method);
    }
  );
});

describe("the listing", () => {
  it("holds every published skill, sorted", () => {
    publish("house-style", skillText("house-style"));
    publish("brand-voice", skillText("brand-voice"));

    expect(shared.list()).toEqual(["brand-voice", "house-style"]);
  });

  // The filter is a name rule, which is `skill-file.ts`'s argument reaching the
  // root an operator's deploy writes into — where a half-copied tree is likelier
  // than in a directory only this process writes. It is the directory's own name
  // now rather than a filename's stem, and the rule is the same one.
  each([
    ["an uppercase name", "Brand-Voice"],
    ["an underscore", "brand_voice"],
    ["a dot-prefixed name", ".brand-voice"],
    ["a name carrying a suffix", "brand-voice.md"],
    ["a temporary directory", ".brand-voice.tmp-1234"]
  ])("passes over %s", (_label, directory) => {
    publish(directory as string, skillText("brand-voice"));

    expect(shared.list()).toEqual([]);
  });

  // The sidecars are why the layout changed. They sit beside `SKILL.md` and the
  // listing is a listing of skills, not of files.
  it("holds one entry for a skill that carries sidecars", () => {
    publish("brand-voice", skillText("brand-voice"));
    mkdirSync(join(root, "brand-voice", "scripts"));
    writeFileSync(join(root, "brand-voice", "scripts", "extract.py"), "print(1)\n", "utf8");
    writeFileSync(join(root, "brand-voice", "README.md"), "# not a skill\n", "utf8");

    expect(shared.list()).toEqual(["brand-voice"]);
  });

  // The layout before #567. Read as a skill it would make one root hold two
  // layouts, and an operator's half-finished migration look finished.
  it("passes over a flat file, and says so", () => {
    publishFlat("brand-voice.md", skillText("brand-voice"));

    expect(shared.list()).toEqual([]);
    expect(events("shared_skill_not_a_directory").map(fields => fields.file)).toEqual([
      join(root, "brand-voice.md")
    ]);
  });

  // Left in `list()` it would hold an index row open against a skill with no
  // file behind it.
  it("passes over a directory with no SKILL.md, and says so", () => {
    mkdirSync(join(root, "brand-voice"));

    expect(shared.list()).toEqual([]);
    expect(events("shared_skill_file_missing").map(fields => fields.file)).toEqual([
      join(root, "brand-voice")
    ]);
  });

  it("says nothing about an ordinary file that is not a skill at all", () => {
    publishFlat("README", "# how to publish one\n");

    expect(shared.list()).toEqual([]);
    expect(events("shared_skill_not_a_directory")).toEqual([]);
  });
});

describe("fingerprints", () => {
  it("carries the three fields an index diffs on", () => {
    publish("brand-voice", skillText("brand-voice"));
    const stat = statSync(join(root, "brand-voice", "SKILL.md"));

    expect(shared.fingerprints()).toEqual([
      { name: "brand-voice", mtimeMs: stat.mtimeMs, size: stat.size, ino: Number(stat.ino) }
    ]);
  });

  // The skill's own file, not its directory — a sidecar changing is not the
  // skill changing, and a directory's mtime moves for either.
  it("fingerprints SKILL.md rather than the directory", () => {
    publish("brand-voice", skillText("brand-voice"));
    const file = statSync(join(root, "brand-voice", "SKILL.md"));
    const directory = statSync(join(root, "brand-voice"));

    expect(shared.fingerprints()[0]?.ino).toBe(Number(file.ino));
    expect(shared.fingerprints()[0]?.ino).not.toBe(Number(directory.ino));
  });

  it("covers the listing and nothing else", () => {
    publish("brand-voice", skillText("brand-voice"));
    publish("Brand-Voice", skillText("brand-voice"));

    expect(shared.fingerprints().map(file => file.name)).toEqual(["brand-voice"]);
  });
});

describe("reading", () => {
  it("answers the file as it is on disk", () => {
    publish("brand-voice", skillText("brand-voice", {}, "Say it plainly.\nNo exclamation marks.\n"));

    expect(shared.read("brand-voice")).toEqual({
      frontmatter: {
        name: "brand-voice",
        description: "How this company writes.",
        created: "2026-01-01",
        status: "active"
      },
      body: "Say it plainly.\nNo exclamation marks."
    });
  });

  // A vendored skill has no `created`: the spec does not define the key, and
  // nothing here decides anything by it. A channel's own file still needs one,
  // which `skill-file.test.ts` is where that is asserted.
  it("reads a skill whose file gives no created", () => {
    publish(
      "brand-voice",
      "---\nname: brand-voice\ndescription: How this company writes.\n---\n\nSay it plainly.\n"
    );

    expect(shared.read("brand-voice")).toEqual({
      frontmatter: {
        name: "brand-voice",
        description: "How this company writes.",
        status: "active"
      },
      body: "Say it plainly."
    });
  });

  // The spec's own keys, read as they are written rather than refused.
  it("reads the metadata block and drops the tool list", () => {
    publish(
      "brand-voice",
      [
        "---",
        "name: brand-voice",
        'description: "How this company writes."',
        "license: Apache-2.0",
        "allowed-tools: Bash",
        "metadata:",
        "  author: example-org",
        "---",
        "",
        "Say it plainly.",
        ""
      ].join("\n")
    );

    const skill = shared.read("brand-voice");
    expect(skill?.frontmatter.description).toBe("How this company writes.");
    expect(skill?.frontmatter.metadata).toEqual({ author: "example-org" });
    expect(skill?.frontmatter.extra).toEqual([{ key: "license", value: "Apache-2.0" }]);
  });

  // The operator's word, read like any other field. What is absent is anything
  // that would write one: a shared skill has no lifecycle here.
  it("carries a status the operator set", () => {
    publish("brand-voice", skillText("brand-voice", { status: "stale" }));

    expect(shared.read("brand-voice")?.frontmatter.status).toBe("stale");
  });

  it("re-reads the file rather than caching it", () => {
    publish("brand-voice", skillText("brand-voice"));
    expect(shared.read("brand-voice")?.frontmatter.description).toBe("How this company writes.");

    publish("brand-voice", skillText("brand-voice", { description: "Revised upstream." }));

    expect(shared.read("brand-voice")?.frontmatter.description).toBe("Revised upstream.");
  });

  // `SkillFiles.read`'s three nulls, and two more: a name that could never be a
  // path segment, and the flat layout reached through `read` rather than the
  // listing. A caller does the same thing in all of them.
  each([
    ["there is no such skill", () => {}, "brand-voice"],
    [
      "the file does not parse",
      () => publish("brand-voice", "no frontmatter at all\n"),
      "brand-voice"
    ],
    [
      "the frontmatter names something else",
      () => publish("brand-voice", skillText("house-style")),
      "brand-voice"
    ],
    [
      "the name is a flat file from the old layout",
      () => publishFlat("brand-voice.md", skillText("brand-voice")),
      "brand-voice"
    ],
    ["the name could not be a path segment", () => {}, "../../etc/passwd"]
  ])("answers null when %s", (_label, arrange, name) => {
    (arrange as () => void)();

    expect(shared.read(name as string)).toBeNull();
  });

  // The address is the index's key and never a path — `sharedSkillRef`'s header
  // in the schema package is explicit about it, and this is what that means here.
  it("takes the bare name and not the qualified address", () => {
    publish("brand-voice", skillText("brand-voice"));

    expect(shared.read("shared/brand-voice")).toBeNull();
    expect(shared.read("brand-voice")).not.toBeNull();
  });
});
