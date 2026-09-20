import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after as afterAll, before as beforeAll, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { parseSkillFile } from "@getlibero/schema";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./io.js";
import type { GitRun } from "./git.js";
import { runSkillCommand } from "./skill-cli.js";

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

function run(argv: string[], cwd: string): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runSkillCommand(
    { argv: ["skill", ...argv], cwd, out: line => void out.push(line), err: line => void err.push(line) },
    argv
  );
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/** A git that runs nothing, for the cases that must never reach one. */
function withRunner(argv: string[], cwd: string, reply: (args: readonly string[]) => Partial<GitRun> = () => ({})): {
  run: Run;
  calls: string[][];
} {
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = runSkillCommand(
    { argv: ["skill", ...argv], cwd, out: line => void out.push(line), err: line => void err.push(line) },
    argv,
    {
      run: args => {
        calls.push([...args]);
        return { code: 0, out: Buffer.alloc(0), err: "", ...reply(args) };
      }
    }
  );
  return { run: { code, out, err, text: [...out, ...err].join("\n") }, calls };
}

// ---------------------------------------------------------------------------
// The fixture repository.
//
// Real `git init`, real commits, real tags, reached over `file://` — so the
// whole git path runs (ls-remote, fetch, rev-parse, ls-tree, cat-file) with no
// network, and therefore never skips. The reporter fails a run that skipped
// anything `ALLOWED_SKIPS` does not account for, and "the internet was down" is
// not on that list.
//
// The SKILL.md fixtures reproduce the *shapes* found in `anthropics/skills` at
// 34040c9c568585f6929bedeaad110ad08f079624, written here rather than copied: a
// plain scalar with an unknown `license:` key beside it, a quoted description
// over the cap, a folded scalar this grammar has no reading of, a name that
// disagrees with its directory, and a symlinked sidecar. The text is this
// file's own — what is being tested is the shape.
// ---------------------------------------------------------------------------

let home = "";
let repo = "";
let work = "";

const IDENTITY = ["-c", "user.email=libero@example.com", "-c", "user.name=libero"];

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function put(path: string, content: string): void {
  const file = join(repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const PDF_SKILL = [
  "---",
  "name: pdf",
  "description: Everything this team does with PDF files, and when not to.",
  "license: Example-Proprietary. LICENSE.txt has complete terms",
  "---",
  "",
  "# Working with PDFs",
  "",
  "Read forms.md before filling one in.",
  ""
].join("\n");

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "libero-vendor-test-"));
  repo = join(home, "fixture.git");
  work = join(home, "deployment");
  mkdirSync(repo, { recursive: true });

  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", "--template=", repo], { stdio: "pipe" });

  put("skills/pdf/SKILL.md", PDF_SKILL);
  put("skills/pdf/forms.md", "# Forms\n");
  put("skills/pdf/LICENSE.txt", "Example-Proprietary.\n");
  put("skills/pdf/scripts/extract.py", "#!/usr/bin/env python3\nprint('hi')\n");
  chmodSync(join(repo, "skills/pdf/scripts/extract.py"), 0o755);

  put("skills/xlsx/SKILL.md", `---\nname: xlsx\ndescription: "${"x".repeat(950)}"\n---\n\n# XLSX\n`);
  put("skills/academy-guide/SKILL.md", "---\nname: academy-guide\ndescription: >\n  Stop and check this skill\n  before finishing any reply.\n---\n\n# Academy\n");
  put("skills/misnamed/SKILL.md", "---\nname: something-else\ndescription: A skill whose name disagrees with its directory.\n---\n\n# Misnamed\n");
  put("skills/linky/SKILL.md", "---\nname: linky\ndescription: A skill carrying a symlink beside it.\n---\n\n# Linky\n");
  symlinkSync("../pdf/forms.md", join(repo, "skills/linky/forms.md"));

  git("add", "-A");
  git(...IDENTITY, "commit", "--quiet", "-m", "first");
  git("tag", "v1.0.0");

  // A second commit that edits one file, deletes one and adds one — which is
  // what makes "a diff of exactly the changed files" checkable.
  put("skills/pdf/SKILL.md", PDF_SKILL.replace("# Working with PDFs", "# Working with PDFs, revised"));
  rmSync(join(repo, "skills/pdf/forms.md"));
  put("skills/pdf/tables.md", "# Tables\n");
  git("add", "-A");
  git(...IDENTITY, "commit", "--quiet", "-m", "second");
  git("tag", "v2.0.0");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
});

function address(path: string, ref: string): string {
  return `file://${repo}/${path}@${ref}`;
}

