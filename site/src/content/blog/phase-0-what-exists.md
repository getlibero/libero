---
title: 'Phase 0: what exists, and what does not'
description: The repository is public at the skeleton stage. Here is an exact account of what is in it, what the specification promises, and why the gap is deliberate.
date: 2026-08-01
kind: post
---

Libero is public. It is also phase 0, which means the specification is a long way ahead of the
code, and it is worth being precise about which is which.

## What is in the repository

`packages/schema` — the zod schemas for team sheets, audit records, tool calls, approvals and
memory operations. This is the single source of truth both services will import from, and it is
real.

`packages/cli` — a placeholder `@getlibero/cli`, published to npm with provenance attestations so
the release path is proven before there is anything worth releasing through it.

`design/` — the design system: tokens, a component layer, brand marks, and a reference page that
renders every component in both modes. This site is built on it.

CI — lint, typecheck, tests, a licence gate that fails on copyleft, a grep-level check that
`packages/agent` never imports `packages/proxy`, and a guard that fails any `pull_request_target`
workflow containing a checkout step.

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
