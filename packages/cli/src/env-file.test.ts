import { describe, expect, it } from "vitest";
import { assignedNames, mergeEnvFile, renderEnvFile } from "./env-file.js";
import type { EnvBlock } from "./env-file.js";

const BLOCKS: readonly EnvBlock[] = [
  { comment: ["The pair."], vars: [{ name: "A", value: "a" }, { name: "B", value: "" }] },
  { comment: ["The other."], vars: [{ name: "C", value: "c" }] }
];

describe("assignedNames", () => {
  it("records a name once, with whether its value is empty", () => {
    const found = assignedNames("A=1\nB=\nC=  \n");

    expect([...found]).toEqual([
      ["A", false],
      ["B", true],
      ["C", true]
    ]);
  });

  it("counts an empty quoted value as empty", () => {
    expect(assignedNames('A=""\nB=\'\'\n').get("A")).toBe(true);
    expect(assignedNames('A=""\nB=\'\'\n').get("B")).toBe(true);
  });

  it("counts an exported assignment", () => {
    expect(assignedNames("export A=1\n").get("A")).toBe(false);
  });

  it("ignores a commented assignment, so the name reads as absent", () => {
    expect(assignedNames("# A=1\n").has("A")).toBe(false);
  });

  it("keeps the first record when a name is assigned twice", () => {
    // Compose reads the last. This records the first, because that is the one
    // a fill would rewrite — and a duplicate is a reason not to append another.
    expect(assignedNames("A=\nA=2\n").get("A")).toBe(true);
  });
});

describe("renderEnvFile", () => {
  it("writes the header, then each block under its comment", () => {
    expect(renderEnvFile(["Header.", "", "More."], BLOCKS)).toBe(
      ["# Header.", "#", "# More.", "", "# The pair.", "A=a", "B=", "", "# The other.", "C=c", ""].join("\n")
    );
  });
});

describe("mergeEnvFile", () => {
  it("leaves a complete file byte-identical", () => {
    const existing = "A=1\nB=2\nC=3\n";
    const merged = mergeEnvFile(existing, BLOCKS);

    expect(merged.text).toBe(existing);
    expect(merged.appended).toEqual([]);
    expect(merged.filled).toEqual([]);
  });

  it("fills an empty assignment in place, keeping comments and order", () => {
    const merged = mergeEnvFile("# mine\nC=\nA=1\nB=\n", BLOCKS);

    expect(merged.text).toBe("# mine\nC=c\nA=1\nB=\n");
    expect(merged.filled).toEqual(["C"]);
    expect(merged.appended).toEqual([]);
  });

  it("never writes over a value that is there", () => {
    const merged = mergeEnvFile("A=already\nB=also\nC=set\n", BLOCKS);

    expect(merged.text).toContain("A=already");
    expect(merged.filled).toEqual([]);
  });

  it("appends what is absent under the comment that explains it", () => {
    const merged = mergeEnvFile("A=1\n", BLOCKS);

    expect(merged.text).toBe("A=1\n\n# The pair.\nB=\n\n# The other.\nC=c\n");
    expect(merged.appended).toEqual(["B", "C"]);
  });

  it("appends exactly once even when the file has no trailing newline", () => {
    const merged = mergeEnvFile("A=1", BLOCKS);

    expect([...merged.text.matchAll(/^C=/gm)]).toHaveLength(1);
    expect(merged.text.endsWith("\n")).toBe(true);
  });

  it("fills only the first of two empty assignments of one name", () => {
    const merged = mergeEnvFile("C=\nC=\nA=1\nB=2\n", BLOCKS);

    expect(merged.text).toBe("C=c\nC=\nA=1\nB=2\n");
    expect(merged.appended).toEqual([]);
  });

  it("keeps the export keyword when it fills", () => {
    const merged = mergeEnvFile("A=1\nB=2\nexport C=\n", BLOCKS);

    expect(merged.text).toBe("A=1\nB=2\nexport C=c\n");
  });
});
