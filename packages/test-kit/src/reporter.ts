// The suite's reporter: dots while it runs, and four things at the end that
// `node:test`'s own reporters do not say.
//
// `dot` was chosen over `spec` because a line per test is four thousand lines
// of CI log for a run whose durable signal is an exit code. What `dot` gives up
// is everything except that exit code — it prints **no counts at all**, not even
// on a clean run. This adds back the parts that carry information, and turns two
// silent green states into failures.
//
// ## Why a reporter and not a test
//
// Three of the four are claims about the run as a whole, which nothing running
// *inside* the run can observe. A test cannot see that it was the only one
// collected, and it certainly cannot see that it was not collected at all.
//
//   1. **Nothing collected fails the run.** `node --test` over a glob matching
//      nothing exits 0 — it reports zero tests and passes. That is the successor
//      to #107 and the reason `test-scripts.test.ts` exists; this is the
//      stronger half of the same guard, because that file catches a mistyped
//      glob and this catches every other cause: a `tsconfig` `include` that
//      stopped matching, a build that emitted nothing, a renamed directory, a
//      package given a `test` script before it has a test.
//   2. **A file that registered nothing is named.** The same failure one level
//      down: the glob found the file, the file loaded, and it declared no test.
//   3. **Every skip is named, with its file.** This is the one the repository's
//      own rule asks for. `apps/runner/src/sandbox.docker.test.ts` records the
//      day this exact thing happened — thirteen cases skipped and a green build
//      — and under `dot` a skip is an invisible character. Note that the
//      runner's own counts do not help here: a skipped `describe` is reported as
//      one suite and its children are never events at all, so it appears in
//      neither `counts.tests` nor `counts.skipped`. This tallies it itself.
//   4. **An unskippable skip fails the run.** `ALLOWED_SKIPS` below is the list
//      of cases entitled to skip and why. Anything else — a flaky test quieted
//      with `{ skip: true }` — fails here rather than passing quietly. The list
//      says *may* skip, not *does*: the Docker cases run in CI and skip on a
//      laptop, which is the arrangement it exists to permit.
//
// A stale entry is not detectable and is not treated as an error, for that last
// reason: nothing in a run where Docker is present distinguishes "this case no
// longer skips" from "this case did not skip today".

import type { TestEvent } from "node:test/reporters";

/**
 * The cases entitled to skip, and why.
 *
 * `file` is the path below the package's `dist/`, which is what makes an entry
 * specific without pinning it to a checkout's absolute path. `name` is the test
 * or suite name exactly. Both must match.
 */
export interface AllowedSkip {
  readonly file: string;
  readonly name: string;
  readonly why: string;
}

export const ALLOWED_SKIPS: readonly AllowedSkip[] = [
  // Two-sided gates. Absent daemon and not CI: skipped, so a contributor
  // without Docker can still run everything else. Absent daemon under CI: the
  // file throws at import rather than reaching this list at all.
  {
    file: "sandbox.docker.test.js",
    name: "a real sandbox container",
    why: "needs a Docker daemon; #395's acceptance, and the file throws rather than skipping under CI"
  },
  {
    file: "sandbox.docker.test.js",
    name: "a sandbox with an egress grant",
    why: "needs a Docker daemon; same two-sided gate as the block above"
  },
  {
    file: "sandbox-attack.test.js",
    name: "attacking the sandbox",
    why: "needs a Docker daemon; #396's acceptance, and the file throws rather than skipping under CI"
  },
  {
    file: "sidecar.docker.test.js",
    name: "a live LiteLLM sidecar, through the agent's own adapters",
    why: "needs a Docker daemon to start the sidecar; #480's acceptance, and the file throws rather than skipping under CI"
  },
  // Reaches the real GitHub, so it needs a credential CI does not have.
  {
    file: "github-live.test.js",
    name: "against api.githubcopilot.com",
    why: "needs LIBERO_GITHUB_PAT; #130's acceptance, run by hand"
  },
  // Root reads and writes through a mode this asserts it cannot, so the case
  // would pass while proving nothing in the environment where it ran.
  {
    file: "memory-file.test.js",
    name: "leaves the old file intact when a write fails",
    why: "meaningless as root, which ignores the directory mode it depends on"
  },
  {
    file: "vault.test.js",
    name: "refuses to open a vault it cannot stat rather than starting empty",
    why: "meaningless as root, which reads through mode 000"
  },
  {
    file: "vault-file.test.js",
    name: "refuses a vault it cannot read rather than treating it as empty",
    why: "meaningless as root, which reads through mode 000"
  },
  {
    file: "vault-cli.test.js",
    name: "refuses to touch a vault it cannot read",
    why: "meaningless as root, which reads through mode 000"
  },
  // The one permanent entry, and the only one that is not conditional: the skip
  // *is* the assertion. `each` forwarding a `{ skip }` option to `node:test` is
  // observable only as a case that did not run.
  //
  // `each.js` and not `each.test.js`, which is not a typo. `node:test` takes a
  // test's file from the call site of `it`, so every case `each` registers is
  // attributed to the helper rather than to the file that asked for it. It costs
  // nothing on a failure — the stack still runs through the callback, which is
  // declared in the test file — but it is what an entry here has to name.
  {
    file: "each.js",
    name: "passes node:test options through: a case",
    why: "the skip is the assertion — it is how `each` proves it forwarded the option"
  }
];

