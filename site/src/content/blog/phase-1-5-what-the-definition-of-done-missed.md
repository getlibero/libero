---
title: 'Phase 1.5: what the definition of done did not cover'
description: The governed core is shipped, and the e2e suite that attacks it passes. Then came a phase that was not on the roadmap, because the property phase 1 proved was written entirely about the agent.
date: 2026-08-14
kind: post
---

The [phase 0 post](/blog/phase-0-what-exists/) ended with a promise about when phase 1 would be
over:

> It is not done when those things exist. It is done when a prompt-injected agent in a test channel
> cannot exfiltrate a secret, call an unlisted tool, exceed budget, or act destructively without a
> human click — demonstrated by e2e tests that try.

Those tests exist and they pass. They are four files in `e2e/` — `exfiltration`, `unlisted-tool`,
`exceed-budget`, `destructive-call`, one per clause — and they run against every change.

## What the suite composes

The rig fakes exactly two things: the Slack socket and the model. Everything between them is the
shipped code. Real mutual TLS, real channel identity taken from a real client certificate, the real
vault, the real budget meter, the real audit log, the real MCP client against a recording upstream.

The proxy is spawned as its built entrypoint and the agent side runs in this process, and that
asymmetry is the point. The security claim is that tool credentials live only in the proxy, so the
half that must be a separate operating-system process is the half holding the vault. Compose both
in one process and "the credential never reached the agent" degrades into a claim about JavaScript
module scope.

The detail that took longest to get right is not an attack. It is the positive control. Every
assertion of the form "the credential did not leak" also passes on a run where no credential was
ever resolved — a broken fixture and a held boundary are indistinguishable from the assertion's
point of view. So each case proves the canary *did* arrive at the upstream before it proves it
reached nothing else. A suite without that is a suite that goes green when it stops testing
anything.

## Then a phase that was not on the roadmap

Phase 1.5 is not in the original plan. It was named after the fact, once the shape of what phase 1
had left out became clear enough to be a milestone rather than a pile.

The definition of done is a good property and it holds. It is also written entirely about the
agent: every clause begins *a prompt-injected agent cannot*. That is the threat the design is
about, so bounding it first was right. But the agent is not the only thing in the picture, and the
property is silent on three of the others — the upstream, the operator, and the invoice.

### The upstream

An MCP server is not a trusted component. It is a program someone else wrote, reached over the
network, returning data the model will read.

The pool holds one client per upstream, which is correct for isolation — channels naming the same
server already share the credential, so they already share its rate limit — but it meant one busy
channel could exhaust that limit for every other channel, with the proxy unable to notice or to
smooth it. There is now a per-upstream concurrency limit, and with it a bug that only exists once a
limit does: a catalog walk that lost its race against the listing budget kept requesting pages,
competing for permits with live calls to warm a client whose result nothing would read. It now
stops asking.

A tool whose header annotations fail validation is now excluded from the listing outright rather
than degraded to the sheet's own thin entry — what the specification requires, and a departure from
what every other listing failure does. The standing doctrine survives it unchanged: **the listing
is not the enforcement.** An upstream cannot widen a channel's grant by describing itself differently, because
what a channel may call is a lookup against a file the upstream never sees.

And OAuth. The `AuthScheme` enum had one member, `bearer`, which covers a service token an operator
writes into the vault. It does not cover an authorization server, a token with a lifetime, or
refresh — and the shape of that mattered more than the mechanism, because a token the proxy *mints
and rotates* is a different lifecycle from anything the vault holds. Rotation hands back a
successor refresh token: a durable credential no operator ever wrote down.

So there are two stores under one master key. The vault, which the operator writes and the serving
process only reads. And a token store only the proxy writes, whose entries can only ever be values
an authorization server just issued for an upstream some team sheet already names — the serving
process cannot persist an operator-authored secret, or read one back out. The grant flow is
authorization-code with PKCE, the client identified by a published Client ID Metadata Document, the
redirect pasted back from a loopback URI nothing listens on, so it needs no browser on the proxy
and no network path from the operator's browser to it. Grant material is keyed by issuer, compared
byte for byte, and a changed issuer fails closed into a re-grant.

