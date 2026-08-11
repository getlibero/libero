# @getlibero/proxy

Unpublished workspace package. `apps/proxy-server` is the process that composes
it. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the
specification.

What is here today: mutual TLS, the rule that decides which channel a request
belongs to, team-sheet enforcement on the call path, the credential vault,
credential injection into outbound HTTP calls, and an MCP client that speaks the
`2026-07-28` revision of the protocol to its upstreams, falling back to the
`initialize` handshake for servers that predate it.

- `tls.ts` — server options that refuse a client with no certificate the local
  CA signed. `requestCert` and `rejectUnauthorized` together, TLS 1.3 only.
- `identity.ts` — the channel id, read from the client certificate's subject
  (`CN=channel:<id>`) and from nowhere else. No header and no request body is
  consulted, because the process on the other end runs the model.
- `team-sheet-store.ts` — resolves `<PROXY_CHANNELS_ROOT>/<channel>/channel.toml`,
  watched and re-read on change. An invalid sheet is rejected loudly and the
  last valid one stays in force.
- `enforce.ts` — the decision, as a pure function of a sheet and a call. No
  I/O, no clock, no model, and nothing in it reads a tool's arguments.
- `dispatch.ts` — the two seams past the decision: what a channel has spent and
  what serves an allowed call. Both are required options with no defaults, and
  `createProxyServer` throws rather than build a proxy that pairs a dispatcher
  which really serves calls with a meter that can never exhaust a budget. The
  meter interface is split three ways — read, count a call, record a turn's
  tokens — so the report route can be handed the last of those and nothing
  else. A dispatcher is handed the team-sheet entry enforcement matched, not the
  sheet — the entry that authorized a call is the entry the call goes to.
- `approvals.ts` / `approvals-route.ts` — the HITL broker: the ticket store and
  the route a human's click arrives on. Tickets are in memory, keyed by channel
  and then by id so a lookup structurally cannot reach another channel's — which
  is why a foreign ticket and one that never existed are genuinely the same
  answer. A spent or expired ticket is kept rather than deleted, so "you already
  used this" does not collapse into "there is no such thing"; a mismatched
  re-submission does not spend one, so a bad retry cannot destroy a human's
  decision. The route is the second with no sheet on it, and the first other
  than `/v1/tools/call` that writes an audit row — because a decision is a fact
  about a call made by a request that is not one, so the row is written there or
  never.
- `budget-db.ts` / `budget-meter.ts` / `budget-admin.ts` — the daily meter over
  `node:sqlite`: counters keyed `(channel, UTC day)` so rollover is a key change
  rather than a sweep, a turn-id table so a retried report cannot double-count,
  and the operator's reset kept in its own module away from the serving path.
- `audit-db.ts` / `audit-log.ts` — the audit log over `node:sqlite`: one row per
  decided tool call, and once the file is open the only statement that touches
  the audit table is an INSERT — the rest of the module's SQL is the
  `schema_version` bookkeeping every database here carries, plus the one
  migration below.
  The file is at schema version 3, and version 1 and 2 files are migrated in
  place on first open. SQLite cannot widen a CHECK constraint, so the migration
  rebuilds the table — the one moment the append-only triggers are deliberately
  dropped. It runs inside a single transaction that also carries the version
  stamp, so a crash anywhere in it rolls back to an untouched older file. What
  made it safe to write at all is that every version so far only *widens*: no
  existing row can fail the new constraint. There is one rebuild rather than a
  ladder — it asks the old table which columns it has rather than being told by
  a version number — because the DDL in the module is by construction the
  *current* table, and a ladder would need a frozen copy of each past one.
  Append-only comes from `BEFORE UPDATE`/`BEFORE DELETE` triggers that
  `RAISE(ABORT)` — SQLite has no roles and no grants, so the write-only
  interface and the file's permissions are defence in depth around those rather
  than the mechanism. The row carries a hash of the model's arguments and never
  the arguments: nothing on the write path holds a credential value, so nothing
  on it could redact one. A failed write refuses the call rather than serving it
  unrecorded. No tokens column — tokens are per turn, so the row carries the
  result's byte length instead and cost joins by task id.

  **Every SQL string in this package is in the module that opens the database it
  runs against** — `budget-db.ts` and `audit-db.ts`, and nowhere else — which is
  what makes "no statement omits `WHERE channel = ?`" checkable in one place.
- `spend-route.ts` — `POST /v1/spend`. The one route with no authorization
  decision on it, and the header says why and what keeps it that way.
