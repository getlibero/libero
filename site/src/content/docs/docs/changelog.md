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

The first entry lands when v0.3.0 is cut.
