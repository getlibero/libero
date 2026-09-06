---
title: Limits
description: Every figure that bounds a deployment, where it lives, which process reads it, and whether it is yours to move. One page, 164 rows, and a test that fails when a limit is added without one.
---

Libero is bounded in a lot of places. Some of those bounds are yours to set — a team sheet's
`daily_tokens`, a deployment's `PROXY_MAX_RESPONSE_BYTES`. Most are not: they are figures chosen
in the issue that introduced them, and moving one means a code change and a release.

This page is the whole list. For each figure it says where it lives, which process reads it, the
argument it carries, and — the column this page exists for — whether it is **fixed**, a **sheet
field**, or **deployment-configurable**.

## Why the list is worth having

Every one of these is a one-way door. Loosening a cap later is a release; tightening one breaks
sheets that already parse. `[skills]`' own schema makes the argument: flipping a cap looser later
"is `enabled`'s hazard in reverse and worse — a sheet that never mentioned them would start paying
more on every turn of every task with nothing in its own file changed."

They were also each chosen in isolation. `SCHEDULED_TASK_MAX_PENDING` is ten "because a channel
with ten checks outstanding has a scheduling problem rather than a tooling one" — a defensible
default, and not obviously a universal truth for a workspace much larger or much smaller than the
one it was sized against.

The rule that sorts them is stated in `packages/schema/src/schedule-task.ts`:

> a bound on what the *process assembles* is a constant, and a policy a team holds an opinion about
> is a sheet field, and the thing that decides which is who grew the corpus.

That rule is real and it is not sufficient. It cleanly separates machine-grown from team-grown, and
it does not answer what to do when the operator is *both* author and setter. The **Decision** column
below is where that third answer gets applied, figure by figure.

## What an operator may set, and why nothing here has a ceiling

