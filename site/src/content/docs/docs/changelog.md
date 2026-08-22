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
