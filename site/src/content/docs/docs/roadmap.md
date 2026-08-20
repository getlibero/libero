---
title: Roadmap
description: The phase record — the governed core before anything that depends on it — and the release milestones that follow it.
---

Phases were gated: a later phase did not start until the governed core was solid. Every phase is shipped; the releases that follow them close this page.

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

**Where a proposal goes was forced rather than chosen.** The obvious surface is the channel, and this process cannot reach it: `postThreadReply` is deliberately withheld from the composing app so that a handler cannot post out of band, and an approval card needs a thread from an inbound event that a background pass does not have. A proactive post is ambient mode's mechanic, and phase 4 wired it (#320): a waiting proposal is now named in the channel once, while the file stays the review surface. So a proposal is a markdown file in the channel's own state root, and declining one is still deleting it.

**The lifecycle job runs on channel activity rather than weekly.** The clocks are absolute dates, so the job is idempotent: running it more often moves nothing sooner than its threshold and running it less often only delays. "Weekly" is a statement about how often a status needs revisiting, and any interval at or below it satisfies that — where a cron would mean this process growing a timer and an enumerator over every channel, neither of which anything else here needs.

**Phase 4 — ambient. Shipped.** Heartbeat, proactive posts and their rate window, `schedule_task` and the clock that fires it — all behind budgets, and all off unless a channel's sheet says otherwise.

*Definition of done: a channel that opts in gets a heartbeat that posts only when something merits it and stays silent otherwise; a question younger than the answer threshold is never answered proactively; the rate window and the one-post-per-firing bound are enforced deterministically; the model gets a future check only through `schedule_task`'s governed create, a fired task fires at its due time and widens nothing — every call it induces still meets the proxy's gates; every ambient turn draws from the same meter and a capped channel goes silent rather than over; a channel that never opted in sees nothing; and the layer survives the e2e suite's attacks, with positive controls proving a merited post landed and a scheduled check fired on time before any silence is asserted.*

Five things landed differently from how this phase was first written down. Four are decisions; the fifth is a clause that is true in a weaker way than it reads, and saying so is better than ticking it.

**Silence is calling no tool, not a `SILENT` sentinel.** Every other background turn in this tree expresses declining as an empty tool list, and under that idiom the requirement that follows — an answer which is neither the sentinel nor a postable finding is treated as silent — holds by construction rather than by a branch somebody has to write correctly. A malformed call, an invented tool name and a paragraph of prose all produce no finding.

**The rate window bounds spend, not only speech.** It is consulted *before* the evaluation, so a heartbeat that could not post does not evaluate and does not advance its watermark — which is how a shut window came to defer a finding rather than lose one. Evaluating first would have forced a choice between losing the finding and paying for the same turn every tick until the window opened.

**A capped channel does not always go silent, and the line above is the wording this phase changed.** A capped *heartbeat* is silent: nobody asked, so nothing is owed. A capped channel's due *check* is not — it fires, spends nothing, and posts once to say it did not happen. The reason is that somebody approved that check and is expecting it, and a reminder that silently slips is worse than one that says it could not run: the team can still act on the timer themselves. That decision also removed a queue, a backoff and a staleness rule, all of which existed only to keep a check alive until the meter reset.

**A fired check fires once, whatever it produced.** It posts an answer, it runs and has nothing to say, or the channel is told it did not happen — and in all three the ticket is done. There is no retry, so a check cannot arrive days late, and no state that leaves one pending, so nothing can consume a check that never ran. `[ambient]` off is the one silence: that switch means *do not speak here*, and a failure notice would be the agent speaking after being told not to.

**"Every call it induces still meets the proxy's gates" is true because a fired check induces none.** It is one bounded turn over the channel's recent messages with a single tool that posts, and no tool proxy client at all — so it can steer what it says and can reach nothing. That is the conservative shape and it is what makes the containment claim structural rather than enforced, but it is a narrower thing than the sentence implies. Giving a fired check the governed tool path is [#348](https://github.com/getlibero/libero/issues/348), and it is a design question — an approval card with nobody to click it, and a pending cap chosen against a much cheaper unit of work — before it is an implementation one.

**Phase 5 — hardening. Shipped.** Hardening pass on the proxy, audit hash-chaining for tamper evidence.

