---
title: Changelog
description: Release notes an operator can upgrade by. Canonical here, copied into each GitHub Release at tag time.
---

This page is the canonical release record, and these are its rules, stated
here so a release-cutter does not re-derive them — `RELEASING.md` in the
repository names this page as the changelog step:

- **Canonical here.** The GitHub Release body gets each entry's text copied in
  at tag time — people land there from the tag, so a bare link is unfriendly,
  and a copy made once at release and never edited after cannot drift. The
  repository's root `CHANGELOG.md` is a one-line pointer to this page.
- **Written at release time, not accumulated per PR.** The milestone already
  enumerates what a version contains, and the judgment a good entry needs —
  what landed differently from the plan, what it means for an operator — is
  release-time judgment. There is no "Unreleased" section, and an entry is
  release notes with upgrade instructions, not a commit digest.
- **Three parts per entry:**
  1. **What shipped**, in prose, naming issues.
  2. **Upgrading** — breaking changes and the operator actions they require:
     sheet format, environment, volumes, image and CLI pairing — or the
     explicit sentence that there are none. Team-sheet changes are called out
     loudest, because the sheet is the first of the surfaces
     [1.0 freezes](/docs/compatibility/) — that page is the list of the rest,
     and an entry touching any of them owes the same call-out. Security fixes
     are flagged as such.
  3. **The suite statement** — that the e2e security suite passes against
     this tag. Saying it per release is what makes the roadmap's "against
     every release" a checkable claim rather than an aspiration.
- **No backfill.** Versions start at v0.3.0. The [roadmap](/docs/roadmap/) is
  the record of phases 0 through 5, and version entries invented for them
  after the fact would duplicate it while numbering things that never had
  numbers.

## v0.8.0 — 2026-09-06

