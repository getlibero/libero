import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { parseSkillFile } from "@getlibero/schema";
import { explainSkillFailure, insertProvenance } from "./skill-frontmatter.js";
import type { SkillFileFailure } from "./skill-frontmatter.js";

const SHA = "34040c9c568585f6929bedeaad110ad08f079624";
const PROVENANCE = { source: "anthropics/skills/skills/pdf", ref: "v1.2.0", sha: SHA };

/** The shape `anthropics/skills` files have: a plain scalar and an unknown key. */
function upstream(extra = ""): string {
  return `---\nname: pdf\ndescription: Anything to do with PDF files.\nlicense: Example-Proprietary. LICENSE.txt has complete terms\n${extra}---\n\n# Working with PDFs\n`;
}

/** What a failure to parse looks like, for the explainer's table. */
function failureOf(text: string): SkillFileFailure {
  const parsed = parseSkillFile(text, { shared: true });
  if (parsed.ok) throw new Error("expected this fixture not to parse");
  return parsed;
}

describe("insertProvenance", () => {
  it("adds a metadata block when the file has none", () => {
    const written = insertProvenance(upstream(), PROVENANCE);

    expect(written).toContain("metadata:\n  libero-source: anthropics/skills/skills/pdf\n");
    expect(written).toContain(`  libero-sha: ${SHA}\n`);
  });

  // #569's "adding three lines to the frontmatter is the whole edit", which is
  // what keeps a `diff` against upstream readable.
  it("changes nothing else about the file", () => {
    const before = upstream().split("\n");
    const after = insertProvenance(upstream(), PROVENANCE).split("\n");

    expect(after.filter(line => !line.startsWith("  libero-") && line !== "metadata:")).toEqual(before);
  });

  it("joins a metadata block the file already has, at its own indent", () => {
    const written = insertProvenance(upstream("metadata:\n    author: example-org\n"), PROVENANCE);

    expect(written).toContain("    author: example-org\n    libero-source:");
    expect(written).not.toContain("  libero-source:\n");
  });

  it("rewrites its own keys rather than appending a second set", () => {
    const once = insertProvenance(upstream(), PROVENANCE);
    const twice = insertProvenance(once, { ...PROVENANCE, ref: "v2.0.0" });

    expect(twice.match(/libero-sha:/g)).toHaveLength(1);
    expect(twice).toContain("libero-ref: v2.0.0");
    expect(twice).not.toContain("libero-ref: v1.2.0");
  });

  // The metadata block is anchored wherever it is, so a key after it stays
  // after it and the provenance still lands inside.
  it("keeps the provenance inside the block when other keys follow it", () => {
    const written = insertProvenance(upstream("metadata:\n  author: example-org\nstatus: active\n"), PROVENANCE);
    const parsed = parseSkillFile(written, { shared: true });

    expect(parsed.ok && parsed.skill.frontmatter.metadata?.["libero-sha"]).toBe(SHA);
    expect(parsed.ok && parsed.skill.frontmatter.status).toBe("active");
  });

  it("keeps allowed-tools in the bytes, which the runtime then ignores", () => {
    const written = insertProvenance(upstream("allowed-tools: Read Write\n"), PROVENANCE);

    expect(written).toContain("allowed-tools: Read Write");
  });

  it("keeps a file's CRLF line endings", () => {
    const written = insertProvenance(upstream().replace(/\n/g, "\r\n"), PROVENANCE);

    expect(written).toContain("\r\nmetadata:\r\n");
    expect(written).not.toMatch(/[^\r]\n/);
  });

  it("produces a file the schema reads back", () => {
    const parsed = parseSkillFile(insertProvenance(upstream(), PROVENANCE), { shared: true });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.skill.frontmatter.metadata).toEqual({
      "libero-source": "anthropics/skills/skills/pdf",
      "libero-ref": "v1.2.0",
      "libero-sha": SHA
    });
  });

  // The grammar reads `metadata` as a map or as nothing, so there is nowhere to
  // record provenance without rewriting a line upstream wrote.
  it("refuses a metadata key that carries a value of its own", () => {
    expect(() => insertProvenance(upstream("metadata: v2\n"), PROVENANCE)).toThrow(/nowhere to\s+record/);
  });
});

describe("explainSkillFailure", () => {
  each([
    [
      "a folded description, which three of anthropics/skills use",
      "---\nname: a\ndescription: >\n  one\n  two\n---\n\nbody\n",
      /YAML folded scalar continued on line 4/
    ],
    [
      "a literal description",
      "---\nname: a\ndescription: |-\n  one\n---\n\nbody\n",
      /YAML literal scalar continued on line 4/
    ],
    ["a comment inside the fence", "---\n# who\nname: a\ndescription: d\n---\n\nbody\n", /# comment on line 2/],
    [
      "a YAML list under a bare key",
      "---\nname: a\ndescription: d\nallowed-tools:\n  - Read\n---\n\nbody\n",
      /YAML list on line 5/
    ],
    ["a key given twice", "---\nname: a\ndescription: d\nname: b\n---\n\nbody\n", /names name twice/],
    ["no frontmatter at all", "# just a heading\n", /no --- fenced frontmatter/],
    ["a fence that never closes", "---\nname: a\ndescription: d\n", /never closes/],
    ["frontmatter and no body", "---\nname: a\ndescription: d\n---\n", /no body/],
    [
      "an over-long description, with the count",
      `---\nname: a\ndescription: ${"x".repeat(600)}\n---\n\nbody\n`,
      /600-character description, and the cap is 512/
    ]
  ])("names %s", (_name, text, pattern) => {
    const explained = explainSkillFailure(text as string, failureOf(text as string), "x/SKILL.md").join(" ");

    expect(explained).toMatch(pattern as RegExp);
  });

  it("says a truncated description would be a different skill", () => {
    const text = `---\nname: a\ndescription: ${"x".repeat(600)}\n---\n\nbody\n`;

    expect(explainSkillFailure(text, failureOf(text), "x").join(" ")).toMatch(/refuses rather than cutting/);
  });
});