*Definition of done: the audit log is tamper-evident — rows are hash-chained, an operator command verifies the chain and names the first broken row, and the e2e suite proves a rewritten row is detected after a positive control proves an untampered log verifies clean; audit argument capture is decided — built behind its flag with a redaction set the design argues is complete, or declined with the reasons recorded; the MCP path survives a hostile upstream at the transport level — responses stream through redaction rather than buffer behind it, and pooled clients have a lifetime and idle eviction sized against the token lifetimes OAuth gave them; and the sheet-store's false error on a mid-write read is fixed or documented as expected.*

Argument capture was **declined**, which is the second arm of its own clause rather than a shortfall: the reasons are recorded where the code is, and the gap it leaves — that a blocked call records nothing about what it attempted — is [#364](https://github.com/getlibero/libero/issues/364).

Three things landed differently from how this phase was first written down. Two are the drops below; the third is a clause whose stated reason turned out to be false while the thing it asked for landed anyway.

**Idle eviction was not "sized against the token lifetimes OAuth gave them", because a pooled client never held a token.** That clause was written expecting the OAuth work to put an expiring credential inside a pooled client, which would have given eviction an obvious deadline. It did the opposite: the token engine introduced a credential *source*, so the client holds the source and mints per request, and can therefore outlive any token — which is a settled reason **not** to evict rather than a reason to. What made eviction necessary instead was the legacy-protocol fallback, after which a client holds a session at the upstream that was released only at shutdown; and key drift, since a sheet edit that moves a url or renames a credential strands an entry nothing will ever ask for again. The window is sized against what eviction costs — re-running the version ladder on the next call — and held above the catalog's own, so a client is never dropped underneath a listing still citing it. The same collection was then owed one level down, in the catalog cache, where the rule had to be per resolution rather than per entry.

It was also first written down as "breadth" — a second platform adapter (Discord) and a durable multi-day orchestration option (Temporal) beside the two items that shipped. Both are dropped rather than deferred.

**Discord:** a second chat surface widens adoption, not the governed core, and every phase 1–4 feature has a Slack-shaped rendering — cards, checklist, proactive posts, the rig's fake gateway — so an adapter is a re-answering of all of it, not a gateway swap. The one thing it would prove, that the gateway seam is real rather than Slack-shaped, is worth proving when a real team asks. Platform adapters are a v1 non-goal in the architecture's scope section.

**Temporal:** the two long-lived things this tree has are already durable rows — an approval ticket waiting for its click, a scheduled check waiting for its instant — and phase 4 deliberately removed the retry-and-continue machinery an orchestrator exists to provide, on the argument that a reminder retried into arriving days late is worse than an honest "it did not happen." A workflow engine would also put every step's arguments and results into one shared history database, which is the wrong shape against the one-file-per-channel boundary. What "multi-day" turned out to gesture at is scheduling rather than orchestration, and that is parked as its own work ([#358](https://github.com/getlibero/libero/issues/358), beside [#348](https://github.com/getlibero/libero/issues/348)) rather than gating this phase.

## After the phases

Phase 5 was the last phase; the list above is complete rather than paused. Delivery is
milestone-gated per release now: each release gets one milestone whose description is its
definition of done, and the open milestone is what lands next.

**v0.3.0 — shipped.** The release that made releases real: both service images published to GHCR
on every tag with provenance attestations, a [changelog](/docs/changelog/) an operator can
upgrade by, and a written release procedure — plus the correctness items beside them: the
approval card shows the exact call being approved, a cancelled scheduled check leaves a record,
and a blocked call's arguments land in an off-chain, deletable store the audit row's own hash
binds, without reopening the decision against argument capture in the chain.

**v0.4.0 — open.** Code execution, governed: the ephemeral container the proxy invokes
([#368](https://github.com/getlibero/libero/issues/368)) — the one section of the
[architecture](/docs/architecture/) still marked designed-not-built — which gives `[egress]` its
first live caller ([#219](https://github.com/getlibero/libero/issues/219)). The
[milestone](https://github.com/getlibero/libero/milestone/8) carries the definition of done.

## What success looks like

Not stars: unaffiliated teams self-hosting the governed core in real workspaces, and the e2e security suite passing against every release.
