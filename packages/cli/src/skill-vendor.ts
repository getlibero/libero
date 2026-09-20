// Copying a skill directory out of a git repository at a pinned commit.
//
// The order below is the design: **nothing is written into the shared root
// until every check has passed**, and `rmSync`/`cpSync` are the last two
// statements of the function. `channel add` keeps the same rule for the same
// reason — it refuses a channel that already has a sheet before it mints key
// material it would then decline to register.
//
// ## Blobs are read with `cat-file`, and there is never a worktree
//
// This is what makes "the copy is verbatim bytes" true rather than nearly true.
// A `git checkout` puts three things between the repository and the file:
// `core.autocrlf`, which rewrites line endings on the operator's machine and
// not on their colleague's; a `.gitattributes` in the fetched tree, which can
// declare `text=auto` or a filter driver and is *upstream's* file, not ours;
// and `core.symlinks`, which on a host without symlink permission writes a
// regular file holding the target's path — silently converting the thing this
// command refuses into the thing it accepts.
//
// `ls-tree` plus `cat-file blob` has none of that surface. It also means modes
// come from git's own record rather than from an `lstat` of something we just
// wrote, which matters more than it sounds: `anthropics/skills`'
// `skills/pdf/scripts/extract_form_structure.py` is 100755 where its seven
// siblings are 100644, and #570 mounts this directory into every sandbox
// container and runs it.
//
// It also rules out `--filter=blob:none`. A blobless fetch makes `cat-file`
// reach the network once per file, and the only way to batch that is a
// checkout — which is the thing being avoided. A `--depth 1` fetch is one round
// trip and no filters, at the cost of every blob at that one commit.
//
// ## `--force` replaces, and does not merge
//
// The directory is deleted and written again, which is the only way #569's "a
// diff of exactly the changed files" can hold: a merge-copy would leave a file
// upstream deleted between two refs sitting in the operator's tree forever,
// invisible to any diff of the change.
//
// **`@getlibero/atomic-write` is not used, twice over.** Its two exports
// hardcode mode 0600 — wrong for a file bind-mounted `:ro` and read by `USER
// node` in two containers, which is the half `channel add` already declined it
// for — and the unit here is a directory of n files, where n atomic file writes
// are not an atomic directory write. A rename would not help either: it is
// banned tree-wide (`packages/atomic-write/src/atomic-write.test.ts` greps for
// exactly one), and it could not restore the *previous* directory any more than
// this can. Recovery is the operator's git, and the failure message says so.

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { SHARED_SKILL_FILE, parseSkillFile, parseTeamSheet } from "@getlibero/schema";
import type { SkillFrontmatter } from "@getlibero/schema";
import { displayPath } from "./io.js";
import type { CliIo } from "./io.js";
import { VENDOR_FILE_MAX_BYTES, text } from "./git.js";
import type { GitRunner } from "./git.js";
import { COMMIT_SHA, parseSkillAddress } from "./skill-address.js";
import type { SkillAddress } from "./skill-address.js";
import { explainSkillFailure, insertProvenance } from "./skill-frontmatter.js";

/**
 * `[skills] max_skill_chars`' own default, read off the schema rather than
 * written down again.
 *
 * **Not a second figure**, which is what limits.md's "figures that are two
 * figures" asks of anything tempted to be one: two numbers are worth a test
 * that they agree only when they cannot be made one number, and this package
 * bundles `@getlibero/schema`, so they can be. Read through `parseTeamSheet`
 * for the same reason the three coupled-figure tests do — what matters is which
 * sheets parse, and a zod object introspected for its default is a test of
 * zod's internals.
 *
 * It bounds nothing here and deliberately so. The cap is a sheet field, and a
 * host-side command cannot know which sheets will name this skill; what it can
 * do is say the number, because the failure it otherwise prevents nobody from
 * hitting is silent from every angle — the skill vendors, `doctor` passes, and
 * the runtime drops it whole with `shared_skill_oversize`. #573 is the check
 * that catches it properly.
 */
function sheetDefaultMaxSkillChars(): number {
  const minimal = parseTeamSheet(`[channel]\nname = "x"\ncertificate_sha256 = ["${"AB:".repeat(31)}AB"]\n`);
  return minimal.ok ? minimal.sheet.skills.max_skill_chars : 0;
}

