---
title: Roadmap
description: Phase-gated delivery. The governed core — vault, enforcement, approvals, budgets, audit — comes before anything that depends on it.
---

Phases are gated: later phases do not start until the governed core is solid.

**Phase 0 — skeleton.** Monorepo, schema package, docker-compose, mock Slack harness, CI with lint/typecheck/tests/license gate + CLA bot. `@getlibero/cli` placeholder published with provenance wiring. A hello-world agent answers a mention in a real channel.

**Phase 1 — the governed core.** Proxy end-to-end: vault, team-sheet enforcement, one real MCP server (GitHub), HITL approval cards, budget meter, audit log + CLI. Channel router, attribution, live checklist. FTS message store.

*Definition of done: a prompt-injected agent in a test channel cannot exfiltrate a secret, call an unlisted tool, exceed budget, or act destructively without a human click — demonstrated by e2e tests that try.*

**Phase 2 — memory.** Curation inner loop with tests, MEMORY.md tooling, sqlite-vec semantic recall, Slack-deletion mirroring.

**Phase 3 — skills.** Author turn, retrieval-based loading, lifecycle job, curator-as-diff.

**Phase 4 — ambient.** Heartbeat, `schedule_task`, rate limits — all behind budgets.

**Phase 5 — breadth.** Second platform adapter (Discord), durable multi-day orchestration option (Temporal), hardening pass on the proxy, audit hash-chaining for tamper evidence.

## What success looks like

Not stars: unaffiliated teams self-hosting the governed core in real workspaces, and the e2e security suite passing against every release.
