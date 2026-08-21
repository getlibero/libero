// Two claims the README makes about this suite's clock, enforced rather than
// described.
//
// The README has said since the suite existed that everything here runs on real
// time — the loop's wall clock is `AbortSignal.timeout`, which no fake timer can
// drive — and that a runner's defaults are too short, so timeouts are passed
// explicitly. Under vitest there were three of those defaults, not the two the
// paragraph named: 5 s per test, 10 s per hook, and 1 s for `vi.waitFor`. Six
// call sites took the third, in files whose `SETUP_MS` is a minute because the
// same rig mints certificates and spawns a process. One of them failed a CI run
// on nothing but a loaded runner, and a re-run of the same commit passed (#329).
//
// **The grep that guarded the third is gone, and its rule is stronger than it
// was.** #202 replaced vitest with `node:test`, which has no `waitFor` at all,
// and the harness's own waits — `proxy.waitForLog`, `agent.waitForLog`,
// `waitForApprovalCard` — are what this suite uses instead. Where a case needs
// something more general, `@getlibero/test-kit`'s `waitFor` takes its timeout as
// a **required argument**. A wait that inherits a bound nobody chose is now a
// type error rather than a line that reads as ordinary code, which is the only
// enforcement strong enough for a failure a reviewer will not catch.
//
// What still needs a grep is the other claim. `node:test` does ship fake timers
// — `mock.timers.enable()` — and a case that installed one would be a case whose
// task can never time out, passing for a reason unrelated to what it asserts.
// That is not visible in an assertion, so it is checked here.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { expect } from "expect";

// The source tree, read from either side of the build: `../src/` resolves to
// `e2e/src/` from a module in `e2e/src` and from its compiled twin in
// `e2e/dist`, and the suite now runs from the second.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every `.ts` under `src/`, harness included, this file excluded. */
function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith(".ts") && entry.name !== "harness-shape.test.ts") found.push(path);
  }
  return found;
}

describe("the suite's clock", () => {
  it("reads the source tree rather than the build output", () => {
    // The grep below is worth nothing if `sources` is walking `dist`, where
    // there are no `.ts` files to fail it. This is that file list's own control.
    expect(sources(SRC).map(path => path.slice(SRC.length))).toContain("harness/agent.ts");
  });

  it("installs no fake timers", () => {
    for (const path of sources(SRC)) {
      const text = readFileSync(path, "utf8");
      // Both spellings: the one `node:test` has now, and the one vitest had, so
      // a case carried over from an older branch fails here rather than passing
      // against a clock the loop cannot see.
      expect(text).not.toContain("mock.timers");
      expect(text).not.toContain("useFakeTimers");
    }
  });
});
