---
title: Security model
description: The threat model, the mitigations in priority order, the trust assumptions, and how to report a vulnerability.
---

Assume the model can be prompt-injected by any channel member or by tool output. Every mitigation
below is designed to hold when that assumption is true, which means none of them can depend on
the model's cooperation.

## Mitigations, in order of importance

1. **No tool credentials in the agent process.** They live only in the proxy's encrypted vault,
   are referenced by name everywhere else, and are injected into the outbound call by the proxy; a
   redaction pass scrubs known secret values from tool results before they cross back to the
   agent. The agent process does hold two other kinds of credential — see [which secrets are
   where](#which-secrets-are-where).
2. **Deterministic tool allowlist.** The channel's [team sheet](/docs/team-sheet), enforced in the
   proxy. The model's cooperation is never part of the enforcement path.
3. **Human approval for dangerous calls.** Per-call, recorded with the approver's Slack user id,
   expiring by default in 15 minutes. Destructive verbs default to approval-required.
4. **Budgets.** Token and tool-call metering per channel per day, authoritative in the proxy. The
   tool-call limit is counted by the proxy from calls it serves and holds even under full
   compromise of the agent process; the token limit is counted from what the agent reports, which
   a prompt-injected model cannot forge — the numbers come out of the provider's response envelope
   — but a compromised agent process could. The reset is an operator command against the proxy's
   own file, deliberately not a route, so a compromised agent cannot clear its own hard limit.
5. **Attribution.** Append-only audit log of every tool call and its requester.
6. **Sandboxed code execution.** Ephemeral container, no network unless the team sheet grants an
   egress allowlist, invoked by the proxy so it is audited and budgeted like any other tool.
7. **Physical channel isolation.** One SQLite file per channel for anything holding channel
   *content* — messages, memory — so no query path can join across channels and the layout
   enforces the storage boundary. The line is whose data it is: content belongs to a channel's
   members, and a cross-channel join is one channel's members seeing another's conversation.
   Operator-facing tables — the budget meter, and the audit log — are read by the operator, and
   cross-channel aggregation there is a feature rather than a hazard. What holds for those instead
   is that channel members cannot manipulate the numbers: the channel comes from the client
   certificate, every write is an increment, and clearing a counter lives on an operator path the
   serving process does not import. Which channel a task acts as is bound by
   the agent when the session is created, from the Slack event and not from anything the model
   produces — see the trust assumption below.

## Which secrets are where

Three kinds, and only the first is governed by the vault.

**Tool credentials** — the GitHub token, the database password, anything a team sheet names. Vault
only. The agent never sees one: the proxy injects it into the outbound call and scrubs it out of
the result. This is mitigation 1 and it is the claim the design hangs on.

**Gateway and model credentials** — `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and the model provider
key. These are in the agent process, necessarily. The gateway holds the socket, so it must hold the
token that opens it; brokering that through the proxy would make the proxy the gateway. Compromise
of the agent process yields the ability to speak as the app and read history in every channel the
app is installed in, and to spend against the model provider. It does not yield a tool credential,
so it reaches nothing the team sheet governs.

That blast radius is the operator's to bound: scope the app to the events and reads it needs,
install it only in the channels it serves, and rotate the tokens from the Slack admin surface if
one leaks.

**Channel client certificates** — one per channel, held by the agent so it can authenticate to the
proxy. Consequences below.

## Trust assumptions

The operator's Slack workspace is trusted. Individual channel members are not.

Out of scope for v1: a malicious operator, a compromised host, and Slack itself.

One assumption worth stating plainly, because it is the only place a mitigation leans on the agent
being correct rather than on the proxy. The agent process holds one client certificate per channel
it serves, so it is able to act as any of them. Prompt injection cannot reach that choice — the
channel is taken from the Slack event, and the proxy will not read one from a header or a request
body — but it does mean two things. A bug that binds a task to the wrong channel is not something
the proxy can detect, since the certificate presented is genuine. And full compromise of the agent
process, as opposed to the model-level cases above, yields the union of those channels' tool
surfaces rather than one channel's. No tool credentials either way: none are in that process, and
what is — the gateway and model credentials above — reaches no tool the proxy guards.

Related, and also not built yet: a leaked client key cannot be revoked without retiring the
channel, because the replacement certificate carries the same subject as the leaked one. Pinning a
channel's key in its team sheet is the intended fix.

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
