---
title: Architecture
description: The two services, the agent loop, the proxy's five jobs, the team sheet, memory, skills, ambient mode, and the sandbox.
---

Libero is a self-hostable, LLM-agnostic AI teammate that lives in Slack channels as a shared agent — one session per channel, not per user — with persistent curated memory, admin-governed tool access, and asynchronous task execution.

The design principle everything else follows from: **the agent is visibly not a user**. It acts only as itself, under admin-provisioned service credentials, through an allowlisted proxy, with every action audited. Channel isolation is a hard admin-defined boundary enforced in code, never model self-restraint.

## The two services

Two deployable services plus per-channel state. The security property the whole design hangs on: **tool credentials live only in the proxy**, and the agent reaches tools only through it. The agent process holds the credentials it cannot function without — the Slack app and bot tokens, and the model provider key — and nothing a team sheet governs.

```
Slack (Socket Mode)
      │
      ▼
┌───────────────────────────────┐      ┌──────────────────────────────┐
│  gateway + agent  (service 1) │      │  tool proxy      (service 2) │
│                               │      │                              │
│  Slack adapter                │      │  team-sheet loader/validator │
│  channel router               │ HTTP │  vault + token store         │
│  (workspace, channel) → sess. │─────▶│  (encrypted, never returned) │
│  context assembler            │ mTLS │  tool allowlist enforcement  │
│  agent loop (BYO model,       │ local│  MCP client pool             │
│    per-channel override)      │ net  │  HITL approval broker ───────┼──▶ approval cards
│  memory curation turn         │      │  budget meter (tokens/calls) │     in Slack
│  skill author + retriever     │      │  egress allowlist            │
│  checklist renderer           │      │  audit writer (append-only)  │
└──────────────┬────────────────┘      └──────────────┬───────────────┘
               │                                      │
               ▼                                      ▼
   channels root (read-only to both)        audit.db (append-only)
   └─ <channel>/channel.toml                          │
        (team sheet, git-managed)                     ▼
                                              sandbox runner
   agent state root (agent writes; proxy      (containerized code exec)
   reads store.db read-only)
   └─ <channel>/
      ├─ store.db     (SQLite+FTS5+sqlite-vec)
      ├─ MEMORY.md    (agent-curated)
      └─ skills/*.md  (agent-authored)
```

**Two roots, not one, and the split is load-bearing.** The obvious layout puts a
channel's whole state in one directory. It cannot: both services mount the
channels directory and it is where the proxy reads its authorization from, so an
agent able to write there could rewrite a `channel.toml` — and the proxy
re-reads the sheet per call, which makes that a compromised agent widening its
own permissions. The channels root stays read-only to both services and
everything the agent writes goes to a root only it writes. `store.db` is the
first thing on that side, `MEMORY.md` joined it in phase 2 for the same reason,
and `skills/` joins them in phase 3.

**The proxy reads `store.db`, and only that.** `search_channel_history` is
served by the proxy, so the proxy mounts the agent's state root and opens each
channel's store read-only — a separate opener with `search` and `close` on it
and no way to write, stamp a version, or migrate. It is the one direction across
that line, and it does not weaken the argument above: the hazard is an agent
writing where the proxy reads *authorization*, and the store is neither the
channels root nor authorization. The mount is read-write at the filesystem level
because a SQLite WAL reader creates the `-shm` and `-wal` sidecars; the
read-only-ness is a property of every connection the proxy opens.

The alternative — the proxy calling back into the gateway to run the search —
was rejected. It needs the first inbound listener on the process whose
compromise this design is written to survive, and it does not protect what it
appears to: the proxy legitimately serves every channel, so the gateway has no
independent way to know the proxy is entitled to the one it names. A compromised
proxy reads everything either way, one hop later. Reading the file directly
keeps *one file per channel is the isolation boundary* a structural fact — the
opener closes over one file, there is no channel column, and no operation takes
a channel id — rather than a promise made by the less-trusted process.

