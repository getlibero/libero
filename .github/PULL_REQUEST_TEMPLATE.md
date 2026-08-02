## What

## Why

## Checklist

- [ ] `pnpm -r build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm license-check` pass
- [ ] Site changes: `pnpm check`, `pnpm build`, and `pnpm check:html` pass inside `site/`
- [ ] No credential values anywhere — credentials are referenced by name only, in code, config, tests, and logs
- [ ] Enforcement changes are deterministic checks in the proxy, not instructions to the model

The roadmap is phase-gated: features that outpace the governed core get parked
(see CONTRIBUTING.md). The CLA bot will prompt on your first pull request.
