// Every workspace package is run by exactly one CI job.
//
// `test-scripts.test.ts` next door asks whether each package runs its suite the
// same way. This asks the question one level out: whether anything runs it at
// all. They are different failures, and this one arrived with #410.
//
// The `build` job used to run every package but `e2e`. It now excludes
// `@getlibero/runner` too, which has a job of its own — three `run:` lines
// across three jobs, where there was one, and nothing checked that they agreed:
//
//   - delete the `sandbox` job and `@getlibero/runner` is run by nothing, while
//     the build job's filter still excludes it — #395's acceptance goes dark and
//     CI reports green;
//   - fold either daemon suite back onto `build` and that job silently acquires
//     a Docker dependency nothing states, which is the arrangement #410 found;
//   - add a workspace package and no line mentions it, which is the "invisible
//     to CI until it has a `test` script" hazard CLAUDE.md already names,
//     pointed at the workflow instead of at the manifest.
//
// All three are the shape this repository calls a test that encodes a gap, and
// all three are invisible in a diff of one file. So the lines have to
// *partition* the workspace — every package in exactly one job — and the two
// that gate on a daemon have to stand alone. Asserted here rather than reviewed.
//
// ## Why it parses the YAML rather than reading a list
//
// A list of what CI runs, kept beside CI, is a second thing to forget. What
// makes this worth having is that it reads the file that actually decides. The
// parser is deliberately small and deliberately brittle: it understands the
// filter syntax those lines use and **throws on anything else**, because a
// parser that quietly mis-models a flag it does not know would report a
// partition that is not there. A new flag in ci.yml fails this test, which is a
// one-line fix and a reviewable one; a wrong green is neither.

import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "expect";
import { ROOT, workspacePackages, type WorkspacePackage } from "./workspace.js";

const WORKFLOW = join(ROOT, ".github/workflows/ci.yml");

/**
 * Every `run:` in ci.yml that invokes a `pnpm` script named `test`.
 *
 * Anchored on the trailing `test` so that `pnpm lint`, `pnpm license-check`,
 * `pnpm install` and `pnpm -r build` are not candidates. Single-line `run:`
 * values only, which is what both of them are — a block scalar running the
 * suite would not be matched, and would fail the count assertion below rather
 * than being skipped silently.
 */
function testCommands(): string[] {
  const yaml = readFileSync(WORKFLOW, "utf8");
  return [...yaml.matchAll(/^\s*run: (pnpm .*\btest)$/gm)].map(m => m[1] as string);
}

/** The tokens this parser understands, beyond `--filter` and its argument. */
const RECURSIVE = new Set(["-r", "--recursive"]);

/**
 * Which packages a `pnpm ... test` command selects, given the whole workspace.
 *
 * Models the two forms in use and refuses the rest: `-r` with negative filters
 * (everything but these), and positive filters (only these). A filter that is
 * not a bare `@getlibero/*` name — a glob, a path, a `...` dependency suffix —
 * throws, because those select things this cannot compute and a guess would be
 * worse than a failure.
 */
function selects(command: string, all: readonly string[]): Set<string> {
  const tokens = command.split(/\s+/);
  expect(tokens.shift()).toBe("pnpm");
  expect(tokens.pop()).toBe("test");

  let recursive = false;
  const include = new Set<string>();
  const exclude = new Set<string>();

  while (tokens.length > 0) {
    const token = tokens.shift() as string;
    if (RECURSIVE.has(token)) {
      recursive = true;
      continue;
    }
    if (token !== "--filter") {
      throw new Error(
        `ci-partition: ${WORKFLOW} runs \`${command}\`, and this check does not understand \`${token}\`. ` +
          `Teach it what that token selects, or the partition it asserts is not the one CI performs.`
      );
    }
    const raw = (tokens.shift() ?? "").replace(/^'(.*)'$/, "$1");
    const negated = raw.startsWith("!");
    const name = negated ? raw.slice(1) : raw;
    if (!all.includes(name)) {
      throw new Error(
        `ci-partition: \`--filter ${raw}\` in ${WORKFLOW} does not name a workspace package. ` +
          `This check understands bare package names only — not globs, paths, or \`...\` suffixes.`
      );
    }
    (negated ? exclude : include).add(name);
  }

  if (include.size === 0 && !recursive) {
    throw new Error(
      `ci-partition: \`${command}\` selects nothing this check can compute — no positive filter and no -r.`
    );
  }

  const selected = include.size > 0 ? include : new Set(all);
  for (const name of exclude) selected.delete(name);
  return selected;
}

