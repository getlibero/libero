// The recipe's own tests, which it did not have until it had a home.
//
// Until #272 the sequence was covered only through its callers —
// `packages/proxy/src/vault-file.test.ts` asserted the mode, the symlink
// outcome and the absent leftover; `packages/memory/src/memory-file.test.ts`
// asserted the inode change. Both are still worth having where they are: they
// prove the *store* writes this way. What was missing is a test of the write
// itself, so that a change to it fails here rather than in four suites that are
// nominally about vaults, memory files, skills and proposals.
//
// **Two things are deliberately not asserted, and the gap is stated rather than
// papered over.** The fsyncs are not observable without cutting power, and a
// call-order test would be the source restated through a mock this repository
// does not otherwise use. And a symlink planted at the *temporary* name cannot
// be aimed at, because the name carries twelve random hex characters; what the
// `wx` there would refuse is the same `openSync(…, "wx", 0o600)` that
// `createFileExclusively` applies to a known path, which is tested below.
//
// What guards the fsyncs instead is the last test in this file: exactly one
// `renameSync(` in the tree, in this module. That is #272's acceptance criterion
// made executable, and it is what would have caught the CLI's fsync-less copy on
// the day it was written.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileExclusively, replaceFileAtomically, temporaryNameFor } from "./atomic-write.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-atomic-write-"));
  file = join(dir, "target");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

/** Everything the directory holds that the recipe would have planted. */
const leftovers = (at: string): readonly string[] =>
  readdirSync(at).filter(name => name.includes(".tmp-"));