/** Dots per line. Wide enough to be compact, narrow enough to read a count off. */
const COLUMNS = 50;

/** A case that did not run. A skipped `describe` arrives as one of these, not as its children. */
export interface Skipped {
  readonly name: string;
  readonly file: string;
  readonly suite: boolean;
}

/** A case that ran and failed. Suites are excluded — see the reason at the `test:fail` arm. */
export interface Failed {
  readonly name: string;
  readonly file: string;
  readonly error: string;
}

/** Everything the run said, as one value, so that what it means is decided by a pure function. */
export interface Tally {
  readonly passed: number;
  readonly todo: number;
  readonly skipped: readonly Skipped[];
  readonly failed: readonly Failed[];
  /** Files whose own summary reported no tests. Not yet a problem — see `problems`. */
  readonly silentFiles: readonly string[];
  readonly filesSeen: number;
  /** The runner's own whole-run count, or undefined if it never sent one. */
  readonly collected: number | undefined;
}

/** The path below a package's `dist/`, which is what `ALLOWED_SKIPS` names. */
export function shortFile(file: string | undefined): string {
  if (file === undefined) return "(unknown file)";
  const at = file.lastIndexOf("/dist/");
  return at === -1 ? file : file.slice(at + "/dist/".length);
}

/**
 * Whether an event is the runner reporting on a *file* rather than on a case in
 * one.
 *
 * A file that declares no test at all is itself reported as a passing test —
 * `name` is the path the runner was given, and no per-file `test:summary`
 * follows. It lands in `counts.tests` as a pass, which is exactly how a suite
 * that stopped declaring anything looks green. So it is detected here and
 * counted as a silent file instead.
 */
export function namesItsOwnFile(name: string | undefined, file: string | undefined): boolean {
  if (name === undefined || file === undefined || name === "") return false;
  // On a path boundary, not on a suffix: `full.test.js` ends with the string
  // `test.js`, and a case called that is a case rather than a file.
  return file === name || file.endsWith(`/${name}`);
}

/** The skips nothing in `ALLOWED_SKIPS` accounts for. */
export function unexpectedSkips(skipped: readonly Skipped[]): readonly Skipped[] {
  return skipped.filter(
    entry => !ALLOWED_SKIPS.some(a => a.file === entry.file && a.name === entry.name)
  );
}

/**
 * Why this run should fail, beyond the cases that failed on their own.
 *
 * Separate from the reporter that prints it, and pure, because the alternative
 * is a module whose whole job is setting `process.exitCode` and which therefore
 * cannot be tested from inside a test run without failing it.
 */
export function problems(tally: Tally): readonly string[] {
  const found: string[] = [];

  // A file that reported nothing *and* skipped nothing. The glob found it and
  // it loaded, and it declared no case at all — a file that stopped being a
  // test rather than a file that passed. `github-live.test.ts` is why the
  // second half of that condition is there: it is one skipped suite and nothing
  // else, because the runner counts a skipped suite under `suites` and never
  // counts the cases inside it. That is a state the skip list already reports
  // honestly.
  const registeredNothing = tally.silentFiles.filter(
    file => !tally.skipped.some(entry => entry.file === file)
  );
  for (const file of registeredNothing) found.push(`${file} registered no tests`);

  for (const entry of unexpectedSkips(tally.skipped)) {
    found.push(`${entry.name} (${entry.file}) skipped, and is not on the allowed list`);
  }

  // `node --test` exits 0 over a glob that matches nothing, which is the whole
  // hazard. Counted from the runner where it said, and from what was seen where
  // it did not.
  const total = tally.collected ?? tally.passed + tally.failed.length + tally.skipped.length;
  if (total === 0) found.push("no tests were collected");

  return found;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map(line => (line === "" ? line : `    ${line}`))
    .join("\n");
}