export interface VendorOptions {
  readonly address: string;
  readonly skill?: string;
  readonly sharedSkillsRoot: string;
  readonly force: boolean;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly size: number;
  /** Repository-relative, as git records it. */
  readonly path: string;
  /** Relative to the skill's own directory. */
  readonly relative: string;
}

export function vendorSkill(io: CliIo, options: VendorOptions, run: GitRunner): number {
  const address = parseSkillAddress(options.address, options.skill);
  const target = resolve(io.cwd, options.sharedSkillsRoot, address.name);

  // Before the network, so a mistyped update does not spend a fetch to find out
  // it was never going to be allowed to write.
  if (existsSync(target) && !options.force) {
    throw new Error(refuseExisting(io, target, address));
  }

  const scratch = mkdtempSync(join(tmpdir(), "libero-vendor-"));
  try {
    const sha = resolveRef(address, scratch, run);
    fetchCommit(address, sha, scratch, run);
    const entries = manifest(address, sha, scratch, run);
    const files = readBlobs(entries, scratch, run);

    const skillFile = files.get(SHARED_SKILL_FILE);
    if (skillFile === undefined) {
      throw new Error(missingSkillFile(address, sha));
    }

    const source = skillFile.toString("utf8");
    const where = `${address.source}/${SHARED_SKILL_FILE}`;
    const parsed = parseSkillFile(source, { shared: true });
    if (!parsed.ok) {
      throw new Error(explainSkillFailure(source, parsed, where).join("\nlibero:   "));
    }
    if (parsed.skill.frontmatter.name !== address.name) {
      throw new Error(
        `${where} calls itself \`${parsed.skill.frontmatter.name}\`, and it is being written to ` +
          `${displayPath(io.cwd, target)}\n` +
          "libero:   The directory is the name, which is the spec's own rule. Publish it as " +
          `${parsed.skill.frontmatter.name} with --skill ${parsed.skill.frontmatter.name}, or rename it upstream.`
      );
    }

    const rewritten = insertProvenance(source, { source: address.source, ref: address.ref, sha });
    const check = parseSkillFile(rewritten, { shared: true });
    if (!check.ok || check.skill.frontmatter.metadata?.["libero-sha"] !== sha) {
      throw new Error(`recorded provenance the schema then rejects in ${where}. This is a bug.`);
    }
    files.set(SHARED_SKILL_FILE, Buffer.from(rewritten, "utf8"));

    write(io, target, entries, files, options.force);
    report(io, options, address, sha, entries, parsed.skill.body, parsed.skill.frontmatter);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The ref as a commit, or the reason it is not one. */
function resolveRef(address: SkillAddress, scratch: string, run: GitRunner): string {
  if (COMMIT_SHA.test(address.ref)) return address.ref;

  const listed = run(["ls-remote", "--quiet", address.remote, address.ref], scratch);
  if (listed.code !== 0) {
    throw new Error(
      `git could not read ${address.remote}\n` +
        `libero:   git said: ${listed.err.split("\n").join("\nlibero:   ")}\n` +
        dotGitHint(address) +
        "libero:   This runs your git with your credentials: whatever `git ls-remote <url>` " +
        "reaches, this reaches. Nothing was written."
    );
  }

  // `ls-remote`'s pattern matches at a slash boundary, so `main` also answers
  // `refs/heads/feature/main`. Only the four exact spellings count, and the
  // peeled `^{}` wins — it is the commit an annotated tag points at, where the
  // unpeeled entry is the tag object.
  const wanted = new Map<string, string>();
  for (const line of text(listed).split("\n")) {
    const [sha, full] = line.split("\t");
    if (sha === undefined || full === undefined) continue;
    for (const spelling of [`refs/tags/${address.ref}^{}`, `refs/tags/${address.ref}`, `refs/heads/${address.ref}`, address.ref, `${address.ref}^{}`]) {
      if (full === spelling) wanted.set(spelling, sha);
    }
  }

  const tag = wanted.get(`refs/tags/${address.ref}^{}`) ?? wanted.get(`refs/tags/${address.ref}`);
  const head = wanted.get(`refs/heads/${address.ref}`);
  if (tag !== undefined && head !== undefined && tag !== head) {
    throw new Error(
      `${address.remote} has both a tag and a branch named ${address.ref}, pointing at different commits\n` +
        `libero:   Say which: @refs/tags/${address.ref} or @refs/heads/${address.ref}`
    );
  }

  const found = tag ?? head ?? wanted.get(`${address.ref}^{}`) ?? wanted.get(address.ref);
  if (found === undefined) {
    throw new Error(
      `${address.remote} has no tag or branch named ${address.ref}\n` +
        `libero:   List what it does have: git ls-remote --tags --heads ${address.remote}`
    );
  }
  return found;
}

function fetchCommit(address: SkillAddress, sha: string, scratch: string, run: GitRunner): void {
  // `--template=` so the operator's own init templates and hooks do not run in
  // a directory this command created.
  expect(run(["-c", "init.defaultBranch=main", "init", "--quiet", "--template=", scratch], scratch), "prepare a scratch repository");
  expect(run(["-C", scratch, "remote", "add", "origin", address.remote], scratch), "name the remote");

  // The **ref**, not the bare sha, unless that is all we were given. GitHub and
  // GitLab serve `allowAnySHA1InWant`; a default-configured self-hosted daemon
  // does not — and private hosts are the whole reason this shells out to git.
  const fetched = run(["-C", scratch, "fetch", "--quiet", "--depth", "1", "--no-tags", "origin", COMMIT_SHA.test(address.ref) ? sha : address.ref], scratch);
  if (fetched.code !== 0) {
    if (COMMIT_SHA.test(address.ref)) {
      throw new Error(
        `${address.remote} will not serve the bare commit ${sha} — the host only serves refs it advertises\n` +
          "libero:   Give the tag or branch that contains it instead.\n" +
          `libero:   git said: ${fetched.err.split("\n").join("\nlibero:   ")}`
      );
    }
    throw new Error(
      `git could not fetch ${address.ref} from ${address.remote}\n` +
        `libero:   git said: ${fetched.err.split("\n").join("\nlibero:   ")}`
    );
  }

  const head = run(["-C", scratch, "rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"], scratch);
  if (head.code !== 0) {
    const kind = text(run(["-C", scratch, "cat-file", "-t", "FETCH_HEAD"], scratch)).trim();
    throw new Error(
      `${address.ref} in ${address.remote} is ${kind === "" ? "not a commit" : `a ${kind}, not a commit`}\n` +
        "libero:   A vendored skill is pinned to a commit."
    );
  }

  const landed = text(head).trim();
  if (landed !== sha) {
    throw new Error(
      `${address.ref} moved between resolving it (${sha}) and fetching it (${landed})\n` +
        `libero:   Run the same command again. If it keeps moving, pin the commit: @${landed}`
    );
  }
}

/** Every blob under the skill's directory, from git's own record. */
function manifest(address: SkillAddress, sha: string, scratch: string, run: GitRunner): TreeEntry[] {
  const args = ["-C", scratch, "ls-tree", "-r", "-l", "-z", sha];
  if (address.path !== "") args.push("--", address.path);
  const listed = expect(run(args, scratch), "read the tree");

  const entries: TreeEntry[] = [];
  for (const record of text(listed).split("\0")) {
    if (record === "") continue;
    const match = /^(\d{6}) (\S+) ([0-9a-f]+)\s+(\S+)\t([\s\S]*)$/.exec(record);
    if (match === null) continue;
    const [, mode, type, oid, size, path] = match as unknown as [string, string, string, string, string, string];
    const prefix = address.path === "" ? "" : `${address.path}/`;
    entries.push({
      mode,
      type,
      oid,
      size: size === "-" ? 0 : Number(size),
      path,
      relative: path.startsWith(prefix) ? path.slice(prefix.length) : path
    });
  }

  if (entries.length === 0) throw new Error(noSuchPath(address, sha, scratch, run));
  if (entries.length === 1 && entries[0]?.path === address.path) {
    throw new Error(
      `${address.source} is a file. Give the directory that holds it: ` +
        `${dirname(address.source)}@${address.ref}`
    );
  }

  for (const entry of entries) {
    if (entry.mode === "120000") {
      throw new Error(
        `${entry.path} is a symlink at ${sha}, and a vendored skill is copied whole\n` +
          "libero:   Your shared skills root is mounted into every sandbox container, so a file " +
          "this command silently dropped would make a diff against upstream a lie. Refusing the " +
          "skill rather than the file."
      );
    }
    if (entry.mode === "160000") {
      throw new Error(`${entry.path} is a submodule at ${sha}, which this command does not follow`);
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error(`${entry.path} is not a regular file at ${sha} (mode ${entry.mode})`);
    }
    if (entry.size > VENDOR_FILE_MAX_BYTES) {
      throw new Error(
        `${entry.path} is ${entry.size} bytes, and this command copies files up to ${VENDOR_FILE_MAX_BYTES}\n` +
          "libero:   A skill is text and its sidecars. Refusing rather than truncating."
      );
    }
  }
  return entries;
}

function readBlobs(entries: readonly TreeEntry[], scratch: string, run: GitRunner): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const blob = run(["-C", scratch, "cat-file", "blob", entry.oid], scratch);
    if (blob.code !== 0) throw new Error(`git could not read ${entry.path}: ${blob.err}`);
    files.set(entry.relative, blob.out);
  }
  return files;
}

