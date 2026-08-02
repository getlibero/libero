---
title: 'Phase 0: what exists, and what does not'
description: The repository is public at the skeleton stage. Here is an exact account of what is in it, what the specification promises, and why the gap is deliberate.
date: 2026-08-01
kind: post
---

Libero is public. It is also phase 0, which means the specification is a long way ahead of the
code, and it is worth being precise about which is which.

## What is in the repository

`packages/schema` — the zod schema for the team sheet: servers and their tool allowlist, approval
mode, budgets, egress, ambient. It is the single source of truth for that one shape, and both
services will import it. The audit, tool-call and memory schemas named in the
[architecture](/docs/architecture) are not written yet.

`packages/cli` — a placeholder `@getlibero/cli`. Nothing is on the npm registry yet. The release
workflow is wired for provenance attestations and fires on a `cli-v*` tag, so the release path gets
proven before there is anything worth releasing through it.

`site/` — this website: the marketing pages and the documentation.

CI — lint, typecheck, a licence gate that fails on copyleft, a grep-level check that
`packages/agent` never imports `packages/proxy`, and a guard that fails any `pull_request_target`
workflow containing a checkout step. There is a test runner too, with nothing in it yet.

## What is not

Everything that matters. `packages/{agent, gateway, memory, proxy}` are README stubs.
`apps/server`, `apps/proxy-server` and `e2e/` are empty directories.

There is no vault, no team-sheet enforcement, no approval broker, no budget meter, and no audit
log. The [architecture](/docs/architecture) describes all of them in detail. None of them exist.

## Why publish at this point

Two reasons.

The boundaries are easier to establish before there is code pressing against them. The
agent-cannot-import-proxy rule, the licence policy, the no-checkout rule for privileged workflows
— those are cheap now and expensive to retrofit after the first person has routed around them for
a good reason.

And the design of record is the thing worth arguing about. If the split between the two services
is wrong, or the team sheet is missing a control, that is a much better conversation to have
against a document than against six months of implementation.

## What happens next

Phase 1 is the governed core: vault, team-sheet enforcement, one real MCP server, approval cards,
budget meter, audit log and CLI.

It is not done when those things exist. It is done when a prompt-injected agent in a test channel
cannot exfiltrate a secret, call an unlisted tool, exceed budget, or act destructively without a
human click — demonstrated by e2e tests that try. Everything after that is gated behind it.
