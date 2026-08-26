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

**v0.4.0 — shipped.** Code execution, governed: the ephemeral container the proxy invokes
([#368](https://github.com/getlibero/libero/issues/368)), which gave `[egress]` its first live
caller ([#219](https://github.com/getlibero/libero/issues/219)), and a third service holding the
Docker socket and no credential ([#393](https://github.com/getlibero/libero/issues/393)). The
[architecture](/docs/architecture/) page carries no designed-not-built marker any more, and the
[changelog](/docs/changelog/) has the operator's account.

Three things landed differently from that milestone's own wording, and the differences are
recorded here rather than a box being ticked against a sentence that turned out to be untrue. It
said the sandbox would be "approved by default", which reads two ways; the default is `approval =
"required"`, argued in `builtin.ts`'s header rather than assumed, because the destructive-verb
heuristic would have answered `"none"` for the one built-in that runs arbitrary code. The socket
did not stay off the deployment — it **moved**, to a runner service that holds no credential, so
what "the proxy still never mounts the Docker socket" now means is that the privilege and the
credentials live in two different processes rather than that neither exists.

And **the milestone closed with three of its correctness items moved out rather than
delivered.** Reconciling the proxy's cost against a sidecar's
([#239](https://github.com/getlibero/libero/issues/239)), a measured distance cutoff for semantic
recall ([#283](https://github.com/getlibero/libero/issues/283)) and segmenting long threads
([#284](https://github.com/getlibero/libero/issues/284)) are each gated on data or a deployment
shape that does not exist yet — there is no LiteLLM sidecar to report a cost, nothing recorded a
recall hit's distance, and thread-length figures need a workspace that has had time to accumulate
them. Parking them is the honest answer; what would have been dishonest is closing them, or
holding a finished release open behind measurements nobody has taken. The work that would make
the first two buildable is filed rather than left implicit
([#427](https://github.com/getlibero/libero/issues/427),
[#428](https://github.com/getlibero/libero/issues/428)), because a parked issue whose precondition
is nowhere is a parked issue nobody can pick up. #427 has since landed, so recall's distances are
recorded and #283 is now parked on the analysis rather than on the data.

One thing landed that the definition of done did not ask for. The sandbox shipped with every
bound on a run being the *channel's* and none being the operator's, so a sheet could ask for 64 GB
and nothing capped how many runs a host held at once
([#405](https://github.com/getlibero/libero/issues/405)). That is a gap the workstream named
before it closed rather than one found afterwards, and it was filled inside the same milestone.

**v0.5.0 — shipped.** Shared skills — the [changelog](/docs/changelog/) entry carries the
upgrade notes. An operator publishes playbooks once into a third root, mounted
read-only to the agent and to neither the proxy nor the channels directory, and each channel's team
sheet names which of them it gets with `[[shared_skill]]`
([#373](https://github.com/getlibero/libero/issues/373)). Two load modes, because retrieval cannot
serve the consistency case: `load = "always"` stands in every task's system prompt, where a house
voice has to be, and `load = "retrieved"` joins the channel's own retrieval pool. `[skills] enabled
= false` switches off neither — that switch governs what a channel grows for itself, and these were
decreed rather than grown. Shared skills do not age, the lifecycle job and the merge curator never
touch them, and the model has no verb over the root. A marketplace *mechanism* was **declined rather
than deferred**: auto-updating text that enters a model's context is an injection subscription, a
runtime marketplace client is a new egress surface, and retrieval over content optimized to be
retrieved is a contest the grown-only corpus does not have. Vendoring through git is the answer, and
`libero skill vendor` is parked as [#439](https://github.com/getlibero/libero/issues/439).

Three sub-issues landed differently from their own wording, recorded here rather than ticked
against sentences that turned out to be untrue.
[#436](https://github.com/getlibero/libero/issues/436) asked that a body edit to a shared file
re-embed it; it does not, because the vector stands for the skill's *description* — so a body edit
re-indexes the full-text side, keeps the vector and keeps the use counters, which is the whole of
what that clause was protecting. Making it re-embed would charge every channel that named the skill
for a vector identical to the one it replaced, on one operator's typo fix.
[#437](https://github.com/getlibero/libero/issues/437) asked for a fake embedder to place a hostile
skill nearest and for an `[egress]` exfiltration leg; the attack suite answers on the lexical leg
instead, because its one fake embedder deliberately ranks nothing — a ranking fake is the hand-built
vector space that rule exists to keep out from between an attack and the thing it attacks — and the
egress leg is attacked at the tool gates, because `[egress]` needs a real sandbox runner and this
suite confines a Docker daemon to exactly one file.
[#450](https://github.com/getlibero/libero/issues/450) proposed that the standing region reach the
task and the proactive post; it reaches **five** turns, because the heartbeat's decision and its
sentence are one call with no seam between them, and because a shared skill is arbitrary operator
text rather than only a voice — house rules about how a runbook is written belong at the
skill-author turn and the merge curator, which that issue's own reading excluded.

One thing landed that the definition of done did not ask for, and it came out of a cost the
milestone chose to record rather than fix. Retrieval's two legs are blind to which half of the
library a playbook came from, so a channel that has since turned its own skills off keeps index rows
that can crowd out the shared skills its sheet names. Purging them automatically on that switch
would let one unparseable `channel.toml` destroy a channel's use counts and first-seen stamps, since
a sheet that fails to parse falls back to skills being off — so the answer is an operator-run
command rather than a config side effect
([#452](https://github.com/getlibero/libero/issues/452)).

## The road to 1.0

Planned 2026-08-25. Four releases remain before 1.0, and the plan's aim is that **1.0 is a
validation release rather than a feature release**: by the time v0.9.0 closes, every open issue is
decided — shipped, scheduled, or recorded as post-1.0 with its reason — and what 1.0 adds is proof,
which is the success criterion below rather than a feature list.

The ordering has one structural argument. Validation needs deployments, and deployments generate
exactly the data three parked issues are gated on — the recall distance cutoff
([#283](https://github.com/getlibero/libero/issues/283)) wants a real corpus, thread segmentation
([#284](https://github.com/getlibero/libero/issues/284)) wants real thread lengths, and cost
reconciliation ([#239](https://github.com/getlibero/libero/issues/239)) wants a sidecar reporting
figures. So the arc front-loads what makes deployments possible and lands the data-gated work last,
once pilot usage has produced its inputs.

**v0.6.0 — scheduling. Shipped.** Recurring turns at a clock time, operator-authored
([#358](https://github.com/getlibero/libero/issues/358)): `[[ambient.rule]]` in the team sheet
(#460), a third `DueEntry.kind` on the ambient clock (#461), the attack suite reaching it (#462),
and a heartbeat switch for rules-only channels. The example-sheet suite learned to tell a documented
figure from an inherited default ([#445](https://github.com/getlibero/libero/issues/445)).

*Definition of done: a rule fires at its next occurrence and posts once; a rules-only channel gets
rules and no heartbeat; injection cannot plant a rule and a rule's turn induces no served calls —
proven by the e2e suite after positive controls; #348 is decided; and the example-sheet suite tells
a documented figure from an inherited default.*

**One clause of that landed differently, and it is the load-bearing one.** "A rule's turn induces no
served calls" is true of every sheet that has not said otherwise, and is **no longer unconditional**:
[#348](https://github.com/getlibero/libero/issues/348) was decided by being *built*, so a channel
that writes `[ambient] tools = true` gets the ReAct loop over the allowlist its sheet already
carries. Both of that issue's blocking questions resolved against machinery that already existed —
an unattended turn is handed no prompter, so a held call is refused rather than waited on, which
draws a read-yes-write-no line off the destructive-name default; and the bound moves from the
pending cap to `daily_tool_calls`, which the proxy counts from calls it served and which therefore
holds against a compromised agent process. What the issue did not ask for is the part that decided
the shape: by the time it was picked up the fired turn had two callers, so the capability landed
behind a switch that is off by default rather than arriving in every sheet that already listed a
tool. What survives unconditionally is the narrower claim — *injection cannot plant a rule*, because
the sheet is the only write path and the model has none.

**Three things shipped that the definition of done did not name**, and the release was better for
refusing to defer them. Rules gained an IANA `timezone`
([#470](https://github.com/getlibero/libero/issues/470)), with absent meaning UTC so nothing written
earlier changed meaning, and with the two days a year a wall clock is not a function of an instant
decided rather than left to the arithmetic. The heartbeat evaluation joined the two fired turns
behind the same switch ([#471](https://github.com/getlibero/libero/issues/471)) — the argument for
excluding it turned out to rest on a frequency the pregate already prevents. And a filesystem-watch
test that had been given a longer timeout twice was rebuilt on a seam
([#474](https://github.com/getlibero/libero/issues/474)), which is the difference between fixing a
flake and postponing it a third time.

**v0.7 — deployment shapes.** The next milestone. The LiteLLM sidecar becomes first-class beside the native adapters
([#428](https://github.com/getlibero/libero/issues/428)), which unblocks the cost-drift recorder
([#239](https://github.com/getlibero/libero/issues/239)), and the vault and token store gain
external secrets-manager backends ([#261](https://github.com/getlibero/libero/issues/261)). This is
the release pilot deployments run from.

**v0.8 — richer tools, wider adoption.** Tool results stop being a string — image, audio and
resource content relayed to the model ([#160](https://github.com/getlibero/libero/issues/160)) — a
channel gets a name, an icon and a persona
([#270](https://github.com/getlibero/libero/issues/270)), and OAuth upstreams get
sender-constrained tokens ([#260](https://github.com/getlibero/libero/issues/260)).

**v0.9 — close-out.** The data-gated items, now buildable against pilot data (#283, and #284 if the
numbers say so); `libero skill vendor` ([#439](https://github.com/getlibero/libero/issues/439));
the native adapters pilot demand actually named, from
[#56](https://github.com/getlibero/libero/issues/56)–[#58](https://github.com/getlibero/libero/issues/58);
and a disposition pass over whatever remains, so each surviving parked issue carries an explicit
post-1.0 reason. "Done" here means no open issue is undecided, not that all of them were built.

Some things stay demand-driven, decided rather than drifted: Windows support for the CLI
([#249](https://github.com/getlibero/libero/issues/249)), the adapters no pilot asked for, and
and event-driven ambient — MCP subscriptions
([#155](https://github.com/getlibero/libero/issues/155)), which is now a post-1.0 workstream on its
own. It was paired here with tool access for fired checks on the argument that a subscription wake
that can look nothing up is thin; #348 having shipped, that half is answered and what remains is the
subscription itself.

## What success looks like

Not stars: unaffiliated teams self-hosting the governed core in real workspaces, and the e2e security suite passing against every release.
