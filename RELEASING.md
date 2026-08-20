# Releasing

How a release is cut. The audience is the release-cutter — a maintainer with
push access — not a self-hoster: what a self-hoster reads is the changelog
(`site/src/content/docs/docs/changelog.md`, whose header states its own
rules; #377 is its record). This document is the process that produces it.

The cut is rare and judgment-laden — deciding the milestone is done, writing
the changelog entry — so this is a manual checklist, not automation. The
automation is what the tag triggers.

## One tag releases everything

A release is one tag, `vMAJOR.MINOR.PATCH` (`v0.3.0`), and it triggers every
publish:

- `release-cli.yml` publishes `@getlibero/cli` to npm with provenance
  attestations.
- `release-images.yml` (#313) publishes `ghcr.io/getlibero/server` and
  `ghcr.io/getlibero/proxy` with build provenance attestations.

Lockstep is the point: CLI 0.3 talks to images 0.3, and two tags per release
(`v0.3.0` beside `cli-v0.3.0`) would reintroduce exactly the drift lockstep
removed — nothing keeps the pair together except care. The cost is stated
rather than hidden: **every release ships all three artifacts, even when only
one changed.** A CLI-only fix still publishes images at the new version. That
is cheaper than divergent versions, and an operator upgrading reads one number.

`cli-v*` is retired. The four `cli-v*` tags are the phase era's history and
stay; nothing triggers on them any more.

The tag's number and `packages/cli/package.json`'s `version` move together —
the bump is a step below. No other package version matters: everything else is
private and ships inside the images.

## The gates a tag meets

A tag alone does not release. Each publish workflow runs behind a reviewed
environment — `npm-publish` for the CLI, `ghcr-publish` for the images. A
required reviewer approves each run in the Actions UI. For npm, the trusted publisher pins the workflow
file and environment name, so the OIDC claim makes skipping the gate a
registry-side rejection, not just a repo-settings one.

One piece of this lives in repo settings rather than in git, which is why it
is recorded here: each environment's deployment tag policy must allow `v*`
refs (type: tag) — `npm-publish`'s was changed from `cli-v*` when the scheme
changed. If a policy and the workflow triggers ever disagree, the run fails
at the environment check — loudly, not silently.

## Who can cut a release

A maintainer with push access to the repository — tag pushes are the
trigger — with a required reviewer on the release environments approving the
runs. Today those are the same person. The first external maintainer changes
the answer here, not the mechanism.

## The cut, step by step

1. **Decide the milestone is done.** Its description is the release's
   definition of done; every issue in it is closed. What landed differently
   from the plan is the changelog entry's material, not a reason to hold the
   tag.
2. **CI is green on the commit to be tagged.** CI's test fan-out includes the
   e2e security suite, so a green run on that main commit is what makes the
   changelog's "the e2e security suite passes against this tag" a checkable
   claim. CI does not run on tags — the tag must point at a main commit whose
   run is green.
3. **Bump the version.** `packages/cli/package.json` `version` becomes the
   release number, by PR, in lockstep with the tag.
4. **Write the changelog entry.** Canonical at
   `site/src/content/docs/docs/changelog.md`; the page's own header carries
   the entry's rules. Land it before tagging, so the tagged tree contains its
   own release notes.
5. **Tag and push.**

   ```bash
   git tag v0.3.0 <commit>
   git push origin v0.3.0
   ```

6. **Approve the environment gates** in the Actions UI — one run per publish
   workflow.
7. **Verify the artifacts.** `npm view @getlibero/cli version` shows the
   release and the npm page shows provenance; both images pull from GHCR at
   the version tag and verify:

   ```bash
   gh attestation verify oci://ghcr.io/getlibero/server:v0.3.0 -R getlibero/libero
   gh attestation verify oci://ghcr.io/getlibero/proxy:v0.3.0 -R getlibero/libero
   ```

8. **Create the GitHub Release** on the tag and copy the changelog entry into
   the body, verbatim. People land there from the tag, so a bare link is
   unfriendly — and a copy made once at release and never edited after cannot
   drift.
9. **Close the milestone.**
