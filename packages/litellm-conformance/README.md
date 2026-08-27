# @getlibero/litellm-conformance

One file, one question: **does the agent's completion and embedding path survive
a real LiteLLM sidecar?** (#480, part of #428.)

Private, never published, and it exports nothing. It is a test suite that needed
a package rather than a package that grew a test suite — see "Why a package"
below.

## Why this is not in `packages/agent`

That package already has conformance suites, and they answer a different
question. `completion/conformance.ts` and `embedding/conformance.ts` run against
recorded fixtures, which is the right instrument for *does the adapter map this
envelope correctly* and the wrong one for *is this the envelope LiteLLM sends*. A
fixture is a claim about a third party's wire format, and the third party is the
one who changes it.

So these cases start the image `deploy/docker-compose.yml` runs, point the real
adapters at it, and read what comes back. That needs a Docker daemon, and a
daemon-gated suite inside `packages/agent` would drag the whole package out of
the `build` CI job — see `packages/test-kit/src/ci-partition.test.ts` for why
that matters.

## What is faked, and what deliberately is not

**The sidecar is real. The upstream behind it is not.**

A real completion needs a provider key, and a suite that needs one runs nowhere:
not on a contributor's laptop, not on a fork's CI, and not without putting a
credential somewhere a test can reach it. So the upstream is a local HTTP server
speaking Anthropic's and OpenAI's response shapes, and LiteLLM is left to do the
one job under test — translating that into an OpenAI-compatible envelope.

That is not a weakened claim, because **the fake is on the far side of the thing
being tested.** The question is what LiteLLM emits given known upstream counts,
and knowing them exactly is what makes the assertion sharp: an upstream reporting
11 fresh input tokens, 7 read from cache and 13 written is a fact this file
chooses, so a `prompt_tokens: 31` coming back is a measurement rather than a
coincidence.

The upstream speaks **Anthropic's** dialect for completions, because it is the
only one of the two that reports all four token tiers, and the four tiers are the
whole of #480.

## What it proves

- **The four token tiers arrive disjointly.** `TokenUsage` follows Anthropic's
  exclusive convention because `costMicroUsd` prices the four counts by adding
  four independent terms. LiteLLM sends OpenAI's inclusive one — `prompt_tokens`
  is the *sum*, 31 where the fresh input was 11 — so `toUsage` in
  `packages/agent/src/completion/openai.ts` converts, and this is the case that
  says it must. Without the conversion the meter charges every cached token
  twice, once at the input rate and again at the cache rate, which on a
  cache-heavy agent is the order-of-magnitude error the four tiers exist to
  prevent.
- **The served id is the alias, not the upstream model.** #62's rule against the
  router it was written for: the sheet asks for `conformance-completion`, LiteLLM
  dials `anthropic/claude-sonnet-4-6`, and the response says
  `conformance-completion` — which is what the proxy's price table must be keyed
  by.
- **Embeddings survive the same envelope**, with vectors in order, `inputTokens`
  reported, and the alias echoed. There is no conversion to do on this path: an
  embedding call has no cache tiers and no output tokens.
- **The master key is enforced.** `deploy/docker-compose.yml` wires it to the
  agent's own required variable on the strength of an unauthenticated sidecar
  being a real hazard, and this asserts the refusal against the same running
  container rather than trusting it.

## The gate

Two-sided, in `apps/runner/src/sandbox.docker.test.ts`'s words and for its
reason:

- **No daemon, not CI** — skipped, so `pnpm test` still works for a contributor
  without Docker. The skip is named in `ALLOWED_SKIPS`, so it is a visible
  absence rather than a green tick over cases that did not run.
- **No daemon, `CI=true`** — thrown at module load, so the file fails rather than
  reporting green on a runner that lost its socket.

Probed **synchronously at module load**, because `describe`'s `skip` option is
read when the file is collected. A flag set in `beforeAll` would still be false
here, which is the mistake `sandbox.docker.test.ts` records having made.

## Why a package

`ci-partition.test.ts` asserts every workspace package is run by exactly one CI
job, and that a daemon-gated suite never runs beside one that is not. A package
is the unit that check works in, so a daemon-gated suite that is not a package is
a suite that check cannot place.

It runs on the **`sandbox`** job, beside `@getlibero/runner` — the first time two
gated packages share one. That is a decision rather than a default: `e2e` and
`sandbox` are apart because `sandbox.docker.test.ts` asserts nothing on the
daemon descends from `python:3.13-alpine` while `sandbox-attack.test.ts` keeps a
container running on exactly that image. Both of the runner's leak assertions are
filtered — `ancestor=python:3.13-alpine` and `name=libero-hop-` — and a LiteLLM
container matches neither, which is why the containers here are named
`libero-litellm-*`. A job of its own would have bought a fourth runner to avoid a
collision that does not exist.

## Running it

```bash
pnpm --filter @getlibero/litellm-conformance test
```

It pulls `ghcr.io/berriai/litellm:main-stable` if the daemon does not have it —
the tag `deploy/docker-compose.yml` runs, not a digest, because testing a version
nobody deploys would answer a question nobody asked. The container is published
on an ephemeral host port so two runs on one daemon cannot collide, and removed
in `afterAll`.
