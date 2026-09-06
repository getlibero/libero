// Every hard-coded figure in the tree has a row on the inventory page.
//
// #465 asked the question this check keeps answered: which of the numbers that
// bound a deployment may an operator move? The answer is a page —
// `site/src/content/docs/docs/limits.md` — and a page is exactly the kind of
// artefact that is true on the day it is written and quietly false a release
// later. #538 asked for the check in the same breath as the page, because "a
// limit chosen in a future issue that skips the inventory is the drift this
// pass exists to stop".
//
// It is the third check on the repository in this package, and the shape is
// `ci-partition.test.ts`'s: derive from the files that actually decide, throw
// rather than guess, and report the whole set at once. What it adds to that
// family is a second direction — a row whose limit has been deleted fails too,
// because a page that names a constant the reader cannot find is a worse
// answer than no page.
//
// ## Why the assertion lives here and not in `packages/schema`
//
// `parse-team-sheet.test.ts` is the nearest precedent — it asserts the site's
// copy of the starter sheet against the file it copies — and its argument for
// reaching outside the workspace is the one this file relies on: `site/` has no
// test runner of its own, so an assertion about a page has to live where a
// runner already goes. What sends this one here rather than there is breadth.
// That check covers one file; this one sweeps nine packages, which is what
// `workspacePackages()` and `sources()` next door exist for.
//
// The cost is that this package may not import the constants it inventories —
// it declares no runtime dependencies, which is what lets `packages/memory`
// import it across the leaf rule — so the sweep reads source text. That is not
// a workaround: the page addresses a limit by where it is written, so where it
// is written is the thing to compare.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "expect";
import { ROOT } from "./workspace.js";
import { limits, NOT_A_LIMIT } from "./limits.js";

/** The inventory. Outside the workspace, which is why it is asserted here. */
const PAGE = join(ROOT, "site/src/content/docs/docs/limits.md");

/**
 * How a row addresses its limit: `` `path/to/file.ts:SYMBOL` ``.
 *
 * By symbol rather than by line, and that is a decision rather than a
 * convenience. #538 offers either. A line number is wrong the moment an import
 * is added above it, which would make an unrelated diff either fail this check
 * or carry a doc edit nobody reviewing it asked for — and a table of stale line
 * numbers teaches a reader to stop trusting the column.
 */
const ROW =
  /`((?:packages|apps)\/[A-Za-z0-9._/-]+\.ts):([A-Za-z_][A-Za-z0-9_]*)`\s*\|\s*`([^`]+)`/g;

/**
 * Each row's limit and the figure it claims, as written on the page.
 *
 * The figure is carried in the table as the **source text** — `15 * 60 * 1000`,
 * not "fifteen minutes" — with the reading in the prose beside it. That is what
 * lets the check compare it. Without it the page could keep a row for a limit
 * whose number had since doubled and still pass, which is most of what #465 is
 * worried about: these figures are one-way doors, and the page exists to be the
 * place somebody notices one moving.
 */
function rows(): Map<string, string> {
  const page = readFileSync(PAGE, "utf8");
  return new Map(
    [...page.matchAll(ROW)].map(([, file, symbol, figure]) => [`${file}:${symbol}`, figure!.trim()])
  );
}

describe("the limits inventory", () => {
  // Both checks below pass on an empty sweep and an empty page, so the sweep
  // has to be shown to have found something first. `test-scripts.test.ts` and
  // `ci-partition.test.ts` each open the same way and for the same reason.
  it("was built from a sweep that found something", () => {
    const found = limits();
    expect(found.length).toBeGreaterThan(100);
    expect(found.map(l => l.key)).toContain("packages/proxy/src/approvals.ts:APPROVAL_TTL_MS");
    expect(found.map(l => l.key)).toContain("packages/schema/src/team-sheet.ts:top_k");
    expect(rows().size).toBeGreaterThan(100);
  });

  it("has a row for every limit in the tree", () => {
    const documented = rows();
    const missing = limits()
      .filter(l => !documented.has(l.key))
      .map(l => ({ limit: l.key, figure: l.figure }));

    // Asserted as a whole array rather than one limit at a time, so a failure
    // names every undocumented figure at once — the idiom `test-scripts.test.ts`
    // uses, for the reason `ci-partition.test.ts` states.
    expect(missing).toEqual([]);
  });

  it("has no row for a limit that is no longer there", () => {
    const swept = new Set(limits().map(l => l.key));
    expect([...rows().keys()].filter(key => !swept.has(key))).toEqual([]);
  });

  it("states the figure each limit actually holds", () => {
    const documented = rows();
    const stated = limits()
      .filter(l => documented.has(l.key))
      .map(l => ({ limit: l.key, figure: documented.get(l.key) }));

    expect(stated).toEqual(limits().filter(l => documented.has(l.key)).map(l => ({
      limit: l.key,
      figure: l.figure,
    })));
  });

  it("excludes only symbols the exclusion list gives a reason for", () => {
    // The list is the argument, so an entry with no reason is the thing it was
    // built to prevent — an exclusion nobody has to justify.
    const unreasoned = Object.entries(NOT_A_LIMIT)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([symbol]) => symbol);
    expect(unreasoned).toEqual([]);
  });
});
