---
title: Security model
description: The threat model, the mitigations in priority order, the trust assumptions, and how to report a vulnerability.
---

Assume the model can be prompt-injected by any channel member or by tool output. Every mitigation
below is designed to hold when that assumption is true, which means none of them can depend on
the model's cooperation.

## Mitigations, in order of importance

1. **No secrets in the agent process.** Credentials live only in the proxy's encrypted vault; a
   redaction pass scrubs known secret values from tool results before they cross back to the
   agent.
2. **Deterministic tool allowlist.** The channel's [team sheet](/docs/team-sheet), enforced in the
   proxy. The model's cooperation is never part of the enforcement path.
3. **Human approval for dangerous calls.** Per-call, recorded with the approver's Slack user id,
   expiring by default in 15 minutes. Destructive verbs default to approval-required.
4. **Budgets.** Token and tool-call metering per channel per day, authoritative in the proxy.
5. **Attribution.** Append-only audit log of every tool call and its requester.
6. **Sandboxed code execution.** Ephemeral container, no network unless the team sheet grants an
   egress allowlist, invoked by the proxy so it is audited and budgeted like any other tool.
7. **Physical channel isolation.** One SQLite file per channel; no query path can join across
   channels.

## Trust assumptions

The operator's Slack workspace is trusted. Individual channel members are not.

Out of scope for v1: a malicious operator, a compromised host, and Slack itself.

## What "not a mitigation" means here

Anything phrased as "instruct the model not to…" is not a mitigation and will not be accepted as
one. Enforcement is a lookup against a file, performed by a process that holds the credentials and
does not run the model.

The same rule shapes the code: `packages/agent` may never import `packages/proxy`. The only path
from the agent to a tool is the network call. This is enforced by an ESLint rule *and* a
grep-level CI job, because a convention that only lives in a comment is not enforcement either.

## Definition of done for the governed core

A prompt-injected agent in a test channel cannot exfiltrate a secret, call an unlisted tool,
exceed budget, or act destructively without a human click — demonstrated by e2e tests in `e2e/`
that try.

Until those tests exist and pass, the governed core is not done, and the
[roadmap](/docs/roadmap) does not move past phase 1.

:::danger[Reporting a vulnerability]
Please do not open a public issue for security reports. Use GitHub private vulnerability
reporting on the repository — [Security → Report a
vulnerability](https://github.com/getlibero/libero/security/advisories/new). We aim to
acknowledge within 72 hours.
:::