- `outbound.ts` — the outbound call, and the **one place in the tree that calls
  `Secret.reveal()`**. `Authorization: Bearer` for every upstream; a fixed
  timeout so a silent upstream cannot pin a request; and errors built from a
  closed set with no `cause`, because a rethrown `fetch` error can carry the
  request headers and those carry the credential. A test asserts the single
  call site by grep. It also **redacts the response before returning it**, and
  the reason that is sufficient rather than merely helpful is structural: a
  credential can only appear in a response if it was sent in a request, and this
  is the only function that sends one. `credentialHeader` and `injectCredential`
  are not exported from the package for the same reason — `callUpstream` is the
  only exported way to send a credential, and it always scrubs the reply.
- `redact.ts` — the scanning rules, kept apart from the custody so they can be
  property-tested without a `Secret` or a socket. Replaces every occurrence of a
  value, in raw, base64 (standard and URL-safe, padded and unpadded),
  percent-encoded, and JSON-escaped form, with `[redacted:<name>]`. The JSON
  spellings matter because the MCP client parses what it is handed: an escaped
  needle that survived the scan is un-escaped on the way to the model (#149). It
  closes the "upstream echoes
  its own auth header" class and says plainly in its header what no scan can
  close — a value the upstream *transforms* is invisible to any search for it.
  An empty stored value throws rather than shredding the body.
- `http-dispatcher.ts` — serves an allowed call against an HTTP upstream:
  resolves the entry's named credential against the vault, then hands the call
  to the client pool. A credential the vault cannot resolve refuses by name
  **before any connection is opened** — not even a discovery probe. A transport
  failure becomes an error result — a tool failing, which the model may recover
  from — while a redaction failure is rethrown, so it reaches the server's
  handler catch and answers a constant 500 instead of serving bytes nobody could
  scrub. It also owns the prose a model reads when a call produced no answer,
  all of it from fixed templates.
- `mcp-protocol.ts` — the wire format as pure functions: JSON-RPC framing, the
  `_meta` every request carries, SSE-body extraction, and the mapping from
  `CallToolResult` to the one string a `ToolResult` holds. No `Secret`, no
  `fetch`, no I/O. Hand-rolled rather than taken from the SDK, and its header
  argues why: the SDK's transport owns its own `fetch`, which would move the
  credential out from under `callUpstream` and turn a one-grep guarantee into a
  careful-wrapper one.
- `mcp-client.ts` — one upstream's client, and the ladder that decides which
  protocol it speaks. Probes `server/discover`; if the server *answers* with a
  refusal of any shape, attempts the legacy `initialize` handshake exactly once
  and caches the result for the client's life. A transport failure short-
  circuits without a fallback — nothing answered, so there is nothing to fall
  back from. Fails closed against a server that speaks no version we do, and
  refuses an `input_required` result rather than answering it — that is an
  upstream asking the proxy to speak for a channel, with no sheet entry and no
  click behind it.

  Replays exactly one signal, on the legacy path only: a 404 answering a request
  that carried a session id, which is the spec's way of saying the session is
  gone. That 404 is generated before the server dispatches anything, so the tool
  did not run and there is no write to double. Nothing else is ever retried —
  `2026-07-28` removed stream resumability, and re-issuing a `tools/call` is how
  one write becomes two.
- `mcp-pool.ts` — one client per upstream, keyed on the `(transport, url,
  credential)` triple `upstreamKey` defines in `enforce.ts`. Sharing that
  definition rather than restating it is what stops the pool from merging two
  blocks enforcement treats as distinct.
- `mcp-fake-server.ts` — a real `node:http` MCP server for the tests, speaking
  either protocol and holding real session state on the legacy one, with the
  knobs the leak assertions need: both framings, an upstream that echoes its
  auth header plainly or JSON-escaped, and one that advertises versions we do
  not speak.
- `vault.ts` — the credential vault, read side. One AES-256-GCM blob over the
  whole entry set, so the names are encrypted along with the values; a per-write
  HKDF subkey; the header authenticated as AAD. Opened once at startup. A value
  leaves only through `Secret.reveal()`, and a `Secret` renders as `[redacted]`
  through `JSON.stringify`, string coercion, and `util.inspect`.
- `vault-file.ts` — the write side, reached only by the operator's CLI in
  `apps/proxy-server`. Apart from `vault.ts` so that file's imports can be read
  as a claim: the process serving tool calls never writes the vault.
- `server.ts` — `node:https` and an exact-match route table, behind mutual TLS.
- `log.ts` — JSON lines over a closed field set. This process holds every
  credential, so there is no free-form log message for one to be interpolated
  into.

Nothing at runtime but `@getlibero/schema`, which fixes the shape of every
error, refusal, and listing the proxy returns. Deliberate, for the process that
holds the secrets.

The audit log's read path is `openAuditReader` in `audit-db.ts` — a second
connection, opened read-only, whose statements are in that file with the write
path's for the reason every statement is. It is reached by `node dist/audit.js`
in `apps/proxy-server` and by nothing on the serving path, which an ESLint rule
enforces by name.

Still to come, with its own issue: the egress allowlist (#73).
`http-dispatcher.ts` marks where the egress check slots in.

The pinned protocol revision lives in one constant in `mcp-protocol.ts`, and
`.github/workflows/mcp-spec-watch.yml` opens an issue when the specification
publishes a newer one. That workflow fails if it cannot find the constant, so a
rename is loud rather than a watcher that quietly reports nothing.

**A permitted call is now served.** `apps/proxy-server` composes the real meter
with `createHttpDispatcher`, so the 501 is gone.
`assertServableComposition` stays and still guards the one pairing that must not
exist — it simply has no provisional meter to reject any more, which is the
point: the seams that land next arrive before their implementations do, and a
stand-in meter is the obvious way to test one.

**Token reports arrive.** The agent's spend client sends one after each model
turn (#110, #115), so `daily_tokens` meters for real rather than reading zero —
and meters as a task runs, so a channel over its cap is refused at that task's
next tool call rather than at its next mention. The dedupe key is
`(channel, turn)` and a turn id is `<task>.<n>`, so a retried turn is a
`duplicate` and the next turn is not. The report carries four raw counts and no
total: what a cached token costs
resolves from the channel's team sheet with the rest of policy, at decision
time, so an operator changes it with a sheet edit rather than an agent release.
`apps/proxy-server/README.md` documents loading secrets into the vault.

## Endpoints

Every route is behind mutual TLS and the channel-identity gate. There is no
anonymous surface.

| Route | | |
| --- | --- | --- |
| `GET /health` | liveness | still needs a certificate naming a channel |
| `GET /v1/whoami` | what the connection authenticated as | |
| `GET /v1/tools` | what this channel may call | `{ tools: [{ server, tool, approval }] }` |
| `POST /v1/tools/call` | one tool call | `ToolCall` in, `ToolCallResponse` out |
| `POST /v1/spend` | what a turn cost | `SpendReport` in, `{ outcome }` out; no decision is made on it |
| `POST /v1/approvals` | a human's decision on a held call | `ApprovalDecision` in, `ApprovalDecisionResponse` out; the ticket id is in the body |

**Approvals.** A tool marked `approval = "required"` is held rather than refused:
the proxy mints a ticket, and the `held` response carries its id and its
deadline. A human's click comes back on `/v1/approvals`, and the approved call
runs by **re-submission** — the same call again, carrying the ticket, served
only if the server, the tool, and the argument hash all match. One ticket, one
call, one channel, fifteen minutes. Tickets are in memory, so a restart drops
pending ones and they degrade to expiry; nothing is served unapproved either
way.

Two things about that route are worth reading as claims rather than as
description. It **resolves no team sheet** — the sheet is enforced when the
ticket is minted and again when it is redeemed, both on `/v1/tools/call`, so an
approval can never widen what a channel may call and an operator's edit during
the hold beats a click that preceded it. And it **cannot mint or redeem** a
ticket: it closes over `ApprovalDecider`, so a route that could manufacture an
approval for a call of its choosing does not exist. Both are enforced by the
import bans in `eslint.config.mjs`, not just asserted here.

Two gates, deliberately. `/v1/tools` keeps an unlisted tool out of the model's
context; `/v1/tools/call` is what actually enforces, and it holds on its own —
a call for a tool that was never listed, or that was listed at session start
and removed from the sheet since, is refused either way. The decision runs
before a credential is resolved or a connection is opened, so a refused call
leaves no trace upstream.

`/v1/tools` carries real tool definitions. It asks each upstream the sheet names
for its `tools/list` through the pool, keeps the entries the sheet named, and
publishes an optional `description` and `inputSchema` beside the approval. **The
sheet decides what is listed; the upstream only describes** — the merge iterates
the sheet's entries and looks each up by name, so a server naming a tool the
sheet does not has no row to attach itself to.

Every way of not getting an answer degrades to the entry as the sheet wrote it,
and logs one `catalog_unavailable` line with a closed `reason`:

| condition | reason |
| --- | --- |
| `transport = "stdio"` | `unsupported_transport` |
| credential not in the vault | `credential_unresolved` (by name) |
| pool closing | `shutting_down` |
| blocks disagree about the upstream | `server_ambiguous` |
| handshake or listing failed | the `McpFailure`, plus a `status` |
| answer was not a `tools/list` | `protocol_error` |
| 5s budget or 5-page walk ran out | `budget_exhausted` / `truncated` |
| body past `PROXY_MAX_RESPONSE_BYTES` | `too_large` |

That is safe because a listing is not the enforcement: a missing schema costs
the model accuracy, never the channel a permission. The one thing that does not
degrade is a `RedactionError` — this proxy unable to guarantee its own boundary
rather than an upstream failing — which answers 500, because degrading would
serve a cheerful thin listing to a channel whose every call is about to fail the
same way.

An upstream's answer is bounded before it reaches a model: descriptions truncate
at 1024 characters, schemas are dropped past 8KB or if they are not a JSON
object saying `type: "object"`, at most 100 tools per upstream carry one, and
the walk follows at most 5 pages. The shape rule is the load-bearing one —
`packages/agent` casts a schema straight into the provider's tool definition, so
one upstream publishing `{"type":"string"}` would fail every turn for every
channel whose sheet names it. **The caps bound the blast radius; they are not a
mitigation for tool poisoning.** Nothing here reads a description, because a
rule that did would be a rule the upstream phrases around. What accepts the
exposure is the team sheet naming the server.

### Two bounds on a response, owned by two different people

Those caps bound what reaches the model's *context*. They do nothing about what
the proxy *buffers*, which is a separate question with a separate answer (#151),
and the two bounds that answer it are split by which principal owns the resource
each spends.

**The wire bound** is `PROXY_MAX_RESPONSE_BYTES`, a deployment setting
defaulting to 4 MiB. `callUpstream` reads a response incrementally and abandons
it past the bound: the reader is cancelled, nothing is decoded, and the call
fails with `too_large`. It is not a team sheet field, because the heap it spends
belongs to the process and is shared by every channel the proxy serves — a sheet
able to raise it would be one channel degrading service for all of them. It is
not hardcoded either, on `PROXY_HOST`'s argument: the operator who sized the
container is the one who should say how much of it a response may occupy. There
is no ceiling, because that operator is the principal who owns the heap.

**The result bound** is `[llm] max_result_chars`, a team sheet field defaulting
to 32,768 characters, overridable per tool on `[[mcp_server.tool]]`. Past it the
result is truncated and carries `[result truncated: N of M characters]`. It is a
sheet field for the reason `max_history_chars` is: it is charged against the
channel's own `max_tokens_per_task`, so a channel raising it spends only its own
budget. Two entries naming one tool resolve most-restrictive-wins, as `approval`
does.

They are layered, not alternatives. The wire bound sits well above the result
bound so an ordinary large answer — a wide file listing, a long diff — is
truncated and says so, and only a pathological one is refused outright. A
handshake gets neither: `MAX_CONTROL_BODY_BYTES` (64 KiB) covers the version
probe, the legacy `initialize`, and the session `DELETE`, none of which anyone
reads at length.

A `tools/list` past the wire bound is **refused rather than truncated**, and
that asymmetry is worth stating: a tool result cut at a cap is a short answer
that admits it, but half a JSON-RPC envelope is not a short catalog — it is an
unparseable one. So an oversized listing takes the path a malformed listing
already takes, degrading to the thin entries the sheet wrote plus one
`catalog_unavailable` line.

The audit row's `result_bytes` records the length **after** truncation, which is
what that column is for: it exists to correlate with the next turn's input
tokens, and those are driven by what the model was handed rather than by what the
upstream sent. The original size is not lost — it is in the notice the model
reads.

Answers are cached per `(upstream, wanted tools)` for five minutes, thirty
seconds on a failure or a partial walk, and single-flighted — so a client
polling the route does not become credentialed load on someone else's server.

`createListingRoute` closes over `ToolCatalog`, whose only method describes. The
dispatcher — the seam that runs something — is not in scope, and
`eslint.config.mjs` bans the vault, the pool, the client, the dispatcher
implementation, and the outbound sender in that file. One object fills both
seams, because it is still the only thing holding a vault and a client pool.

A refusal is a served request: HTTP 200 with `{ outcome: "refused" | "held",
refusal }`. `ProxyError` stays what it was, the shape of a request that could
not be answered at all. A channel with no team sheet gets an empty listing and
a refusal on every call — which is what revoking a channel looks like.

## Certificates

`scripts/dev-certs.sh` mints the CA, the server certificate, and one client
certificate per channel, laid out by role — `ca.pem` at the root, the proxy's
keypair under `proxy/`, the channel client certs under `agent/` — so each
container mounts only its slice and the CA key is mounted into neither. The
tests run that same script rather than carrying fixtures, so no private key is
committed here and the documented operator path is exercised on every CI run.
It needs `openssl` on PATH.
