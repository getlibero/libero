import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  SKILL_BODY_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_PATTERN,
  SHARED_SKILL_DESCRIPTION_MAX_CHARS,
  ChannelSkillFrontmatter,
  SkillCreated,
  SkillFrontmatter,
  SHARED_SKILL_NAMESPACE,
  SkillName,
  SkillStatus,
  parseSkillFile,
  readSkillScalar,
  serializeSkillFile,
  sharedSkillRef
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
  each([
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
  each([
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
  each([
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

  each([["pinned"], ["deprecated"], ["ACTIVE"], [""]])("refuses %s", value => {
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

  each([["name"], ["description"]])("requires %s", field => {
    const without: Record<string, unknown> = skill();
    delete without[field];
    expect(codes(SkillFrontmatter.safeParse(without))).toEqual([`${field}: invalid_type`]);
  });

  // #567 split what used to be one shape. The spec does not define `created`, so
  // a vendored shared skill has not got one and nothing decides anything by it;
  // a channel's own skill is stamped on create, so a file without one there is
  // damaged.
  it("does not require created", () => {
    const without: Record<string, unknown> = skill();
    delete without["created"];
    expect(SkillFrontmatter.safeParse(without).success).toBe(true);
  });

  it("requires created of a channel's own skill", () => {
    const without: Record<string, unknown> = skill();
    delete without["created"];
    expect(codes(ChannelSkillFrontmatter.safeParse(without))).toEqual(["created: invalid_type"]);
  });

  it("still refuses a created that is not a date, on both", () => {
    expect(codes(SkillFrontmatter.safeParse(skill({ created: "2026-02-30" })))).toEqual([
      "created: custom"
    ]);
    expect(codes(ChannelSkillFrontmatter.safeParse(skill({ created: "2026-02-30" })))).toEqual([
      "created: custom"
    ]);
  });

  it("refuses an empty description", () => {
    expect(codes(SkillFrontmatter.safeParse(skill({ description: "" })))).toEqual([
      "description: too_small"
    ]);
  });

  // Two figures since #580: the spec's on a file an operator published, the
  // model's on a channel's own skill.
  it("accepts a shared skill's description at the spec's cap", () => {
    expect(
      SkillFrontmatter.safeParse(
        skill({ description: "d".repeat(SHARED_SKILL_DESCRIPTION_MAX_CHARS) })
      ).success
    ).toBe(true);
  });

  it("refuses a shared skill's description one past it", () => {
    expect(
      codes(
        SkillFrontmatter.safeParse(
          skill({ description: "d".repeat(SHARED_SKILL_DESCRIPTION_MAX_CHARS + 1) })
        )
      )
    ).toEqual(["description: too_big"]);
  });

  it("accepts a channel skill's description at the model's cap", () => {
    expect(
      ChannelSkillFrontmatter.safeParse(
        skill({ description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS) })
      ).success
    ).toBe(true);
  });

  it("refuses a channel skill's description one past it", () => {
    expect(
      codes(
        ChannelSkillFrontmatter.safeParse(
          skill({ description: "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) })
        )
      )
    ).toEqual(["description: too_big"]);
  });

  it("keeps the spec's figure above the model's", () => {
    expect(SHARED_SKILL_DESCRIPTION_MAX_CHARS).toBeGreaterThan(SKILL_DESCRIPTION_MAX_CHARS);
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

  each([
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

// What #567 widened the grammar for: a `SKILL.md` written against the Agent
// Skills spec, read as it is. Each case below is a line from a real spec file
// that the parser refused, or kept nothing of, before that.
describe("reading a spec SKILL.md", () => {
  const SPEC_FILE = file(
    [
      `name: ${FRONTMATTER.name}`,
      `description: "Two pins live across the overlap."`,
      "license: Apache-2.0",
      "allowed-tools: Bash, Read",
      "compatibility: >=1.0",
      "metadata:",
      "  author: example-org",
      "  version: '2.1'"
    ],
    "Do the thing."
  );

  // The spec's designated place for client keys, and the one thing a parser
  // anchored at column 0 could not read at all.
  it("reads an indented map under a bare key", () => {
    const parsed = parseSkillFile(SPEC_FILE, { shared: true });
    expect(parsed.ok && parsed.skill.frontmatter.metadata).toEqual({
      author: "example-org",
      version: "2.1"
    });
  });

  // Unstripped, the quotes reach the embedding, the full-text index and every
  // line a person reads.
  it("strips one matching pair of quotes from a scalar", () => {
    const parsed = parseSkillFile(SPEC_FILE, { shared: true });
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe(
      "Two pins live across the overlap."
    );
  });

  each([
    ['"a: b"', "a: b"],
    ["'single'", "single"],
    ['"unbalanced', '"unbalanced'],
    ['say "this"', 'say "this"'],
    ['""', ""]
  ])("reads %s as the value it means", (written, meant) => {
    const parsed = parseSkillFile(
      file([`name: n`, `description: ${written}`, "created: 2026-09-07"], "b")
    );
    // An empty description is refused by the shape, which is the right answer
    // for `""` and is not what this case is about.
    if (meant === "") {
      expect(!parsed.ok && parsed.reason).toBe("schema_invalid");
      return;
    }
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe(meant);
  });

  // The sheet is the allowlist. A second, inert statement of permission in the
  // file is worse than none, because it looks exactly like the one that binds.
  it("reads allowed-tools and keeps nothing of it", () => {
    const parsed = parseSkillFile(SPEC_FILE, { shared: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && serializeSkillFile(parsed.skill)).not.toContain("allowed-tools");
  });

  // A vendored file has no `created`, because the spec does not define one and
  // nothing here decides anything by it.
  it("accepts a missing created where the caller says the file is shared", () => {
    expect(parseSkillFile(SPEC_FILE, { shared: true }).ok).toBe(true);
  });

  it("still requires one of a channel's own skill", () => {
    const parsed = parseSkillFile(SPEC_FILE);
    expect(!parsed.ok && parsed.reason).toBe("schema_invalid");
    expect(!parsed.ok && parsed.reason === "schema_invalid" && [...parsed.issues]).toEqual([
      { path: "created", code: "invalid_type" }
    ]);
  });

  it("defaults to a channel skill, so every existing caller is unchanged", () => {
    expect(parseSkillFile(SPEC_FILE).ok).toBe(false);
    expect(parseSkillFile(SPEC_FILE, {}).ok).toBe(false);
  });

  // Writing `license:` back with its value dropped would be writing back
  // something the file did not say.
  it("drops a map under any other key, the bare key with it", () => {
    const parsed = parseSkillFile(
      file(
        [
          "name: n",
          "description: d",
          "created: 2026-09-07",
          "compatibility:",
          "  runtime: node"
        ],
        "b"
      )
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && serializeSkillFile(parsed.skill)).not.toContain("compatibility");
  });

  it("refuses an indented line that hangs from nothing", () => {
    const parsed = parseSkillFile(
      file(["name: n", "description: d", "created: 2026-09-07", "  author: nobody"], "b")
    );
    expect(!parsed.ok && parsed.reason).toBe("malformed_line");
    expect(!parsed.ok && parsed.reason === "malformed_line" && parsed.line).toBe(5);
  });

  it("refuses an indented line that is not a pair", () => {
    const parsed = parseSkillFile(
      file(["name: n", "description: d", "created: 2026-09-07", "metadata:", "  a b c"], "b")
    );
    expect(!parsed.ok && parsed.reason).toBe("malformed_line");
    expect(!parsed.ok && parsed.reason === "malformed_line" && parsed.line).toBe(6);
  });

  it("refuses a map key given twice, for the same reason a scalar is", () => {
    const parsed = parseSkillFile(
      file(
        ["name: n", "description: d", "created: 2026-09-07", "metadata:", "  a: 1", "  a: 2"],
        "b"
      )
    );
    expect(!parsed.ok && parsed.reason).toBe("duplicate_key");
    expect(!parsed.ok && parsed.reason === "duplicate_key" && parsed.line).toBe(7);
  });

  it("reads a metadata block a blank line was left inside", () => {
    const parsed = parseSkillFile(
      file(
        ["name: n", "description: d", "created: 2026-09-07", "metadata:", "", "  a: 1"],
        "b"
      )
    );
    expect(parsed.ok && parsed.skill.frontmatter.metadata).toEqual({ a: "1" });
  });

  // A key with nothing under it said nothing, rather than saying an empty map.
  it("carries no metadata for a bare metadata key", () => {
    const parsed = parseSkillFile(
      file(["name: n", "description: d", "created: 2026-09-07", "metadata:"], "b")
    );
    expect(parsed.ok && parsed.skill.frontmatter.metadata).toBeUndefined();
    expect(parsed.ok && serializeSkillFile(parsed.skill)).not.toContain("metadata");
  });
});

// #580. The six files in anthropics/skills (at dbd4588f9e1033efb41dad4bef2f7947c8993d44)
// that this grammar refused, by the shape each was refused for. The text is this
// file's own rather than copied — those files declare their own licence terms,
// and what is being tested is the shape: the quoting, the length, the indicator
// and the indent.
describe("reading the spec SKILL.md files the grammar used to refuse", () => {
  const prose = (length: number) => {
    const words = "use this skill whenever the request names the format or a file of it ";
    return words.repeat(Math.ceil(length / words.length)).slice(0, length).trim();
  };

  // Wrapped the way those files wrap a long description: one sentence per
  // indented line, at about seventy-five columns.
  const wrapped = (length: number, indent = "  ") => {
    const lines: string[] = [];
    let line = "";
    for (const word of prose(length).split(" ")) {
      if (line !== "" && line.length + word.length + 1 > 75) {
        lines.push(indent + line);
        line = word;
      } else {
        line = line === "" ? word : `${line} ${word}`;
      }
    }
    lines.push(indent + line);
    return lines;
  };

  const LICENSE = "license: Complete terms in LICENSE.txt";

  each([
    ["a quoted 837-character description, docx's shape", 837],
    ["a plain 740-character one, pptx's shape", 740],
    ["a quoted 950-character one, xlsx's shape", 950]
  ])("reads %s", (_shape, length) => {
    const description = prose(length as number);
    const parsed = parseSkillFile(
      file(["name: docx", `description: "${description}"`, LICENSE], "Body."),
      { shared: true }
    );
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe(description);
  });

  it("reads a strip literal description, claude-api's shape, keeping its breaks", () => {
    const parsed = parseSkillFile(
      file(
        [
          "name: claude-api",
          "description: |-",
          "  Reference for one API and its SDKs.",
          "  TRIGGER when the code imports it.",
          "  SKIP when the code uses another provider.",
          LICENSE
        ],
        "Body."
      ),
      { shared: true }
    );
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe(
      "Reference for one API and its SDKs.\nTRIGGER when the code imports it.\nSKIP when the code uses another provider."
    );
    expect(parsed.ok && parsed.skill.frontmatter.extra).toEqual([
      { key: "license", value: "Complete terms in LICENSE.txt" }
    ]);
  });

  each([
    ["a folded description, academy-guide's shape", "academy-guide", 960],
    ["another, discernment-nudge's shape", "discernment-nudge", 890]
  ])("reads %s, joined into one line", (_shape, name, length) => {
    const parsed = parseSkillFile(
      file([`name: ${name as string}`, "description: >", ...wrapped(length as number), LICENSE], "Body."),
      { shared: true }
    );
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe(prose(length as number));
  });

  // The figure that did not move. A model-written file at the same length is
  // still refused.
  it("still refuses the same description on a channel's own skill", () => {
    const parsed = parseSkillFile(
      file(["name: xlsx", `description: "${prose(950)}"`, "created: 2026-10-11"], "Body.")
    );
    expect(!parsed.ok && parsed.reason === "schema_invalid" && [...parsed.issues]).toEqual([
      { path: "description", code: "too_big" }
    ]);
  });
});

describe("a block scalar", () => {
  const parse = (frontmatter: string[]) =>
    parseSkillFile(file(["name: n", ...frontmatter, "created: 2026-10-11"], "b"));

  each([
    ["|", ["  one", "  two"], "one\ntwo"],
    ["|-", ["  one", "  two"], "one\ntwo"],
    [">", ["  one", "  two"], "one two"],
    [">-", ["  one", "  two"], "one two"],
    // A blank line inside a folded block is the one break folding keeps.
    [">", ["  one", "", "  two"], "one\ntwo"],
    // A more-indented line is kept on its own, its own indent with it.
    [">", ["  one", "    two", "  three"], "one\n  two\nthree"],
    ["|", ["    deeper", "    still"], "deeper\nstill"],
    ["|", ["  one", "    two"], "one\n  two"]
  ])("reads description: %s over %j as %j", (indicator, lines, meant) => {
    const parsed = parse([`description: ${indicator as string}`, ...(lines as readonly string[])]);
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe(meant);
  });

  // The reason this is not YAML, and it holds inside a block too.
  it("types nothing and strips no quotes", () => {
    expect(parse(["description: >", "  no"]).ok && parse(["description: >", "  no"])).toMatchObject({
      skill: { frontmatter: { description: "no" } }
    });
    const quoted = parse(["description: |", '  "quoted"']);
    expect(quoted.ok && quoted.skill.frontmatter.description).toBe('"quoted"');
  });

  it("reads one on a key the format does not define, and keeps it", () => {
    const parsed = parse(["description: d", "compatibility: >", "  any runtime", "  at all"]);
    expect(parsed.ok && parsed.skill.frontmatter.extra).toEqual([
      { key: "compatibility", value: "any runtime at all" }
    ]);
  });

  // Widening only: before #580 this was the one-character value, and a file
  // that parsed then must parse the same now.
  it("reads an indicator with nothing under it as it always did", () => {
    const parsed = parse(["description: |"]);
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe("|");
  });

  it("refuses a line indented less than the block's first", () => {
    const parsed = parse(["description: |", "    one", "  two"]);
    expect(!parsed.ok && parsed.reason === "malformed_line" && parsed.line).toBe(5);
  });

  // Keep chomping contradicts the rule that a value is trimmed, so it is not
  // read — and refused rather than misread, as before.
  it("still refuses an indicator it does not read", () => {
    const parsed = parse(["description: |+", "  one"]);
    expect(!parsed.ok && parsed.reason).toBe("malformed_line");
  });

  it("ends at the fence, as every other reader of these files finds it", () => {
    const parsed = parseSkillFile("---\nname: n\ndescription: |\n  one\n---\n\nbody\n", { shared: true });
    expect(parsed.ok && parsed.skill.frontmatter.description).toBe("one");
    expect(parsed.ok && parsed.skill.body).toBe("body");
  });

  it("is what readSkillScalar reads, so a caller measures the value the parser does", () => {
    const text = file(["name: n", "description: >", "  one", "  two"], "b");
    expect(readSkillScalar(text, "description")).toBe("one two");
    expect(readSkillScalar(text, "status")).toBeNull();
    expect(readSkillScalar("no header", "name")).toBeNull();
  });

  // #580's acceptance: the lifecycle job's rewrite keeps the text.
  each([
    ["folded", ">", ["  one", "  two"]],
    ["literal", "|-", ["  one", "", "    two", "  three"]]
  ])("survives a status rewrite of a %s description with its text unchanged", (_kind, indicator, lines) => {
    const first = parse([`description: ${indicator as string}`, ...(lines as readonly string[])]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const rewritten = serializeSkillFile({
      ...first.skill,
      frontmatter: { ...first.skill.frontmatter, status: "stale" }
    });
    const second = parseSkillFile(rewritten);

    expect(second.ok && second.skill.frontmatter.description).toBe(first.skill.frontmatter.description);
    expect(second.ok && second.skill.frontmatter.status).toBe("stale");
    // And it is a fixed point from there on.
    expect(second.ok && serializeSkillFile(second.skill)).toBe(rewritten);
  });

  it("writes a one-line value on one line", () => {
    const parsed = parse(["description: >", "  one", "  two"]);
    expect(parsed.ok && serializeSkillFile(parsed.skill)).toContain("description: one two\n");
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

  // **A data-loss bug, fixed in #567 and pinned here.** `setStatus` rewrites a
  // channel skill through this function, so before this a `license:` line a team
  // hand-added was erased the first time the lifecycle clock moved the status.
  // The input carries every kind of key the format does not define; the expected
  // output is the whole file, so the order is the assertion too.
  it("preserves every key the format does not define, in one order", () => {
    const parsed = parseSkillFile(
      file(
        [
          `name: ${FRONTMATTER.name}`,
          `description: ${FRONTMATTER.description}`,
          "license: Apache-2.0",
          `created: ${FRONTMATTER.created}`,
          "compatibility: >=1.0",
          "uses: 14",
          "metadata:",
          "  author: example-org",
          "  version: 2.1",
          "status: active"
        ],
        "Do the thing."
      )
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && serializeSkillFile(parsed.skill)).toBe(
      [
        "---",
        `name: ${FRONTMATTER.name}`,
        `description: ${FRONTMATTER.description}`,
        `created: ${FRONTMATTER.created}`,
        "status: active",
        "license: Apache-2.0",
        "compatibility: >=1.0",
        "uses: 14",
        "metadata:",
        "  author: example-org",
        "  version: 2.1",
        "---",
        "",
        "Do the thing.",
        ""
      ].join("\n")
    );
  });

  // The status change itself still has to be a one-line diff, which is the whole
  // reason the unknown keys go after the four rather than where they were.
  it("changes one line when the lifecycle job moves a status", () => {
    const before = parseSkillFile(
      file(
        [
          "name: n",
          "description: d",
          "created: 2026-09-07",
          "license: Apache-2.0",
          "metadata:",
          "  author: example-org"
        ],
        "b"
      )
    );
    if (!before.ok) throw new Error("did not parse");
    const after = serializeSkillFile({
      ...before.skill,
      frontmatter: { ...before.skill.frontmatter, status: "archived" }
    });
    const was = serializeSkillFile(before.skill).split("\n");
    expect(after.split("\n").filter((line, index) => line !== was[index])).toEqual([
      "status: archived"
    ]);
  });

  // A shared skill has no `created`, and nothing in this tree writes one back —
  // so this is what keeps the round trip honest rather than a case that fires.
  it("writes no created line when the file had none", () => {
    const parsed = parseSkillFile(file(["name: n", "description: d"], "b"), { shared: true });
    expect(parsed.ok && serializeSkillFile(parsed.skill)).not.toContain("created");
    const again = parsed.ok ? parseSkillFile(serializeSkillFile(parsed.skill), { shared: true }) : null;
    expect(again?.ok && again.skill).toEqual(parsed.ok && parsed.skill);
  });

  // The parser cannot produce one; a hand-built `SkillFile` can, and the file it
  // would write has the key twice and does not parse.
  it("drops a defined key somebody put in extra", () => {
    const text = serializeSkillFile({
      frontmatter: {
        name: "n",
        description: "d",
        created: "2026-09-07",
        status: "active",
        extra: [
          { key: "status", value: "archived" },
          { key: "allowed-tools", value: "Bash" },
          { key: "license", value: "Apache-2.0" }
        ]
      },
      body: "b"
    });
    expect(text).toContain("license: Apache-2.0");
    expect(text).not.toContain("allowed-tools");
    expect(parseSkillFile(text).ok).toBe(true);
  });
});

// The namespace an operator-published skill is addressed under, and the mechanism
// that reserves it. `builtin.test.ts` is the shape: it asserts that
// `BUILTIN_SERVER` parses as a `ResourceName` rather than assuming it, because the
// two definitions are in different files and only a test keeps them in step. This
// is the same relationship inverted — the claim is that the qualified form can
// *never* parse as a name — and it is the whole reservation, so it is asserted
// rather than trusted.
describe("an operator-published skill's name", () => {
  it("addresses a shared skill under the reserved namespace", () => {
    expect(sharedSkillRef("brand-voice")).toBe("shared/brand-voice");
    expect(SHARED_SKILL_NAMESPACE).toBe("shared");
  });

  each([["a"], ["brand-voice"], ["x".repeat(64)]])(
    "produces a name no channel skill could ever have: %s",
    name => {
      expect(SkillName.safeParse(name).success).toBe(true);
      expect(SkillName.safeParse(sharedSkillRef(name)).success).toBe(false);
    }
  );

  // The separator is what does the reserving, and it does it by being outside the
  // alphabet rather than by a check anybody has to remember. This case fails the
  // day somebody widens the pattern, which is the day the reservation stops
  // holding.
  it("reserves the namespace by an alphabet that admits no separator", () => {
    expect(SKILL_NAME_PATTERN.test("shared")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("shared/brand-voice")).toBe(false);
  });
});
