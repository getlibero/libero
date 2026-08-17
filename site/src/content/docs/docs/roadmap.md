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

**Phase 2 — memory. Shipped.** Curation inner loop with tests, MEMORY.md tooling, sqlite-vec semantic recall.

*Definition of done: an agent curates `MEMORY.md` through a post-reply inner-loop turn with size-capped writes a later task reads back; semantic recall answers over thread summaries from the same per-channel file; both layers hold the one-file-per-channel isolation boundary and the curation write path survives the e2e suite's attacks.*

Two things landed differently from how this phase was first written down, and both are decisions rather than shortfalls. **The writes are not locked** — a lock file outliving a killed process is a worse failure than the one it prevents, so what replaces it is an atomic rename and a synchronous interface with no point at which a second operation could interleave. And **recall answers over thread summaries and not over curated facts**: `MEMORY.md` is already injected whole into every task's opening context, so retrieving over it would replace all of the corpus with some of it. Summaries are the corpus too large to inject, which is what makes them the one worth searching.

**Phase 3 — skills. Shipped.** Author turn, retrieval-based loading, lifecycle job, curator-as-diff.

*Definition of done: a qualifying task leaves a skill that a later task on the same subject retrieves and loads, and an unrelated task does not; retrieval records use, so the lifecycle clocks run on real signal; the files are the source of truth — a skill the team hand-edits is re-indexed and one the team deletes is gone; and the skill layer survives the e2e suite's attacks: authoring cannot escape the channel's skills directory or its size caps, and a poisoned skill loaded into a later task widens nothing — every call it induces still meets the proxy's gates.*

Three things landed differently from how this phase was first written down, and all three are decisions rather than shortfalls.

**The curator does not produce a diff**, which is this phase's own name for the item. A merged playbook is a rewrite rather than an edit, so hunks over two rewritten documents are unreadable — and a diff format would imply a patch tool that does not exist here. What a proposal shows instead is three whole documents: the merged file as it should read, and both originals beside it. Applying one is a paste over one file and a delete of another, which is one unambiguous act rather than a surgical edit.

**Where a proposal goes was forced rather than chosen.** The obvious surface is the channel, and this process cannot reach it: `postThreadReply` is deliberately withheld from the composing app so that a handler cannot post out of band, and an approval card needs a thread from an inbound event that a background pass does not have. A proactive post is ambient mode's mechanic, which ships in the next phase. So a proposal is a markdown file in the channel's own state root, and declining one is deleting it.

**The lifecycle job runs on channel activity rather than weekly.** The clocks are absolute dates, so the job is idempotent: running it more often moves nothing sooner than its threshold and running it less often only delays. "Weekly" is a statement about how often a status needs revisiting, and any interval at or below it satisfies that — where a cron would mean this process growing a timer and an enumerator over every channel, neither of which anything else here needs.

**Phase 4 — ambient. Next.** Heartbeat, `schedule_task`, rate limits — all behind budgets.

**Phase 5 — breadth.** Second platform adapter (Discord), durable multi-day orchestration option (Temporal), hardening pass on the proxy, audit hash-chaining for tamper evidence.

## What success looks like

Not stars: unaffiliated teams self-hosting the governed core in real workspaces, and the e2e security suite passing against every release.
