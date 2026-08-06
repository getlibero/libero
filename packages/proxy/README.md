# @getlibero/proxy

Unpublished workspace package. `apps/proxy-server` is the process that composes
it. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the
specification.

What is here today: mutual TLS, the rule that decides which channel a request
belongs to, team-sheet enforcement on the call path, the credential vault, and
credential injection into outbound HTTP calls.

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
  The file is at schema version 2, and version 1 files are migrated in place on
  first open. SQLite cannot widen a CHECK constraint, so the migration rebuilds
  the table — the repository's first, and the one moment the append-only
  triggers are deliberately dropped. It runs inside a single transaction that
  also carries the version stamp, so a crash anywhere in it rolls back to an
  untouched version 1 file. What made it safe to write at all is that version 2
  only *widens*: no existing row can fail the new constraint.
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
  value, in raw, base64 (standard and URL-safe, padded and unpadded), and
  percent-encoded form, with `[redacted:<name>]`. It closes the "upstream echoes
  its own auth header" class and says plainly in its header what no scan can
  close — a value the upstream *transforms* is invisible to any search for it.
  An empty stored value throws rather than shredding the body.
- `http-dispatcher.ts` — serves an allowed call against an HTTP upstream:
  resolves the entry's named credential against the vault, then calls out. A
  credential the vault cannot resolve refuses by name **before any connection
  is opened**. A transport failure becomes an error result — a tool failing,
  which the model may recover from — while a redaction failure is rethrown, so
  it reaches the server's handler catch and answers a constant 500 instead of
  serving bytes nobody could scrub. The request body it posts is a placeholder;
  MCP's JSON-RPC framing and the client pool are #39.
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

Still to come, each with its own issue: the egress allowlist (#73), the MCP
client pool (#39), and the audit log's read path (#98).
`http-dispatcher.ts` marks where the egress check slots in.

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

`/v1/tools` is a **permission manifest, not a tool catalog**: a team sheet
carries names and approval and nothing else, so real tool definitions —
descriptions and input schemas — arrive with the MCP client pool (#39), which
intersects the upstream catalogs with this list.

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