The proxy is a separate OS process listening only on localhost/private network with mutual TLS between services. The agent authenticates to the proxy per-channel: one client certificate per channel, subject `CN=channel:<id>`, and that certificate is the only place the proxy reads a channel identity from — never a header, query parameter, or body field, because the process on the other end runs the model and anything the model can influence is not a boundary. Certificates authenticate; team sheets authorize, and the sheet has a narrow say in the first of those: `[channel] certificate_sha256` lists the fingerprints of the certificates allowed to speak for that channel, so a request arriving on a certificate the sheet does not name is answered 401 before any route sees it. There is still no revocation list and no CRL. Retiring a channel is removing its sheet, which removes its permissions on the next call and leaves a stale certificate holding nothing. Revoking a *leaked key* for a channel still in use is dropping one fingerprint from that channel's sheet — the same file, the same review, the same next-call effect, and the channel never stops working. Rotation is the same mechanism run forwards: pin the replacement beside the certificate in service, swap the material, drop the old fingerprint, with no moment when neither is accepted and no restart of either process. The sheet still cannot make a key speak for a *different* channel, because the certificate's `CN=channel:<id>` is what selects which sheet is consulted. The proxy resolves which credentials and tools that channel's team sheet permits. Compromise of the agent process (prompt injection, malicious skill, model misbehavior) yields no tool credentials and only the tool surface that channel's team sheet allows, with every call audited. Those are model-level cases, and none of them reaches certificate selection: which channel a task runs as is derived from the Slack event, not from anything the model produces. Full compromise of the process is wider, because it holds one certificate per channel it serves — the union of those channels' tool surfaces, though still no tool credentials, since none are in that process. What is in it is the Slack app and bot tokens and the model provider key, which the gateway and the loop cannot run without; a leak there lets an attacker speak as the app and spend against the provider, and reaches no tool the proxy guards. See the [security model](/docs/security#which-secrets-are-where).

## Gateway and channel router

