# @getlibero/aws-conformance

One file, asking whether the AWS custody backend's idea of Secrets Manager
matches somebody else's (#484). It starts LocalStack and runs
`runCustodyConformance` — the same seventy-six cases `packages/proxy` runs
against its own fake, and the same cases the file and GCP backends pass.

Private, never published, daemon-gated two-sided like the sandbox suite, and run
by the `sandbox` job.

## Why a package rather than a file in `packages/proxy`

The same reason `packages/litellm-conformance` is one: it needs a Docker daemon,
and `packages/proxy`'s suite must not. A file that gated on a daemon inside a
package CI runs on every job would either skip in most of them — which the
reporter fails a run for — or acquire a Docker dependency nothing states, which
is the arrangement #410 found and removed.

## What this proves that the fake does not

`packages/proxy/src/fake-secrets-manager.ts` is this repository's reading of the
Secrets Manager API. LocalStack is somebody else's. Running the contract against
both is what turns "we implemented the API" into "we implemented an API two
independent readings agree on".

**It has already earned that twice.** The first run against LocalStack found two
real defects that the fake had happily mirrored:

- **`CreateSecret` and `PutSecretValue` require a `ClientRequestToken`.** The
  AWS SDKs generate one, and the documentation mentions that in a sentence about
  the SDKs — so a client written from the request reference omits it and gets an
  `InvalidRequestException`. This is the archetype of what hand-rolling risks,
  and it was invisible to a fake written from the same reference.
- **`remove` derived "was it there" from the delete's own reply.** AWS documents
  `DeleteSecret` as answering `ResourceNotFoundException` for a name it does not
  hold; LocalStack answers success. `custody-aws-client.ts` now asks
  `DescribeSecret` first — which is also the better shape, because `remove` has
  no use for the value and `GetSecretValue` would have pulled a credential into
  the process in order to delete it.

Both fixes went into the client, and the fake was made stricter to match, so the
fast suite stopped being more permissive than the thing it stands in for.

## What it does not prove

**The signature.** LocalStack accepts any well-formed `Authorization` header, so
nothing here would notice if SigV4 were wrong. That is checked in two other
places: `fake-secrets-manager.ts` recomputes every signature and refuses a call
whose signature does not match, and `custody-aws-client.test.ts` asserts
differentially that changing each signed input — the body, the action, the
region, the date — changes the signature, which is what catches an input that
silently fell out of the canonical request.

**IAM, quotas, KMS, replication, and the recovery window.** LocalStack does not
enforce policy, and this backend always passes `ForceDeleteWithoutRecovery` so
the window is never exercised. A real account is the only place all of it is true
at once, and **nobody has run this against one** — `deploy/README.md` says so
where an operator will read it.

**IMDS.** LocalStack does not emulate the instance metadata service, so this file
stubs the three legs. IMDSv2's actual shape — a PUT-issued token gating the two
GETs — is exercised against the fake, which does model it.

## The gate, and which job

Two-sided, worded exactly as `apps/runner/src/sandbox.docker.test.ts` and
`packages/litellm-conformance`'s gate are: no daemon and not CI is a skip, so a
contributor without Docker can still run everything else; no daemon under `CI=true`
throws at module load, so the file fails rather than reporting green.
`ci-partition.test.ts` greps for that sentence to learn which packages need a
daemon, which is why the wording is shared rather than merely similar.

It runs on `sandbox`, as a third step after `@getlibero/runner` and
`@getlibero/litellm-conformance`. That is the decision `ci-partition.test.ts`
forces rather than a default: the runner's two leak assertions are filtered by
`ancestor=python:3.13-alpine` and by `name=libero-hop-`, and LocalStack's
containers — named `libero-localstack-*`, from `localstack/localstack` — match
neither. A job of its own would buy a fourth runner to avoid a collision that
does not exist.

## Running it

```bash
pnpm --filter @getlibero/aws-conformance test
```

Needs a Docker daemon and pulls `localstack/localstack:3` on the first run.