**Read this first if you install from npm.** `@getlibero/cli` 0.6.0 and 0.7.0 cannot start —
`npx @getlibero/cli@0.7.0` fails on every install with `ERR_MODULE_NOT_FOUND`
([#514](https://github.com/getlibero/libero/issues/514)). Two writers of one filename: `build.mjs`
bundled to `dist/index.js`, then the `test` script's `tsc` overwrote it with the 458-byte entry stub
that imports `./cli.js`, and the release workflow published what `tsc` left. Two gates were blind to
it — CI's tarball check ran *before* the tests that clobbered the file, and its one grep could never
fail, because POSIX ignores `set -e` for a pipeline beginning with `!`. The bundle is now
`dist/libero.js`, a name `tsc` never emits, and `scripts/cli-tarball-check.sh` **executes** what is
packed, after the tests in CI and immediately before `npm publish`
([#513](https://github.com/getlibero/libero/pull/513)). This release is the first to carry the fix
to the registry. Reported by a self-hoster standing Libero up on a homelab from the published
artifacts.

**Tool results carry content blocks** ([#160](https://github.com/getlibero/libero/issues/160) is the
tracker). `ToolResult.content` was a string, so a tool whose whole answer is a screenshot was
rendered as a sentence naming the type and the size. It is now an array of blocks — text, image,
audio and embedded resource ([#500](https://github.com/getlibero/libero/issues/500)) — with the
proxy emitting real ones and **vouching for each against the schema the agent will parse it with**,
because a block that failed over there would lose the call rather than degrade it
([#501](https://github.com/getlibero/libero/issues/501)). What cannot be vouched for — a payload
that is not base64, a `resource_link`, a block from a newer protocol revision — becomes the
placeholder it always was. The completion adapter decides again at the far end: Anthropic relays
text and image natively and degrades the rest, and the OpenAI-compatible adapter flattens the whole
result, which is where "degrades to the placeholder rather than to base64 in a string" is actually
enforced ([#502](https://github.com/getlibero/libero/issues/502)). One bound is spent over the whole
result — `[llm] max_result_chars`, where text pays its characters and a binary part pays its decoded
bytes. A credential found inside a *decoded* payload fails the whole result closed rather than being
edited out, because a replacement inside a PNG is a corrupt image. The end-to-end suite asserts the
payload crossing byte for byte before it asserts anything about what did not cross
([#503](https://github.com/getlibero/libero/issues/503)).

**OAuth tokens are sender-constrained** ([#260](https://github.com/getlibero/libero/issues/260) is
the tracker). RFC 9449 DPoP binds a token to a key, so the proxy holds one — in a **third store on
the custody seam**, beside the vault and the token store
([#504](https://github.com/getlibero/libero/issues/504)). Not the token store, which would make the
promise vacuous: whoever stole the tokens stole the key that presents them. Not the vault either,
whose whole design is that the serving process cannot write to it. Proofs go on the token-endpoint
exchange ([#505](https://github.com/getlibero/libero/issues/505)) and on every upstream call, with a
fresh proof per request carrying that request's method, URL and a digest of the token itself
([#506](https://github.com/getlibero/libero/issues/506)). The sheet decides per upstream in
`[mcp_server.auth] dpop`: `prefer` (the default) sends proofs where the authorization server
advertises support and stays on bearer where it does not, `require` refuses rather than falling back
— an unannounced downgrade is what sender-constraining exists to prevent — and `off` is for an
issuer that advertises and gets it wrong. What this buys is written down per backend rather than
claimed once: on the encrypted files, theft of `tokens.enc` plus the master key no longer yields
presentable credentials, and theft of the whole volume plus the master key still does. The verifier
both fakes run was written from the specification and imports nothing from the maker, so it can
disagree rather than agree by construction — and the attack case is the real one: a thief holding a
stolen token can mint a key and sign a perfectly valid proof, and the only thing that refuses them
is that it is not the key the token was issued to.

**A channel gets a persona** ([#270](https://github.com/getlibero/libero/issues/270)).
`[channel] persona` sits beside `[channel] description` — one field does not earn a section — capped
at 1000 characters, a parse failure rather than a truncation. It is **appended to the system prompt
and never substituted for it**, so the clauses about the sheet's tool list, about relaying refusals
and about saying plainly when the answer is not known survive whatever voice is asked for; the
attack suite runs a channel whose persona declares the agent an administrator and asserts it is
refused exactly what it was refused before. The issue asked for a name and an icon too, and those
are **declined rather than deferred**: `chat.update` accepts neither, and every approval card and
live checklist this system paints is a `chat.update`, so a per-message override would apply to
replies and not to cards. What landed instead was not in the issue at all — the agent now learns its
own name from its installation, so an operator who renames the app in Slack renames the agent.

**Two bugs found on a live deployment, in a thread.** Inside a thread the prompt is thread-scoped,
so `search_channel_history` is the only path to the rest of the channel — and it was answering the
model its own words: the asking message is in the index by the time the tool runs and shares every
word with the query written out of it, so under an implicit AND the rows matching *what did I do
this weekend* were exactly the other questions and the answer was excluded outright
([#522](https://github.com/getlibero/libero/issues/522)). The search now excludes the calling
thread, inside the statement rather than over its rows, and a conjunction that finds nothing widens
to OR. Beside it, **the agent's own replies are now stored**
([#523](https://github.com/getlibero/libero/issues/523)) — in `agent_message`, a second table rather
than a `kind` column, which is the whole of the safety: there is no full-text index over it and no
trigger that would build one, nothing joins it to the embeddings, and every existing read names
`message` alone. A reply is derived from tool results, and a searchable one would give an injection
that surfaced in its prose a second life in the channel's durable state.

**A signing key could be destroyed under its holder** ([#529](https://github.com/getlibero/libero/issues/529)).
On the GCP custody backend, minting the DPoP signing key was four non-atomic calls that discarded
the boolean the create already returns, so two handles that both found no version could each write
one — and because that backend is replace-not-stack, the second write destroyed the first, leaving a
process signing with a key the store no longer held. The create is the arbiter now, as the AWS
backend already had it. Caught by the conformance suite intermittently on `main`, which is what that
suite is for.

**Smaller, and each its own fix.** One surrogate-pair guard at all three places a bound cuts a
string, rather than at the one that had it
([#509](https://github.com/getlibero/libero/issues/509)). The e2e harness's `AuditRow` is checked
against the table it is cast from, after a column was added and the interface silently went without
it ([#511](https://github.com/getlibero/libero/issues/511)). `libero init` scaffolds the shape that
was asked for rather than every shape there is, and names the compose file the deployment actually
has ([#518](https://github.com/getlibero/libero/issues/518),
[#516](https://github.com/getlibero/libero/issues/516),
[#517](https://github.com/getlibero/libero/issues/517)). And the compose file stopped shipping
`:latest` ([#519](https://github.com/getlibero/libero/issues/519)), which is the next section.

**Upgrading.**

*The CLI works again.* If you installed 0.6.0 or 0.7.0 from npm and it would not start, that is
#514 and this release fixes it. Upgrade to 0.8.0.

*A new variable, and it is the one action this release asks for.* `LIBERO_VERSION` in `deploy/.env`
is the tag all three service images are pulled at; `deploy/docker-compose.yml` interpolates it into
every `image:` line and into the runner's `RUNNER_IMAGE`. An existing deployment's environment file
has no such line, so it keeps resolving `latest` until you add one — `libero init` appends it on a
re-run, or write `LIBERO_VERSION=v0.8.0` by hand. `libero doctor` reports it against the release of
the `libero` asking, as a warning rather than a failure. Nothing rewrites it for you: upgrading from
here is moving that line and pulling.

*No breaking team-sheet changes.* `[channel] persona` and `[mcp_server.auth] dpop` are both new and
both optional, and an absent section is exactly the previous behaviour. `dpop` defaults to `prefer`,
which sends proofs only where the authorization server advertises support — so no sheet that worked
before stops working. Two things to know if you use OAuth upstreams: **grants made before this
release are bearer grants** and stay that way until `grant add` is re-run, and changing `dpop` on a
sheet whose grant already exists is refused rather than reconciled. A persona longer than 1000
characters is a parse failure, not a truncation.

*Two additive schema changes, and neither needs anything from you.* The audit log goes to version 7
with `result_bytes_by_type`, a widening of the kind version 6 already made — NULL columns are
omitted from the preimage, so every row already on disk hashes to exactly what it did and
`audit verify` still walks a pre-upgrade chain. `result_bytes` itself now counts decoded bytes for a
binary part where it counted string length before: the meaning changed, not the type or the
position. The message store gains the `agent_message` table without moving its schema version,
because every prior statement names `message` alone.

*One thing worth deciding about rather than noticing.* From this release the per-channel store holds
the agent's replies as well as the channel's messages, beginning at the upgrade — it is not
backfilled. That is a change in what the file is, and therefore in what a backup of it contains.
Nothing searches or summarizes those rows, and `MEMORY.md` curation does not see them.

*And as always, the images and the CLI pair at 0.8.0.* One `v*` tag releases all four together.

The e2e security suite passes against this tag.

## v0.7.0 — 2026-08-29

**What shipped.** Deployment shapes — the release pilot deployments run from
([#428](https://github.com/getlibero/libero/issues/428) and
[#261](https://github.com/getlibero/libero/issues/261) are the trackers). Reaching a model is now
three chosen shapes with no default among them: directly against a provider; through a LiteLLM
gateway you already run — a base URL and a key, no service started here, the provider keys with
whoever runs it; or through the sidecar `deploy/docker-compose.yml` can start behind a `litellm`
profile, with a worked `model_list` ([#479](https://github.com/getlibero/libero/issues/479)).
None of the three is a fallback, and `deploy/README.md` and the
[self-hosting page](/docs/self-hosting/) each carry a section an operator can stand any of them up
from ([#481](https://github.com/getlibero/libero/issues/481),
[#488](https://github.com/getlibero/libero/pull/488)).

**The LiteLLM path is proven against the real image, and the proof found a live bug**
([#480](https://github.com/getlibero/libero/issues/480)). A new conformance package starts the
exact image the compose file runs and points the real adapters at it. LiteLLM's `prompt_tokens` is
a sum — fresh, cache-read and cache-write tokens included — and the adapter was adding the four
tiers on top of it, so every cached token was counted twice: once at the input rate, again at the
cache rate. On a cache-heavy channel that is the order-of-magnitude metering error the four
tiers exist to prevent, and it was live on this path until this release. The cache-write count
also arrives in three spellings; the adapter now reads all three, first one wins.

**What a gateway charged is recorded beside what the price table says**
([#239](https://github.com/getlibero/libero/issues/239)). Where calls reach a model through a
LiteLLM, the gateway's own cost figure lands in a second SQLite file beside the counts the proxy
priced itself, and `node dist/drift.js show` puts the two side by side per model — so a stale
price table is visible before the provider's invoice is. Recording is the whole feature: nothing
enforces on the gateway's number, the command has no failing exit code, and enforcement stays
deterministic and stays in the proxy. Only calls somebody priced are in it — absent and zero stay
different statements.

**The vault and token store run on a custody contract behind a backend seam**
([#482](https://github.com/getlibero/libero/issues/482)). The two encrypted files on the proxy's
volume stay the default backend, unchanged and not deprecated. `PROXY_CUSTODY_BACKEND=gcp` moves
both stores into Google Secret Manager
([#483](https://github.com/getlibero/libero/issues/483)); `=aws` into AWS Secrets Manager
([#484](https://github.com/getlibero/libero/issues/484)). Writer separation becomes an IAM policy
`deploy/README.md` states, replace-not-stack becomes the provider's versioning with the
superseded value destroyed rather than kept, and there is no master key to hold. Values still
leave the stores only as `Secret`, and every backend passes the same contract suite — the AWS one
also against LocalStack, an independent implementation, which found two client defects the
repository's own fake had mirrored. Stated rather than implied: neither managed backend has yet
been run against a live project or account. What each was actually proven against is in
`deploy/README.md`, and the live verification is
[#496](https://github.com/getlibero/libero/issues/496).

**The master key can come from a file** ([#495](https://github.com/getlibero/libero/issues/495)).
`PROXY_VAULT_KEY_FILE` names a path — a compose secret, a Kubernetes projected volume — and with
the file backend the proxy insists on exactly one source, refusing to start with both or neither
set. On a managed backend, none of the key variables is read at all.

**Upgrading.** No team-sheet changes. No action required: the file backend, the direct provider
shape and `PROXY_VAULT_KEY` all keep working unchanged, and every new variable —
`PROXY_CUSTODY_BACKEND`, `PROXY_VAULT_KEY_FILE`, the `LITELLM_*` keys — is opt-in, with nothing
new started by default. Two things an operator may notice. If your deployment already reached a
model through a LiteLLM-compatible gateway, metered spend on cache-heavy channels drops to its
correct value — the double-charge fix means the old figures were high, not that usage fell. And
the images and the CLI pair at 0.7.0 as always: upgrade them together.

The e2e security suite passes against this tag.

## v0.6.0 — 2026-08-26

**What shipped.** Scheduling ([#358](https://github.com/getlibero/libero/issues/358) is the
tracker). An operator writes recurrence into the team sheet: an `[[ambient.rule]]` entry says at
these times, on these days, ask this question
([#460](https://github.com/getlibero/libero/issues/460) the sheet grammar,
[#461](https://github.com/getlibero/libero/issues/461) the ambient clock firing it as a third kind
of due entry, [#462](https://github.com/getlibero/libero/issues/462) the attack suite reaching it).
Every rule is an ask — a question put to a bounded turn over the channel's recent messages — and a
deterministic post kind was declined rather than deferred: fixed text on a timer is a cron job, and
judgment at the moment of firing is the one thing a rule's turn adds over cron. Rules read their
times in an IANA `timezone` ([#470](https://github.com/getlibero/libero/issues/470)), absent
meaning UTC so no rule written earlier changed meaning; a time the zone skips does not fire that
day, and a time the zone repeats fires once. Occurrences are computed from the wall clock with no
last-fired stamp, so a restart cannot double-fire and a missed window is skipped rather than
replayed — a restart spanning Monday 09:00 loses that digest, and the next occurrence is already
coming. `[ambient] heartbeat = false` runs rules and no heartbeat evaluation — the channel that
wants Monday digests and no noticing job — while `enabled = false` stays the one silence.

**An unattended turn can now use the channel's tools, and only if the sheet says so.**
[#348](https://github.com/getlibero/libero/issues/348) was decided by being built: `[ambient]
tools = true` gives a fired check, a standing rule and the heartbeat evaluation
([#471](https://github.com/getlibero/libero/issues/471) — one switch, because a channel decides
unattended lookup once, not three times) the ReAct loop over the allowlist its sheet already
carries. The switch decides who may use that list, not what is on it. An unattended turn has no
prompter, so a call that would raise an approval card is refused rather than waited on —
read-yes-write-no, drawn off the same destructive-name default that governs holds — and every such
call carries `ambient:clock` as its requesting user, a name reserved by an alphabet no Slack id
can spell, so the audit log says plainly that a clock asked.

Beside the headline: the example-sheet suite learned to tell a documented figure from an inherited
default ([#445](https://github.com/getlibero/libero/issues/445)), and the price-table watcher test
was rebuilt on a seam rather than given a third, longer timeout
([#474](https://github.com/getlibero/libero/issues/474)).

**Upgrading.** The team sheet is **purely additive**: a sheet with no `[[ambient.rule]]` entry and
none of the new keys parses exactly as before, and every new key defaults to the old behaviour —
`[ambient] tools = false`, so no sheet gained an unattended caller by upgrading; `heartbeat =
true`; `timezone` absent meaning UTC. The failure direction on old software is the same as
v0.5.0's: a 0.5.0 service does not reject a sheet carrying `[[ambient.rule]]` — unknown keys are
stripped — so a rule added before the images are upgraded is silently inert. Upgrade first, then
edit sheets. No environment variables, volumes or services changed, no wire shape between the
agent and the proxy moved, so the two services may be upgraded in either order, and the CLI at
0.6.0 pairs with the images at 0.6.0 as always. There are no security fixes in this release.

**The suite.** The e2e security suite passes against this tag — now including the rule attacks,
which run without a daemon: channel content that tries to plant a rule plants nothing, because the
sheet is the only write path and the model has none; a fired turn on a sheet that never wrote
`tools = true` induces no served calls; a rule's turn that did opt in meets the same gates a
mention's calls do, and a call that would need a human click is refused rather than held. Each
runs after a positive control proves a rule fires and posts at all. The one file that requires a
Docker daemon still fails rather than skips in CI.

## v0.5.0 — 2026-08-25

**What shipped.** Shared skills ([#373](https://github.com/getlibero/libero/issues/373) is the
tracker). An operator publishes a playbook once — one `<name>.md` file in a third root, mounted
read-only into the agent service and into nothing else — and each channel's team sheet names which
of them it gets with a `[[shared_skill]]` entry
([#432](https://github.com/getlibero/libero/issues/432) the sheet grammar,
[#433](https://github.com/getlibero/libero/issues/433) the root,
[#434](https://github.com/getlibero/libero/issues/434) the read-only opener and `origin` on the
skill index, [#438](https://github.com/getlibero/libero/issues/438) the docs). Two load modes,
because retrieval cannot serve the consistency case: `load = "always"` stands in every task's
system prompt ([#435](https://github.com/getlibero/libero/issues/435)) — the standing region, which
reaches the five turns that compose text and none of the turns that keep records
([#450](https://github.com/getlibero/libero/issues/450)) — and `load = "retrieved"` joins the
channel's own retrieval pool, fused, ranked and bounded exactly as the channel's own playbooks are
([#436](https://github.com/getlibero/libero/issues/436)). Everywhere a shared skill is loaded,
indexed or logged it is addressed as `shared/<name>` — a slash cannot appear in a skill name, so
the namespace is reserved by the alphabet rather than by a precedence rule. Shared skills do not
age, the lifecycle job and the merge curator never touch them, and the model has no verb over the
root. The attack suite reaches them too
([#437](https://github.com/getlibero/libero/issues/437)): a hostile shared skill is retrieved,
read, and widens nothing, and the agent cannot write the root. A marketplace *mechanism* was
declined rather than deferred — auto-updating text that enters a model's context is an injection
subscription, and #373 records the rest of the argument. Vendoring through git is the answer;
`libero skill vendor` is parked as [#439](https://github.com/getlibero/libero/issues/439).

Beside the headline: `node dist/skill-purge.js <channel> --yes`, run against the server image, is
the operator's way to empty a channel's own half of its skill index
([#452](https://github.com/getlibero/libero/issues/452)) — for the channel that has since set
`[skills] enabled = false` and keeps dead rows crowding the shared skills its sheet still names. It is a
command rather than a side effect of the switch, because a sheet that fails to parse falls back to
skills-off, and state deletion triggered by a typo is the wrong default. `totalTokens` now means
tokens on every log line that carries it — six lines that rode counts of other things in the spend
field moved to a general `count` field ([#429](https://github.com/getlibero/libero/issues/429)).
Every semantic-recall hit now writes a `recall_hit` line carrying its kind, rank and distance
([#427](https://github.com/getlibero/libero/issues/427)) — the measurement
[#283](https://github.com/getlibero/libero/issues/283) was parked for want of. A per-channel bound
on concurrent sandbox runs was closed as declined, with the argument recorded where the paragraph
that invited it sits ([#425](https://github.com/getlibero/libero/issues/425)). And the two test
suites that gate on a Docker daemon now run in two CI jobs, because one asserts the daemon holds no
leaked sandbox container while the other deliberately keeps one running
([#410](https://github.com/getlibero/libero/issues/410)).

**Upgrading.** The team sheet first, because it is the compatibility surface — and here it is
**purely additive**: a sheet with no `[[shared_skill]]` entry parses exactly as before, and the new
`[skills]` keys bounding the standing block (`max_always_skills`, `max_always_chars`) have
defaults. An entry is a `name` and a `load`, and `load` has no default — the two modes are not two
strengths of one setting. `[skills] enabled = false` does **not** switch shared skills off: that
switch governs what a channel grows for itself, and these were decreed rather than grown. Note the
failure direction on old software: a 0.4.0 service does not reject a sheet carrying
`[[shared_skill]]` — unknown keys are stripped — so an entry added before the images are upgraded
is silently inert. Upgrade first, then edit sheets.

New in the environment: `AGENT_SHARED_SKILLS_ROOT`, optional. The shipped compose file sets it and
bind-mounts `../shared-skills` read-only into the server alone — the proxy does not mount it at
all, because a shared skill is text for the model, not authorization. A deployment carrying its own
compose file must add the variable and the mount, or every `[[shared_skill]]` entry resolves to a
log line naming the dangling skill; the server states once at startup whether the root is
configured. The repository ships a `shared-skills/` directory with a README and two worked
examples, and `libero doctor` now checks the root exists when any sheet names a shared skill — and
refuses a configuration that points it at the store root or the channels root. The two services may
be upgraded in either order: no wire shape between the agent and the proxy moved. One operator
number changes meaning: if a dashboard sums `totalTokens` across log lines, the sum drops to the
correct one, because the six count-carrying lines no longer contribute to it. There are no security
fixes in this release.

**The suite.** The e2e security suite passes against this tag — now including the shared-skill
attacks, which run without a daemon: the hostile playbook is served and still bounded by its
channel's sheet, and the write paths to the shared root do not exist. The one file that requires a
Docker daemon still fails rather than skips in CI, and its exfiltration cases still run only after
a positive control proves the surface reaches an allowed host.

## v0.4.0 — 2026-08-22

**What shipped.** Code execution, governed. A channel whose sheet grants the `run_code` built-in
can run model-written code in an ephemeral container — read-only rootfs, a tmpfs workdir sized from
its own memory cap, cpu/memory/time limits from its `[[builtin]]` block, a process cap against fork
bombs, and no network at all unless `[egress]` grants a host — metered and audited under the
reserved server name like any other tool ([#368](https://github.com/getlibero/libero/issues/368) is
the tracker, with [#394](https://github.com/getlibero/libero/issues/394) the schema,
[#395](https://github.com/getlibero/libero/issues/395) the runner,
[#396](https://github.com/getlibero/libero/issues/396) the attack suite and
[#397](https://github.com/getlibero/libero/issues/397) the docs).

**The Docker socket did not come back to the proxy.** It moved to a third service that holds no
credential at all ([#393](https://github.com/getlibero/libero/issues/393)), so the process with
root-equivalent privilege and the process with every tool credential are different ones. That cost
is stated rather than hidden: compromising the runner is host root. What makes it the better trade
is argued in `packages/proxy/README.md` under "Reaching a runtime". The runner speaks the Docker
Engine API over a unix socket with no client library, builds every container spec itself, and has
no request field that reaches `Image`, `Binds` or `Privileged`.

`[egress]` is now enforced rather than only validated
([#219](https://github.com/getlibero/libero/issues/219)) — its first live caller since the matcher
landed in #73. Enforcement is topological, not a check the code could decline to make: the sandbox
sits on an ephemeral internal network whose only other member is a per-run CONNECT hop, and the hop
is the single route out. A destination outside the list is refused before a connection is opened,
the refusal names the host, and it **ends the run** — fail-closed, with the cost stated in the
sheet's own comments.

Two bounds on the sandbox are the operator's rather than the channel's
([#405](https://github.com/getlibero/libero/issues/405)). `RUNNER_MAX_CPUS`,
`RUNNER_MAX_MEMORY_MB` and `RUNNER_MAX_TIMEOUT_SECONDS` cap what any sheet may ask for — they
**clamp rather than refuse**, and both the channel and the log are told which caps were sized down
— and `PROXY_MAX_SANDBOX_CONCURRENCY` caps how many runs the host holds at once, which
`PROXY_MAX_UPSTREAM_CONCURRENCY` never did.

Beside them: an upstream call's queue wait now comes out of the call's own budget rather than
stacking on top of it, closing a residue #159 recorded and could not fix by choosing better numbers
([#253](https://github.com/getlibero/libero/issues/253)); `node dist/rebuild.js <channel>` is the
way out of a changed embedding model ([#282](https://github.com/getlibero/libero/issues/282)); and
the test suite moved to `node:test` with standalone `expect`, which retired vitest and with it the
MPL-2.0 question ([#202](https://github.com/getlibero/libero/issues/202)).

**Upgrading.** The team sheet first, because it is the compatibility surface — and here it is
**purely additive**: a sheet with no `[[builtin]]` block naming `run_code` parses exactly as before
and its channel cannot reach the sandbox at all. Granting it means a `[[builtin]]` block with
optional `cpus`, `memory_mb` and `timeout_seconds`, each defaulting to the tight end. `approval`
defaults to `"required"` for this built-in specifically, which is the opposite of what the
destructive-verb heuristic would have answered for a tool whose whole job is running arbitrary
code. `[egress] allow` was parsed but inert before this release and is now enforced — it governs
only sandbox runs, so a sheet that carried one speculatively did nothing before and does nothing
now unless the same sheet also grants `run_code`.

**A third image, and it is opt-in twice.** `ghcr.io/getlibero/runner` is published on this tag
beside `server` and `proxy`, and the service sits behind a compose profile: `docker compose
--profile runner up -d`. A deployment that does not start it is unchanged by this release. Turning
it on needs `RUNNER_SANDBOX_IMAGE` **pinned by digest** — a floating tag is refused at boot, because
which toolchain the sandbox has is a deployment fact rather than a fact about whenever the daemon
last pulled — plus `RUNNER_CLIENT_PIN` and `DOCKER_GID`, none of which has a usable default. Run
`libero init` to scaffold them, and re-run `sh scripts/dev-certs.sh`, which now also mints the
runner's server certificate and the proxy's client certificate for it. `RUNNER_MAX_*` and
`PROXY_MAX_SANDBOX_CONCURRENCY` have defaults in the shipped compose file and can be left alone.

The two services may be upgraded in either order: no wire shape between the agent and the proxy
moved, and the one new `unavailable` reason (`runner_busy`) falls through to an older agent's
generic message rather than breaking it. The proxy and the runner are a pair and should move
together, which one tag already guarantees.

**The suite.** The e2e security suite passes against this tag — including the file that requires a
Docker daemon, which fails rather than skips in CI, and whose exfiltration cases run only after a
positive control proves the same surface reaches an allowed host.

## v0.3.0 — 2026-08-20

The first numbered release. For everything before versions — phases 0 through 5 — the
[roadmap](/docs/roadmap/) is the record.

**What shipped.** Releases themselves: one `v0.3.0` tag publishes the npm CLI and both service
images to GHCR, each carrying provenance attestations verifiable against the commit that built it
([#313](https://github.com/getlibero/libero/issues/313),
[#378](https://github.com/getlibero/libero/issues/378) — `RELEASING.md` in the repository is the
procedure, and this page's first entry is [#377](https://github.com/getlibero/libero/issues/377)'s).
The approval card now shows the arguments of the call it asks a human to decide — short and lossy
without misleading: the sharp argument first, the drops named, backticks neutralized so a hostile
argument cannot forge card copy ([#376](https://github.com/getlibero/libero/issues/376)). A blocked
call now leaves an attempt record the operator can read: the full arguments, in an off-chain and
deletable store keyed by the audit row's own hash, read and deleted through `audit.js attempt` and
`attempt-delete` ([#364](https://github.com/getlibero/libero/issues/364) — built to the shape
decided on the issue, overriding its own parked stance; the in-chain capture decline of
[#122](https://github.com/getlibero/libero/issues/122) stands). Cancelling a scheduled check leaves
a record, printed by `tasks.js cancelled`
([#349](https://github.com/getlibero/libero/issues/349)). `[channel] description` now reaches the
model, appended to the system prompt and capped
([#369](https://github.com/getlibero/libero/issues/369)), and the docs were swept against the code
([#370](https://github.com/getlibero/libero/issues/370)). One item resolved differently from the
milestone's first wording and then differently again: the attempt record was briefly re-parked
mid-milestone and reinstated on the argument recorded in #364's thread — the release that creates
the deployments should precede the incidents they will review.

**Upgrading.** The team sheet first, because it is the compatibility surface: `[channel]
description` is now capped at 500 characters, as a parse failure rather than a truncation — a sheet
with a longer description parsed under 0.2.x and is rejected loudly now, with the previous valid
sheet staying active until the file is fixed. The same field now reaches the model on every task,
so empty it of anything a model should not read. New in the compose file: `PROXY_ATTEMPTS_DB`
switches attempt capture on; a deployment carrying its own environment must add it, or the proxy
says once at startup that capture is off. The service images are now published — `docker compose
pull` fetches the release's attested bytes, and pinning the version tag in a compose override is
the recommended posture. `cli-v*` tags are retired: a release is one `v*` tag, and CLI 0.3.0 pairs
with images 0.3.0. Everything else is additive — the cancellation record and the attempt store are
new files and tables that appear on first open, and no wire shape moved, so the two services may be
upgraded in either order. Security hardening, flagged as such: the approval card neutralizes
backticks in model-authored text on the decision surface (#376), and two quadratic regexes over
member-authored and credential text were bounded after CodeQL — enabled this release — flagged them.

**The suite.** The e2e security suite passes against this tag.
