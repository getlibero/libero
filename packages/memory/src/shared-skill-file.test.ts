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

let root: string;
let shared: SharedSkillFiles;

/** The operator's act: a file lands in the root, from outside this package. */
const publish = (filename: string, text: string): void => {
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
  const files = openSharedSkillFiles({ root: at });
  if (files === null) throw new Error(`the fixture root ${at} did not open`);
  return files;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-shared-skills-"));
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
    publish("house-style.md", skillText("house-style"));
    publish("brand-voice.md", skillText("brand-voice"));

    expect(shared.list()).toEqual(["brand-voice", "house-style"]);
  });

  // The filter is a name rule and not a suffix rule, which is `skill-file.ts`'s
  // argument reaching the root an operator's deploy writes into — where a
  // half-copied file is likelier than in a directory only this process writes.
  each([
    ["an uppercase stem", "Brand-Voice.md"],
    ["an underscore", "brand_voice.md"],
    ["a dotfile", ".brand-voice.md"],
    ["a double suffix", "brand-voice.md.md"],
    ["no suffix", "brand-voice"],
    ["a temporary file", ".brand-voice.md.tmp-1234"]
  ])("passes over %s", (_label, filename) => {
    publish(filename as string, skillText("brand-voice"));

    expect(shared.list()).toEqual([]);
  });

  it("passes over a subdirectory", () => {
    mkdirSync(join(root, "marketing.md"));

    expect(shared.list()).toEqual([]);
  });
});

describe("fingerprints", () => {
  it("carries the three fields an index diffs on", () => {
    publish("brand-voice.md", skillText("brand-voice"));
    const stat = statSync(join(root, "brand-voice.md"));

    expect(shared.fingerprints()).toEqual([
      { name: "brand-voice", mtimeMs: stat.mtimeMs, size: stat.size, ino: Number(stat.ino) }
    ]);
  });

  it("covers the listing and nothing else", () => {
    publish("brand-voice.md", skillText("brand-voice"));
    publish("Brand-Voice.md", skillText("brand-voice"));

    expect(shared.fingerprints().map(file => file.name)).toEqual(["brand-voice"]);
  });
});

describe("reading", () => {
  it("answers the file as it is on disk", () => {
    publish("brand-voice.md", skillText("brand-voice", {}, "Say it plainly.\nNo exclamation marks.\n"));

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

  // The operator's word, read like any other field. What is absent is anything
  // that would write one: a shared skill has no lifecycle here.
  it("carries a status the operator set", () => {
    publish("brand-voice.md", skillText("brand-voice", { status: "stale" }));

    expect(shared.read("brand-voice")?.frontmatter.status).toBe("stale");
  });

  it("re-reads the file rather than caching it", () => {
    publish("brand-voice.md", skillText("brand-voice"));
    expect(shared.read("brand-voice")?.frontmatter.description).toBe("How this company writes.");

    publish("brand-voice.md", skillText("brand-voice", { description: "Revised upstream." }));

    expect(shared.read("brand-voice")?.frontmatter.description).toBe("Revised upstream.");
  });

  // `SkillFiles.read`'s three nulls, and a fourth for a name that could never be
  // a filename. A caller does the same thing in all four.
  each([
    ["there is no such file", () => {}, "brand-voice"],
    [
      "the file does not parse",
      () => publish("brand-voice.md", "no frontmatter at all\n"),
      "brand-voice"
    ],
    [
      "the frontmatter names something else",
      () => publish("brand-voice.md", skillText("house-style")),
      "brand-voice"
    ],
    ["the name could not be a filename", () => {}, "../../etc/passwd"]
  ])("answers null when %s", (_label, arrange, name) => {
    (arrange as () => void)();

    expect(shared.read(name as string)).toBeNull();
  });

  // The address is the index's key and never a filename — `sharedSkillRef`'s
  // header in the schema package is explicit about it, and this is what that
  // means here.
  it("takes the bare name and not the qualified address", () => {
    publish("brand-voice.md", skillText("brand-voice"));

    expect(shared.read("shared/brand-voice")).toBeNull();
    expect(shared.read("brand-voice")).not.toBeNull();
  });
});