function write(
  io: CliIo,
  target: string,
  entries: readonly TreeEntry[],
  files: ReadonlyMap<string, Buffer>,
  force: boolean
): void {
  const staging = mkdtempSync(join(tmpdir(), "libero-staged-"));
  try {
    for (const entry of entries) {
      const destination = join(staging, entry.relative);
      // git records normalized repository-relative paths, so this cannot escape
      // — which is exactly why it is cheap to prove rather than assume.
      if (relative(staging, destination).startsWith("..")) {
        throw new Error(`${entry.path} names a path outside the skill's directory`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, files.get(entry.relative) as Buffer);
      // Explicitly, and not through `writeFileSync`'s mode: that one is masked
      // by the operator's umask, and an 0o077 umask would strip the executable
      // bit off a script #570 runs in a container.
      chmodSync(destination, entry.mode === "100755" ? 0o755 : 0o644);
    }

    if (force && existsSync(target)) rmSync(target, { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(staging, target, { recursive: true, dereference: false, preserveTimestamps: false });
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\n` +
        `libero:   ${displayPath(io.cwd, target)} may be half-written. Undo it: ` +
        `git checkout -- ${displayPath(io.cwd, target)} && git clean -fd ${displayPath(io.cwd, target)}`
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function report(
  io: CliIo,
  options: VendorOptions,
  address: SkillAddress,
  sha: string,
  entries: readonly TreeEntry[],
  body: string,
  frontmatter: SkillFrontmatter
): void {
  const shown = join(options.sharedSkillsRoot, address.name);
  io.out(`libero: vendored ${address.source} at ${sha}`);
  io.out(`libero:   ${shown} — ${entries.length} file${entries.length === 1 ? "" : "s"}: ${summarize(entries)}`);

  const licence = frontmatter.extra?.find(field => field.key === "license" || field.key === "licence");
  if (licence !== undefined) {
    io.out(`libero:   ${licence.key}: ${licence.value}`);
  } else if (entries.some(entry => /^(LICEN[CS]E|COPYING)/i.test(entry.relative))) {
    io.out("libero:   this skill ships its own licence file — read it before you commit the copy");
  }

  const cap = sheetDefaultMaxSkillChars();
  if (body.length > cap) {
    io.out(
      `libero:   note: its body is ${body.length} characters, over the ${cap} ` +
        "default — a channel whose [skills] max_skill_chars is below that loads nothing"
    );
  }
  if (frontmatter.description.includes('\\"') || frontmatter.description.includes("\\\\")) {
    io.out(
      "libero:   note: the description carries a \\\" escape, which this grammar keeps as written " +
        "— it reaches retrieval with the backslash"
    );
  }

  io.out("");
  io.out(`libero: ${address.name} is on disk and no channel reads it yet. Name it in a sheet:`);
  io.out("");
  io.out("  [[shared_skill]]");
  io.out(`  name = "${address.name}"`);
  io.out('  load = "retrieved"');
  io.out("");
  io.out(`Then check it: libero doctor. Review the copy before you commit it: git status ${shown}`);
}

/** Top-level names, with a directory's contents counted rather than listed. */
function summarize(entries: readonly TreeEntry[]): string {
  const top = new Map<string, number>();
  for (const entry of entries) {
    const head = entry.relative.split("/")[0] as string;
    top.set(head, (top.get(head) ?? 0) + 1);
  }
  return [...top]
    .map(([name, count]) => (count === 1 && !entries.some(e => e.relative.startsWith(`${name}/`)) ? name : `${name}/ (${count})`))
    .join(", ");
}

function noSuchPath(address: SkillAddress, sha: string, scratch: string, run: GitRunner): string {
  const parent = address.path.includes("/") ? dirname(address.path) : "";
  const args = ["-C", scratch, "ls-tree", "--name-only", "-z", sha];
  if (parent !== "") args.push("--", `${parent}/`);
  const listed = run(args, scratch);
  const siblings = text(listed)
    .split("\0")
    .filter(name => name !== "")
    .map(name => name.split("/").at(-1) as string);

  const headline = `${address.source} at ${sha} has no ${address.path === "" ? SHARED_SKILL_FILE : address.path}`;
  const lines = [headline];
  if (siblings.length > 0) {
    const listedNames = siblings.slice(0, 12).join(", ");
    lines.push(
      `${parent === "" ? "its root" : `${parent}/`} holds: ${listedNames}` +
        (siblings.length > 12 ? `, … (${siblings.length} entries)` : "")
    );
  }
  const hint = dotGitHint(address);
  if (hint !== "") lines.push(hint.replace(/^libero:   /, "").trimEnd());
  return lines.join("\nlibero:   ");
}

/**
 * The one ambiguity in the address grammar, said where an operator meets it.
 *
 * `https://host/team/skills/skills/pdf` is a repository with a skill inside it
 * or a repository at that whole path, and nothing in the string tells them
 * apart — so ./skill-address.ts takes the second reading and this says so on
 * both failures it causes: a remote git will not serve, and a repository with
 * no SKILL.md at its root.
 */
function dotGitHint(address: SkillAddress): string {
  const spelledOut = address.remote.endsWith(".git");
  const deep = address.remote.replace(/^[a-z+]+:\/\//, "").split("/").length > 2;
  if (spelledOut || address.path !== "" || !deep) return "";
  return (
    "libero:   A plain git URL is read as the whole repository. If the skill is a directory " +
    "inside it, spell the repository with a trailing .git: " +
    "https://host/team/skills.git/skills/pdf@ref\n"
  );
}

function missingSkillFile(address: SkillAddress, sha: string): string {
  return (
    `${address.source} at ${sha} has no ${SHARED_SKILL_FILE}\n` +
    `libero:   A skill is a directory holding ${SHARED_SKILL_FILE}, with scripts/, references/ and ` +
    "assets/ beside it — the Agent Skills layout."
  );
}

/** What is already published here, so the refusal can name the update command. */
function refuseExisting(io: CliIo, target: string, address: SkillAddress): string {
  const shown = displayPath(io.cwd, target);
  let from = "";
  try {
    const existing = parseSkillFile(readFileSync(join(target, SHARED_SKILL_FILE), "utf8"), { shared: true });
    if (existing.ok) {
      const source = existing.skill.frontmatter.metadata?.["libero-source"];
      const ref = existing.skill.frontmatter.metadata?.["libero-ref"];
      if (source !== undefined) from = `, vendored from ${source}${ref === undefined ? "" : ` at ${ref}`}`;
    }
  } catch {
    // Not vendored by this command, or not readable. The plain refusal still
    // says everything an operator has to do.
  }
  return (
    `${shown} already holds a skill${from}\n` +
    `libero:   Update it: libero skill vendor ${address.source}@${address.ref} --force`
  );
}

function expect(run: GitRun, what: string): GitRun {
  if (run.code !== 0) throw new Error(`git could not ${what}: ${run.err}`);
  return run;
}

type GitRun = ReturnType<GitRunner>;