function vendored(name: string, file = "SKILL.md"): string {
  return readFileSync(join(work, "shared-skills", name, file), "utf8");
}

describe("libero skill", () => {
  it("prints its usage to stdout on --help", () => {
    const result = run(["--help"], work);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("\n")).toContain("usage: libero skill");
    expect(result.err).toEqual([]);
  });

  each([
    [["vendor"], /takes one address/],
    [["vendor", "a/b@v1", "c/d@v2"], /takes one address/],
    [["vendor", "a/b/c@v1", "--nope"], /unknown option/],
    [["publish", "a/b@v1"], /unknown skill command/],
    [[], /needs a command/]
  ])("refuses %s as a usage error", (argv, pattern) => {
    const { run: result, calls } = withRunner([...(argv as readonly string[])], work);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.text).toMatch(pattern as RegExp);
    expect(calls).toEqual([]);
  });
});

describe("libero skill vendor, before it reaches git", () => {
  // `channel add`'s rule: refuse before spending anything you would then have
  // to undo. Here that is a network fetch rather than key material.
  it("refuses a skill already published, without running git", () => {
    expect(run(["vendor", address("skills/pdf", "v1.0.0")], work).code).toBe(EXIT_OK);

    const { run: result, calls } = withRunner(["vendor", address("skills/pdf", "v2.0.0")], work);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.text).toMatch(/already holds a skill/);
    expect(calls).toEqual([]);
  });

  it("names what is published there and the command that updates it", () => {
    run(["vendor", address("skills/pdf", "v1.0.0")], work);

    const result = run(["vendor", address("skills/pdf", "v2.0.0")], work);

    expect(result.text).toContain("vendored from");
    expect(result.text).toMatch(/--force/);
  });

  it("refuses a bad address without running git", () => {
    const { run: result, calls } = withRunner(["vendor", "anthropics/skills/skills/pdf"], work);

    expect(result.code).toBe(EXIT_USAGE);
    expect(calls).toEqual([]);
  });

  it("says what is missing when git is not on PATH", () => {
    const { run: result } = withRunner(["vendor", "a/b/c@v1"], work, () => {
      const error = new Error("spawnSync git ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.text).toMatch(/spawnSync git ENOENT/);
  });

  it("does not fetch when the ref does not resolve", () => {
    const { run: result, calls } = withRunner(["vendor", "a/b/c@v9"], work, args =>
      args[0] === "ls-remote" ? { code: 0, out: Buffer.alloc(0) } : {}
    );

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.text).toMatch(/has no tag or branch named v9/);
    expect(calls.map(call => call[0]).filter(name => name === "fetch")).toEqual([]);
  });

  it("relays what git said when a remote cannot be read", () => {
    const { run: result } = withRunner(["vendor", "a/b/c@v1"], work, args =>
      args[0] === "ls-remote" ? { code: 128, err: "Permission denied (publickey)." } : {}
    );

    expect(result.text).toMatch(/Permission denied \(publickey\)/);
    expect(result.text).toMatch(/your git with your credentials/);
  });

  it("refuses a ref that names both a tag and a branch", () => {
    const listed = `aaaaaaaa\trefs/heads/dup\nbbbbbbbb\trefs/tags/dup\n`;
    const { run: result } = withRunner(["vendor", "a/b/c@dup"], work, args =>
      args[0] === "ls-remote" ? { code: 0, out: Buffer.from(listed) } : {}
    );

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.text).toMatch(/both a tag and a branch named dup/);
  });
});

