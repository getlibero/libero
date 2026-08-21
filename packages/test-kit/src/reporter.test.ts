// The reporter decides whether a run failed, so it is the one thing here that
// must not be trusted to a green build of its own. Every guard is exercised in
// both directions: the case it must catch, and the case it must not.
//
// `problems` and `summaryLines` are tested rather than the generator's exit
// code, and that separation is the reason the module has them. A test that
// drove the reporter into its failing state would set `process.exitCode = 1` on
// the very process running the suite, and this file would fail the build by
// proving it works.

import { describe, it } from "node:test";
import { expect } from "expect";

import report, {
  ALLOWED_SKIPS,
  namesItsOwnFile,
  shortFile,
  problems,
  summaryLines
} from "./reporter.js";
import type { Tally } from "./reporter.js";
import { each } from "./each.js";

const CLEAN: Tally = {
  passed: 3,
  todo: 0,
  skipped: [],
  failed: [],
  silentFiles: [],
  filesSeen: 1,
  collected: 3
};

const text = (tally: Tally): string => [...summaryLines(tally)].join("");

describe("a clean run", () => {
  it("has nothing to report beyond its counts", () => {
    expect(problems(CLEAN)).toEqual([]);
    expect(text(CLEAN)).toBe("\n3 passed, 0 failed, 1 file\n");
  });

  it("pluralizes the file count", () => {
    expect(text({ ...CLEAN, filesSeen: 4 })).toContain("4 files");
  });
});

describe("a run that collected nothing", () => {
  // The whole reason this reporter exists: `node --test` over a glob matching
  // nothing reports zero tests and exits 0.
  it("is a failure, not a pass", () => {
    expect(problems({ ...CLEAN, passed: 0, collected: 0, filesSeen: 0 })).toEqual([
      "no tests were collected"
    ]);
  });

  it("falls back to what it saw when the runner sent no count", () => {
    expect(problems({ ...CLEAN, passed: 0, collected: undefined, filesSeen: 0 })).toEqual([
      "no tests were collected"
    ]);
    expect(problems({ ...CLEAN, passed: 1, collected: undefined })).toEqual([]);
  });
});

describe("a file that registered nothing", () => {
  it("is a failure", () => {
    expect(problems({ ...CLEAN, silentFiles: ["orphan.test.js"] })).toEqual([
      "orphan.test.js registered no tests"
    ]);
  });

  // The false positive this had on its first run. `github-live.test.ts` is one
  // skipped `describe` and nothing else, and the runner counts a skipped suite
  // under `suites` — never under `tests`, and never its children at all. The
  // file is honestly reported by the skip list; it has not gone quiet.
  it("is not a failure when the file is a skipped suite and nothing else", () => {
    const allowed = ALLOWED_SKIPS.find(entry => entry.file === "github-live.test.js");
    expect(allowed).toBeDefined();
    expect(
      problems({
        ...CLEAN,
        silentFiles: ["github-live.test.js"],
        skipped: [{ name: allowed?.name ?? "", file: "github-live.test.js", suite: true }]
      })
    ).toEqual([]);
  });
});

// The shape found by running the guard rather than reasoning about it: a file
// declaring nothing is reported as a passing test named after itself, with no
// per-file summary to carry a zero. Left unhandled it counted as a pass, which
// is the state this whole reporter exists to refuse.
describe("an event that names its own file", () => {
  it("is the runner reporting an empty file, not a case that passed", () => {
    expect(namesItsOwnFile("e/empty.test.js", "/repo/packages/x/dist/e/empty.test.js")).toBe(true);
  });

  it("is not an ordinary case, whatever it is called", () => {
    expect(namesItsOwnFile("also passes", "/repo/packages/x/dist/full.test.js")).toBe(false);
    // The name is a suffix of the path, but not the tail of it.
    expect(namesItsOwnFile("test.js", "/repo/packages/x/dist/full.test.js")).toBe(false);
    expect(namesItsOwnFile(undefined, "/repo/a.test.js")).toBe(false);
    expect(namesItsOwnFile("a.test.js", undefined)).toBe(false);
  });
});

describe("a skip", () => {
  const allowed = ALLOWED_SKIPS[0];

  it("passes when the allowed list accounts for it", () => {
    expect(
      problems({
        ...CLEAN,
        skipped: [{ name: allowed?.name ?? "", file: allowed?.file ?? "", suite: true }]
      })
    ).toEqual([]);
  });

  it("fails the run when nothing accounts for it", () => {
    expect(
      problems({
        ...CLEAN,
        skipped: [{ name: "a flaky case somebody quieted", file: "somewhere.test.js", suite: false }]
      })
    ).toEqual([
      "a flaky case somebody quieted (somewhere.test.js) skipped, and is not on the allowed list"
    ]);
  });

  // Both halves of the key, so that an entry cannot be borrowed by a case of
  // the same name in another file or a different case in the same one.
  each([
    ["the file", { name: allowed?.name ?? "", file: "elsewhere.test.js" }],
    ["the name", { name: "something else entirely", file: allowed?.file ?? "" }]
  ])("is not accounted for when only %s matches", (_label, entry) => {
    expect(problems({ ...CLEAN, skipped: [{ ...entry, suite: true }] })).toHaveLength(1);
  });

  // A run that collected nothing has no skip to explain, and pointing its
  // reader at ALLOWED_SKIPS sends them to the wrong file.
  it("draws the advice about the allowed list only when a skip is what went wrong", () => {
    const empty: Tally = { ...CLEAN, passed: 0, collected: 0, filesSeen: 0 };
    expect(text(empty)).toContain("no tests were collected");
    expect(text(empty)).not.toContain("ALLOWED_SKIPS");

    const quieted: Tally = {
      ...CLEAN,
      skipped: [{ name: "quieted", file: "somewhere.test.js", suite: false }]
    };
    expect(text(quieted)).toContain("ALLOWED_SKIPS");
  });

  it("is named in the output, and marked when it is not allowed", () => {
    const out = text({
      ...CLEAN,
      skipped: [
        { name: allowed?.name ?? "", file: allowed?.file ?? "", suite: true },
        { name: "unexpected", file: "somewhere.test.js", suite: false }
      ]
    });
    expect(out).toContain(`  suite ${allowed?.name ?? ""} — ${allowed?.file ?? ""}\n`);
    expect(out).toContain("  unexpected — somewhere.test.js  NOT ON THE ALLOWED LIST\n");
    expect(out).toContain("2 skipped");
  });
});

