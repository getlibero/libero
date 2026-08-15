import { describe, expect, it } from "vitest";
import {
  SKILL_BODY_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_PATTERN,
  SkillCreated,
  SkillFrontmatter,
  SkillName,
  SkillStatus,
  parseSkillFile,
  serializeSkillFile
} from "./skill.js";
import type { SkillFile } from "./skill.js";

const codes = (result: {
  success: boolean;
  error?: { issues: readonly { path: PropertyKey[]; code: string }[] };
}) => result.error?.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`) ?? null;

const FRONTMATTER = {
  name: "rotate-a-channel-certificate",
  description: "Two pins live across the overlap, so neither service restarts.",
  created: "2026-08-15",
  status: "active"
} as const;

const skill = (over: Partial<Record<string, unknown>> = {}) => ({ ...FRONTMATTER, ...over });

const file = (frontmatter: string[], body: string) =>
  ["---", ...frontmatter, "---", "", body, ""].join("\n");

const VALID_FILE = file(
  [
    `name: ${FRONTMATTER.name}`,
    `description: ${FRONTMATTER.description}`,
    `created: ${FRONTMATTER.created}`,
    `status: ${FRONTMATTER.status}`
  ],
  "1. `scripts/dev-certs.sh --rotate <channel>`\n2. Add the staged fingerprint to the sheet."
);

describe("a skill's name", () => {
  it.each([
    ["one word", "deploy"],
    ["several words", "rotate-a-channel-certificate"],
    ["digits", "postgres-15-upgrade"],
    ["a name that is all digits", "2026"],
    ["64 characters", "a".repeat(64)]
  ])("accepts %s", (_label, name) => {
    expect(SkillName.safeParse(name).success).toBe(true);
  });

  // The name becomes a path segment and an index key, so each of these would
  // either climb out of `skills/`, collide with a sibling, or arrive as two
  // spellings of one skill.
  it.each([
    ["a parent traversal", ".."],
    ["a separator", "deploy/runbook"],
    ["a backslash", "deploy\\runbook"],
    ["a leading dot", ".hidden"],
    ["an extension", "deploy.md"],
    ["a dot anywhere", "deploy.runbook"],
    ["an underscore", "deploy_runbook"],
    ["a space", "deploy runbook"],
    ["a capital", "Deploy"],
    ["a leading dash", "-deploy"],
    ["a trailing dash", "deploy-"],
    ["a doubled dash", "deploy--runbook"],
    ["empty", ""],
    ["65 characters", "a".repeat(65)],
    ["a tilde", "deploy~1"],
    ["a null byte", "deploy\0runbook"]
  ])("refuses %s", (_label, name) => {
    expect(SkillName.safeParse(name).success).toBe(false);
  });

  // Nothing folds a name on the way in, so the pattern is the whole boundary: a
  // name that parses is already the filename stem. If this ever stops being
  // true, the storage layer needs a normalized form and a collision check, and
  // the argument on `SKILL_NAME_PATTERN` needs rewriting rather than extending.
  it("admits only names that are already canonical", () => {
    for (const name of ["deploy", "rotate-a-channel-certificate", "postgres-15-upgrade"]) {
      expect(name.toLowerCase()).toBe(name);
      expect(SKILL_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  // The rule the whole design leans on, stated as a test because it is easy to
  // lose by widening the alphabet. Two names that differ only in case would be
  // one file on a case-insensitive filesystem and two on ext4.
  it("cannot express two spellings of one name", () => {
    expect(SkillName.safeParse("Deploy").success).toBe(false);
    expect(SkillName.safeParse("deploy_runbook").success).toBe(false);
    expect(SkillName.safeParse("deploy").success).toBe(true);
  });
});

describe("a skill's created date", () => {
  it("accepts a UTC calendar date", () => {
    expect(SkillCreated.safeParse("2026-08-15").success).toBe(true);
  });

  it("accepts a leap day that exists", () => {
    expect(SkillCreated.safeParse("2028-02-29").success).toBe(true);
  });

  // The three ways `Date.parse` is lenient, each refused. Without the round-trip
  // the first two of these become other dates rather than errors.
  it.each([
    ["a date that rolls over", "2026-02-30"],
    ["a leap day that does not exist", "2027-02-29"],
    ["a thirteenth month", "2026-13-01"],
    ["a day zero", "2026-08-00"],
    ["an American ordering", "08/15/2026"],
    ["a prose date", "Aug 15 2026"],
    ["an instant", "2026-08-15T12:00:00Z"],
    ["a zoneless instant", "2026-08-15T12:00:00"],
    ["a year alone", "2026"],
    ["unpadded", "2026-8-15"],
    ["empty", ""]
  ])("refuses %s", (_label, value) => {
    expect(SkillCreated.safeParse(value).success).toBe(false);
  });

  // A date whose shape is already wrong should not also be reported as a date
  // that does not exist: one mistake, one issue.
  it("reports a malformed date once", () => {
    expect(codes(SkillCreated.safeParse("08/15/2026"))).toEqual([": invalid_format"]);
  });
});

describe("a skill's status", () => {
  it("is exactly the three the lifecycle moves between", () => {
    expect([...SkillStatus.options]).toEqual(["active", "stale", "archived"]);
  });

  it.each([["pinned"], ["deprecated"], ["ACTIVE"], [""]])("refuses %s", value => {
    expect(SkillStatus.safeParse(value).success).toBe(false);
  });
});

describe("a skill's frontmatter", () => {
  it("parses what a skill file carries", () => {
    expect(SkillFrontmatter.safeParse(skill()).success).toBe(true);
  });

  // A skill somebody wrote by hand must join the library without their having
  // to know the status vocabulary.
  it("defaults an absent status to active", () => {
    const parsed = SkillFrontmatter.safeParse({
      name: FRONTMATTER.name,
      description: FRONTMATTER.description,
      created: FRONTMATTER.created
    });
    expect(parsed.success && parsed.data.status).toBe("active");
  });

  it.each([["name"], ["description"], ["created"]])("requires %s", field => {
    const without: Record<string, unknown> = skill();
    delete without[field];
    expect(codes(SkillFrontmatter.safeParse(without))).toEqual([`${field}: invalid_type`]);
  });

  it("refuses an empty description", () => {
    expect(codes(SkillFrontmatter.safeParse(skill({ description: "" })))).toEqual([
      "description: too_small"
    ]);
  });

  it("accepts a description at the cap", () => {
    expect(
      SkillFrontmatter.safeParse(skill({ description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS) }))
        .success
    ).toBe(true);
  });

  it("refuses a description one past the cap", () => {
    expect(
      codes(
        SkillFrontmatter.safeParse(
          skill({ description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) })
        )
      )
    ).toEqual(["description: too_big"]);
  });

  // **Not `.strict()`, and this is the case that decides it.** The architecture
  // page documented `uses` as a frontmatter key, so files written against it
  // exist; refusing them would drop a team's own skill out of the library over a
  // line nothing needs. The key is ignored, not honoured — where a use count
  // lives is the index's business.
  it("ignores an unknown key rather than refusing the file", () => {
    const parsed = SkillFrontmatter.safeParse(skill({ uses: "14", owner: "platform" }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(FRONTMATTER);
  });
});

describe("parsing a skill file", () => {
  it("reads the frontmatter and the body", () => {
    const parsed = parseSkillFile(VALID_FILE);
    expect(parsed.ok && parsed.skill.frontmatter).toEqual(FRONTMATTER);
    expect(parsed.ok && parsed.skill.body).toContain("dev-certs.sh --rotate");
  });

  it("reads a file a person wrote without a status", () => {
    const parsed = parseSkillFile(
      file(
        [
          `name: ${FRONTMATTER.name}`,
          `description: ${FRONTMATTER.description}`,
          `created: ${FRONTMATTER.created}`
        ],
        "Do the thing."
      )
    );
    expect(parsed.ok && parsed.skill.frontmatter.status).toBe("active");
  });

  // A value is the rest of its line, so the first colon is the separator and
  // every later one is content. A description saying "rotation: two pins" is
  // ordinary.
  it("splits on the first colon only", () => {
    const parsed = parseSkillFile(
      file(
        [
          `name: ${FRONTMATTER.name}`,
          "description: rotation: two pins live across the overlap",
          `created: ${FRONTMATTER.created}`
        ],
        "Do the thing."
      )
    );
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe(
      "rotation: two pins live across the overlap"
    );
  });

  it("reads a file edited on Windows", () => {
    const parsed = parseSkillFile(VALID_FILE.replaceAll("\n", "\r\n"));
    expect(parsed.ok && parsed.skill.frontmatter).toEqual(FRONTMATTER);
    // The carriage return must not survive into a name, a date, or the index.
    expect(parsed.ok && parsed.skill.body).not.toContain("\r");
  });

  it.each([
    ["text with no fence at all", "just some markdown\n"],
    ["a fence that never closes", "---\nname: deploy\n"],
    ["prose before the fence", "hello\n---\nname: deploy\n---\n\nbody\n"],
    ["an empty file", ""]
  ])("refuses %s", (_label, text) => {
    const parsed = parseSkillFile(text);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toBe("no_frontmatter");
  });

  it("refuses a line inside the fences that is not a field, naming the line", () => {
    const parsed = parseSkillFile(
      file([`name: ${FRONTMATTER.name}`, "this is not a field", `created: ${FRONTMATTER.created}`], "b")
    );
    expect(!parsed.ok && parsed.reason).toBe("malformed_line");
    expect(!parsed.ok && parsed.reason === "malformed_line" && parsed.line).toBe(3);
  });

  // Silently taking the last is how a status a human set gets dropped by a
  // parser rather than by anybody's decision.
  it("refuses a key given twice, naming the line", () => {
    const parsed = parseSkillFile(
      file(
        [
          `name: ${FRONTMATTER.name}`,
          `description: ${FRONTMATTER.description}`,
          `created: ${FRONTMATTER.created}`,
          "status: active",
          "status: archived"
        ],
        "b"
      )
    );
    expect(!parsed.ok && parsed.reason).toBe("duplicate_key");
    expect(!parsed.ok && parsed.reason === "duplicate_key" && parsed.line).toBe(6);
  });

  it("refuses a skill with no body", () => {
    const parsed = parseSkillFile(
      ["---", `name: ${FRONTMATTER.name}`, `description: ${FRONTMATTER.description}`, `created: ${FRONTMATTER.created}`, "---", "", "  ", ""].join("\n")
    );
    expect(!parsed.ok && parsed.reason).toBe("empty_body");
  });

  it("reports schema failures as paths and codes", () => {
    const parsed = parseSkillFile(
      file(["name: Deploy Runbook", "description: d", "created: 2026-02-30"], "b")
    );
    expect(!parsed.ok && parsed.reason).toBe("schema_invalid");
    expect(!parsed.ok && parsed.reason === "schema_invalid" && [...parsed.issues]).toEqual([
      { path: "name", code: "invalid_format" },
      { path: "created", code: "custom" }
    ]);
  });

  // The failure side is read by whatever logs it, and this file was written by a
  // model. Nothing it chose may travel in a reason.
  it("puts no file content in a failure", () => {
    const secret = "correct-horse-battery-staple";
    const parsed = parseSkillFile(file([`name: ${secret}!!`, "description: d"], "b"));
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  // A body longer than one operation is a body a person wrote, and the team's
  // own writing is not bounded by the model's budget. What to do with one is the
  // indexer's call.
  it("does not bound the body", () => {
    const parsed = parseSkillFile(
      file(
        [
          `name: ${FRONTMATTER.name}`,
          `description: ${FRONTMATTER.description}`,
          `created: ${FRONTMATTER.created}`
        ],
        "x".repeat(SKILL_BODY_MAX_CHARS * 4)
      )
    );
    expect(parsed.ok).toBe(true);
  });

  it("never throws", () => {
    for (const text of ["---", "---\n---", "\0", "---\n:\n---\n\nb\n", "---\n---\n---\n"]) {
      expect(() => parseSkillFile(text)).not.toThrow();
    }
  });
});

describe("serializing a skill file", () => {
  const parsed = parseSkillFile(VALID_FILE);
  const value: SkillFile = parsed.ok
    ? parsed.skill
    : (() => {
        throw new Error("fixture does not parse");
      })();

  // Two spellings of one format, held together here rather than trusted. Without
  // this the storage layer writes these files by concatenation and the parser is
  // the only thing that knows the grammar.
  it("round-trips a skill unchanged", () => {
    const text = serializeSkillFile(value);
    const again = parseSkillFile(text);
    expect(again.ok && again.skill).toEqual(value);
  });

  // A fixed point, not merely reversible: the lifecycle job rewrites these files
  // to change a status, and a serializer that grew a blank line each time would
  // put a whitespace diff in the team's history on every run.
  it("is stable under repeated rewriting", () => {
    const once = serializeSkillFile(value);
    const twice = serializeSkillFile(
      (() => {
        const p = parseSkillFile(once);
        if (!p.ok) throw new Error("did not parse");
        return p.skill;
      })()
    );
    expect(twice).toBe(once);
  });

  // Fixed, so a status change is a one-line diff rather than a reordered header.
  it("writes the fields in one order", () => {
    expect(serializeSkillFile(value).split("\n").slice(0, 6)).toEqual([
      "---",
      `name: ${FRONTMATTER.name}`,
      `description: ${FRONTMATTER.description}`,
      `created: ${FRONTMATTER.created}`,
      "status: active",
      "---"
    ]);
  });

  it("writes a status the parser defaulted, so the file says what it is", () => {
    const p = parseSkillFile(
      file(
        [
          `name: ${FRONTMATTER.name}`,
          `description: ${FRONTMATTER.description}`,
          `created: ${FRONTMATTER.created}`
        ],
        "Do the thing."
      )
    );
    expect(p.ok && serializeSkillFile(p.skill)).toContain("status: active");
  });

  it("ends with exactly one newline", () => {
    const text = serializeSkillFile(value);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});