Eleven figures are settable per deployment (#539) — the seven marked
**deployment-configurable** below, plus the four the proxy already carried. They
are environment variables in the `AGENT_*` and `PROXY_*` contracts each service
already documents, rather than a new file to mount: the environment is
per-process by construction, so a limit the proxy enforces is one the agent has
no path to, without that having to be arranged.

**Absent is the whole default.** Every one keeps the figure its module argues
for, so a deployment that sets none of them is the deployment it was before they
existed, and `""` is a setting removed rather than a setting of zero.

**None of them has an upper bound, and that was a decision rather than an
oversight.** #539 asked for a ceiling on each. The answer is that a ceiling this
repository invents is advice wearing a boundary's clothes: the operator owns the
heap, the bill and the context window, and a figure chosen here against one
imagined workspace is exactly what #465 objected to in the first place. So the
whole of what is enforced is that a value is a positive whole number, because
`AGENT_RECALL_LIMIT=0` and `AGENT_RECALL_LIMIT=none` are both an operator trying
to say something and neither means what silently continuing would do.

There is one real bound in the whole set and it is not ours. `AGENT_RECALL_LIMIT`
is clamped by the message store, which returns at most `READ_MAX_LIMIT` rows for
any one read — so a larger number is not refused and does not do what it says
either. The process logs `recall_limit_clamped` at boot and uses 200. Refusing
it would be deciding an operator may not ask; saying nothing would be the
surprise `[llm] max_history_messages`' own ceiling exists to prevent.

`libero doctor` reports any of the eleven that is set to something that is not a
positive whole number, one restart before the service would refuse to start.

## How to read a row

The **Figure** column carries the source text, not a reading of it — `15 * 60 * 1000` rather than
"fifteen minutes", with the reading in the prose. That is what lets
`packages/test-kit/src/limits-inventory.test.ts` compare the page against the tree and fail when a
figure moves without this page moving.

Limits are addressed by file and symbol, never by line number. A line number is wrong the moment an
import is added above it, and a table of stale line numbers teaches a reader to stop trusting the
column.

## What the proxy enforces

These are read by the process that holds every tool credential. None may become settable from the
agent side or from a request body: the process on the other end runs the model, so anything the
model can influence is not a boundary.

Four of them are already deployment-configurable, through `apps/proxy-server/src/env.ts`. That file
is the precedent any future configuration surface follows — one `xFromEnv(env)` per variable, each
with a comment arguing why it is a deployment setting and not a sheet field, validated at boot.

| Limit | Figure | Decision and why |
| --- | --- | --- |
| `packages/proxy/src/server.ts:MAX_BODY_BYTES` | `1_048_576` | **Fixed.** One mebibyte of inbound tool call. The cap exists so a client cannot make this process buffer without bound, and the check runs before the bytes are kept rather than after. |
| `packages/proxy/src/approvals.ts:APPROVAL_TTL_MS` | `15 * 60 * 1000` | **Fixed**, and argued as such where it lives: "a sheet field is a thing an operator can set to a week — which turns 'the broker fails closed on a restart' into 'the broker fails closed eventually'." |
| `packages/proxy/src/approvals.ts:MAX_TICKETS_PER_CHANNEL` | `64` | **Fixed.** A held call is not metered, so an agent looping on a tool marked `approval = "required"` mints a ticket per iteration and spends no budget doing it. Over the cap the oldest is evicted. |
| `packages/proxy/src/attempts-db.ts:MAX_ATTEMPT_BYTES` | `1_048_576` | **Fixed.** Equal to the listener's `MAX_BODY_BYTES` on purpose: a smaller one would reintroduce the partial-capture exception #122 named as the same failure as partial redaction. |
| `packages/proxy/src/budget-meter.ts:TURN_RETENTION_MS` | `48 * 60 * 60 * 1000` | **Fixed.** Two days of reported turn ids, generous enough to cover a retry and short enough to bound the table at two days of turns rather than every turn ever reported. |
| `packages/proxy/src/builtins.ts:DEFAULT_SEARCH_LIMIT` | `20` | **Fixed.** The default row count for `search_channel_history`, well below `READ_MAX_LIMIT` because the model can ask for more and every message it did not need is charged against `max_tokens_per_task`. |
| `packages/proxy/src/builtins.ts:RUN_CODE_MAX_CHARS` | `65_536` | **Fixed.** An argument the model writes is an argument a prompt injection can write. Far past any script worth sending and far short of a body worth buffering in the process that holds every tool credential. |
| `packages/proxy/src/vault.ts:MAX_VAULT_BYTES` | `262_144` | **Fixed.** A hostile or corrupt vault file should not be able to make this process allocate. The token store and the signing store take the same figure by importing it. |
| `packages/proxy/src/custody.ts:MAX_SECRET_BYTES` | `8_192` | **Fixed.** One credential value — generous enough for a PEM private key. Contract-level rather than the file backend's, because every writer holds it. |
| `packages/proxy/src/mcp-bounds.ts:MAX_RELAYED_MESSAGE` | `300` | **Fixed.** Upstream-authored text inside a placeholder or error line. |
| `packages/proxy/src/mcp-bounds.ts:MAX_LABEL` | `64` | **Fixed.** A block *type* name inside `[unsupported content block: …]`. Per #500 these stopped being a rendering detail the moment a label started travelling inside a block the agent parses. |
| `packages/proxy/src/mcp-bounds.ts:MAX_TOOL_SCHEMA_BYTES` | `8192` | **Fixed.** "Bigger than any hand-written schema and small enough that a hundred of them are not a context window." |
| `packages/proxy/src/mcp-catalog.ts:MAX_DESCRIBED_TOOLS` | `100` | **Fixed.** A bound on what enters the model's context, applied *after* the sheet's names have filtered the page, so an upstream cannot push a sheet's tool past the cap behind two hundred decoys. |
| `packages/proxy/src/mcp-catalog.ts:MAX_CATALOG_PAGES` | `5` | **Fixed.** Pages walked before a listing gives up. |
| `packages/proxy/src/mcp-catalog.ts:CATALOG_TTL_MS` | `300_000` | **Fixed.** Five minutes, because a task fetches its listing once and mentions arrive in bursts, so this collapses a burst to one round trip per upstream. |
| `packages/proxy/src/mcp-catalog.ts:CATALOG_FAILURE_TTL_MS` | `30_000` | **Fixed.** Thirty seconds bounds a persistently down upstream to one attempt per half minute per process, and still recovers quickly. |
| `packages/proxy/src/mcp-catalog.ts:CATALOG_BUDGET_MS` | `5_000` | **Fixed.** The wall budget for one catalog walk. Since #159 each page costs a permit on the upstream's semaphore, so pages after the in-flight one are abandoned outright. |
| `packages/proxy/src/mcp-pool.ts:QUEUE_WAIT_MS` | `5_000` | **Fixed.** How long a call waits for an upstream permit, and per #253 it is spent out of the call's budget rather than beside it — waiting here and then starting a fresh upstream timeout meant a queued call could run thirty-five seconds against an agent that hung up at thirty. |
| `packages/proxy/src/mcp-pool.ts:LISTING_QUEUE_WAIT_MS` | `2_000` | **Fixed.** Must stay under `CATALOG_BUDGET_MS`; a partial walk caches empty parameter declarations and SEP-2243 upstreams then refuse. `mcp-pool.test.ts` pins the inequality. |
| `packages/proxy/src/mcp-pool.ts:IDLE_TTL_MS` | `900_000` | **Fixed.** Idle MCP client eviction, deliberately above `CATALOG_TTL_MS`. |
| `packages/proxy/src/outbound.ts:DEFAULT_UPSTREAM_TIMEOUT_MS` | `30_000` | **Deployment-configurable** today, as `PROXY_UPSTREAM_TIMEOUT_MS`. |
| `packages/proxy/src/outbound.ts:DEFAULT_UPSTREAM_RESPONSE_BYTES` | `4_194_304` | **Deployment-configurable** today, as `PROXY_MAX_RESPONSE_BYTES`. Four mebibytes and deliberately not the listener's one, because since #129 a response may be a `tools/list` catalog. A sheet able to raise it would be one channel degrading service for all of them. |
| `packages/proxy/src/outbound.ts:DEFAULT_UPSTREAM_CONCURRENCY` | `8` | **Deployment-configurable** today, as `PROXY_MAX_UPSTREAM_CONCURRENCY`. Low enough that one busy channel cannot spend a shared upstream's rate limit on behalf of every other channel naming it. |
| `packages/proxy/src/outbound.ts:MAX_CONTROL_BODY_BYTES` | `65_536` | **Fixed.** Handshake and `DELETE` replies. "Not a default and not a sheet field but a cap — these are not a deployment's business." |
| `packages/proxy/src/outbound.ts:SESSION_TERMINATION_TIMEOUT_MS` | `2_000` | **Fixed.** Docker sends SIGKILL ten seconds after SIGTERM, and a thirty-second courtesy `DELETE` to a wedged upstream would mean the budget and audit databases never got their close. |
| `packages/proxy/src/outbound.ts:MAX_SESSION_ID` | `512` | **Fixed.** Session-id length before the proxy declines to hand it onward. |
| `packages/proxy/src/sandbox-dispatcher.ts:DEFAULT_SANDBOX_CONCURRENCY` | `2` | **Deployment-configurable** today, as `PROXY_MAX_SANDBOX_CONCURRENCY` (#405). Not a sheet field: a channel's `[[builtin]]` block sizes one run, and how many runs the *host* can hold at once is a fact about the deployment no channel is in a position to know. |
| `packages/proxy/src/sandbox-dispatcher.ts:MAX_REPLY_BYTES` | `4_194_304` | **Fixed.** "The other end promised" is not a bound. |
| `packages/proxy/src/sandbox-dispatcher.ts:OVERHEAD_MS` | `30_000` | **Fixed.** Allowance beyond the run's own wall-time cap; a client timeout below the server's own cap would abandon containers. |
| `packages/proxy/src/sandbox-dispatcher.ts:SANDBOX_QUEUE_WAIT_MS` | `10_000` | **Fixed.** Ten seconds, twice the MCP pool's five, and not sized against the whole run budget for the reason #253 names. |
| `packages/proxy/src/token-engine.ts:TOKEN_EXPIRY_MARGIN_MS` | `30_000` | **Fixed.** The early-refresh margin, sized against `QUEUE_WAIT_MS` plus a handshake plus clock skew. |
| `packages/proxy/src/dpop.ts:DPOP_PROOF_LIFETIME_SECONDS` | `300` | **Fixed.** RFC 9449 §4.2. Stated here rather than enforced — it is the figure the fake issuer enforces. |
| `packages/proxy/src/dpop-verifier.ts:IAT_WINDOW_SECONDS` | `300` | **Fixed.** The proof `iat` skew window. |
| `packages/proxy/src/grant-flow.ts:MAX_CALLBACK_BYTES` | `16 * 1024` | **Fixed.** An operator-pasted callback URL. "The paste is one URL; anything past this is not one." |
| `packages/proxy/src/grant-flow.ts:DEFAULT_GRANT_PHASE_TIMEOUT_MS` | `30_000` | **Fixed.** The per-phase OAuth budget. |
| `packages/proxy/src/custody-gcp.ts:OPEN_CONCURRENCY` | `8` | **Fixed.** Secrets fetched at once at vault open. Sequential would make startup linear in the credential count against a network; unbounded would open a socket per secret at the moment the process is least able to spare one. |
| `packages/proxy/src/custody-aws.ts:OPEN_CONCURRENCY` | `8` | **Fixed.** The GCP backend's batch, for its reason. |
| `packages/proxy/src/custody-gcp-client.ts:MAX_CONTROL_BODY_BYTES` | `65_536` | **Fixed.** The bound the outbound path takes. |
| `packages/proxy/src/custody-gcp-client.ts:DEFAULT_TIMEOUT_MS` | `30_000` | **Fixed.** One Secret Manager call. |
| `packages/proxy/src/custody-gcp-client.ts:TOKEN_MARGIN_MS` | `60_000` | **Fixed.** Early refresh of the metadata-server access token. |
| `packages/proxy/src/custody-gcp-client.ts:PAGE_SIZE` | `100` | **Fixed.** The listing walk's page. |
| `packages/proxy/src/custody-gcp-client.ts:MAX_PAGES` | `20` | **Fixed.** The listing walk's ceiling. |
| `packages/proxy/src/custody-aws-client.ts:MAX_CONTROL_BODY_BYTES` | `65_536` | **Fixed.** The bound the outbound path, the runner's Docker client and the GCP client all take. |
| `packages/proxy/src/custody-aws-client.ts:DEFAULT_TIMEOUT_MS` | `30_000` | **Fixed.** One Secrets Manager call. |
| `packages/proxy/src/custody-aws-client.ts:CREDENTIAL_MARGIN_MS` | `60_000` | **Fixed.** Early refresh of the container or instance credential. |
| `packages/proxy/src/custody-aws-client.ts:IMDS_TOKEN_TTL_SECONDS` | `21_600` | **Fixed.** The IMDSv2 session token's lifetime, six hours. |
| `packages/proxy/src/custody-aws-client.ts:PAGE_SIZE` | `100` | **Fixed.** The listing walk's page. |
| `packages/proxy/src/custody-aws-client.ts:MAX_PAGES` | `20` | **Fixed.** The listing walk's ceiling. |
| `apps/runner/src/server.ts:MAX_BODY_BYTES` | `262_144` | **Fixed.** The code bound is 64k and the envelope around it is small. Checked against the streamed length rather than `content-length`, which a caller writes. |
| `apps/runner/src/run.ts:SANDBOX_PIDS_LIMIT` | `128` | **Fixed.** A fork bomb is the cheapest way to make a machine unusable. Not a sheet field, for the reason the tmpfs is not: a channel sizing its own enforcement point would be a channel deciding how hard its enforcement is to exhaust. |
| `apps/runner/src/run.ts:HOP_READY_TIMEOUT_MS` | `30_000` | **Fixed.** How long the hop is given to bind its port. The cost of being wrong is asymmetric in the two directions. |
| `apps/runner/src/docker.ts:CALL_TIMEOUT_MS` | `30_000` | **Fixed.** Any single Engine API call except `wait`. |
| `apps/runner/src/docker.ts:MAX_CONTROL_BODY_BYTES` | `65_536` | **Fixed.** The shape `MAX_CONTROL_BODY_BYTES` takes in the proxy's outbound path. |
| `apps/runner/src/hop-server.ts:DIAL_TIMEOUT_MS` | `10_000` | **Fixed.** How long to wait for an allowed upstream to accept the connection. |

The runner's three operator ceilings — `RUNNER_MAX_CPUS`, `RUNNER_MAX_MEMORY_MB`,
`RUNNER_MAX_TIMEOUT_SECONDS` (#405) — have no row, because they have no figure: an absent member
means no ceiling on that field, which is the behaviour that predates them, preserved deliberately.
`deploy/docker-compose.yml` ships real values.

## What the agent assembles

These bound what the model process builds and how often it acts. None of them is a security
boundary — the proxy's meter is authoritative — and they exist so that a task cannot spend a
channel's context on one pasted stack trace, or a background pass run more often than a team can
read its output.

`apps/server` deliberately reads **no** numeric environment variable. `session/registry.ts` states
the rule: "this process's environment contract is that everything in it is required and
load-bearing; an optional knob for a number nobody has yet had a reason to change cuts against it."

| Limit | Figure | Decision and why |
| --- | --- | --- |
| `apps/server/src/session/context.ts:MAX_MESSAGE_CHARS` | `2_000` | **Fixed.** One human message's contribution to history. This process's rather than the sheet's: it exists so a single pasted stack trace cannot spend a channel's whole assembly budget on one author. |
| `apps/server/src/session/context.ts:MAX_AGENT_MESSAGE_CHARS` | `1_000` | **Fixed.** Tighter than a person's, deliberately, since `max_history_chars` is shared (#523). |
| `apps/server/src/session/recall.ts:RECALL_LIMIT` | `5` | **Deployment-configurable** as `AGENT_RECALL_LIMIT` (#539). "A retrieved summary that was not relevant is not neutral, it is a distractor" — but the figure is sized against a corpus, and the size of one is a deployment fact. The message store returns at most `READ_MAX_LIMIT` rows for any one read, so a larger value is logged at boot rather than refused or silently taken. |
| `apps/server/src/session/recall.ts:RECALL_MAX_CHARS` | `6_000` | **Deployment-configurable** as `AGENT_RECALL_MAX_CHARS` (#539). Still not a sheet field: what it bounds is what this process assembles, and a channel raising it would spend a budget it shares. |
| `apps/server/src/session/skill-recall.ts:SKILLS_MAX_CHARS` | `12_000` | **Deployment-configurable** as `AGENT_SKILLS_MAX_CHARS` (#539). Three times `SKILL_BODY_MAX_CHARS`, and deliberately not the sum of three maxima. The per-channel caps beside it stay `[skills]` fields. |
| `apps/server/src/session/fired-turn.ts:MAX_FIRED_TURN_MESSAGES` | `40` | **Fixed.** Messages a fired turn reads. Re-exported as `MAX_CHECK_MESSAGES` rather than restated, because "two numbers for one quantity is how one of them gets read as the other". |
| `apps/server/src/session/heartbeat.ts:MAX_HEARTBEAT_MESSAGES` | `40` | **Fixed.** Messages one heartbeat evaluation reads. |
| `apps/server/src/session/summarize.ts:SWEEP_INTERVAL_MS` | `5 * 60 * 1000` | **Fixed.** How often one channel may sweep for quiet threads. |
| `apps/server/src/session/summarize.ts:MAX_THREADS_PER_SWEEP` | `3` | **Fixed.** The bound that matters on the first sweep of an existing channel. |
| `apps/server/src/session/summarize.ts:MAX_THREAD_MESSAGES` | `60` | **Fixed.** `READ_MAX_LIMIT` is 200 and would already clamp this. |
| `apps/server/src/session/ambient.ts:AMBIENT_RESCAN_MS` | `60_000` | **Fixed.** The ceiling on the sleep before re-reading the channels directory, matching `heartbeat_every_minutes`' floor of one. |
| `apps/server/src/session/ambient.ts:MAX_CONCURRENT_HEARTBEATS` | `4` | **Fixed.** After a restart every enabled channel takes the same first-sight instant and therefore comes due together. |
| `apps/server/src/session/skill-curate.ts:CURATE_INTERVAL_MS` | `24 * 60 * 60 * 1000` | **Fixed.** What this bounds is how often a team may be asked to read something. |
| `apps/server/src/session/skill-curate.ts:MAX_OPEN_PROPOSALS` | `3` | **Deployment-configurable** as `AGENT_MAX_OPEN_PROPOSALS` (#539). Counted from the directory rather than the index. What it bounds is how much unread review a team is carrying, which is a fact about the team. |
| `apps/server/src/session/skill-curate.ts:MAX_PROPOSAL_PRUNES_PER_PASS` | `8` | **Fixed.** Orphaned rows cleared per pass. |
| `apps/server/src/session/skill-embed.ts:MAX_SKILLS_PER_EMBED_PASS` | `10` | **Fixed.** `[skills] max_skills` defaults to a hundred, so a full library is worked through over ten passes. |
| `apps/server/src/session/skill-lifecycle.ts:LIFECYCLE_INTERVAL_MS` | `6 * 60 * 60 * 1000` | **Deployment-configurable** as `AGENT_SKILL_LIFECYCLE_INTERVAL_MS` (#539). The spec calls this a weekly job; idempotence is what makes any interval at or below that satisfy it, so the figure is a cost decision and the operator pays it. |
| `apps/server/src/session/skill-lifecycle.ts:MAX_SKILL_STATUS_WRITES_PER_PASS` | `20` | **Fixed.** What it bounds is neither calls nor tokens but writes to files a team owns. |
| `apps/server/src/session/registry.ts:SESSION_IDLE_MS` | `30 * 60_000` | **Fixed**, and coupled — see [figures that are two figures](#figures-that-are-two-figures). Moving it down means moving `follow_up_window_seconds`' ceiling down (#66). |
| `apps/server/src/session/sheet.ts:DEFAULT_FOLLOW_UP_WINDOW_MS` | `900_000` | **Sheet field.** The fallback a sheet that says nothing inherits for `follow_up_window_seconds`. |
| `apps/server/src/session/names.ts:NAME_CACHE_MAX` | `500` | **Fixed.** Distinct users one session remembers. |
| `apps/server/src/proactive/proactive.ts:HEARTBEAT_POST_WINDOW_MS` | `4 * 60 * 60 * 1000` | **Deployment-configurable** as `AGENT_HEARTBEAT_POST_WINDOW_MS` (#539). "Too short kills the feature and too long only costs a finding." `[ambient]`'s comment refuses the *sheet field* by name and that refusal stands — a channel tightening its cadence must not loosen its own throttle. The throttle stays in the posting surface, reachable from no sheet. An operator is not a channel. |
| `apps/server/src/checklist/checklist.ts:MIN_EDIT_INTERVAL_MS` | `1_000` | **Fixed.** It exists to stay inside Slack's rate limits, which belong to the app rather than to any channel, and a sheet able to lower it would be one channel spending an allowance the whole workspace shares. |
| `apps/server/src/index.ts:SHUTDOWN_DRAIN_MS` | `8_000` | **Fixed.** Not how long a task can take. Sized against one spend call and one Slack edit, under the `stop_grace_period: 20s` that `deploy/docker-compose.yml` sets. |
| `packages/agent/src/loop/loop.ts:MAX_TOOL_ERROR_CHARS` | `2048` | **Fixed.** A tool that returns a megabyte of stack trace should not become a megabyte of context. |
| `packages/agent/src/skill/turn.ts:SKILL_STEP_MAX_CHARS` | `512` | **Fixed.** This package declining to relay unbounded data rather than a policy a channel should be able to raise. |
| `packages/agent/src/proxy/tool-names.ts:MAX_NAME_LENGTH` | `64` | **Fixed.** Every provider bounds a tool name at 64 characters. |
| `packages/agent/src/proxy/transport.ts:MAX_RESPONSE_BYTES` | `1_048_576` | **Fixed.** Mirrors the proxy's own read cap. |
| `packages/agent/src/proxy/transport.ts:DEFAULT_PROXY_TIMEOUT_MS` | `30_000` | **Fixed.** How long a request may take before it is abandoned, when nothing else says. |
| `packages/agent/src/proxy/transport.ts:RETIRED_AGENT_GRACE_MS` | `30_000` | **Fixed.** How long a superseded agent is left alone before its sockets are dropped. |
| `packages/agent/src/proxy/spend.ts:DEFAULT_SPEND_TIMEOUT_MS` | `5_000` | **Fixed.** How long a Slack thread waits on bookkeeping nobody asked for. The proxy's work is one parse and one row; a meter that has not answered in five seconds is not going to answer usefully. |
| `packages/agent/src/proxy/budget.ts:DEFAULT_BUDGET_TIMEOUT_MS` | `5_000` | **Fixed.** A channel's session mutex is held while a background pass asks whether to start. |
| `packages/agent/src/proxy/approvals.ts:DEFAULT_APPROVAL_DECISION_TIMEOUT_MS` | `5_000` | **Fixed.** The ticket survives the abandonment — fifteen minutes of validity against five seconds of deadline — so the human retries by clicking, not by waiting. |
| `packages/gateway/src/slack/gateway.ts:SEEN_EVENT_LIMIT` | `1000` | **Fixed.** Events remembered for redelivery suppression. |
| `packages/gateway/src/slack/socket-mode.ts:CLOSE_TIMEOUT_MS` | `1_000` | **Fixed.** How long a socket is given to close before the reconnect ladder moves on. |
| `packages/gateway/src/slack/proactive-post.ts:BODY_LIMIT` | `800` | **Fixed.** Above `AMBIENT_FINDING_MAX_CHARS`, deliberately, so an ordinary finding is never truncated on the way to a channel. |
| `packages/gateway/src/slack/approval-card.ts:TOOL_NAME_LIMIT` | `80` | **Fixed.** What fits on a card. |
| `packages/gateway/src/slack/approval-card.ts:ARGUMENTS_LIMIT` | `300` | **Fixed.** What fits on a card. |
| `packages/gateway/src/slack/approval-card.ts:REASON_LIMIT` | `400` | **Fixed.** What fits on a card. |
| `packages/gateway/src/slack/checklist-card.ts:TOOL_NAME_LIMIT` | `80` | **Fixed.** The approval card's figure, for its reason. |
| `packages/gateway/src/slack/checklist-card.ts:NOTE_LIMIT` | `200` | **Fixed.** What fits on a checklist row. |
| `packages/gateway/src/slack/checklist-card.ts:MAX_ROWS` | `20` | **Fixed.** Rows before a checklist stops being readable in a thread. |
| `packages/gateway/src/slack/decision.ts:TICKET_ID_LIMIT` | `128` | **Fixed.** Matches `ToolCall.id`'s bound; a click decodes into one. |

## What both ends agree on

These live in `packages/schema`, which reads no environment at all and should keep not reading it.
Most of them bound what the *model* may write — a memory operation, a skill body, a scheduled
check's prompt — which is why they are constants rather than sheet fields: they bound what the model
may write, not what a channel may spend.

`packages/memory`'s four are the store's own bounds on what a caller can make it do.

| Limit | Figure | Decision and why |
| --- | --- | --- |
| `packages/schema/src/schedule-task.ts:SCHEDULED_TASK_MAX_PENDING` | `10` | **Deployment-configurable** as `PROXY_MAX_PENDING_SCHEDULED_TASKS` (#539), and #465's named example. "The cap is the backstop behind that click, not the primary control." `packages/schema` is untouched and still reads no environment: the cap counts rows in a store rather than checking a shape, so the schema states the figure and `builtin-dispatcher.ts` reads it. |
| `packages/schema/src/schedule-task.ts:SCHEDULED_TASK_MIN_LEAD_MINUTES` | `5` | **Fixed.** Below it the design cannot honour the time it promised: the clock rescans at most once a minute and a create is held for a human's click, so a two-minute lead is a check already late when approved. |
| `packages/schema/src/schedule-task.ts:SCHEDULED_TASK_MAX_HORIZON_MINUTES` | `10_080` | **Fixed.** A week, which is `answer_after_idle_minutes`' own roof and the same judgement. |
| `packages/schema/src/schedule-task.ts:SCHEDULED_TASK_MAX_PROMPT_CHARS` | `500` | **Fixed.** Enough to say what to check and what would count as worth mentioning, and short enough that a human reading it on an approval card reads all of it. Under `AMBIENT_FINDING_MAX_CHARS`, deliberately. |
| `packages/schema/src/skill.ts:SkillName` | `1..64` | **Fixed.** "A name is a subject, not a sentence: the sentence is `description`." |
| `packages/schema/src/skill.ts:SKILL_BODY_MAX_CHARS` | `4_096` | **Fixed.** One memory operation, twice a thread summary. The upper bound is retrieval: a longer skill is a vector averaged over more procedures, and past a point it is retrieved by everything and answers nothing. |
| `packages/schema/src/skill.ts:SKILL_DESCRIPTION_MAX_CHARS` | `512` | **Fixed.** This is the retrieval surface. Longer and it stops being a statement of when this skill applies and starts being a summary of the skill, which makes a vector unselective. |
| `packages/schema/src/memory-op.ts:MEMORY_OP_MAX_TEXT_CHARS` | `4_096` | **Fixed.** Above the floor because compaction *is* replace-with-a-shorter-string; below the roof because one op must not be able to spend the file. One sixteenth of `max_file_chars`' default. |
| `packages/schema/src/thread-summary.ts:SUMMARY_MAX_TEXT_CHARS` | `2048` | **Fixed.** Chosen against retrieval rather than storage: one vector stands for the whole summary. "A thread that cannot be said in 2048 characters is one that should have been segmented." |
| `packages/schema/src/ambient-finding.ts:AMBIENT_FINDING_MAX_CHARS` | `700` | **Fixed.** Under the gateway's own post cap, deliberately. An unprompted message is rate-limited so the agent does not speak often, and bounded so it does not speak at length. |
| `packages/schema/src/tool-listing.ts:MAX_TOOL_DESCRIPTION` | `1024` | **Fixed.** A budget, not a style rule: tool definitions are fetched once per task and re-sent on every model turn. A proxy bounding at 2048 against a schema rejecting at 1024 would turn every chatty upstream into a malformed response on the agent side. |
| `packages/schema/src/tool-call.ts:id` | `1..128` | **Fixed.** It lands in a SQLite key and in log lines. |
| `packages/schema/src/tool-call.ts:thread` | `1..128` | **Fixed.** `id`'s bound, for its reason. |
| `packages/schema/src/tool-call.ts:MAX_RESULT_MIME_TYPE` | `64` | **Fixed.** Was the proxy's own `MAX_LABEL`; it lives here now because it stopped being one module's rendering detail the moment a block became a shape both ends parse (#160). |
| `packages/schema/src/tool-call.ts:MAX_RESULT_URI` | `200` | **Fixed.** `MAX_RESULT_MIME_TYPE`'s move, for its reason. |
| `packages/schema/src/sandbox.ts:SANDBOX_CODE_MAX_CHARS` | `65_536` | **Fixed.** Restated here rather than imported from the proxy because this file is what the runner parses against, and a bound on only one side of a wire is a bound an attacker skips by speaking to the other side. |
| `packages/schema/src/sandbox.ts:SANDBOX_MAX_OUTPUT_BYTES` | `1_048_576` | **Fixed.** The runner's own bound and not the channel's, so a program printing in a loop cannot make the runner buffer without limit before anybody gets a chance to truncate. |
| `packages/schema/src/sandbox.ts:SANDBOX_MAX_CPUS` | `64` | **Fixed.** One figure serving two shapes since #545 — the runner's `SandboxCaps` and the sheet's `[[builtin]]` cap both read it, where they used to state it separately. |
| `packages/schema/src/sandbox.ts:SANDBOX_MAX_MEMORY_MB` | `65_536` | **Fixed.** As above. |
| `packages/schema/src/sandbox.ts:SANDBOX_MAX_TIMEOUT_SECONDS` | `3_600` | **Fixed.** As above. |
| `packages/schema/src/spend-report.ts:TurnId` | `1..128` | **Fixed.** `ToolCall.id`'s bound: it lands in a SQLite key and in log lines. |
| `packages/schema/src/spend-report.ts:MAX_REPORTED_TOKENS` | `10_000_000` | **Fixed.** Not a plausibility check — no provider bills a single turn near this — but a bound, so a wrong or hostile number cannot make the counter meaningless or overflow the arithmetic it feeds. |
| `packages/schema/src/spend-report.ts:MAX_REPORTED_COST_NANO_USD` | `1_000_000_000_000` | **Fixed.** `MAX_REPORTED_TOKENS`' argument, except that this one fails open rather than closed. |
| `packages/schema/src/price-table.ts:MAX_PRICE_MICRO_USD` | `1_000_000_000` | **Fixed.** A thousand dollars per million tokens, here to bound the arithmetic rather than to judge the number. A price this large is almost certainly a units mistake, and one that fails at load is better than one that refuses a channel at breakfast. |
| `packages/schema/src/names.ts:DestinationHost` | `1..253` | **Fixed.** A DNS name's length. |
| `packages/schema/src/names.ts:ModelId` | `1..128` | **Fixed.** `TurnId`'s bound, for its reason. |
| `packages/schema/src/egress.ts:EgressPattern` | `1..255` | **Fixed.** One allowlist host pattern. |
| `packages/memory/src/store-db.ts:READ_MAX_LIMIT` | `200` | **Fixed**, and coupled — see [figures that are two figures](#figures-that-are-two-figures). |
| `packages/memory/src/store-db.ts:SEARCH_MAX_TERMS` | `32` | **Fixed.** A bound on what a caller can make this process do rather than tuning, because #64 feeds model-authored text through here. Clamps silently, and safely: dropping terms from an AND removes constraints, so a truncated query returns more of *this* channel's messages and never a row from another. |
| `packages/memory/src/store-db.ts:SEARCH_MAX_QUERY_CHARS` | `1024` | **Fixed.** `SEARCH_MAX_TERMS`' argument. |
| `packages/memory/src/store-db.ts:MAX_EMBEDDING_DIMS` | `4096` | **Fixed.** A bound on what a caller can make this file do rather than a limit of `vec0`. The widest embedding any shipping model produces today is 3072, so this leaves room without leaving a `float[2000000000]` in a DDL string one arithmetic slip away. |

## What a sheet may set, and the bound on that bound

These are the fields a channel's own members edit. They are already configurable, so the question
this page asks of them is narrower — the one #538 states: `[skills] top_k` is 1..10, and the row
asks whether **10** is a deployment's to raise, not whether the field exists.

The answer for almost all of them is no, and for one reason: a ceiling that a deployment could
raise is a ceiling a channel could then reach, and several of these bound spend rather than taste.

`[[builtin]]`'s three sandbox caps have no rows of their own here any more. Since #545 their
ceilings are `SANDBOX_MAX_CPUS`, `SANDBOX_MAX_MEMORY_MB` and `SANDBOX_MAX_TIMEOUT_SECONDS` in the
section above — one figure each, read by both the sheet and the runner's own parse rather than
written out twice. What a channel may *ask for* is still the sheet's; what it will *get* is
`RUNNER_MAX_CPUS` and its two siblings, which is the deployment's.

| Limit | Figure | Decision and why |
| --- | --- | --- |
| `packages/schema/src/team-sheet.ts:top_k` | `1..10` | **Fixed ceiling.** Three rather than recall's five by default, because a skill is up to 4096 characters where a summary is 2048. Zero does not parse: that is `enabled = false` said a second way. |
| `packages/schema/src/team-sheet.ts:max_always_skills` | `1..10` | **Fixed ceiling.** The count's roof is `top_k`'s, so no reading of this sheet lets the standing set be larger than the largest pool retrieval may load (#432). |
| `packages/schema/src/team-sheet.ts:max_always_chars` | `max 32_768` | **Fixed ceiling.** `max_file_chars`' *default* rather than its roof: past 32k the standing set has stopped being a standing instruction and become a document. |
| `packages/schema/src/team-sheet.ts:max_skill_chars` | `max 65_536` | **Fixed ceiling.** A sanity bound in the spirit of `max_file_chars`': past 64k a skill has stopped being a playbook. |
| `packages/schema/src/team-sheet.ts:max_skills` | `1..1_000` | **Fixed ceiling.** A hundred by default is far more playbooks than a channel will write and far fewer than the point where any of those hurt. The cost that sizes the roof is the curator's overlap pass, which compares skills against each other and so grows as the square. |
| `packages/schema/src/team-sheet.ts:stale_after_days` | `1..3_650` | **Fixed ceiling.** `min(1)` rather than `min(0)`: zero would be a second spelling of "the clocks are off". The roof leaves ten years. |
| `packages/schema/src/team-sheet.ts:archive_after_days` | `1..3_650` | **Fixed ceiling.** `stale_after_days`' bounds, for their reason. |
| `packages/schema/src/team-sheet.ts:max_file_chars` | `max 262_144` | **Fixed ceiling.** Past a quarter-megabyte the file has stopped being a distillation and become a document the channel cannot afford to read on every task. Its floor is `MEMORY_OP_MAX_TEXT_CHARS`, because a file cap below one operation's ceiling is a channel where a legal operation is unwritable by construction. |
| `packages/schema/src/team-sheet.ts:summarize_after_idle_minutes` | `5..10_080` | **Fixed ceiling.** The one number here an operator genuinely holds an opinion about, which is why it is a field. The floor of five minutes is a bound rather than a recommendation; the roof is a week, past which the thread has not gone quiet, the channel has. |
| `packages/schema/src/team-sheet.ts:answer_after_idle_minutes` | `5..10_080` | **Fixed ceiling.** The sibling of `summarize_after_idle_minutes` in name and in kind — the worst case for a proactive answer is their sum, seventy-five minutes at the defaults. |
| `packages/schema/src/team-sheet.ts:heartbeat_every_minutes` | `1..1_440` | **Fixed ceiling.** The roof is a day, past which the heartbeat is not noticing anything. Fifteen minutes by default because a quiet channel's ticks are free, so the figure trades against latency rather than against spend. |
| `packages/schema/src/team-sheet.ts:max_history_messages` | `max 200` | **Fixed ceiling**, and coupled — see [figures that are two figures](#figures-that-are-two-figures). Without it a sheet could name a number the store would silently clamp (#67). |
| `packages/schema/src/team-sheet.ts:follow_up_window_seconds` | `max 1800` | **Fixed ceiling**, and coupled. A window longer than `SESSION_IDLE_MS` would be cut short by eviction, so the sheet refuses one loudly (#66). |
| `packages/schema/src/team-sheet.ts:certificate_sha256` | `1..4` | **Fixed ceiling.** "`max(4)` is the operator who stopped dropping old fingerprints. Two is a rotation in progress; four is room for a mistake; ten is a list of keys nobody has retired, which is what this field exists to prevent." A sheet naming no certificate must not parse (#79). |
| `packages/schema/src/team-sheet.ts:description` | `max 500` | **Fixed ceiling.** The cap keeps a paragraph from becoming a standing tax on every task's `max_tokens_per_task`, and it is a parse failure rather than a truncation because a sheet is a reviewed file (#369). |
| `packages/schema/src/team-sheet.ts:persona` | `max 1000` | **Fixed ceiling.** Bounded for `description`'s reason, doubled because a paragraph is not a sentence (#270). |
| `packages/schema/src/team-sheet.ts:at` | `1..4` | **Fixed ceiling.** "Four because a rule is one question, and a question worth asking at five separate clock times is two rules." The cap is the cadence floor and the duplicate check is what keeps it honest. |
| `packages/schema/src/team-sheet.ts:days` | `1..7` | **Fixed ceiling.** There are seven. |
| `packages/schema/src/team-sheet.ts:AmbientRuleList` | `max 8` | **Fixed ceiling.** "Eight because a sheet with nine standing rules has a scheduling problem rather than a tooling one", which is `SCHEDULED_TASK_MAX_PENDING`'s judgement in its own words. Eight rules of four times each is thirty-two firings a day. |
| `packages/schema/src/team-sheet.ts:AmbientRuleName` | `1..64` | **Fixed ceiling.** A rule's schedule is keyed by name. |
| `packages/schema/src/team-sheet.ts:TimeZoneName` | `1..64` | **Fixed ceiling.** An IANA zone name (#470). |
| `packages/schema/src/team-sheet.ts:ScopeToken` | `1..128` | **Fixed ceiling.** "A scope is a word, not a document." |
| `packages/schema/src/team-sheet.ts:scopes` | `max 16` | **Fixed ceiling.** The list is bounded for `ScopeToken`'s reason (#255, #505). |
| `packages/schema/src/team-sheet.ts:cache_read_weight` | `max 100` | **Fixed ceiling.** The default is Anthropic's ratio. |
| `packages/schema/src/team-sheet.ts:cache_write_weight` | `max 100` | **Fixed ceiling.** The default is Anthropic's ratio. |

Two figures on this block are deliberately **not** bounded above, and both are decisions rather than
omissions. `max_result_chars` has no roof because the companion bound — how many bytes the proxy
will read off an upstream — is `PROXY_MAX_RESPONSE_BYTES`, a deployment setting (#151). `daily_usd`
has no default at all, because "a default token count is a brake; a default dollar cap is a bill".

## What an operator's entrypoint accepts

Read by a command an operator runs, not by a service.

| Limit | Figure | Decision and why |
| --- | --- | --- |
| `apps/proxy-server/src/audit-cli.ts:DEFAULT_LIST_LIMIT` | `50` | **Fixed.** "Default to something useful rather than the whole table." `csv` deliberately has no such default. |
| `apps/proxy-server/src/budget-cli.ts:PRUNE_OLDER_THAN_MS` | `48 * 60 * 60 * 1000` | **Fixed.** Matches the meter's own `TURN_RETENTION_MS`. |
| `apps/proxy-server/src/drift-cli.ts:NOTABLE_DIFFERENCE` | `0.01` | **Fixed.** It decides wording only: every row is printed either way, and the drift command has no failing exit code at all. |
| `apps/server/src/tasks-cli.ts:LIST_LIMIT` | `50` | **Fixed.** Above `SCHEDULED_TASK_MAX_PENDING` so a channel at its cap is shown whole. There is deliberately no `--limit`. |
| `apps/server/src/rebuild-cli.ts:MAX_SUMMARIES_PER_EMBED_CALL` | `16` | **Fixed.** The batch size per provider call. |
| `apps/server/src/rebuild-cli.ts:MAX_SUMMARIES_PER_REBUILD` | `1000` | **Fixed.** "Where a provider bill stops being something you would want to discover afterwards." |
| `packages/cli/src/doctor-cli.ts:EXPIRY_WARN_MS` | `30 * 24 * 60 * 60 * 1000` | **Fixed.** How near an expiring certificate has to be before `doctor` says so. |
| `packages/cli/src/doctor-cli.ts:PROBE_TIMEOUT_MS` | `5000` | **Fixed.** How long `doctor` waits on a probe before reporting it unreachable. |

## Figures that are two figures

Three figures are written twice, in packages that cannot import from one another. The reason is the
same for all three and it is not going away: `packages/schema` is the base package and cannot import
`packages/memory`, `packages/agent` or `apps/server`, so the number cannot be made one. **Moving one
of a pair means moving the other**, and since #545 a test says so rather than a reviewer.

| Pair | Figure | What breaks if they drift | What notices |
| --- | --- | --- | --- |
| `READ_MAX_LIMIT` / `[llm] max_history_messages`' roof | 200 | A sheet could name a number the store silently clamps — the one place that clamp would surprise (#67). | `packages/memory/src/coupled-figures.test.ts` |
| `DEFAULT_AGENT_LOOP_CAPS` / the four `[llm]` caps | 25, 300 s / 300_000 ms, 200_000, 8_192 | The loop's own defence-in-depth cap and the sheet's stated one stop meaning the same thing. | `packages/agent/src/coupled-caps.test.ts` |
| `SESSION_IDLE_MS` / `follow_up_window_seconds`' roof | 1_800_000 ms / 1800 s | A follow-up window longer than eviction would be cut short rather than refused (#66). | `apps/server/src/session/coupled-window.test.ts` |

Each test lives in the package that can see both halves, which is always the dependent one — the
edge back to `packages/schema` is the one the leaf rule forbids. Each asserts through
`parseTeamSheet` rather than by reading a bound off a zod object: what matters is which sheets
parse, and a schema introspected for its `.max()` is a test of zod's internals.

**Two of the three are unit-converted rather than equal**, which is why an equality assertion over
all of them would have been wrong: `max_task_seconds` is seconds against `maxWallTimeMs`'
milliseconds, and `follow_up_window_seconds` is seconds against `SESSION_IDLE_MS`. The tests state
the conversion.

**There was a fourth pair, and it is one figure now.** `SandboxCaps` and `[[builtin]]`'s
`sandboxLimits` are both in `packages/schema`, so the import ban never applied to them — the
duplication was habit rather than necessity. Since #545 both read `SANDBOX_MAX_CPUS` and its two
siblings, which is the better answer wherever it is available: a test that two numbers agree is
worth having only when they cannot be made one number.

## What this page does not cover

The inventory's net is the two shapes #538 names: a module-level numeric constant, and an inline
numeric zod bound with a literal. Three things are outside it deliberately, and the omission is
stated rather than left to be discovered.

- **Bounds derived from a constant.** `.max(SKILL_BODY_MAX_CHARS)` is a reader of a figure decided
  elsewhere. The constant carries the row; the derived site is a fact about the constant.
- **Numeric fields inside object literals.** `DEFAULT_AGENT_LOOP_CAPS`' four figures and the hop
  container's caps in `apps/runner/src/run.ts` are named in the prose above but are not swept.
  Matching them mechanically would mean knowing which object literals are caps, which is parsing
  TypeScript — and `packages/test-kit`, which runs the check, declares no dependencies at all.
- **Non-emptiness and sign checks.** A lone `.min(1)` says a string is not empty and a lone `.min(0)`
  says a number is not negative. Neither is a figure anybody chose.
- **Exit codes, schema versions, cipher sizes, ports and unit conversions.** Numeric, and not bounds.
  Each is excluded by name with its reason in `NOT_A_LIMIT`, in
  `packages/test-kit/src/limits.ts` — so an exclusion is a line in a diff rather than a regex quietly
  not matching.

Figures in tests are not swept either. A number in a fixture is a fixture, and this is a record of
what ships.
