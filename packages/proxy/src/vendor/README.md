# vendor/

Third-party source copied into this package rather than depended on. One file
today.

A directory rather than a filename suffix, so provenance shows up in every
import path — `./vendor/mcp-param-headers.js` reads as borrowed at the call
site, which `./mcp-param-headers.js` would not.

## The rule

**Vendored code is a copy, not a fork.** Do not fix, tidy, or restyle anything
in here. If a line looks wrong, it is wrong upstream, and the fix is an issue
there plus a version bump here. The only permitted edits are removing code we do
not use and adding the attribution header, and both must be described in that
header.

**`scripts/license-check.sh` cannot see any of this.** It walks `package.json`
dependency trees, and a copied file is not a dependency. So attribution here is
an obligation kept by review rather than by CI — which is the reason the header
of each file states the source repository, the exact commit, the release it
corresponds to, and what was removed.

**Each file needs a test that fails when upstream's behaviour changes.** A
vendored copy silently diverging is the whole hazard, and a version bump does not
touch it. `mcp-param-headers.test.ts` pins the codec against the SDK's own
mirroring over a real connection, so a bump that changes the encoding goes red
here rather than at an upstream that rejects our headers.

## What is here

- `mcp-param-headers.ts` — the client half of SEP-2243's `Mcp-Param-*` codec,
  from `@modelcontextprotocol/client@2.0.0`. Needed because the SDK mirrors
  these headers only on a `2026-07-28` connection — correct, since
  `x-mcp-header` exists only in that revision — while GitHub's hosted server
  negotiates `2025-11-25` and requires them anyway, declining SEP-2243's
  optional headerless-legacy courtesy. Both sides are within spec and no
  published SDK can call an annotated tool on that server; that is the gap #130
  hit. Filed upstream as
  [typescript-sdk#2639](https://github.com/modelcontextprotocol/typescript-sdk/issues/2639).
  When the SDK mirrors on legacy connections, this file and its one call site go.
- `LICENSE.modelcontextprotocol` — the upstream licence, reproduced whole. The
  project is mid-transition from MIT to Apache-2.0, so it carries both texts;
  see the vendored file's header for which applies and why nothing turns on it.
