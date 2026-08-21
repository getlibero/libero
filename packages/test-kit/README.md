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

`each` and `waitFor`. Nothing else.

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

## Running the suite

Every package's `test` script compiles and then runs `node --test` over `dist`,
this one included. `packages/test-kit` has no dependency on the rest of the
workspace, so it can be run on its own:

```sh
pnpm --filter @getlibero/test-kit test
```