describe("the CI jobs that run the suite", () => {
  it("were found at all, so the checks below are not vacuous", () => {
    // Three: `build`, `e2e`, `sandbox`. A fourth would be fine and would still
    // have to partition; none means the regex stopped matching and everything
    // after this would pass on an empty set.
    expect(testCommands().length).toBeGreaterThanOrEqual(3);
    expect(workspacePackages().length).toBeGreaterThan(10);
  });

  it("run every workspace package exactly once between them", () => {
    const all = workspacePackages().map(p => p.name);
    const commands = testCommands();

    const runBy = new Map<string, string[]>(all.map(name => [name, []]));
    for (const command of commands) {
      for (const name of selects(command, all)) (runBy.get(name) as string[]).push(command);
    }

    // Asserted as a whole object rather than package by package, so a failure
    // names every package that is unrun or double-run at once — and says which
    // command runs it, because "which job was that?" is the next question.
    const counted = Object.fromEntries([...runBy].map(([name, by]) => [name, by.length]));
    expect({ counted, runBy: Object.fromEntries(runBy) }).toEqual({
      counted: Object.fromEntries(all.map(name => [name, 1])),
      runBy: Object.fromEntries(runBy)
    });
  });

  it("never run a suite that gates on a Docker daemon beside one that does not", () => {
    // The narrower claim #410 turns on, and the reason the daemon-needing
    // packages are one-per-job rather than grouped.
    //
    // Their gates are two-sided: no daemon and `CI=true` throws at import
    // rather than skipping, so that #395's and #396's acceptance cannot report
    // green on a runner that lost its socket. That makes *any* job running one
    // of them a job that must have a daemon — so putting one on the `build`
    // job silently gives that job a dependency nothing states, which is where
    // this started.
    //
    // One per command, not merely grouped away from `build`. Two of these
    // suites on one job have to run in series, because
    // `apps/runner/src/sandbox.docker.test.ts` asserts that nothing on the
    // daemon descends from `python:3.13-alpine` — daemon-wide on purpose, since
    // a leaked container is one whose id it never learned — while
    // `e2e/src/sandbox-attack.test.ts` keeps a sink container running on that
    // image. Measured: concurrently they collide, in series the job becomes the
    // critical path. A daemon each is what makes both go away, and this fails
    // rather than letting the next person rediscover it.
    const all = workspacePackages().map(p => p.name);
    const gated = new Set(workspacePackages().filter(gatesOnDocker).map(p => p.name));

    // Non-vacuous: the two files this is about are still there and still gate.
    expect([...gated].sort()).toEqual(["@getlibero/e2e", "@getlibero/runner"]);

    const alongside = Object.fromEntries(
      testCommands()
        .map(command => [command, [...selects(command, all)]] as const)
        .filter(([, selected]) => selected.some(name => gated.has(name)))
        .map(([command, selected]) => [command, selected.filter(name => !gated.has(name))])
    );

    expect(alongside).toEqual(
      Object.fromEntries(Object.keys(alongside).map(command => [command, []]))
    );
    expect(Object.keys(alongside)).toHaveLength(gated.size);
  });
});

/**
 * Whether a package's suite refuses to run without a Docker daemon.
 *
 * Read off the gate rather than listed here, so that a third one added
 * tomorrow is covered on the day it is written rather than on the day someone
 * remembers this file. The marker is the sentence both gates throw — they are
 * worded alike because they are the same decision, and `sandbox-attack.test.ts`
 * says so in its header.
 */
function gatesOnDocker({ directory }: WorkspacePackage): boolean {
  return sources(join(directory, "src")).some(file =>
    readFileSync(file, "utf8").includes(DAEMON_GATE)
  );
}

/**
 * The sentence both two-sided gates throw when `CI` is true and no socket is
 * there.
 *
 * Spelled in two halves so that this file is not itself a match. The `build`
 * job's `workflow-guard` step has the same note for the same reason — a check
 * that greps for a string has to say the string somewhere, and the somewhere is
 * inside the thing being searched. Joining at run time is the smaller
 * instrument than teaching the search to skip a path.
 */
const DAEMON_GATE = "must not be" + " skipped in CI";

/** Every `.ts` file below a directory, or none if it is not there. */
function sources(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}
