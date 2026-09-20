import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { UsageError } from "./io.js";
import { parseSkillAddress } from "./skill-address.js";

describe("parseSkillAddress", () => {
  each([
    [
      "shorthand with a path",
      "anthropics/skills/skills/pdf@v1.2.0",
      { remote: "https://github.com/anthropics/skills.git", path: "skills/pdf", ref: "v1.2.0", name: "pdf" }
    ],
    [
      "shorthand at the repository root",
      "example/brand-voice@main",
      { remote: "https://github.com/example/brand-voice.git", path: "", ref: "main", name: "brand-voice" }
    ],
    [
      "a ref with a slash in it",
      "a/b/c@refs/tags/v1.2.0",
      { remote: "https://github.com/a/b.git", path: "c", ref: "refs/tags/v1.2.0", name: "c" }
    ],
    [
      "a 40-character commit",
      "a/b/c@34040c9c568585f6929bedeaad110ad08f079624",
      { remote: "https://github.com/a/b.git", path: "c", ref: "34040c9c568585f6929bedeaad110ad08f079624", name: "c" }
    ],
    [
      "an https URL with a sub-path",
      "https://git.example.com/team/skills.git/skills/pdf@v1",
      { remote: "https://git.example.com/team/skills.git", path: "skills/pdf", ref: "v1", name: "pdf" }
    ],
    [
      "an ssh URL with a sub-path — the two-@ case",
      "git@git.example.com:team/skills.git/skills/pdf@v1",
      { remote: "git@git.example.com:team/skills.git", path: "skills/pdf", ref: "v1", name: "pdf" }
    ],
    [
      "an ssh URL naming the repository alone",
      "git@git.example.com:team/brand-voice.git@v1",
      { remote: "git@git.example.com:team/brand-voice.git", path: "", ref: "v1", name: "brand-voice" }
    ],
    [
      "an ssh:// URL",
      "ssh://git@host/team/skills.git/pdf@v1",
      { remote: "ssh://git@host/team/skills.git", path: "pdf", ref: "v1", name: "pdf" }
    ],
    [
      "a file URL, which is what the suite's own fixtures use",
      "file:///tmp/fixture.git/skills/pdf@v1.0.0",
      { remote: "file:///tmp/fixture.git", path: "skills/pdf", ref: "v1.0.0", name: "pdf" }
    ],
    [
      "a URL with no .git, which is the whole repository by the documented rule",
      "https://host/team/skills@v1",
      { remote: "https://host/team/skills", path: "", ref: "v1", name: "skills" }
    ]
  ])("reads %s", (_name, spec, expected) => {
    expect(parseSkillAddress(spec as string)).toMatchObject(expected as Record<string, unknown>);
  });

  it("records the address without its ref as the provenance source", () => {
    expect(parseSkillAddress("anthropics/skills/skills/pdf@v1.2.0").source).toBe("anthropics/skills/skills/pdf");
  });

  it("takes --skill over the last path segment", () => {
    expect(parseSkillAddress("a/b/c@v1", "house-style").name).toBe("house-style");
  });

  // The trap's trap. `git@host:team/x.git`'s only `@` is the SSH user's, so a
  // last-`@` split would otherwise invent a repository called `git` with a ref
  // of `host:team/x.git`.
  it("does not read an SSH user as a ref", () => {
    expect(() => parseSkillAddress("git@git.example.com:team/skills.git")).toThrow(UsageError);
    expect(() => parseSkillAddress("git@git.example.com:team/skills.git")).toThrow(/no ref in/);
  });

  each([
    ["no ref at all", "anthropics/skills/skills/pdf", /no ref in/],
    ["an https URL with no ref", "https://host/team/skills.git", /no ref in/],
    ["one segment", "anthropics@v1", /not a skill address/],
    ["a leading dash", "-rf/x@v1", /not a skill address/],
    ["an empty address", "   ", /needs an address/],
    ["a ref that walks up", "a/b@v1/../v2", /no ref in/],
    ["a name the alphabet refuses", "a/b/SKILL.md@v1", /not a skill name/],
    ["an upper-case --skill", "a/b/c@v1", /not a skill name/]
  ])("refuses %s", (_name, spec, pattern) => {
    const skill = (spec as string) === "a/b/c@v1" ? "PDF_Tools" : undefined;
    expect(() => parseSkillAddress(spec as string, skill)).toThrow(pattern as RegExp);
  });

  // `SkillName`'s rule, which this command is one of the places that could
  // quietly break it.
  it("refuses a bad name rather than folding it", () => {
    expect(() => parseSkillAddress("a/b/c@v1", "Brand Voice")).toThrow(/refuses rather than folding/);
  });
});