/** Everything printed after the last dot. */
export function* summaryLines(tally: Tally): Generator<string> {
  if (tally.failed.length > 0) {
    yield "\nfailed:\n";
    for (const failure of tally.failed) {
      yield `\n  ${failure.name} — ${failure.file}\n${indent(failure.error)}\n`;
    }
  }

  if (tally.skipped.length > 0) {
    const unexpected = new Set(unexpectedSkips(tally.skipped));
    yield "\nskipped:\n";
    for (const entry of tally.skipped) {
      const note = unexpected.has(entry) ? "  NOT ON THE ALLOWED LIST" : "";
      yield `  ${entry.suite ? "suite " : ""}${entry.name} — ${entry.file}${note}\n`;
    }
  }

  const parts = [`${tally.passed} passed`, `${tally.failed.length} failed`];
  if (tally.skipped.length > 0) parts.push(`${tally.skipped.length} skipped`);
  if (tally.todo > 0) parts.push(`${tally.todo} todo`);
  parts.push(`${tally.filesSeen} ${tally.filesSeen === 1 ? "file" : "files"}`);
  yield `\n${parts.join(", ")}\n`;

  const found = problems(tally);
  if (found.length === 0) return;

  yield "\n";
  for (const problem of found) yield `${problem}\n`;
  // Advice only where it applies. A run that collected nothing has no skip to
  // explain, and telling its reader about `ALLOWED_SKIPS` sends them to the
  // wrong file.
  if (unexpectedSkips(tally.skipped).length > 0) {
    yield "A skip is a case that is not being run. If it is entitled to skip, say so with a reason in @getlibero/test-kit's ALLOWED_SKIPS.\n";
  }
}

/** What the reporter reads off each event. `node:test`'s own type is a union over every arm. */
interface EventData {
  name?: string;
  file?: string;
  skip?: boolean | string;
  todo?: boolean | string;
  message?: string;
  details?: { type?: string; error?: Error };
  counts?: { tests: number };
}

export default async function* report(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  let passed = 0;
  let todo = 0;
  let filesSeen = 0;
  let collected: number | undefined;
  let column = 0;
  const skipped: Skipped[] = [];
  const failed: Failed[] = [];
  const silentFiles: string[] = [];

  /** One character per case, wrapped. */
  const mark = (character: string): string => {
    column += 1;
    return column % COLUMNS === 0 ? `${character}\n` : character;
  };

  for await (const event of source) {
    const data = event.data as EventData;
    const kind = data.details?.type;

    switch (event.type) {
      case "test:pass": {
        // A skipped `describe` arrives here, once, with `skip` set and no events
        // for the cases inside it — which is why skips are tallied rather than
        // read off `test:summary`, where they do not appear at all.
        if (namesItsOwnFile(data.name, data.file)) {
          filesSeen += 1;
          silentFiles.push(shortFile(data.file));
        } else if (data.skip !== undefined && data.skip !== false) {
          skipped.push({
            name: data.name ?? "(unnamed)",
            file: shortFile(data.file),
            suite: kind === "suite"
          });
          yield mark("-");
        } else if (data.todo !== undefined && data.todo !== false) {
          todo += 1;
          yield mark("*");
        } else if (kind !== "suite") {
          // A suite that merely contains passing cases is not a case itself.
          passed += 1;
          yield mark(".");
        }
        break;
      }
      case "test:fail": {
        // A failing suite reports again for every ancestor with "1 subtest
        // failed", which is one failure told three times.
        if (kind === "suite") break;
        const error = data.details?.error;
        failed.push({
          name: data.name ?? "(unnamed)",
          file: shortFile(data.file),
          error: error?.stack ?? error?.message ?? "(no error)"
        });
        yield mark("X");
        break;
      }
      case "test:stdout":
      case "test:stderr": {
        // Never swallowed: a test that writes is usually a test being debugged.
        // The newline keeps the output off the dot line rather than through it.
        column = 0;
        yield `\n${data.message ?? ""}`;
        break;
      }
      case "test:summary": {
        if (data.file === undefined) collected = data.counts?.tests;
        else {
          filesSeen += 1;
          if (data.counts?.tests === 0) silentFiles.push(shortFile(data.file));
        }
        break;
      }
      default:
        break;
    }
  }

  const tally: Tally = { passed, todo, skipped, failed, silentFiles, filesSeen, collected };

  yield column % COLUMNS === 0 ? "" : "\n";
  yield* summaryLines(tally);

  if (problems(tally).length > 0) process.exitCode = 1;
}
