---
title: Roadmap
description: Phase-gated delivery. The governed core — vault, enforcement, approvals, budgets, audit — comes before anything that depends on it.
---

Phases are gated: later phases do not start until the governed core is solid.

**Phase 0 — skeleton. Shipped.** Monorepo, schema package, design system, site, docker-compose skeleton, CI with lint/typecheck/tests/license gate + CLA bot. `@getlibero/cli` placeholder published with provenance.

**Phase 1 — the governed core. Shipped.** Slack gateway and agent loop — a hello-world agent answers a mention in a real channel — with a mock Slack harness for tests. Proxy end-to-end: vault, team-sheet enforcement, one real MCP server (GitHub), HITL approval cards, budget meter, audit log + CLI. Channel router, attribution, live checklist. FTS message store.

*Definition of done: a prompt-injected agent in a test channel cannot exfiltrate a secret, call an unlisted tool, exceed budget, or act destructively without a human click — demonstrated by e2e tests that try.* Those tests live in `e2e/`, one file per property, and they pass against every change.

**Phase 1.5 — consolidation. Shipped.** What phase 1 built, made solid and operable before memory lands on top: pool discipline against a hostile or broken upstream, a bounded shutdown drain, spend-denominated budget caps that fail closed on an unpriced model, the CLI's host-authored half — `init`, `channel add`, `doctor` — OAuth for MCP upstreams, and deployment guides for GCP and AWS.

*Definition of done: a hostile or broken MCP upstream cannot wedge the pool, bypass the listing bounds, or widen a channel's grant; SIGTERM loses at most one turn's spend, within a stated bound; a channel can be capped in dollars, failing closed on an unpriced model; the quick start's first command either works or fails loudly; an OAuth-secured MCP upstream can be declared in a sheet and called, with the proxy minting and rotating the token and the agent never seeing it; an operator can follow a guide from a fresh GCP or AWS account to a working mention-and-reply.*

**Phase 2 — memory. In progress.** Curation inner loop with tests, MEMORY.md tooling, sqlite-vec semantic recall.

**Phase 3 — skills.** Author turn, retrieval-based loading, lifecycle job, curator-as-diff.

**Phase 4 — ambient.** Heartbeat, `schedule_task`, rate limits — all behind budgets.

**Phase 5 — breadth.** Second platform adapter (Discord), durable multi-day orchestration option (Temporal), hardening pass on the proxy, audit hash-chaining for tamper evidence.

## What success looks like

Not stars: unaffiliated teams self-hosting the governed core in real workspaces, and the e2e security suite passing against every release.