describe("libero skill vendor, against a real repository", () => {
  it("copies the skill whole, at a tag", () => {
    const result = run(["vendor", address("skills/pdf", "v1.0.0")], work);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(join(work, "shared-skills/pdf/forms.md"))).toBe(true);
    expect(existsSync(join(work, "shared-skills/pdf/LICENSE.txt"))).toBe(true);
    expect(existsSync(join(work, "shared-skills/pdf/scripts/extract.py"))).toBe(true);
  });

  it("writes a SKILL.md the schema reads back, pinned to a commit", () => {
    run(["vendor", address("skills/pdf", "v1.0.0")], work);

    const parsed = parseSkillFile(vendored("pdf"), { shared: true });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.skill.frontmatter.metadata?.["libero-ref"]).toBe("v1.0.0");
    expect(parsed.ok && parsed.skill.frontmatter.metadata?.["libero-sha"]).toMatch(/^[0-9a-f]{40}$/);
  });

  // #570 mounts this directory into every sandbox container and runs what is in
  // `scripts/`, so the bit is not decoration. `writeFileSync`'s mode argument is
  // masked by the operator's umask, which is why it is set explicitly.
  it("keeps a script's executable bit, and does not spread it", () => {
    run(["vendor", address("skills/pdf", "v1.0.0")], work);

    expect(statSync(join(work, "shared-skills/pdf/scripts/extract.py")).mode & 0o111).not.toBe(0);
    expect(statSync(join(work, "shared-skills/pdf/forms.md")).mode & 0o111).toBe(0);
  });

  it("keeps a sidecar byte-identical to upstream", () => {
    run(["vendor", address("skills/pdf", "v1.0.0")], work);

    expect(vendored("pdf", "forms.md")).toBe("# Forms\n");
  });

  it("vendors at a branch and at a bare commit", () => {
    expect(run(["vendor", address("skills/pdf", "main")], work).code).toBe(EXIT_OK);

    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    rmSync(join(work, "shared-skills"), { recursive: true });

    const result = run(["vendor", address("skills/pdf", sha)], work);

    expect(result.code).toBe(EXIT_OK);
    expect(parseSkillFile(vendored("pdf"), { shared: true })).toMatchObject({ ok: true });
  });

  it("publishes under --skill, and under the last path segment otherwise", () => {
    run(["vendor", address("skills/misnamed", "v1.0.0"), "--skill", "something-else"], work);

    expect(existsSync(join(work, "shared-skills/something-else/SKILL.md"))).toBe(true);
  });

  it("writes into --shared-skills-root", () => {
    run(["vendor", address("skills/pdf", "v1.0.0"), "--shared-skills-root", "playbooks"], work);

    expect(existsSync(join(work, "playbooks/pdf/SKILL.md"))).toBe(true);
  });

  // #569's second acceptance criterion, made executable.
  it("re-vendors at a new ref as exactly the changed files plus two lines", () => {
    run(["vendor", address("skills/pdf", "v1.0.0")], work);
    const before = vendored("pdf").split("\n");

    const result = run(["vendor", address("skills/pdf", "v2.0.0"), "--force"], work);
    const after = vendored("pdf").split("\n");

    expect(result.code).toBe(EXIT_OK);
    // A file upstream deleted is gone, one it added is here: --force replaces
    // the directory rather than merging into it.
    expect(existsSync(join(work, "shared-skills/pdf/forms.md"))).toBe(false);
    expect(existsSync(join(work, "shared-skills/pdf/tables.md"))).toBe(true);

    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed.filter(line => line.startsWith("  libero-"))).toHaveLength(2);
    expect(changed.filter(line => !line.startsWith("  libero-"))).toEqual(["# Working with PDFs, revised"]);
  });

  it("leaves what is published alone when it refuses an update", () => {
    run(["vendor", address("skills/pdf", "v1.0.0")], work);
    const before = vendored("pdf");

    expect(run(["vendor", address("skills/pdf", "v2.0.0")], work).code).toBe(EXIT_ERROR);
    expect(vendored("pdf")).toBe(before);
  });

  each([
    ["skills/xlsx", /950-character description, and the cap is 512/, "xlsx"],
    ["skills/academy-guide", /YAML folded scalar/, "academy-guide"],
    ["skills/linky", /is a symlink at [0-9a-f]{40}/, "linky"],
    ["skills/misnamed", /calls itself `something-else`/, "misnamed"],
    ["skills/nope", /has no skills\/nope/, "nope"]
  ])("refuses %s and writes nothing", (path, pattern, name) => {
    const result = run(["vendor", address(path as string, "v1.0.0")], work);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.text).toMatch(pattern as RegExp);
    expect(existsSync(join(work, "shared-skills", name as string))).toBe(false);
  });

  it("names the siblings when a path is not in the tree", () => {
    const result = run(["vendor", address("skills/nope", "v1.0.0")], work);

    expect(result.text).toContain("pdf");
    expect(result.text).toContain("xlsx");
  });

  it("tells the operator the skill is inert until a sheet names it", () => {
    const result = run(["vendor", address("skills/pdf", "v1.0.0")], work);

    expect(result.out.join("\n")).toContain("[[shared_skill]]");
    expect(result.out.join("\n")).toContain('name = "pdf"');
  });

  // The operator is committing somebody else's licence into their own
  // repository. One line, not a gate — `license-check.sh` scans dependencies
  // and would never see this.
  it("prints the licence the skill declares", () => {
    const result = run(["vendor", address("skills/pdf", "v1.0.0")], work);

    expect(result.out.join("\n")).toContain("license: Example-Proprietary.");
  });
});
