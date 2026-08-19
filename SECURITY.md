# Security

## Threat model (abbreviated)

Assume the model can be prompt-injected by any channel member or by tool output. Mitigations, in order of importance:

1. **No tool credentials in the agent process.** They live only in the proxy's encrypted stores — the operator-written vault and, for OAuth upstreams, a token store only the proxy writes — are referenced by name everywhere else, and are injected into the outbound call by the proxy; a redaction pass scrubs known secret values from tool results before they cross back to the agent. Two other kinds of credential are in the agent process and are not governed by the vault: the Slack app and bot tokens, because the gateway holds the socket, and the model provider key. A leak there lets an attacker speak as the app, read history in every channel it is installed in, and spend against the provider — and reaches no tool the proxy guards. Scope the app narrowly, install it only where it is needed, rotate from the Slack admin surface.
2. **Deterministic tool allowlist.** The channel's team sheet, enforced in the proxy. The model's cooperation is never part of the enforcement path.
3. **Human approval for dangerous calls.** Per-call, recorded with the approver's Slack user id, expiring by default in 15 minutes. Destructive verbs default to approval-required. The click is observed by gateway code rather than produced by the model, so the approver's identity holds against a prompt-injected model and not against a compromised agent process, which relays it — tool credentials survive process compromise; approvals survive prompt injection.
4. **Budgets.** Token, tool-call, and dollar metering per channel per day — the dollar cap failing closed on an unpriced model — authoritative in the proxy. The tool-call limit is counted by the proxy from calls it serves and holds even under full compromise of the agent process; the token limit is counted from what the agent reports — out of the provider's response envelope, so a prompt-injected model cannot forge it, but a compromised agent process could. The reset is an operator command against the proxy's own file rather than a route, so a compromised agent cannot clear its own hard limit.
5. **Attribution.** Append-only audit log of every tool call and its requester.
6. **Sandboxed code execution — designed, not built.** The design of record: ephemeral container, no network unless the team sheet grants an egress allowlist, invoked by the proxy so it is audited and budgeted like any other tool. No code-execution surface exists today, so `[egress]` is validated when a sheet loads and enforced nowhere (#219).
7. **Physical channel isolation.** One SQLite file per channel for anything holding channel *content* — messages, memory — so no query path can join across channels. The line is whose data it is: content belongs to a channel's members, and a cross-channel join is one channel's members seeing another's conversation. Operator-facing tables — the budget meter, and the audit log — are read by the operator, and cross-channel aggregation there is a feature rather than a hazard. What holds for those instead is that channel members cannot manipulate the numbers: the channel comes from the client certificate, every write is an increment, and clearing a counter lives on an operator path the serving process does not import.

**Trust assumptions:** the operator's Slack workspace is trusted; individual channel members are not. Out of scope for v1: malicious operator, compromised host, Slack itself.

## Definition of done for the governed core

A prompt-injected agent in a test channel cannot exfiltrate a secret, call an unlisted tool, exceed budget, or act destructively without a human click — demonstrated by e2e tests in `e2e/` that try.

## Reporting a vulnerability

Please do not open a public issue for security reports. Use GitHub private vulnerability reporting on this repository (Security → Report a vulnerability). We aim to acknowledge within 72 hours.