describe("replaceFileAtomically", () => {
  it("writes a file that was not there", () => {
    replaceFileAtomically(file, bytes("first"));
    expect(readFileSync(file, "utf8")).toBe("first");
  });

  it("replaces the contents rather than appending", () => {
    replaceFileAtomically(file, bytes("a much longer first write"));
    replaceFileAtomically(file, bytes("short"));
    expect(readFileSync(file, "utf8")).toBe("short");
  });

  it("creates the file owner-only", () => {
    replaceFileAtomically(file, bytes("first"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  // The recipe does not preserve the target's mode, because the bytes land in a
  // file it opened rather than in the one that was there. That is what
  // `packages/memory`'s "a state directory that is uniformly 0600 is one an
  // operator can reason about" rests on, and nothing asserted it before.
  it("takes an existing file's mode down to owner-only", () => {
    writeFileSync(file, "first", { mode: 0o644 });
    replaceFileAtomically(file, bytes("second"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  // The observable signature of write-temp-then-rename, and the reason to assert
  // it rather than the contents: it fails for writeFileSync, for appendFileSync,
  // and for anything opening O_TRUNC — which are exactly the three
  // simplifications a later reader reaches for.
  it("lands by rename, so the inode changes", () => {
    replaceFileAtomically(file, bytes("first"));
    const before = statSync(file).ino;
    replaceFileAtomically(file, bytes("second"));
    expect(statSync(file).ino).not.toBe(before);
  });

  // The reader's half of the same property. A process holding the file open
  // across a write sees the whole old file, never a truncated one.
  it("leaves a handle opened before the write reading the whole old file", () => {
    replaceFileAtomically(file, bytes("the original contents"));
    const handle = openSync(file, "r");
    try {
      replaceFileAtomically(file, bytes("x"));
      const buffer = Buffer.alloc(64);
      const read = readSync(handle, buffer, 0, buffer.length, 0);
      expect(buffer.subarray(0, read).toString("utf8")).toBe("the original contents");
    } finally {
      closeSync(handle);
    }
  });

  it("leaves no temporary file behind a successful write", () => {
    replaceFileAtomically(file, bytes("first"));
    replaceFileAtomically(file, bytes("second"));
    expect(readdirSync(dir)).toEqual(["target"]);
  });

  // The failure is forced by aiming at a non-empty directory, so the temporary
  // file is created and the *rename* is what throws — the one window in which
  // there is something to clean up. Deliberately not forced with a mode: a
  // chmod 0o500 parent means one thing as an unprivileged user and nothing at
  // all as root, so it is a test that would quietly stop testing inside a
  // container.
  it("leaves no temporary file behind a rename that fails", () => {
    const occupied = join(dir, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "child"), "so the directory is not empty");

    expect(() => replaceFileAtomically(occupied, bytes("first"))).toThrow();

    expect(leftovers(dir)).toEqual([]);
    expect(readdirSync(occupied)).toEqual(["child"]);
  });

  it("fails rather than writing into a directory that does not exist", () => {
    const missing = join(dir, "no-such-dir", "target");
    expect(() => replaceFileAtomically(missing, bytes("first"))).toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  // `rename` over a symlink replaces the symlink, not its target. A store path
  // aimed at something else does not overwrite it — plainly right for a vault,
  // and worth stating for a file the team is invited to edit.
  it("does not write through a symlinked target", () => {
    const decoy = join(dir, "decoy");
    writeFileSync(decoy, "not the target");
    const link = join(dir, "linked");
    symlinkSync(decoy, link);

    replaceFileAtomically(link, bytes("written"));

    expect(readFileSync(decoy, "utf8")).toBe("not the target");
    // lstat, not stat: stat follows the link, so it could never observe one.
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).toBe("written");
  });

  it("writes zero bytes rather than removing the file", () => {
    replaceFileAtomically(file, bytes("first"));
    replaceFileAtomically(file, Buffer.alloc(0));
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBe(0);
  });
});

// The shape three modules in `packages/memory` depend on to keep a leftover out
// of a directory listing. Its other half is `skill-file.test.ts`, which lists a
// directory holding `.deploy.md.tmp-1234-abcd` and requires the skill listing to
// refuse it; changing the spelling here has to fail there too, and does.
describe("the temporary name", () => {
  it("is a hidden sibling of the target", () => {
    const temp = temporaryNameFor(file);
    expect(dirname(temp)).toBe(dir);
    expect(basename(temp).startsWith(".target.tmp-")).toBe(true);
  });

  it("carries the pid and twelve random hex characters", () => {
    expect(basename(temporaryNameFor(file))).toMatch(
      new RegExp(`^\\.target\\.tmp-${process.pid}-[0-9a-f]{12}$`)
    );
  });

  it("does not repeat", () => {
    expect(temporaryNameFor(file)).not.toBe(temporaryNameFor(file));
  });
});

describe("createFileExclusively", () => {
  it("writes a file that was not there, owner-only", () => {
    createFileExclusively(file, bytes("first"));
    expect(readFileSync(file, "utf8")).toBe("first");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  // The property the placement of `wx` exists for: two `libero init` runs racing
  // on one path end with one of them saying the file already exists, not with a
  // master key written over a master key.
  it("refuses an existing target and leaves its bytes alone", () => {
    writeFileSync(file, "the first run's key");
    expect(() => createFileExclusively(file, bytes("the second run's key"))).toThrow(
      expect.objectContaining({ code: "EEXIST" })
    );
    expect(readFileSync(file, "utf8")).toBe("the first run's key");
  });

  // Where the two functions deliberately differ, and the first place in the tree
  // this claim is directly testable. O_EXCL refuses a symlink at the path, so a
  // link planted where a key is about to be written is an error rather than a
  // write through it.
  it("refuses a symlinked target rather than writing through it", () => {
    const decoy = join(dir, "decoy");
    writeFileSync(decoy, "not the target");
    const link = join(dir, "linked");
    symlinkSync(decoy, link);

    expect(() => createFileExclusively(link, bytes("written"))).toThrow(
      expect.objectContaining({ code: "EEXIST" })
    );

    expect(readFileSync(decoy, "utf8")).toBe("not the target");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  // The same refusal where the link resolves to nothing, which is the spelling
  // an attacker would reach for: O_EXCL is EEXIST on the link itself, so the
  // referent is never created.
  it("refuses a dangling symlink too", () => {
    symlinkSync(join(dir, "nothing-here"), join(dir, "dangling"));
    expect(() => createFileExclusively(join(dir, "dangling"), bytes("written"))).toThrow(
      expect.objectContaining({ code: "EEXIST" })
    );
    expect(existsSync(join(dir, "nothing-here"))).toBe(false);
  });

  it("fails rather than writing into a directory that does not exist", () => {
    const missing = join(dir, "no-such-dir", "target");
    expect(() => createFileExclusively(missing, bytes("first"))).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});

// #272's acceptance criterion, executable.
//
// A grep and not a review note, for the reason `packages/proxy/src/outbound.test.ts`
// gives about the two `reveal()` sites: the claim is about the whole tree, and a
// grep cannot be routed around. This one is load-bearing in a way the ESLint
// bans are not — those say which modules may *name* this package, and nothing in
// a lint config can stop somebody writing the four syscalls out again, which is
// exactly what `libero init` did.
//
// `renameSync(` with the paren: `packages/proxy/src/vault.ts` names the function
// in prose, in a comment making the opposite claim about its own import list.
describe("one implementation", () => {
  it("has exactly one renameSync call in the tree, in this module", () => {
    const found = execFileSync(
      "sh",
      [
        "-c",
        "grep -rn 'renameSync(' packages/*/src apps/*/src e2e/src --include='*.ts' | grep -v '\\.test\\.ts' || true"
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    )
      .split("\n")
      .filter(line => line.length > 0);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("packages/atomic-write/src/atomic-write.ts");
  });

  // What lets every other package depend on this one: it is a leaf under the
  // leaves. A dependency added here reaches the proxy's image, the agent's
  // image, and the single file an operator installs from npm.
  it("imports nothing but node: builtins", () => {
    const source = join(REPO_ROOT, "packages/atomic-write/src");
    for (const name of readdirSync(source)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      for (const [, specifier] of readFileSync(join(source, name), "utf8").matchAll(
        /from "([^"]+)"/g
      )) {
        expect(specifier).toMatch(/^(node:|\.\/)/);
      }
    }
  });
});
