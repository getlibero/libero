# @getlibero/test-kit

The two things `node:test` does not have and this repository's suite needs.
Private, never published, and a devDependency of every package that has tests.

## Why it is a package rather than a copied file

CLAUDE.md's rule is that a duplicated helper needs a home before it is copied,
and #272 is the worked example: the durable-replace recipe existed three times
until it became `@getlibero/atomic-write`. `each` has 155 call sites spread
across ten packages, which is exactly the shape that gets copied.

It is importable from anywhere for the same reason `@getlibero/atomic-write`
is: **it declares no dependencies at all** and imports nothing but `node:`
builtins, so the edge puts no code into either service's image. That matters for
`packages/memory`, which is a leaf and may not import either service — the
ESLint block there bans the two services by name, and this package is not one of
them because it cannot pull either in.

## What is here, and what deliberately is not

`each`, `waitFor`, and the suite's reporter. Nothing else.

There is **no re-export of `describe`, `it`, `expect` or the lifecycle hooks**.
A test file names `node:test` and `expect` directly, so it says which runner and
which assertion library it is using. A facade over both would put this package
on the path of every assertion in the repository while adding nothing.

### `each`

`it.each`, spelled as a drop-in so that #202's migration off vitest could be a
rewrite of one token per call site and leave every assertion untouched. Two
vitest behaviours are copied because tests depend on them: an array case is
spread across the callback's parameters and a non-array case is not, and a name
consumes only as many arguments as it has placeholders.

### `waitFor`

Polling until an assertion holds, with a **required** timeout. That is the
point of it. `vi.waitFor` defaulted to a second, six e2e call sites silently
took the default inside rigs whose other waits are minutes, and one of them
failed a CI run on a loaded runner (#329) — a wait with no timeout argument is
not a suspicious line, so it survived review. `e2e/src/harness-shape.test.ts`
grepped for the import to stop that recurring; a required parameter is the same
rule enforced by the type system, which is why that grep is gone.

On timeout it throws the last failure rather than a bare deadline message, so
the answer to "waiting for what?" is in the error.

### The reporter

`--test-reporter=@getlibero/test-kit/reporter`, which every package's `test`
script names. Dots while it runs — `node:test`'s `spec` is a line per test and
four thousand lines of CI log for a run whose durable signal is an exit code —
and four things at the end that `dot` does not say, two of which turn a silent
green state into a failure:

| | |
| --- | --- |
| Counts | `dot` prints none at all, not even on a clean run. |
| Nothing collected → **fail** | `node --test` over a glob matching nothing exits 0. This is the stronger half of `test-scripts.test.ts`'s guard: that catches a mistyped glob, this catches a `tsconfig` `include` that stopped matching, a build that emitted nothing, a renamed directory. |
| A file that registered nothing → **fail** | The same failure one level down: the glob found it, it loaded, it declared no case. |
| Every skip named, with its file | The repository's own rule, which `apps/runner/src/sandbox.docker.test.ts` records being bitten by — thirteen cases skipped and a green build. Under `dot` a skip is an invisible character. |
| An unallowed skip → **fail** | `ALLOWED_SKIPS` lists the cases entitled to skip and why. A flaky test quieted with `{ skip: true }` fails here instead of passing. |

`ALLOWED_SKIPS` says a case *may* skip, not that it *does*: the Docker suites run
in CI and skip on a laptop, which is the arrangement it exists to permit. That
also means a stale entry is undetectable — nothing in a run where Docker is
present distinguishes "no longer skips" from "did not skip today" — so a stale
entry is not treated as an error.

Two things the runner does that the reporter has to work around, both recorded
where they bite:

- **A skipped `describe` is one event and its children are never events at
  all.** It appears in neither `counts.tests` nor `counts.skipped`, so skips are
  tallied here rather than read off `test:summary`. It is also why a file that is
  one skipped suite reports zero tests and must not be called silent.
- **A test's file is the call site of `it`,** so every case `each` registers is
  attributed to `each.js` rather than to the file that asked for it. A failure's
  stack still names the real file; an `ALLOWED_SKIPS` entry has to spell it the
  runner's way.

The decision and the printing are separate functions — `problems` and
`summaryLines` — because a module whose job is setting `process.exitCode` cannot
otherwise be tested from inside a test run without failing it.
`src/reporter.test.ts` exercises every guard in both directions.

## The two checks that are not helpers

`each`, `waitFor` and the reporter are what other packages import. Two test
files here import nothing and are checks on the repository, and they live in
this package because it is the one about how the suite runs and because it
depends on nothing else in the tree.

- **`test-scripts.test.ts`** — every package's `test` script is the same string,
  and its `build` and `typecheck` are the invocations that string assumes. The
  hazard is #107's successor: a glob that matches nothing exits 0.
- **`ci-partition.test.ts`** — every workspace package is run by exactly one job
  in `.github/workflows/ci.yml`. The hazard is one level out: a package no job
  runs, which the reporter cannot see because there is no run to report on.
  #410 created it by moving `@getlibero/runner` to the `e2e` job, where the
  Docker daemon and the sandbox fixtures already are. Its parser understands the
  filter syntax those two lines use and **throws on anything else**, because
  quietly mis-modelling a flag would assert a partition CI does not perform.

Both read the workspace off disk through `workspace.ts`, which is not exported:
the list neither can hardcode is the same list, and the thing they exist to
catch is a package nobody remembered.

## Running the suite

Every package's `test` script compiles and then runs `node --test` over `dist`,
this one included. `packages/test-kit` has no dependency on the rest of the
workspace, so it can be run on its own:

```sh
pnpm --filter @getlibero/test-kit test
```