Built over Slack Socket Mode (no inbound ports — good self-host ergonomics). Sessions are keyed on `(team_id, channel_id)` with a per-session async mutex serializing context writes; concurrent mentions in one channel queue rather than interleave. Every inbound message in a provisioned channel is stored with `user_id`, display name, `thread_ts`, and timestamp — the raw `thread_ts`, null for a top-level message, so a thread is recoverable from the store rather than inferred. The context assembler renders attribution (`@alice: ...`) so the model can address the right person; the display name is a snapshot taken when the message was stored, and resolving it is the assembler's rather than the write path's. Long tasks render a single live-updating checklist message in the thread (edit, don't spam). Follow-ups in a thread the agent is active in do not require re-mention.

## Agent loop

A ReAct-style loop over a provider-agnostic completion layer (Anthropic, OpenAI, Google, Groq, Ollama out of the box; the optional LiteLLM sidecar covers the long tail behind an OpenAI-compatible endpoint). Per-channel model override comes from the team sheet. Tool definitions are fetched from the proxy at session start — the agent never constructs tool clients itself. Hard caps per task: max tool calls, max wall time, max tokens, all read from the team sheet and enforced in the loop *and* independently in the proxy (defense in depth; the proxy's meter is authoritative).

## Tool proxy

The proxy is the core of the project. It does five things.

**Credential vault and token store.** Tool credentials at rest live in two stores under one master key: the vault, which the operator writes and the serving process only reads, and — for OAuth upstreams — a token store only the proxy writes, because an OAuth 2.1 authorization server rotates a refresh token by handing back its successor, a durable credential no operator ever held. Today both are encrypted files on the proxy's volume (key from env/KMS). The only values the serving process can persist are values an authorization server just issued for an upstream a team sheet already names; it cannot persist an operator-authored secret or read one back out. Refresh-token rotation survives a restart because the successor is persisted before it is used; access tokens are minted into memory and die with the process. Everything else holds for both stores: referenced by name in team sheets, injected into outbound MCP/HTTP calls by the proxy, and never present in any response body, log line, or error message returned to the agent. A redaction pass scrubs known secret values — the minted access token among them — from tool results before they cross back to the agent, closing the "tool echoes its own auth header" leak class. A grant enters the token store through an operator entrypoint on the proxy process: authorization-code + PKCE, the client identified by a published Client ID Metadata Document, the redirect pasted back from a loopback URI nothing listens on — so the flow needs no browser on the proxy and no network path from the operator's browser to it, and grant material stays keyed by issuer, byte for byte, with a changed issuer failing closed into a re-grant.

**Team-sheet enforcement.** On each call the proxy resolves the channel's team sheet and answers deterministically: is this MCP server allowed for this channel; is this specific tool on the allowlist; does the call require approval; is the budget exhausted. Any "no" is a structured refusal the agent can relay to the user. The model's cooperation is never part of the enforcement path.

Where the call goes is answered by the same sheet, in two places that do not overlap. An MCP call goes to the `url` on the `[[mcp_server]]` block that carried the tool — declaring a destination there is what authorizes it, and the block that authorized the tool is the block the call is dispatched to. The `[egress]` allowlist governs the destinations the sheet does *not* pin: the code-execution sandbox, and anything later that takes a URL as an argument. Keeping them apart is what stops one grant widening the other — a channel can reach the GitHub MCP server without its sandbox reaching the GitHub API. Redirects are not followed, because a redirect target is the one destination neither list names.

**HITL approval broker.** Tools marked `approval = "required"` — and, under the destructive-verb heuristic (delete, drop, transfer, deploy), tools whose sheet entry says nothing either way — cause the proxy to hold the call and mint an **approval ticket**: one call, one ticket, bound to the channel by the client certificate, dead fifteen minutes after it is minted. The gateway renders an Approve once / Deny card in the thread and relays the click to `POST /v1/approvals`.

An approved call runs by **re-submission**: the agent re-sends the call carrying the ticket, and the proxy serves it only if the server, the tool, and the hash of the arguments all match the ticketed call. Approve-then-mutate is a refusal, not a call. The ticket is single-use, and **the team sheet is enforced again at redemption** — so an operator's edit during the hold beats a click that preceded it, and an approval never widens what a channel may call. A sheet refusal does not spend the ticket, so fixing the sheet inside the window does not cost the human a second click.

Tickets live in memory. A restart drops pending approvals, which degrades to expiry: the cards go stale, the calls behind them never run, and nothing is served unapproved. Every decision is recorded in the audit log with the approver's Slack user id — `approved` and `denied` when a human clicks, `expired` when a request first finds a ticket that died undecided.

**What approver identity is worth, stated so nothing here overstates it.** The click is observed by gateway code — a Socket Mode interactive envelope, not model output — and relayed to the proxy over a route the model has no tool for. So the approver recorded in the audit log holds against a **prompt-injected model**, and not against a **compromised agent process**, which could forge a decision. That is the same narrower claim the token meter makes, for the same reason, and the alternative — the proxy reading Slack itself — is rejected above because it makes the proxy the gateway. Say *tool credentials* survive process compromise; approvals survive prompt injection. What a forged decision still cannot do is widen anything: it can only approve a call the sheet already permits, because redemption enforces the sheet again.

**Budget meter.** Token, spend and tool-call accounting per channel per day, authoritative in the proxy. One SQLite file, two tables: tool calls keyed `(channel, UTC day)`, and the four raw token counts keyed `(channel, UTC day, model)` — two tables because a tool call has no model, so one key over all three would force the tool-call counter to invent one. Rollover is implicit, because a new day is a key nothing has written and reads as zero, so it survives a restart and does not happen at process start. A hard limit stops the loop and requires the daily rollover or an admin reset — `node dist/budget.js reset <channel>`, a second process against the same file, which takes effect on the next call without a restart. Ambient mode draws from the same meter. The soft limit is `[budget] warn_at`, a fraction of each hard limit rather than a second pair of numbers — so a sheet cannot name a soft limit above the hard one it belongs to, and raising a hard limit moves the warning with it. Crossing it is not a refusal: the decision carries a warning on the call it serves, the agent relays it into the thread beside that task's answer, and the model is never shown it. Claimed once per channel per day per limit, in the meter's own file so that a restart does not re-arm it and a reset does.

The three limits rest on different things. `daily_tool_calls` is counted by the proxy from calls it serves, at the moment it commits to serving one, so it holds even under full compromise of the agent process. `daily_tokens` and `daily_usd` are counted from a report the agent POSTs to `/v1/spend` after each turn — bound to a channel by the client certificate exactly as a tool call is, idempotent on a per-turn id so a retry cannot double-count. The numbers come out of the provider's HTTP response envelope rather than from anything the model writes, so a prompt-injected model cannot forge them; a compromised agent process could, which is an assumption the [security model](/docs/security/) already states and whose consequences are larger.

That report **carries nothing that selects a policy**. It names the model the provider served, which is a dimension of the count rather than a permission: it decides which row the tokens are filed under, the way the day already does, and it selects a price and nothing else. The price table and the cap are the proxy's, and a report naming a model the table does not price refuses the channel rather than metering it at zero — so the lie that helps an agent most, naming no model at all, is the one that stops it, and naming a *cheaper* model buys only what under-reporting the counts already buys. The line to hold as this grows: a field on that report may select a price, and may never select a permission.

What a cached token is worth against `daily_tokens` is a team sheet setting, and what a token *costs* is the proxy's price table, so the meter stores raw counts per model and both the weighting and the price resolve with the rest of policy at decision time. A corrected price re-prices spend already recorded today, on the channel's next call — which is why cost is computed rather than accumulated: a price table is operator-authored config and will eventually contain a typo, and under a stored total the only remedy would be a reset that also discards the spend that was right.

**The report route makes no authorization decision**, and that is structural rather than incidental: it resolves no team sheet, shares no handler with the route that does, and lives in a module with no import that could reach one — a lint rule in CI, not a comment, is what keeps it that way. Reporting spend is not asking for anything, so there is nothing to decide.

**Audit writer.** Append-only SQLite table (WAL), one row per decided tool call: timestamp, channel, requesting user, task id, tool, server, argument hash, outcome, refusal reason, result size and error flag, approver if any, and the approval ticket if the call passed through the broker. The outcome is one of `ran`, `held`, `refused`, `unavailable`, `unanswered`, `approved`, `denied`, or `expired` — the last three are decisions rather than calls, written when a human clicks or when a request first observes a ticket that died undecided. `unanswered` is the proxy describing itself: the call was decided and metered, the handler then failed, and the agent got a 500 rather than any answer. It asserts nothing about whether the upstream acted, because the proxy could not find out — so `ran` undercounts upstream effects by exactly the `unanswered` rows. A held call and its decision are two rows, because the table refuses UPDATE; the ticket column is what ties them together. The read path is `node dist/audit.js` — query and CSV export, opened read-only — and it is a second entrypoint of the proxy process rather than a command in the published CLI, for the reason the budget reset is one: the file lives in a container volume the operator's host cannot see. The line is that the CLI owns what an operator authors on the host (channels, certificates, configuration) and the proxy's own entrypoints own what the services own inside their volumes.

Append-only is enforced by `BEFORE UPDATE` and `BEFORE DELETE` triggers on the table that `RAISE(ABORT)`. SQLite has neither roles nor grants, so a per-role permission is not available to implement — the triggers are, and they hold for every connection that opens the file rather than only for the service. The write-only interface the proxy holds and the file's permissions are defence in depth around that, not the mechanism. None of it stops an attacker who holds the file from dropping the table or replacing it: append-only means the service cannot rewrite history in normal operation. Tamper *evidence* — hash-chained rows — is phase 5.

There is no retention command and there will not be a delete-based one; when the file needs to shrink, it rotates.

**The arguments themselves are not stored, only their hash.** Redacting them would need the credential values, and neither the route nor the writer holds one — that is what makes the rest of this design checkable. Storing arguments redacted against a set the writer cannot see would be worse than storing none, because a column labelled redacted gets believed.

**There is no per-call token count, because there is no such quantity.** Tokens are spent by model turns, not by tool calls; the meter records the real numbers per turn. The audit row carries the size of the result the proxy handed back, which it observes directly and which is the largest driver of the *next* turn's input tokens. Handed back is the operative word: where a result was truncated at the channel's `max_result_chars`, the number recorded is the truncated one, because it exists to predict what the next turn will read rather than to describe what the upstream sent. To ask what a request cost, join on the task id: turn ids are `<task>.<n>`.

The same is true of money, and the audit row says so in its wording rather than leaving it to be inferred. A row carries the channel's **spend so far that day** as the decision saw it, in integer micro-USD, together with the digest of the price table that computed it — the figure the comparison was made against and what priced it, so a past budget decision can be re-derived once prices have moved on. It is absent, never zero, whenever nothing was priced: a channel that sets no `daily_usd` consults no table, and spend the table cannot price has no total. A budget refusal also records which of the three limits bound, which is what lets the audit CLI print the sentence the channel was given rather than "the budget ran out".

## The team sheet

The manifest is the admin surface: a TOML file per channel, intended to live in the operator's own git repo. We call it the channel's **team sheet** — the sheet the manager submits before a match declaring who is allowed on the pitch, what position they play, and what needs the gaffer's sign-off. Nothing in it is a secret — credentials are named references resolved only inside the proxy. See the [team sheet reference](/docs/team-sheet) for a documented starter.

Team-sheet changes are picked up on file change (watched and validated against the zod schema in `@getlibero/schema`); invalid sheets are rejected loudly and the previous valid version stays active.

## Memory

One SQLite database per channel, and the file-per-channel layout *is* the isolation boundary — there is no query path that can join across channels.

- **Layer 1:** full message history with FTS5 for "what did we decide about X" search, exposed to the agent as a `search_channel_history` built-in (proxied like everything else). **A built-in is not a bypass**: it is granted by a `[[builtin]]` block in the channel's team sheet, refused when the sheet omits it, held when the sheet asks for a click, charged to the channel's daily meter, and written to the audit log under the reserved server name `libero`. The only thing that differs from an MCP tool is where the call goes once all of that has passed. Its scope is the calling channel and there is no argument for naming another — the channel comes from the client certificate, and the tool's input schema has no field for one.
- **Layer 2:** `MEMORY.md`, agent-curated via a post-reply inner-loop turn: the model gets one extra call with `memory_append` / `memory_replace` tools and instructions to persist only durable team facts. Writes go through the memory package: an operation that would take the file past the channel's `[memory] max_file_chars` is refused and nothing is written, never silently truncated, because a shortened memory is a fact the team believes it recorded. Every write lands by renaming a fully written temporary file over the old one, so a reader gets the old file or the new one and never a torn one. **There is no lock file**: the agent process is the only writer, its per-channel session queue serializes tasks, and the write itself is synchronous with no point at which a second operation could interleave — and a lock that outlives a killed process is a worse failure than the one it would prevent.
- **Layer 3:** semantic recall via sqlite-vec embeddings over curated facts and thread summaries — same database file, same isolation. Summaries are produced by a pass over threads that have gone **quiet**, which is a correctness condition rather than politeness: a thread summarized mid-argument records a conclusion the team had not reached, and that artifact is then retrieved by exactly the question it is worst at answering. Quiet is `[memory] summarize_after_idle_minutes`, and the pass is the one model call in the deployment that does not follow a mention — a channel opts out with `[memory] summarize = false`, and an unreadable sheet falls back to off. What the pass records is shaped by what the thread produced — a question answered, a decision, an incident, an open question, or **nothing at all**, which writes no vector. That last is load-bearing: a corpus is bounded as much by what it keeps out as by what it holds, and a summary of "deploying now" is a vector that dilutes every deployment question near it.

  **Recall enters a task as context, not as a tool.** At the head of every task the agent embeds the incoming request and renders the nearest summaries into the opening context, beside the transcript and `MEMORY.md`. It is not a second `search_channel_history`: a model-invoked read of a channel's content is a proxied built-in, granted by the sheet and written to the audit log, and an agent-local twin of it would route around that decision rather than extend it. Assembling a task's own opening context is a different act and already the agent's — bounded by `[llm]` and by no `[[builtin]]` grant. If mid-task semantic recall is ever wanted, the consistent shape is a vector leg on the existing built-in rather than a second tool. No model-provider key moves in either case: the query is embedded on the agent side, and the proxy holds none.

Slack retention is respected: a message deleted in Slack is deleted from the store on the corresponding event, and derived data goes with it — an edit or a deletion drops the thread's summary and that summary's embedding, so nothing outlives the words it was drawn from. Curated facts in `MEMORY.md` are the stated exception, since curation is a model turn rather than a join and a fact carries no per-message provenance; they are a distillation the team reads and edits as text.

## Skills

After any task exceeding a tool-call threshold (default 5), a skill-author turn decides whether a reusable playbook emerged and, if so, writes a frontmatter-structured `skills/*.md` (name, description, created, status). Loading is by retrieval: at task start the agent embeds the incoming request and retrieves top-k matching skills (sqlite-vec + FTS hybrid), loading only those into context — never the whole library. Lifecycle: stale at 30 days unused and archived at 90 — `[skills] stale_after_days` and `archive_after_days`, tunable per channel — run by a maintenance job that makes no model call and spends nothing, plus a curator pass that proposes merges of overlapping skills as a PR-style diff for human review rather than silently rewriting institutional knowledge. Skills are text in the channel's directory under the agent state root, beside `MEMORY.md` — the root the agent writes, not the channels root the proxy reads its authorization from: reviewable, editable, deletable by the team that owns them.

**The file carries what a human authored; the index carries what the runtime observed.** Use counts and last-used timestamps are columns in `store.db`, not frontmatter — an earlier draft of this page listed `uses` among the frontmatter fields, and #289 moved it. Retrieval records a use at the head of every task, for every skill it loaded, so in frontmatter that would be top-k rewrites of team-owned markdown per task, each one able to lose an edit somebody made in between. The rule that leaves: reconciliation reads these files and never writes them, and `created` is documentation — no clock reads it, because it is a model-authored line in a file the team may edit. What the clocks run on is the index's own record of when it first saw a skill and when a task last loaded one.

**The job was written as a pass on channel activity rather than a weekly cron, and the two are the same thing here.** The clocks are absolute dates, so the job is idempotent: running it more often moves nothing sooner than its threshold and running it less often only delays. "Weekly" is a statement about how often a status needs revisiting, and any interval at or below it satisfies that — where a cron would mean the process growing a timer and an enumerator over every channel, neither of which anything else here needs. A channel nobody has spoken in for a year ages nothing until somebody does, which is the same answer the quiescence sweep already gives. Two rules keep the team in charge of their own files: a status the job did not write is adopted rather than overwritten, and adopting restarts the clock, so a hand edit buys a full stale window before the job has an opinion again. Ageing needs only time; moving a skill back toward `active` needs a task to have loaded it — which is what makes `archived` terminal without a rule saying so, since nothing archived is ever loaded.

## Ambient mode

Ships last, disabled by default, and only behind the budget meter. A per-channel cron invokes a heartbeat evaluation: recent activity is summarized and the model is asked whether anything merits a proactive post — stale thread, approaching deadline, unanswered question — with a SILENT sentinel otherwise, and a hard rate limit of one proactive post per channel per heartbeat. A `schedule_task` tool (proxied, audited, approval-gated by default) lets the agent create its own future checks.

## Sandbox

The built-in code-execution tool runs in an ephemeral container (Docker by default; gVisor documented for hardened deployments) with no network unless the team sheet grants an egress allowlist, a read-only rootfs, cpu/mem/time limits, and a tmpfs workdir. The runner is invoked *by the proxy*, not the agent, so code execution is audited and budgeted like any other tool.

## Threat model

See the [security model](/docs/security).

## Scope (v1 non-goals)

Discord/Teams adapters (the gateway supports them in principle; untested until Slack is solid). A web admin UI — manifests are files in a git repo, and that *is* the admin UI for v1. Fine-grained per-user permissions within a channel — channel membership is the permission boundary. Voice or DM personal-assistant modes. Multi-workspace control plane — single-tenant self-host only.

## Acknowledgments

Libero builds on and learns from prior open work: the gateway is built over Slack's official MIT-licensed SDKs — [`@slack/socket-mode` and `@slack/web-api`](https://github.com/slackapi/node-slack-sdk) — where we contribute upstream rather than fork when possible; the memory-curation inner loop follows the pattern popularized by Letta; and the skill-lifecycle design draws on ideas explored in earlier MIT-licensed community projects in this category. The channel-agent product category was defined by Anthropic's Claude Tag; Libero exists to offer a self-hosted, model-agnostic, source-available take on it.