A scripted authorization server attacks that path in `e2e/` beside the other four. It hangs, it
500s, it returns a body that is not a token. Each time the audit row is `unavailable` rather than a
refusal — nothing was denied, something was broken, and the two are different words on purpose —
no bare call reaches the upstream, the pool is not wedged for the next caller, and the refresh
token that crossed the wire five times in that file reaches no agent-visible surface, in failure as
in success.

### The operator

`@getlibero/cli` was a placeholder: three `console.log` calls, no argument parsing. It accepted any
argument and exited 0, which is worse than not existing — the first command an operator runs
reported success at having done nothing.

It is now the real thing. `init` writes the environment file and generates the vault master key,
`channel add` writes a team sheet and mints the certificate that speaks for it, and `doctor` says
what is still wrong before anything starts. There is a scope boundary underneath those three,
settled earlier and worth restating: the published CLI owns what the operator authors on the
host — the sheets, the certificates, the environment file — and the proxy's own entrypoints own
what the services own inside their volumes. `npx @getlibero/cli audit` would open a path that is
not on the host, so the audit reader is not in the CLI.

Beside that, a guide from a fresh GCP or AWS account to a working mention-and-reply: one VM, one
disk for every piece of durable state, the four secrets in the platform's secret manager rather
than in a file the snapshot story then copies around.

### The money

Every limit in the team sheet was denominated in tokens or tool calls. Tokens are right for the
per-task caps, which are a runaway brake and have to work with no pricing knowledge at all — a
self-hosted Ollama channel has no dollar cost, and a router picking a model absent from every price
table still needs stopping.

They are the wrong unit for a budget. `daily_tokens` is only a spend control if the model is fixed,
and with a sidecar switching models per task the same 60k tokens is an order-of-magnitude swing.
The number an operator wrote in the sheet stops meaning what they thought it meant. What an
operator wants to bound is the invoice, so `daily_usd` sits beside the other two rather than
instead of them, and a channel it cannot price fails closed rather than billing an unknown amount.
A pricing fault is answered ahead of every other limit, because a channel whose spend cannot be
priced has an unknown position against its cap and no comparison below it is trustworthy — and a
sheet setting no dollar cap consults no price table at all, so a self-hosted channel on an unpriced
model works exactly as it did.

One honest edge closed with it. `SIGTERM` used to abort every task and exit without waiting, so a
spend report in flight was simply lost — at most one turn per running task, under-reporting rather
than over-reporting, which is to say the budget failed open. Shutdown now cancels every task and
then waits `SHUTDOWN_DRAIN_MS` — eight seconds — for what they owe the meter. A cancelled task
still posts nothing to the channel; what the drain saves is the accounting. Exceeding the bound is
logged rather than silent.

## What still does not exist

The same section the last post had, because it is the one worth keeping.

There is no sandbox, so `[egress]` is validated when a sheet loads and enforced nowhere — the
surface it governs is code execution, which is later work. `[ambient]` is parsed and unread until
phase 4. Skills are phase 3. Memory is the per-channel message store, its full-text index, and
read-back into a task's context; curation and semantic recall are phase 2, which is where the work
now is. Audit rows are append-only, enforced by triggers, but not hash-chained — tamper *evidence*
is phase 5, and so is a second platform adapter. Certificate revocation is an edit to a team sheet
and there is no CRL by design; rotation is two commands with a human edit between them, without
downtime, and the human edit is deliberate.

`docker compose -f deploy/docker-compose.yml up` now starts a deployment from a clean checkout, and
the three CLI commands before it work. It is still pre-release. Point it at a scratch workspace
before a real one.

## What happens next

Phase 2 is memory: a curation inner loop that writes `MEMORY.md` under a lock and a size cap, and
semantic recall over curated facts and thread summaries from the same per-channel file.

Both halves of that have to hold the boundary the store already has. One SQLite file per channel,
no `channel` column anywhere in it, and no operation that takes a channel id — so a cross-channel
query is not a rule a reviewer applies but a sentence the type system cannot express. The curation
write path is a new thing the model influences, which means it arrives with the case in `e2e/` that
attacks it. That ordering is the whole gate, and it has not changed since phase 0.

The [roadmap](/docs/roadmap) says what lands when, and
[phase 1.5's milestone](https://github.com/getlibero/libero/milestone/2) has every issue behind
this post.
