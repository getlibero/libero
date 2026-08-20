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
