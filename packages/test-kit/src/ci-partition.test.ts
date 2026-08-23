// Every workspace package is run by exactly one CI job.
//
// `test-scripts.test.ts` next door asks whether each package runs its suite the
// same way. This asks the question one level out: whether anything runs it at
// all. They are different failures, and this one arrived with #410.
//
// The `build` job used to run every package but `e2e`. It now excludes
// `@getlibero/runner` as well, because that package's container cases need a
// Docker daemon and belong beside the other suite that does. That split is two
// lines of YAML, and nothing checked that they agreed:
//
//   - drop `@getlibero/runner` from the `e2e` job and its cases stop running,
//     while the build job's filter still excludes them — #395's acceptance goes
//     dark and CI reports green;
//   - add a workspace package and neither line mentions it, which is the
//     "invisible to CI until it has a `test` script" hazard CLAUDE.md already
//     names, pointed at the workflow instead of at the manifest.
//
// Both are the shape this repository calls a test that encodes a gap, and both
// are invisible in a diff of one file. So the two lines have to *partition* the
// workspace — every package in exactly one job — and that is asserted here
// rather than reviewed.
//
// ## Why it parses the YAML rather than reading a list
//
// A list of what CI runs, kept beside CI, is a second thing to forget. What
// makes this worth having is that it reads the file that actually decides. The
// parser is deliberately small and deliberately brittle: it understands the
// filter syntax these two lines use and **throws on anything else**, because a
// parser that quietly mis-models a flag it does not know would report a
// partition that is not there. A new flag in ci.yml fails this test, which is a
// one-line fix and a reviewable one; a wrong green is neither.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "expect";
import { ROOT, workspacePackages } from "./workspace.js";

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
    // Two: the `build` job's `Tests` step and the `e2e` job's. A third would be
    // fine and would still have to partition; none means the regex stopped
    // matching and everything after this would pass on an empty set.
    expect(testCommands().length).toBeGreaterThanOrEqual(2);
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

  it("keep the daemon-needing packages together, and say so", () => {
    // The narrower claim #410 turns on. `apps/runner`'s container cases and
    // `e2e`'s both need a Docker daemon; the job that runs them is the one that
    // documents needing one, and the build job is the one that must not need
    // one. A future split that separates these two is not wrong, but it is a
    // decision — this fails so that it is made rather than drifted into.
    const all = workspacePackages().map(p => p.name);
    const withDaemon = testCommands().filter(command => {
      const selected = selects(command, all);
      return selected.has("@getlibero/e2e") || selected.has("@getlibero/runner");
    });

    expect(withDaemon).toHaveLength(1);
    const selected = selects(withDaemon[0] as string, all);
    expect([...selected].sort()).toEqual(["@getlibero/e2e", "@getlibero/runner"]);
  });
});
