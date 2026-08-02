# Governance

This document states, up front and at v0.1, how Libero is licensed, why contributions require a CLA, and where the open/commercial line sits. We're announcing this now because discovering it later reads as a rug-pull; stating it first reads as what it is — honesty.

## License

The entire core is **MIT — proxy included**. The proxy being open and readable is what makes the security claims verifiable, and verifiability is the whole point. A closed-source security proxy asking for your trust would be a contradiction.

## Contributor License Agreement

A CLA (Apache-style) is required from the first external PR and enforced by a CLA bot in CI.

**Why, stated plainly:** the CLA preserves the project's ability to relicense future versions if a strip-mining threat ever actually materializes. The intent is MIT forever; the CLA is cheap optionality, not a plan.

## Open/commercial boundary

If a commercial layer ever materializes (multi-workspace control plane, SSO/SCIM, compliance exports, hosted offering), it lives in a **separate private repository** and is never merged into this one. No `ee/` directory, ever. The community should never have to argue about which side of a repo a feature belongs on.

## Dependency posture

- **Allowed in core:** MIT and Apache-2.0 only (NOTICE files carried in distributions). Public-domain SQLite.
- **Excluded from core:** any AGPL/SSPL component; any dependency under commercial (non-OSI) terms, such as the Anthropic Claude Agent SDK, which is permitted only as an optional, user-installed adapter.
- A CI license-checker gate fails the build on any copyleft introduction. It scans the repository root and every workspace package under `packages/` and `apps/`. `site/` is out of scope: it is outside the pnpm workspace, carries its own lockfile and CI job, and ships OFL-1.1 licensed fonts — it is presentation, not core.

## Repository ownership

- The GitHub org (`getlibero`) and npm org (`@getlibero`) each carry at least two owners for recovery.
- Org membership requires 2FA; base member permission is Read.
- `packages/proxy` is protected by CODEOWNERS — changes to the enforcement layer require review by proxy owners.
- `@getlibero/cli` is published from GitHub Actions with npm provenance attestations, cryptographically linking every release to the commit that built it.
