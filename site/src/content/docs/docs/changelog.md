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
     loudest, because the sheet is the compatibility surface 1.0 will
     eventually freeze. Security fixes are flagged as such.
  3. **The suite statement** — that the e2e security suite passes against
     this tag. Saying it per release is what makes the roadmap's "against
     every release" a checkable claim rather than an aspiration.
- **No backfill.** Versions start at v0.3.0. The [roadmap](/docs/roadmap/) is
  the record of phases 0 through 5, and version entries invented for them
  after the fact would duplicate it while numbering things that never had
  numbers.

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
