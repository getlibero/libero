// The successor to #107, guarded before it happens.
//
// #107 was the reverse of this: vitest collected each test file twice, once
// from `src` and once from its compiled copy in `dist`, so every count was
// doubled and deleted tests kept running. `--exclude '**/dist/**'` fixed it and
// became a rule every `test` script had to carry.
//
// #202 inverted the arrangement — the suite now runs *from* `dist`, which
// retires that flag — and inverted the hazard with it. `node --test` over a
// glob that matches nothing **exits 0**: it reports zero tests and passes. So a
// `test` script with `dist/*.test.js` where it meant `dist/**/*.test.js` does
// not fail loudly; it silently stops running everything in a subdirectory, and
// CI goes green. That is the same shape as the bug this repository has been
// bitten by three times, and it is invisible in a diff of one `package.json`.
//
// So the script is one string, checked here against every workspace package. It
// lives with `each` and `waitFor` because this package is the one about how the
// suite runs, and because it depends on nothing else in the tree.
//
// `ci-partition.test.ts` beside it asks the question one level out — whether CI
// runs each package at all — off the same workspace list, which is why that
// list moved to `workspace.ts` rather than being copied.

import { describe, it } from "node:test";
import { expect } from "expect";
import { workspacePackages as packages } from "./workspace.js";

/** The canonical script: compile the package, then run the suite out of `dist`. */
const TEST_SCRIPT =
  "tsc -p tsconfig.json && node --test --test-reporter=@getlibero/test-kit/reporter 'dist/**/*.test.js'";

describe("every workspace package", () => {
  it("was found at all, so the checks below are not vacuous", () => {
    expect(packages().map(p => p.name)).toContain("@getlibero/proxy");
    expect(packages().length).toBeGreaterThan(10);
  });

  it("runs its suite out of dist with the same glob", () => {
    const scripts = packages().map(({ name, manifest }) => ({
      name,
      test: (manifest["scripts"] as Record<string, string> | undefined)?.["test"]
    }));

    expect(scripts).toEqual(scripts.map(({ name }) => ({ name, test: TEST_SCRIPT })));
  });

  it("builds and typechecks with the invocations the test script assumes", () => {
    for (const { name, manifest } of packages()) {
      const scripts = manifest["scripts"] as Record<string, string>;
      // `test` compiles with `tsc -p tsconfig.json`, so a package whose build
      // is something else entirely would be testing a `dist` nobody produced
      // the way it produces it. `packages/cli` appends a bundling step, which
      // is why this is a prefix rather than an equality.
      expect({ name, build: scripts["build"]?.startsWith("tsc -p tsconfig.json") }).toEqual({
        name,
        build: true
      });
      expect({ name, typecheck: scripts["typecheck"] }).toEqual({
        name,
        typecheck: "tsc -p tsconfig.json --noEmit"
      });
    }
  });
});
