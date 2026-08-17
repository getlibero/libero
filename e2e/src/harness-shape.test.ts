// Two claims the README makes about this suite's clock, enforced rather than
// described.
//
// The README has said since the suite existed that everything here runs on real
// time — the loop's wall clock is `AbortSignal.timeout`, which no fake timer can
// drive — and that vitest's defaults are too short, so timeouts are passed
// explicitly. Both were true of the two defaults the paragraph named. There is a
// third, `vi.waitFor`'s 1000 ms, and six call sites took it: in files whose
// `SETUP_MS` is a minute because the same rig mints certificates and spawns a
// process. One of them failed a CI run on nothing but a loaded runner, and a
// re-run of the same commit passed (#329).
//
// So the rule is now a grep, for the reason `packages/proxy/src/outbound.test.ts`
// gives about its own: the claim is about the whole tree and a grep cannot be
// routed around. It is also the *right* enforcement for this particular failure,
// which a reviewer will not catch — a wait with no timeout argument is not a
// suspicious line. It looks like ordinary code, and it is ordinary code
// everywhere except in a suite whose other waits are measured in minutes.
//
// Waiting belongs to the harness: `proxy.waitForLog` (woken, across a pipe),
// `agent.waitForLog` (polled, counted, in-process) and `waitForApprovalCard`.
// All three default to ten seconds and all three say what they were waiting for
// when they give up, which is the half `expected undefined to be defined` was
// missing.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

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
  // Matched on the import rather than on `vi.` — the lesson the proxy's greps
  // already teach is that a module explaining why something is confined has to
  // be able to name it, and this file's own header names `vi.waitFor` four
  // times. An import is the thing that would actually reintroduce it.
  it("imports vi nowhere, so no wait can inherit a default nobody chose", () => {
    const importers = sources(SRC).filter(path => {
      const text = readFileSync(path, "utf8");
      return /^import\s*\{[^}]*\bvi\b[^}]*\}\s*from\s*"vitest"/m.test(text);
    });

    expect(importers.map(path => path.slice(SRC.length))).toEqual([]);
  });

  // The companion, and the reason the first one is not merely tidiness. A fake
  // timer cannot drive `AbortSignal.timeout`, which is the loop's wall clock, so
  // a case that installed one would be a case whose task can never time out —
  // passing for a reason that has nothing to do with what it asserts.
  it("installs no fake timers", () => {
    for (const path of sources(SRC)) {
      expect(readFileSync(path, "utf8")).not.toContain("useFakeTimers");
    }
  });
});