describe("a failure", () => {
  const tally: Tally = {
    ...CLEAN,
    failed: [{ name: "refuses the call", file: "enforce.test.js", error: "Error: boom\n  at x" }]
  };

  it("prints in full, indented, under the case that produced it", () => {
    const out = text(tally);
    expect(out).toContain("failed:");
    expect(out).toContain("  refuses the call — enforce.test.js");
    expect(out).toContain("    Error: boom\n      at x");
  });

  // The counts are the reporter's own, so a failed run still says how much ran.
  it("is counted rather than swallowed", () => {
    expect(text(tally)).toContain("3 passed, 1 failed");
  });

  // Failing on its own is what the runner's exit code is already for. Adding it
  // here would make every ordinary red build print this file's advice about
  // skips, which is about something else.
  it("is not one of this reporter's own problems", () => {
    expect(problems(tally)).toEqual([]);
  });
});

describe("the file a case is attributed to", () => {
  it("is the path below the package's dist, which is what the allowed list names", () => {
    expect(shortFile("/Users/x/src/libero/packages/proxy/dist/vault.test.js")).toBe("vault.test.js");
    expect(shortFile("/repo/e2e/dist/harness/agent.test.js")).toBe("harness/agent.test.js");
  });

  it("is left alone when there is no dist in it, and named when there is no file at all", () => {
    expect(shortFile("/tmp/loose.test.js")).toBe("/tmp/loose.test.js");
    expect(shortFile(undefined)).toBe("(unknown file)");
  });
});

describe("the allowed list", () => {
  it("gives every entry a reason", () => {
    for (const entry of ALLOWED_SKIPS) {
      expect({ name: entry.name, hasWhy: entry.why.length > 10 }).toEqual({
        name: entry.name,
        hasWhy: true
      });
    }
  });

  it("names each case once", () => {
    const keys = ALLOWED_SKIPS.map(entry => `${entry.file}::${entry.name}`);
    expect(keys).toHaveLength(new Set(keys).size);
  });
});

// The wiring the pure functions cannot cover: which events become which
// character, and which are deliberately ignored. Driven over a synthetic stream
// with nothing wrong in it, so running this cannot set `process.exitCode`.
describe("reading the runner's events", () => {
  // A file and a suite name the allowed list accounts for, so that driving the
  // reporter here cannot reach its failing branch. `run` restores
  // `process.exitCode` regardless, because "cannot" is a claim about today's
  // fixture and the cost of it being wrong is this suite failing green builds.
  const file = "/repo/e2e/dist/github-live.test.js";
  const SKIPPED_SUITE = "against api.githubcopilot.com";

  async function* stream(): AsyncGenerator<{ type: string; data: unknown }> {
    yield { type: "test:pass", data: { name: "one", file, details: { type: "test" } } };
    yield { type: "test:pass", data: { name: "two", file, details: { type: "test" } } };
    // A skipped suite: one event, and its cases never arrive at all.
    yield {
      type: "test:pass",
      data: { name: SKIPPED_SUITE, file, skip: true, details: { type: "suite" } }
    };
    // The suite that held the two passes. Not a case, so not a dot.
    yield { type: "test:pass", data: { name: "a suite", file, details: { type: "suite" } } };
    yield { type: "test:stdout", data: { message: "a line a test printed\n" } };
    yield { type: "test:enqueue", data: { name: "one", file } };
    yield { type: "test:summary", data: { file, counts: { tests: 2 } } };
    yield { type: "test:summary", data: { counts: { tests: 2 } } };
  }

  async function run(): Promise<string> {
    const before = process.exitCode;
    try {
      let out = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const chunk of report(stream() as any)) out += chunk;
      return out;
    } finally {
      process.exitCode = before;
    }
  }

  it("marks a case per character and leaves suites out of the count", async () => {
    const out = await run();
    expect(out).toContain("..-");
    expect(out).toContain("2 passed, 0 failed, 1 skipped, 1 file");
    expect(out).not.toContain("..-.");
  });

  it("names the skipped suite it was given, as a suite", async () => {
    expect(await run()).toContain(`  suite ${SKIPPED_SUITE} — github-live.test.js`);
  });

  it("passes a test's own output through rather than swallowing it", async () => {
    expect(await run()).toContain("a line a test printed");
  });

  it("finds nothing wrong with a file whose only skip is its one suite", async () => {
    expect(await run()).not.toContain("registered no tests");
    expect(await run()).not.toContain("NOT ON THE ALLOWED LIST");
  });
});
