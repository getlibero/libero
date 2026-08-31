# @getlibero/proxy

Unpublished workspace package. `apps/proxy-server` is the process that composes
it. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the
specification.

What is here today: mutual TLS, the rule that decides which channel a request
belongs to, team-sheet enforcement on the call path, the credential vault,
credential injection into outbound HTTP calls, and an MCP client — the official
SDK since #188 — that probes for the `2026-07-28` revision and falls back to the
`initialize` handshake for servers that predate it. The SDK reaches the network
only through `outbound.ts`'s guarded fetch, which is still the one function that
reveals a credential and the one that scrubs the reply.

- `tls.ts` — server options that refuse a client with no certificate the local
  CA signed. `requestCert` and `rejectUnauthorized` together, TLS 1.3 only.
- `identity.ts` — the channel id, read from the client certificate's subject
  (`CN=channel:<id>`) and from nowhere else. No header and no request body is
  consulted, because the process on the other end runs the model. It also reads
  the certificate's SHA-256 digest, which the identity gate matches against the
  fingerprints the channel's sheet pins (#79) — the sheet's one say in *which
  key* may speak for a channel, and no say at all in which channel a key speaks
  for.
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
  `schema_version` bookkeeping every database here carries, one read of the
  chain's tip at open, plus the one migration below.
  The file is at schema version 5, and version 1 through 4 files are migrated in
  place on first open. SQLite cannot widen a CHECK constraint, so the migration
  rebuilds the table — the one moment the append-only triggers are deliberately
  dropped. It runs inside a single transaction that also carries the version
  stamp, so a crash anywhere in it rolls back to an untouched older file. What
  made it safe to write was that every version through 4 only *widens*: no
  existing row can fail the new constraint. Version 5 is the first that cannot
  say that — it adds two NOT NULL columns — so it answers the question
  differently, by computing a value for every row it copies. There is one rebuild
  rather than a ladder — it asks the old table which columns it has rather than
  being told by a version number — because the DDL in the module is by
  construction the *current* table, and a ladder would need a frozen copy of each
  past one.
  Append-only comes from `BEFORE UPDATE`/`BEFORE DELETE` triggers that
  `RAISE(ABORT)` — SQLite has no roles and no grants, so the write-only
  interface and the file's permissions are defence in depth around those rather
  than the mechanism. Rows are hash-chained on top of that, which is a different
  kind of protection and is described below. The row carries a hash of the
  model's arguments and never the arguments — decided in #122 rather than
  deferred, and the argument is in `audit-log.ts`'s header. A failed write
  refuses the call rather than serving it unrecorded. No tokens column — tokens
  are per turn, so the row carries the result's byte length instead and cost
  joins by task id.

  **Every SQL string in this package is in the module that opens the database it
  runs against** — `budget-db.ts`, `audit-db.ts` and `attempts-db.ts`, and
  nowhere else — which is
  what makes "no statement omits `WHERE channel = ?`" checkable in one place.
- `spend-route.ts` — `POST /v1/spend`. The one route with no authorization
  decision on it, and the header says why and what keeps it that way.
- `budget-route.ts` — `GET /v1/budget`. Its mirror: that one writes a counter and
  cannot read one, this one reads and cannot write. **Advisory, not
  enforcement** — see below.
- `outbound.ts` — the outbound call, and the **one place in the tree that calls
  `Secret.reveal()`**. `Authorization: Bearer` for every upstream; a fixed
  timeout so a silent upstream cannot pin a request; and errors built from a
  closed set with no `cause`, because a rethrown `fetch` error can carry the
  request headers and those carry the credential. A test asserts the single
  call site by grep. It also **redacts the response before returning it**, and
  the reason that is sufficient rather than merely helpful is structural: a
  credential can only appear in a response if it was sent in a request, and this
  is the only function that sends one. `credentialHeader` and `injectCredential`
  are not exported from the package for the same reason — `callUpstream` and the
  guarded fetch built on it are the only exported ways to send a credential, and
  both scrub the reply.

  Since #156 the body is **scrubbed as it arrives** rather than read to
  completion first. `callUpstreamStream` is the call and `callUpstream` is that
  same call drained to a string, so there is still one reveal site and one
  redaction rule set — the token exchange and every control-plane read take the
  drained one, and the MCP transport takes the stream. What it bought is what
  #128 had accepted: a server that leaves its event stream open after delivering
  the result now returns that result instead of hitting the timeout, and a
  progress notification arrives while it is still progress.
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

  Since #501 it also exports `findSecret`, which asks the same needles a
  different question: **is one of them in here at all.** A tool result's binary
  payloads are searched twice — once as wire text like everything else, and once
  *decoded*, in `mcp-bounds.ts`, where a credential the base64 does not spell can
  be found. It answers rather than edits, because there is no edit: replacing
  bytes inside a PNG produces a corrupt image at a length the container's own
  headers no longer describe, so a match raises `RedactionError` and the whole
  result fails closed. The passes never leave this layer — what crosses to
  `mcp-bounds.ts` is a `SecretScan`, a closure over them, so the single reveal
  site is unchanged.

  `StreamingRedactor` is the same rules over a body still arriving, and the
  difficulty it exists for is the only one there is: a chunk boundary is chosen
  by an upstream's TCP writes, so a credential can be split across two of them
  and a per-chunk scan would pass it through. It holds back exactly the tail that
  a later chunk could still complete into a match — measured, not the worst case,
  because assuming the worst case would hold back more than an SSE event is long
  and make streaming pointless. The suite pins it against the buffered path
  across every split of a body rather than asserting the two separately.
- `http-dispatcher.ts` — serves an allowed call against an HTTP upstream:
  resolves the entry's named credential against the vault, then hands the call
  to the client pool. A credential the vault cannot resolve refuses by name
  **before any connection is opened** — not even a discovery probe. A transport
  failure becomes an error result — a tool failing, which the model may recover
  from — while a redaction failure is rethrown, so it reaches the server's
  handler catch and answers a constant 500 instead of serving bytes nobody could
  scrub. It also owns the prose a model reads when a call produced no answer,
  all of it from fixed templates.
- `mcp-bounds.ts` — what an upstream is allowed to say and how much of it:
  the channel's bound on a result, the caps on a description and a schema, and
  the per-entry rule for reading a page of a catalog. Since #501 it also maps an
  SDK content block to the wire's four block types, and **vouches for each
  candidate against the schema the agent will parse it with** rather than
  re-deriving that schema's rules — a block this module emits that fails over
  there is not a degraded result, it is a lost call. What it cannot vouch for
  degrades to the placeholder sentence. No `Secret`, no `fetch`, no I/O — the
  decoded payload scan it runs is a closure it is handed, never a value it
  holds. It is policy rather than protocol, which is why it outlived the wire
  format it used to sit beside.
- `mcp-client.ts` — one upstream's client, over `@modelcontextprotocol/client`
  since #188, and **the only module in the tree that may import the SDK** (an
  ESLint ban, a `boundary-check` grep and a test in `outbound.test.ts` each keep
  it that way). What this file owns is the translation: it configures the client
  so the proxy's refusals are structural, and it maps the SDK's open error
  surface onto a closed set of failure words. From an SDK error it reads the
  class and the numeric code and never a message — except the one relay that was
  always upstream text and has always been scrubbed.

  Five of its options invert an SDK default and each would fail quietly if
  dropped, so each has a test that fails without it: `versionNegotiation:
  { mode: "auto" }` (the SDK defaults to the legacy handshake with no probe),
  `inputRequired: { autoFulfill: false }` (it defaults to *on*, which would let
  an upstream drive elicitation and sampling from inside an ordinary
  `tools/call`), `supportedProtocolVersions` (the SDK's own list reaches back to
  the HTTP+SSE revisions this proxy fails closed on — their results arrive on
  the listen stream the guarded fetch answers 405, so accepting the handshake
  makes every call a timeout), `reconnectionOptions.maxRetries: 0`, and the
  absence of an `authProvider` — without one the OAuth paths are unreachable
  rather than merely unused. A `tools/call` goes out as a raw `request` against
  a permissive envelope rather than through `callTool`, so the SDK's
  header-mismatch recovery — which would re-POST an identical call — has no
  code path to run on, and one forward-revision content block costs a
  placeholder rather than the whole answer.

  Replays exactly one signal, on the legacy path only: a 404 answering a request
  that carried a session id, which is the spec's way of saying the session is
  gone. That 404 is generated before the server dispatches anything, so the tool
  did not run and there is no write to double. The stale client is dropped
  rather than closed, because closing aborts in-flight requests and the other
  callers about to discover the same loss are still reading their own 404s.
  Nothing else is ever retried — `2026-07-28` removed stream resumability, and
  re-issuing a `tools/call` is how one write becomes two.
- `mcp-pool.ts` — one client per upstream, keyed on the `(transport, url,
  credential)` triple `upstreamKey` defines in `enforce.ts`. Sharing that
  definition rather than restating it is what stops the pool from merging two
  blocks enforcement treats as distinct. It also gates that client behind
  `PROXY_MAX_UPSTREAM_CONCURRENCY` permits, so the calls every channel rides
  through one client are counted (#159). A client is kept while it is in use and
  dropped after `IDLE_TTL_MS` without — fifteen minutes, above the catalog's
  window so an entry is never evicted underneath a listing still citing it
  (#158). What that releases is a legacy client's `Mcp-Session-Id`, which is
  state at somebody else's server and used to be terminated only at shutdown;
  the entry it exists to collect is the one whose key no sheet names any more,
  since a rotated credential name or a moved url mints a new `upstreamKey` and
  strands the old. Eviction is **lazy and on `acquire`**, with an injected clock
  and no timer, the way `mcp-catalog.ts` expires — so a proxy that goes
  completely quiet keeps what it had until the next call or `close()`, which is
  the case least worth a timer. Two guards are load-bearing rather than tidy: an
  entry with a call in flight or queued is never swept, and neither is the key
  being acquired, or an upstream called once an hour would re-run the version
  ladder every time and never hold a session at all. OAuth is not a reason for
  any of this — `CredentialSource` means the client holds the source and mints
  per request, so it already outlives a token.
- `mcp-catalog.ts` — what an upstream says its tools are, bounded and cached on
  `upstreamKey` with per-name freshness. Its file header is the record for the
  walk, the budget and the three publication states; what belongs beside the
  pool's entry above is that since #374 it also **collects**. The rule is per
  resolution rather than per entry, and that is the whole of it: dropping an
  entry only once everything in it had expired never fires on the case that
  holds bytes, which is one tool removed from a server whose other tools keep
  the entry warm while nothing asks for the removed name again. A published
  resolution carries a bounded description and schema, so a stranded upstream is
  most of a megabyte rather than a map slot. Lazy, on read, injected clock, no
  timer — the same trade as the pool, including that a quiet proxy collects
  nothing until the next listing or `clear()`. Collecting is otherwise invisible
  by construction, since every reader already treats an expired resolution as a
  missing one, which is why `size` exists and why the cases assert a walk count
  beside it. The in-flight guard there is a **correctness** guard rather than a
  memory one: an entry is emptiest while it is being walked, and collecting it
  lets the next caller join that walk and then assemble from a different object,
  answering with no tools at all.
- `semaphore.ts` — FIFO permits with a bounded wait, and a waiter that gave up
  leaves the queue rather than being handed a permit nobody is waiting for.
- `mcp-fake-server.ts` — a real `node:http` MCP server for the tests, speaking
  either protocol and holding real session state on the legacy one, with the
  knobs the leak assertions need: both framings, an upstream that echoes its
  auth header plainly or JSON-escaped, and one that advertises versions we do
  not speak.
- `custody.ts` — what a credential store *is*: `Secret`, `Vault`, `TokenStore`,
  `Custody`, `MAX_SECRET_BYTES`, `CustodyError`. No `node:fs`, no `node:crypto`,
  no `envelope.ts` — the import list is the claim that the two encrypted files
  are the built form rather than the invariant (#482). `custody-backend.ts` is
  the whole backend switch and `custody-admin.ts` the operator's writer, apart
  from it for the reason `vault-file.ts` is apart from `vault.ts`.
  `custody-conformance.ts` holds the assertions every backend inherits; the
  section "Two credential stores" below is the argument.
- `custody-gcp.ts` / `custody-aws.ts` — the two managed backends and their
  clients (`custody-gcp-client.ts`, `custody-aws-client.ts`), each speaking its
  provider's API with no client library, for `apps/runner/src/docker.ts`'s
  reason. `fake-secret-manager.ts` and `fake-secrets-manager.ts` are the servers
  their suites run against; the AWS one also verifies every SigV4 signature.
- `vault.ts` — the credential vault, read side, and the default backend's half
  of it. One AES-256-GCM blob over the
  whole entry set, so the names are encrypted along with the values; a per-write
  HKDF subkey; the header authenticated as AAD. Opened once at startup. A value
  leaves only through `Secret.reveal()`, and a `Secret` renders as `[redacted]`
  through `JSON.stringify`, string coercion, and `util.inspect`. The vault is
  one of two credential stores — the OAuth token store beside it is specified
  under "Two credential stores" below.
- `vault-file.ts` — the write side, reached only by the operator's CLI in
  `apps/proxy-server`. Apart from `vault.ts` so that file's imports can be read
  as a claim: the process serving tool calls never writes the vault. What that
  process does write is the token store — the custody decision under "Two
  credential stores" below.
- `grant-flow.ts` — the authorization-code + PKCE grant, orchestrated for the
  grant entrypoint (`node dist/grant.js` in `apps/proxy-server`) and reached by
  nothing on the serving path, which the ESLint groups enforce alongside the
  vault's write side. The redirect is a paste-back — a loopback URI nothing
  listens on, the code bound by PKCE and `state` — and the refresh token the
  exchange yields is written to the token store inside the flow, returned to no
  caller. The custody section below says why that shape.
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
enforces by name. `verifyChain` is on it for a second reason on top of that one:
the walk needs the serialization as well as the SQL, and a walk that recomputed
with a different encoding would report a break on every untampered file ever
written.

Still to come, with its own issue: the egress allowlist's first live caller
(#219), which arrives with the code-execution sandbox (#368). Where it goes is
decided rather than open — "Reaching a runtime" and "Enforcing `[egress]`" below
— and it is not a call site in this package. `http-dispatcher.ts` says why it
makes no such check, and that stays true.

The proxy pins no protocol revision of its own any more. The SDK owns the wire
since #188, so keeping up with the specification is a dependency bump rather
than a code change here — and there is no watcher. There was one — a weekly cron that compared
that constant against the specification's revision tags — and it was retired with
#188 rather than repointed, because its only mechanism was grepping a constant
that will not exist and its own header conceded the fatal limit: it fired on
revision *tags*, so a within-revision change was invisible to it. That is exactly
the gap (`x-mcp-header`) that #130 hit, and the watcher was green throughout.

**One property narrowed with adoption, and it is worth knowing before you meet
it.** The proxy's rule for a catalog is that an unreadable *entry* is skipped
and only an unreadable *page* is refused — a partial catalog costs the model
accuracy, while a refused one costs every tool beside the bad entry its schema.
The client asks for a page against a permissive schema precisely to keep that,
and on the `2025-11-25` era it works: a tool whose `inputSchema` is not an object,
or is missing, is published thin and the rest of the page survives.

On `2026-07-28` it does not. The SDK validates a result against the
specification's shape before any caller-supplied schema, and a single
non-conforming entry fails the whole page — which the proxy then reports as a
protocol error and falls back to the sheet's thin entries for every tool. There
is no relaxation flag, and the bytes it rejected never reach us.

What is lost is graceful degradation, not a permission: the listing still names
every tool the sheet allows, and the sheet is still enforced on the call. Every
upstream in production today negotiates the legacy era, GitHub included.
`mcp-catalog.test.ts` pins both halves so this is a decision on the record rather
than something to rediscover.

**The same narrowing applies to a *result*, which #503 found by looking.** A
`tools/call` goes out as a raw `request` against `CallEnvelope`'s permissive
schema precisely so that one unreadable content block costs a placeholder rather
than the whole answer — and on `2026-07-28` the SDK validates the result against
the specification's closed content union first, so a block from a newer revision,
or an `image` whose `data` is not base64, fails the entire call as a protocol
error. `mcp-bounds.ts`'s `[unsupported content block: …]` and its
degrade-a-bad-payload branch are therefore **reachable on the legacy era and not
on the modern one**. They are not dead code: the era they work on is the era
production runs. `e2e/src/content-blocks.test.ts` asserts them there and says so,
for the same reason the paragraph above exists.

**What replaces it is a review obligation, not a job.** An
`@modelcontextprotocol/*` bump lands inside the process that holds every tool
credential, so it is a security review: read the changelog, and answer the two
questions a version diff does not — whether anything new lets an upstream ask
the client to act on a channel's behalf (the way `input_required` does, which is
a refusal decision before it is an implementation one), and whether the servers
this deployment actually talks to speak the revision yet.

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

### Two spend tables, and which model spent what

Since #62 the meter records **which model** a turn's tokens went to, because a
dollar cap cannot be resolved without it and the team sheet cannot answer:
`[llm] model` is optional, and when it is absent the real model is `AGENT_MODEL`
in the agent process's env, which this service cannot see. Under a router the
sheet is wrong even when it is set.

Tool calls and tokens are now **two tables**, not one re-keyed table.
`channel_spend` is `(channel, day)` and holds `tool_calls`;
`channel_token_spend` is `(channel, day, model)` and holds the four counts. A
tool call has no model, so one table keyed on all three would force
`addToolCall` to invent one — and the row it invented would carry a real count
beside zeroed token columns, one key meaning two things. The split also puts
something worth reading straight into the schema: `daily_tool_calls` is the limit
that holds under full compromise of the agent process, and nothing #62 added
touches its table.

**Cost is never accumulated.** The meter stores raw counts and the price table
joins them in `enforce.ts` at decision time, exactly as the cache weights are
applied rather than stored — so correcting a mistyped price re-prices spend
already recorded today, on the channel's next call. The arithmetic is BigInt: a
count times a price at the table's ceiling passes 2^53, and a cap whose exactness
depends on how large the day got is not a cap. A price table is operator-authored config and will
eventually contain a typo; under a stored total the only remedy would be
`budget reset`, which also discards the spend that was right. `BudgetSpend`
carries both the day's totals and the split, and the totals are summed from the
split rather than read separately, so the two cannot disagree.

**Two reserved model ids**, because they look alike and behave oppositely.
`(legacy)` is what the version-2 migration files pre-#62 counts under; it is
priced at **zero**, since `daily_usd` did not exist when those tokens were spent
and charging them would refuse a channel on the morning after an upgrade. It can
only appear on rows dated on or before the migration, so it ages out with one UTC
day. `(unreported)` is what the meter files a report that named no model under;
it is deliberately **unpriceable**, so a channel capped in dollars fails closed.
The remedies differ — "add a price" against "diagnose the agent" — which is why
one "unknown" would not do. Neither can arrive on the wire: `ModelId`'s alphabet
has no parenthesis, so the reservation holds at parse rather than by convention,
the way `BUILTIN_SERVER`'s does.

**Version 2 is also the first migration this file has had.** `checkVersion` could
previously only stamp or refuse, so a shape change had no path forward that did
not go through an operator deleting their spend. `rebuildBudgetTables` follows
`audit-db.ts`'s `rebuildAuditTable`, including asking the table what it has
rather than trusting the stamp. Unlike the audit log's versions this one is a
**data move rather than a widening**, so "what happens to a row that fails" needed
its own answer: none can, because every v1 row maps by a total function to one
`channel_spend` row and at most one bucket. Check that again before adding a
version 3.

**The report route still decides nothing.** The model is a dimension of a count —
it selects which row the tokens land in, the way the day already does — and
`spend-route.ts` resolves no sheet, imports nothing that could, and answers 200
either way. Its ESLint rule is unchanged. The line to hold: a dimension may
select a *price*, and may never select a *permission*.

`price-table-store.ts` is where a table is read: absent is legal and prices
nothing, a parse failure keeps the last good table, and a removed file drops it.
It pairs a stat with a watcher for `team-sheet-store.ts`'s reason — correcting a
digit in a price changes neither the file's size nor its inode, which is exactly
the edit a stat cannot see.

**The watcher is a seam, and that is a testing decision rather than a deployment
one** (#474). Nothing in production passes one: `watchDirectory` is the default
and is what every deployment runs. What the seam buys is that the property the
pairing exists for — an edit the stat cannot see still reaches the store — is
asserted without waiting on `fs.watch` delivery, which is at the platform's
discretion and which coalesces on macOS. That case had been a flat 50 ms, then a
polled second, and a full-workspace run beat the second too; a third raise would
have been the same fix with the same expiry ahead of it, and each raise makes a
real regression slower to surface. One case still drives a real `fs.watch` end to
end so the seam cannot prove itself, and its bound is ten seconds because
reaching it should be news.

**`daily_usd` is enforced here, and the order is load-bearing.** `exhaustedLimit`
answers pricing faults first, then dollars, then tokens, then tool calls. Pricing
first because a channel whose spend cannot be priced has an unknown position
against its dollar cap, so no comparison below it is trustworthy — answering
`daily_tokens` would send an operator to raise a number that is not the problem.
Dollars before tokens because it is the more specific statement and the one the
operator asked for.

**A sheet with no `daily_usd` never consults the price table**, which is what
keeps a channel on a self-hosted model working exactly as it did. The two pricing
refusals are conditional on the cap rather than on the spend: they do not say
"this deployment is misconfigured", they say "this channel cannot be capped as its
sheet asks". `crossedThreshold` takes the same first branch, so `warn_at` covers
all three limits and a dollar cap's first sign is a notice rather than a refusal.

### The soft limit

`[budget] warn_at` is a **fraction** of each hard limit rather than a pair of
absolute soft values (#99). The contradiction then has nowhere to live: a soft
limit above the hard one it belongs to is unsayable rather than validated, which
is why the field needs no cross-field refinement — and a fraction follows an edit
to `daily_tokens` where an absolute pair goes stale silently. `1` is excluded,
because a warning delivered at the moment the meter is spent is the refusal said
twice; `0` is off.

`crossedThreshold` sits beside `exhaustedLimit` and runs **after** it, which is
the acceptance criterion rather than a preference: a channel crossing both in one
call is refused, and a refusal carries no warning.

**The claim is durable and belongs to the meter.** `budget_warning (channel, day,
budget_limit)` with `ON CONFLICT DO NOTHING` is what makes "once a day" hold
under concurrency — per *limit*, because two limits are two facts — and
`clearDay` clears it, so an operator's reset re-arms the warning. It needed **no
`BUDGET_SCHEMA_VERSION` bump**: that stamp guards the shape of the *counters* and
this table holds none, so a build without it reads and writes every number
identically and simply never warns.

`Decision.warning` is on `allow` **and** `hold` — an approved call is served from
a `hold`, so a warning only on `allow` would be one no approved call ever carried
— and it is `BudgetWarning | null` rather than optional, so a server composing an
answer has to say what it did with it. The claim is taken on the `ran` branch of
the dispatch switch and not beside `recordToolCall`: a call that came back
`refused` or `unavailable` has nowhere to put a notice, and claiming earlier
would burn the channel's one warning of the day on an answer that cannot carry
it.

### The price-drift record: a second opinion nothing acts on (#239)

Two figures price the same call. The proxy computes one from the counts a spend
report carries and the operator's price table, and that is the figure the section
above enforces. A router — a LiteLLM the operator runs, or the sidecar the
compose file starts — computes the other from its own price map and reports it on
the response, and the agent passes it along on the spend report as
`costNanoUsd`. `drift-db.ts` keeps them side by side so that a table which has
gone stale is visible **before** the provider's invoice arrives, which is the
whole of what this is for.

**It never enforces, and that is structural rather than promised.** The route
that records it holds a `DriftRecorder`, whose one method writes; there is no
read on it to make a decision from. `enforce.ts` is forbidden by an ESLint rule
from importing the module at all. And the operator's command has no exit code for
a difference of any size, so nothing downstream can come to depend on one either.
Metering on a number a gateway computed would move enforcement out of the proxy,
which is the invariant the whole design hangs on.

**Absent is not zero, and the record only holds what somebody priced.** Measured
against LiteLLM `main-stable`: a model it can price answers
`x-litellm-response-cost: 0.00011385`, and a model it cannot omits that header
entirely while still sending `-input` and `-output` reading `0.0`. So a call
nobody priced — every direct provider call, and every model the gateway has never
heard of — is not a disagreement and is not recorded; a reported zero means
priced and free, exactly as a `0` row in the price table does. A report naming no
model records nothing either: there is no table row to compare it against, and
the meter is already saying the useful thing about it under `(unreported)`.

**One row per `(day, channel, model)`, and the aggregation is exact.** Cost is
linear in the counts at a fixed price, so pricing a day's summed counts is the
sum of pricing each turn — it even removes a rounding step, since a per-turn
figure would truncate to micro-USD once per turn and a nine-token embedding costs
less than that. What it buys is a file bounded by days times channels times
models rather than one that grows with traffic and needs a retention policy this
package does not have.

**The computed side is never stored.** It is derived when the operator asks, from
the table as it stands then — `PriceTable`'s own rule, that cost is computed
fresh rather than accumulated. That is what makes the command a feedback loop:
correct a price, run it again, and the difference is gone, over spend already
recorded. A stamped figure would keep showing an operator a drift they had
already fixed.

**Nano-USD, where the price table is micro-USD per million tokens.** A
per-million price needs no resolution below a millionth of a dollar; one call's
cost does. Nine tokens through LiteLLM cost `1.8e-07` USD — 180 nano-USD, and
nothing at all at micro, which would have recorded a real charge as a zero that
means something else.

**Its own file, beside the meter rather than in it.** `budget reset` discards
counters, and this outlives them: staleness is a property of a table over weeks,
not of today's spend. Keeping it in `budget.db` would make its survival depend on
what a reset happens to delete. `PROXY_DRIFT_DB` is optional on the attempt
store's argument, and off is a legitimate deployment twice over — a deployment
calling providers directly records nothing anyway, and one that caps nothing in
dollars has no table to check.

## Two credential stores, and which process writes which

Everything in the vault shares one lifecycle: the operator wrote it, the
serving process reads it, revoking it is an operator act against the issuing
service. OAuth upstreams (#254) break that symmetry. The proxy mints access
tokens with lifetimes, and an OAuth 2.1 authorization server rotates the
refresh token on use — handing the serving process the successor, a durable
credential no operator ever held. Memory-only custody dies in one sentence: a
rotated refresh token that exists nowhere durable makes every restart a
re-grant, and rotation is the authorization server's default posture, not an
edge case. So this section is the custody decision the OAuth workstream (#157)
builds against — the sheet field is #255, the engine that makes it true is
#256, the grant flow #257.

**A second store, not a writable vault.** Grant material lives in a store the
operator never writes, under its own subkey, keyed by the same `credential`
names. The alternative — the serving process writing the vault itself — dies on
`vault.ts`'s first rule: "it never writes" is proved by an import list, and one
store with two writers deletes that proof for both.

*How the default backend realizes that:* `tokens.enc` beside `vault.enc`, the
path fixed as the vault's sibling, because a second path variable would be a
second way to point the two writers at different files. Same envelope byte for
byte, two constants apart: magic `LBTOKEN`, HKDF info `libero.tokens.v1` — the
separation `vault.ts`'s info string was written to anticipate. A token store
opened as a vault fails `not_a_vault` before any key is used, and even a forged
header cannot decrypt one file under the other's subkey. Whole-set encryption
and the size caps carry over: a list of grant names is an inventory of what the
deployment reaches, the vault's own argument. None of that paragraph is the
contract — a managed backend keeps the separation and none of the file facts.

**What a record is.** Keyed by the sheet's `credential` name, one grant per
name, so `upstreamKey`'s "one name is one vault entry" generalizes to "one
name is one grant." A record holds the issuer, the client identity (the Client
ID Metadata Document URL the grant was made under), the refresh token — the
only secret in it — and grant metadata: scopes, obtained and rotated
timestamps. Two bindings are the record's teeth. A refresh token is only ever
sent to the issuer its record names; a sheet whose auth block now names a
different issuer finds no grant — fail closed, re-grant — which is also how
Client ID Metadata's re-registration-by-issuer rule is kept without a
registry. And scopes are grant-time facts: a sheet later asking wider than the
record holds is a re-grant, not a silent escalation — widening a grant is an
operator act, like widening a sheet. Access tokens are not in the record. They
are minted into process memory and die with it; a restart costs one
token-endpoint round trip per upstream at first use, where persisting them
would put a live bearer token on disk that the refresh token alone only
becomes through an observable, revocable exchange at the issuer.

**Which store a name resolves in is the scheme's decision, never a fallback.**
One namespace of `credential` names: a bearer entry resolves in the vault, an
OAuth entry in the token store, and neither ever falls through to the other —
`vault set` under a name an OAuth block uses changes nothing, and a grant
under a name a bearer block uses changes nothing.

**Two writers, no `tokens set`.** The serving proxy writes a rotation; the
grant entrypoint (`node dist/grant.js add <name>` in `apps/proxy-server`,
composing `performAuthorizationGrant` from `./grant-flow.ts`) writes a grant,
replacing any predecessor under the
same name. The operator CLI never writes it — a value an operator holds is by
definition a vault value. That asymmetry is the narrowness: the only values
the serving process can persist are values an authorization server just
issued, for an upstream some team sheet already names. It cannot persist an
operator-authored secret, read one back out, or move one between the stores.
And there is no command that prints a token back — the grant entrypoint
inherits the vault CLI's discipline whole.

**Why no lock.** The vault's "one admin, one command, one container" does not
cover a grant run racing a rotation, so what replaces it: the proxy serializes
its own writes behind one mutex — refreshes for one grant are already
single-flighted (#256) — and both writers re-read the file, apply their one
entry, and rename, `@getlibero/atomic-write`'s recipe. The residual race is a
grant and a rotation interleaving within milliseconds, between events hours
apart, and its worst outcome is one lost refresh token: the next refresh
presents a stale one, the issuer refuses, the call fails `unavailable` by name,
and the remedy is re-running the grant. No outcome of the race discloses a
value or widens a permission — it degrades to a loud re-grant. A lock file was
rejected for the reason the vault already gives: one that outlives a killed
process is a worse failure than the one it prevents.

**Rotation is persisted before the successor is used.** Exchange, receive the
rotated refresh token, fsync it into the store — then use the access token
that came with it. The authorization server invalidated the predecessor at the
exchange, so the gap between exchange and persist is the one window that can
lose a grant; it is as small as the filesystem allows and nothing else is
permitted inside it.

**The exchange is an outbound call with the guard inverted.** It lives in
`outbound.ts` beside `callUpstream`, not inside it: `callUpstream` spends a
credential and scrubs the reply; the exchange spends a refresh token at the
issuer its record binds and returns the reply to no caller at all, because the
reply *is* the credential. Same guarded fetch otherwise — origin pinned to the
declared issuer, redirects refused (a redirected token request is a refresh
token sent to the one host neither list names), failures mapped to a closed
set that never carries the response body, the `VaultError` no-`cause` argument
applied to HTTP. Where discovery metadata is read, its `issuer` must equal the
declared one or the grant is treated as absent. The minted access token enters
`callUpstream`'s needle list exactly where the revealed vault value does. This
moves `outbound.test.ts`'s grep contract from one `reveal()` site to two —
both still in `outbound.ts` — a change #256 makes in the commit that makes it
true. Every lifecycle event — grant stored, token minted, token rotated, grant
dead — goes through the closed field set, by credential name; there is still
no free-form message for a value to reach.

**Freshness.** The vault is still read once at startup. The token store is
opened at startup if present — wrong key or corruption fails then; absent is a
deployment with no OAuth upstream, and no store — and read again at mint and
refresh, never on the call path while a live access token is in memory. A
grant completed while the proxy runs takes effect at the next mint or refresh,
no restart. The vault's no-watcher argument transfers intact: the token store
is not the authorization source either — nothing is permitted because a grant
exists — so a stale read can fail a refresh and can never widen a call.

**Key posture.** Same master key, second subkey. What changes is duration: the
parsed key now outlives startup, held in one closure reachable only by the
store's read and write paths and zeroed on shutdown, because a fresh salt per
write requires the master key at write time. That is the heap-dump concession
`vault.ts` already makes, held longer — not a second copy — and the startup
`delete` of `PROXY_VAULT_KEY` stays.

**What a stolen store is worth.** The client is public — PKCE and a metadata
URL, no client secret — so `tokens.enc` plus the master key yields refresh
tokens exchangeable by anyone who can read the public client id. What bounds
that: the volume copy alone is worthless without the key; the exchange happens
at the issuer, observable and revocable, where a stolen vault credential
spends silently against the service itself; rotation's reuse detection turns a
stolen-and-used refresh token into a dead grant the operator can see —
`invalid_grant` on refresh is logged as its own event, a theft signal rather
than a retry; and the issuer binding stops a mix-up from redirecting the
exchange. Sender-constraining (DPoP, #260) is what makes a stolen token
*unusable* rather than merely loud, and as of #505 it reaches the exchange:
where the sheet and the issuer both allow it, the refresh token is bound to a
key this store does not hold. **This paragraph is not yet re-priced**, because
the property is not yet whole — #506 carries proofs to the calls that spend an
access token, and re-words what a stolen store is worth in the same PR.

**The invariant, re-worded.** Tool credentials at rest live in two stores: the
vault, which the operator writes and the serving process only reads, and the
token store, which the serving process writes — because an authorization
server rotates a refresh token by handing back its successor. The default
backend puts both in encrypted files on the proxy's volume, under one master
key and one envelope; every sentence in this paragraph survives a backend that
does neither.
The process serving tool calls still never writes the vault; what it writes is
the token store, and the only values that can reach it are values an
authorization server just issued for an upstream a team sheet already names.
There is still no `get`, in either store: a value leaves only as a `Secret`,
and only `outbound.ts` ever unwraps one — to spend a credential on an upstream
call, whose reply it scrubs, or to exchange a refresh token at the issuer that
minted it, whose reply is never returned to any caller. And neither store is
the authorization source, so a stale read can refuse a call and can never
widen one.

**The store is the contract; the files are the built form — and since #482 that
is a seam in code rather than a claim in prose.** What #255–#257 build against
is the paragraph above plus the write discipline — disjoint writers,
provenance, persist-before-use, replace-not-stack — none of which names a
filesystem. `custody.ts` is where that is declared: `Vault`, `TokenStore`,
`Custody`, `VaultAdmin` (in `custody-admin.ts`), `Secret`, `MAX_SECRET_BYTES`
and `CustodyError`, in a module whose import list holds no `node:fs`, no
`node:crypto` and no `./envelope.js` — the absence is the argument, in
`vault.ts`'s own style. `custody-conformance.ts` is where it is asserted, and
`custody-file.test.ts` runs it against these files. `vault.ts`,
`vault-file.ts` and `token-store.ts` are the default backend, unchanged and
still the whole of what a deployment runs; `custody-backend.ts` is the entire
switch, and `PROXY_CUSTODY_BACKEND` (absent, or `files`) is what selects it.

A managed backend (GCP Secret Manager as #483, AWS Secrets Manager as #484,
tracked by #261 in v0.7.0) re-implements the mechanism with stronger
enforcement — writer separation as IAM roles, replace-not-stack as
add-version/destroy-old, and no master key at all — and changes nothing above
this sentence. The seam both stores share is `vaultKeyFromEnv`, which a managed
branch simply never reaches; what it bought instead was #495, where a second
*source* for the key on the branch that does need one — `PROXY_VAULT_KEY_FILE`
beside `PROXY_VAULT_KEY`, exactly one of them — was a change to that function's
body and to no caller. What makes that checkable rather than hoped for is that it inherits
`custody-conformance.ts` whole: the assertions are what say what the contract
*is*, which is why they were written against one backend rather than derived
from what the first two happened to agree on.

**What the contract says about time.** The vault answers every lookup from
state it acquired at open, with no I/O on the serving path — its synchronous
`lookup` and its read-once-at-startup freshness rule are one clause, not two,
and a backend does not get to relax either. That is not a burden on a managed
store; it is what a managed store wants, since Secret Manager charges per
access and `lookup` runs per tool call. The cheapest correct shape for a
managed vault backend is therefore one secret holding the whole entry set,
fetched once at `openCustody` — reach for that before inventing a cache. The
token store is the inverse: re-read per use, so a grant completed while the
proxy runs takes effect at the next mint with no restart, which is why
`TokenStore.read` is `Awaitable<GrantRead>` where `Vault.lookup` is not. What
keeps that off the serving path is `token-engine.ts`, which calls it at mint
and refresh and never while a live access token is in memory. The file backend
declares `FileTokenStore`, narrowing `read` back to a synchronous answer,
which is what lets every caller that opens *that* store keep its shape.

**The failure vocabulary is two levels, and neither has free text.**
`CustodyFailure` — `unreachable`, `unauthorized`, `bad_key_or_tampered`,
`malformed`, `too_large` — is what a caller who does not know which backend
this is may branch on. Inside it each backend keeps its own closed set, because
an operator who pointed the proxy at the wrong file deserves `not_a_vault`
rather than a hint that their key is wrong, and each maps onto the contract's
through a total `Record`, so a new backend word does not compile until someone
has decided what the coarse answer is. `unauthorized` was reserved with no producer
on the argument that a service account missing `secretmanager.versions.access`
would otherwise land on `unreachable` — telling an operator to check the network
when the answer is IAM. #483 gave it one: a 401 or 403 from Secret Manager is
`denied`, which maps to it. Adding a member later would mean widening a set the
conformance suite pins, which is the thing the seam exists to prevent, and this
is what reserving one instead looks like when it pays off. The one place free text could enter is
`CustodyError.reason`, typed `string` on the base and narrowed by every
subclass; the conformance suite closes it by taking each harness's
`failureWords` up front and refusing any error carrying something else.

### The signing key: a third store, and where it had to go (#504)

DPoP (#260) binds a token to a key, so the proxy needs one — and the promised
sentence, the one #506 re-prices the stolen-store paragraph with, is "the
exchange requires a key the store does not hold." **Where that key lives is what
decides whether the sentence means anything**, which is why #504 is a decision
before it is an implementation.

**Not the token store.** A private key in `tokens.enc` under the same subkey
makes the property vacuous: whoever stole the tokens stole the key that presents
them, and the paragraph would be re-worded into a claim about nothing.

**Not the vault either, and this is the half worth reading twice.** The vault is
the store the serving process may only *read*. Putting the key there means one
of two things: an operator generating an ES256 private key and pasting it
through `vault set` — a private key through a shell history, and no lazy mint —
or this process gaining a vault write path. The second is the claim the whole
custody design is built on, and it is not for sale to save a file.

So the key is a **third store on the same seam**. `SigningKeyStore` in
`custody.ts` beside `Vault` and `TokenStore`, one more member of `Custody`,
`signing-key.ts` holding everything about what a key *is*, and each backend
supplying four methods: read the material, create it if none is stored, name its
own word for material that is not a key, and close. The built form is
`signing.enc` beside the other two — same envelope, magic `LBSIGNK`, HKDF info
`libero.signing.v1`, third subkey — and on a managed backend it is one more
secret, `<prefix>-signing-dpop` or `<prefix>/signing/dpop`, labelled so it lists
with neither of the others.

**What that buys, per backend, stated exactly.** On the encrypted files: theft
of `tokens.enc` plus the master key no longer yields presentable credentials,
and theft of the whole volume plus the master key still does, because everything
on the volume is under one key. That is a real narrowing and not the whole
property, and saying so is the point — the honest version of the claim is
against a stolen *store*, not against a stolen host. On GCP and AWS it is
stronger and is enforced by somebody else: the signing secret carries its own
IAM, so the accessor role on it can be granted to the serving principal alone,
and there is no master key for anyone to steal. Both are why the location is a
contract decision rather than the file backend's private business.

**One key per deployment, not per grant.** The private half never leaves the
process, so an attacker who can use one key can use fifty; per-grant keys would
buy nothing against that, and would cost one more secret per grant on the
managed backends, where the two costs of a secret per name are already priced
below. The cost of one key is stated rather than hidden: authorization servers
that collude can correlate this deployment across upstreams by its thumbprint,
which for a self-hosted proxy whose upstreams the operator chose is not a threat
the operator has.

**Minted lazily, adopted rather than replaced, and never rotated from inside.**
A deployment with no OAuth upstream never creates a key; the first exchange that
needs a proof does, which is also why this is the one store that does not open at
startup. The write is `createFileExclusively`, not a replace, and a `create` that
loses answers with the winner: a second process that got there first keeps its
key, because overwriting it strands every grant bound to it. For the same reason
there is no `rotate` and no second key — rotating this key kills every live
grant, so it is an operator act (remove the backing, re-grant) rather than a
method the serving process holds.

**What the key can do and what it cannot.** `SigningKey` is `Secret`'s posture
one turn further: where a credential leaves through the one guarded `reveal()`,
this leaves through nothing at all. The `KeyObject` is a closure variable, no
member returns it, and `sign` is the whole surface — so `Custody`'s new member
adds no way for material to reach a log line, and the conformance suite walks the
object to say so. The thumbprint *is* logged, and `log.ts` carries the argument:
it is a digest of the public members, it is inside every proof this proxy sends,
and it is the only fact that makes a stranded grant legible.

The conformance suite gained nine cases for all this, so every backend inherits
the storage semantics rather than re-deriving them — including the one that
matters most, that a minted key is in **neither of the other two stores**. A
backend that quietly kept it as a vault entry would pass every other case and
make #260's claim vacuous. What is deliberately *not* asserted there is anything
about DPoP itself: proofs, nonces and thumbprint continuity across a refresh are
#505's, and they belong to the exchange rather than to a store.

### Sender-constrained tokens: the exchange (#505)

The key (#504) is what a proof is signed with; this is what is signed, and where.
`dpop.ts` makes a proof — one compact JWS, ES256, per request — and the two token
exchanges in `outbound.ts` attach one where the sheet and the authorization
server both allow it. #506 is the other half: proofs on the calls that *spend* a
token, and the stolen-store paragraph re-priced once the property is whole.

**The sheet decides, in three values, and the default changes nothing.**
`[mcp_server.auth] dpop` is `prefer` unless an operator says otherwise: proofs
where discovery advertises `dpop_signing_alg_values_supported`, bearer where it
does not. That is the only default that leaves every working sheet working,
because most authorization servers have not shipped DPoP. `require` refuses the
exchange rather than falling back — a server that quietly stopped advertising
would otherwise quietly stop binding, and an unannounced downgrade is the thing
sender-constraining exists to prevent. `off` never sends a proof, for an issuer
that advertises DPoP and gets it wrong.

`require` is a promise about the *token in hand*, not about the request sent: an
issuer that advertises, takes the proof and answers `token_type: Bearer` has
bound nothing, and that is refused under `require` and accepted as a bearer token
under `prefer`. The reverse — a `DPoP` answer to a request that proved nothing —
is refused outright, because a token bound to a key nothing will prove with is
dead on arrival.

**The decision is made before the credential is revealed.** `dpopPlan` runs on
discovery metadata, so a sheet saying `require` against an issuer that does not
advertise never takes the refresh token out of its `Secret`. The nonce dance
(RFC 9449 §8) is one retry and not a loop: a fresh proof carrying the server's
nonce — fresh because `jti` and `iat` are per-request claims and a re-sent proof
reads as a replay — and a second challenge is `dpop_nonce_unsatisfied` rather
than another attempt.

**Three new failure words, because three different people have to do three
different things**: `dpop_unsupported` (this issuer does not bind and the sheet
said it must), `dpop_key_mismatch` (this grant is bound to a key this proxy no
longer holds), `dpop_nonce_unsatisfied` (this issuer keeps asking for a nonce it
then will not accept). Landing all three on `exchange_failed` would have made
each of them a debugging session.

**The grant record carries the binding.** `GrantRecord.jkt` is the thumbprint the
authorization server bound the refresh token to, written by the grant flow when
the code exchange was proved for and never rewritten — a key does not change
under a live grant, and a grant whose key is gone is re-run rather than repaired.
The engine checks it before spending anything: a record bound to a thumbprint the
current key does not match fails as `dpop_key_mismatch` with no token request
made at all. Absent is a bearer grant, which is every record written before
v0.8.0.

**The fake authorization server verifies, and that is the half that makes the
rest worth anything.** `fake-token-issuer.ts` checks the signature against the
key the proof carries, checks `htm` and `htu` against the request it received,
checks `iat` against a window, refuses a `jti` it has seen, demands its own nonce
where it issued one, refuses a header carrying a private key, and binds each
grant to the key that proved for it so a later exchange under another key is
refused. #484's discipline applied to a protocol rather than to an API: a fake
that accepted any proof would make every DPoP test in the suite pass over a
client that signed nothing. It computes the thumbprint, the `htu` and the digest
itself rather than importing `dpop.ts`'s, so the two agree by being checked
rather than by construction — and `fake-token-issuer.test.ts` is the file that
holds the verifier to that, asserting *why* each refusal happened rather than
that a 400 came back.

### The Secret Manager backend (#483)

`PROXY_CUSTODY_BACKEND=gcp` runs both stores on Google Secret Manager.
`custody-gcp.ts` is the backend, `custody-gcp-client.ts` is the wire, and
`custody-gcp.test.ts` is a harness and one call — the same seventy-six cases the
files pass, against a store that shares no code with them below `custody.ts`.

**Writer separation becomes IAM, which is the stronger form of the same claim.**
One secret per credential name, `<prefix>-vault-<name>` and
`<prefix>-grant-<name>`, labelled so one project can hold several deployments.
The serving service account holds `secretAccessor` on both and
`secretVersionAdder` on the grants; the operator's principal holds the create,
add-version and delete roles the proxy does not. Where the file backend proves
"the serving process never writes the vault" with an import list, this proves it
with a policy the backend enforces — and the import list is still there.
Replace-not-stack becomes add-version then destroy-old, so a superseded value
stops being *retrievable* rather than merely stopping being latest, which is
something the file backend cannot claim.

**No client library, and the reason is which process rather than which vendor.**
`packages/agent` takes `@anthropic-ai/sdk` and `openai` directly — an operator
calling a provider already trusts it, and that process holds no tool
credentials. This one holds all of them, and `@google-cloud/secret-manager`
would bring google-gax, gRPC and protobufjs into its image, with every bump
landing as a security review. What is needed is five calls: a token from the
metadata server, then list, access, add-version and destroy. Auth is one GET
because the backend supports VM-attached service accounts and nothing else — a
service-account JSON key mounted into this container is a long-lived private key
on disk, worse than the master key it would replace. **The condition for
revisiting is stated in the module header rather than left as a taboo:** if the
scope grows past those calls — CMEK, rotation schedules, IAM managed from inside
the proxy, or a second credential source — take the SDK and argue it the way
#185 argued the MCP SDK.

**Two costs of one secret per name, and both are real.** Secret Manager names
are metadata, so the credential inventory the file backend hides behind
whole-set encryption is visible to anyone with `secretmanager.secrets.list` —
bought back by an accessor role that can be granted per secret, which the file
backend cannot express at all. And a `CredentialName` may hold a dot where a
secret id may not: refused as `invalid_name` at `vault set` and `grant add`,
which is the one place it can be fixed. Encoding it would either collide (`a.b`
and `a_b` reaching one id) or make every id unreadable to the operator who has
to create it, and a collision between two credentials is the worse failure.

**What has not been run.** #483 shipped without access to a live GCP project.
The conformance suite passes against `fake-secret-manager.ts`, a real
`node:http` server written from Google's published REST reference — so the
contract holds over real sockets, real JSON and real version semantics as that
reference describes them. It says nothing about IAM, quotas, replication, CMEK
or eventual consistency, and a misreading of the reference would show up as a
passing suite. `deploy/README.md` carries the operator walkthrough with the same
warning attached. Treat the first live deployment as the real test, and fix the
fake where it disagrees.

### The Secrets Manager backend (#484)

`PROXY_CUSTODY_BACKEND=aws` runs both stores on AWS Secrets Manager, in the
shape #483 proved out: `custody-aws.ts`, `custody-aws-client.ts`, and a
`custody-aws.test.ts` that is a harness and one call. Writer separation is an
IAM policy, replace-not-stack is the backend's versioning, and there is no
master key.

**SigV4 is the difference, and it is what a reviewer should look at.** Google
takes a bearer token; AWS takes a signature over the request, so this backend
carries a hundred lines of HMAC that the GCP one does not. What makes that an
acceptable hundred lines is the direction it fails in: a signing mistake is a
403, not a disclosure. There is no partial-credit failure where a wrong
signature still moves a secret. It is checked three ways — the fake recomputes
every signature and refuses one that does not match, `custody-aws-client.test.ts`
asserts differentially that each signed input changes the signature, and a
deliberate break of the body coverage was confirmed to fail both.

**Replace-not-stack needed an extra call here, and it is a deliberate departure
from AWS convention.** `PutSecretValue` moves `AWSCURRENT` to the new version
and `AWSPREVIOUS` to the old one, which leaves the superseded value readable to
anyone with `GetSecretValue` — for a rotated refresh token, the dead one is
still there. This backend strips the `AWSPREVIOUS` label, so a version left with
no staging label is deprecated and stops being retrievable: the same property
GCP's destroy-old buys. AWS keeps `AWSPREVIOUS` for rotation rollback, so this
gives that up on purpose.

**Removal is irreversible.** `DeleteSecret` defaults to a recovery window of up
to thirty days during which the name cannot be reused, which would turn
`vault remove x` followed by `vault set x` into a failure with no workaround.
This backend passes `ForceDeleteWithoutRecovery`. The operator act removal was
always paired with — revoking the credential at the service that issued it — is
not undoable either.

**A dot is fine here**, unlike on GCP: Secrets Manager names allow
`[A-Za-z0-9/_+=.@-]`, which covers every `CredentialName`. A deployment moving
from GCP to AWS gains names; one moving the other way may have to rename.

**This one was checked against an independent implementation**, which #483 could
not be: `packages/aws-conformance` runs the contract suite against LocalStack. It
found two real defects the fake had mirrored — a missing `ClientRequestToken`,
which the SDKs generate and a hand-written client omits, and a `remove` that
derived "was it there" from the delete's own reply where LocalStack and AWS
disagree. Both are fixed and the fake was made stricter to match. What LocalStack
still cannot answer is the signature, IAM, quotas, KMS and the recovery window,
and **nobody has run this against a real account**; `deploy/README.md` says so
where an operator will read it.

## Built-in tools

Not every permitted call goes to an upstream. Three are served by this process:
`search_channel_history`, which reads the calling channel's message store
(`@getlibero/memory`, opened read-only), `schedule_task`, which creates one
future check, and `run_code` (#394), which is the sandbox. `builtins.ts` holds
every definition and the strict argument parsers; `builtin-dispatcher.ts` is the
executor for the first two only.

**`run_code` is a built-in that this arm does not serve**, and the split is
#393's. Everything the team sheet cares about is identical — a `[[builtin]]`
block grants it, an omitted block refuses it, the meter is charged, the row is
written under `libero` — and the thing that differs is that serving it means
talking to a runner over the network, which is the one capability
`builtin-dispatcher.ts` promises it does not have. So it gets a third arm on
`createToolDispatcher`, and `StoreBuiltinName` in `dispatch.ts` makes putting it
in the wrong one a type error rather than a review question. Its sheet block is
also the only one carrying caps (`cpus`, `memory_mb`, `timeout_seconds`), which
is why `BuiltinEntry` is a discriminated union rather than one flat object — see
"Reaching a runtime" above, and the shape's own header in
`@getlibero/schema`. The runner behind the arm is #395; until it lands, a
granted call answers `not_implemented`.

**`schedule_task` is governed here and recorded elsewhere.** The create is a
served tool call like any other — the sheet lists it, a human clicks, the meter is
charged, an audit row is written — and what it produces is a *ticket* returned in
the result, which the agent side writes into the channel's own store. This process
does not write it, and could not: it opens those files `readOnly`, and a writer
here would be a second writer on one file from the process that must not be able
to repair a channel's evidence. So neither built-in writes anything, and "this arm
holds a directory path" stays literally true.

**Its three caps refuse from the dispatcher rather than from `decide`.** That is
`Dispatch`'s `refused` arm, which has existed since the vault landed for "a
refusal discovered while serving" — `credential_unresolved` needs a lookup a pure
decision cannot make, and these need the model's *arguments*, which `decide`
deliberately never reads, plus a count from the channel's store. `server.ts`
audits a dispatch refusal exactly as it audits a decision's, so the record is
unchanged: one row, the reason on it, and the sentence `refusalMessage` writes.
The cost, stated rather than discovered: `recordToolCall` runs before dispatch, so
a create refused for a cap is metered — `credential_unresolved`'s position
already, and the right direction, since `daily_tool_calls` is the backstop a cap
enforced in code is not.

The pending count comes from `MessageReader.pendingScheduledTasks`, the second
method that interface has ever had. What admits it is what admits `search`: no
channel argument, one file closed over at open, read-only. What makes it a
different question from the ones that interface refuses is that it answers a
**number** — this process learns how many checks are waiting and never what any
of them says.

**A built-in is not a bypass**, and the type system is what says so rather than a
comment. `decide` returns a `Target` — `{kind: "mcp", upstream}` or
`{kind: "builtin", tool}` — so both kinds come out of the same decision, having
passed the same allowlist, the same budget check and the same approval rule, and
the only way to obtain one is to be handed a `Decision`. `decideBuiltin` runs the
same steps in the same order as the MCP branch, minus `server_ambiguous`, which
has no question to answer when there is one provider; `exhaustedLimit`,
`resolveLimits` is the function that branch calls rather than a copy of it.

Approval is the one exception, and it is a fallthrough rather than a rule.
`resolveBuiltinApproval` keeps `resolveApproval`'s three rules exactly — empty is
required, any `required` wins, an explicit `none` beats silence — and differs only
in what it answers when a sheet said nothing. There, `isDestructiveName` guesses
from a verb, which is the right shape for names somebody else chose; a built-in's
name was chosen in this repository, so `BUILTIN_APPROVAL_DEFAULT` in
`@getlibero/schema` states the answer. `search_channel_history` declares `none`,
which is what the heuristic already answered; `schedule_task` declares `required`,
which the heuristic could not have — creating future work destroys nothing, and
adding `"schedule"` to `DESTRUCTIVE_VERBS` would hold an upstream
`reschedule_meeting` in every deployment to decide something about a tool this
process implements itself. The consequence is the one #322 asks for: a sheet
**loosens** scheduling by writing `approval = "none"`, and forgetting the line
gets the hold.

**Both callers use that resolver.** `permittedToolSources` publishes an approval
the model is shown and `decideBuiltin` enforces one; a listing that said `none`
where the gate held would be this process disagreeing with itself in the one place
a channel can see both.

**`decideBuiltin` has one per-tool branch, and it is the only field of `[ambient]`
this process reads.** A `schedule_task` create against a channel whose block is
off is refused `ambient_disabled`, above the meter — because nothing would ever
enumerate that channel to run the check, and a channel accumulating approved
future work no clock will reach is worse than a refusal when a human clicked
Approve on each one. It sits here rather than in the executor because it is a fact
the *sheet* answers and `ToolDispatcher` may not read one, and it does not change
`[ambient]`'s standing: the field is read only to refuse, never to permit, so
nothing an agent could do to its own copy widens anything. The listing is
unaffected — it still publishes the tool, for the reason an ambiguous server's
tools are still listed: a listing describes what a call would do rather than
deciding it, and a second policy rule there is a second rule that has to match.

**The two arms cannot be handed each other's work.** `createToolDispatcher` is
the only thing that narrows a `Target`, and it is a switch with no I/O:
`HttpDispatcher` implements `McpToolDispatcher` and takes an `McpServer`,
`BuiltinDispatcher` takes a `BuiltinToolName`. So the object holding the vault
and the client pool never sees a built-in, and the object holding a path to
channel messages never sees an upstream — neither needs a branch guarding
against it.

**The listing route may import `builtins.ts` and not `builtin-dispatcher.ts`**,
enforced by its ESLint block. That is the `ToolCatalog`/`ToolDispatcher` split
one file over: definitions are constants a route may publish, the executor opens
a channel's store. A built-in's description comes from this build rather than
from an upstream answer, so it is the one listing row that cannot degrade to a
thin one — and it is checked against `MAX_TOOL_DESCRIPTION` at module load,
because a description over that bound fails `ToolListing.parse` on the agent's
side and ends the task rather than costing it a sentence.

### What a governed create is worth, and what it is not

Four claims, in this order, because three of them are the near overclaims.

**Scheduling is not a permission.** A served create widens nothing. The turn it
eventually fires is bounded by the same sheet, the same meter and the same
approval rules a mention's is: every call it induces meets these gates, its post
goes through a surface that allows one per firing, its tokens draw on the same
budget. What the create buys is a turn happening later, not a turn allowed to do
more.

**It is not a boundary against a compromised agent process.** The ticket lives in
the channel's own store, which the agent side writes; a process under an
attacker's control could put a row there this proxy never served — and it could
call the tools directly instead, which is cheaper and needs no forgery. In the
terms `refusal.ts` uses, this has `daily_tokens`' standing and not
`daily_tool_calls`'.

**What it holds against is the prompt-injected model.** Injected text can talk a
model into asking for future work. It cannot list a tool the sheet omits, cannot
skip a hold the sheet left in place, cannot pass the pending cap or the horizon,
and cannot make a create unaudited. Unbidden future work becomes a held, audited,
budgeted act instead of a free one.

**The pending cap holds in that same narrow sense, and holds exactly there.** This
process counts what the agent has durably written; a task's tool calls are
dispatched one at a time, the write is synchronous, and a channel's work is
serialized on one session mutex — so the row from one create is on disk before the
next is submitted, and no burst gets past the count. A compromised process can,
and does not need to. The count is also a *floor* rather than an exact tally: a
create this proxy served whose row failed to land is audited and uncounted, so a
channel gets at most one extra slot and never one fewer.

One thing that makes the hold worth having rather than ceremonial: the approval
card renders the call's arguments, so the human clicking Approve has read the
question and the offset before either becomes a ticket.

Adding a built-in is five parts that fail the build separately: a member on
`BuiltinToolName` in `@getlibero/schema`, an entry in `BUILTIN_APPROVAL_DEFAULT`
beside it, a block shape in `BuiltinEntry`, a definition in `BUILTIN_TOOLS`, and
somewhere for the call to go. Two `Record`s over the enum, a union whose members
narrow it, and a switch, so there is no order in which a half-added built-in
compiles — and the approval entry is in that list because a built-in with no
declared default would silently inherit a guess about somebody else's naming.

That last part became two places in #394. A built-in reading a local file is a
case in the executor's exhaustive switch; `run_code` is a branch in
`createToolDispatcher` instead, for the reason above. Deciding which one a new
built-in belongs in is the question "does serving it need the network", and the
type answers it: `BuiltinDispatcher` takes `StoreBuiltinName`, so a built-in that
needs a client cannot be added to the arm that has none.

## Reaching a runtime

The code-execution built-in (#368) needs a container runtime, and this process
must not be able to reach one. `deploy/docker-compose.yml` argues the second half
where the mount would be: a process that can reach the daemon socket can start a
privileged container mounting the host's root filesystem, so giving the socket to
the process holding every tool credential is a supported path to host root. That
is the trade this package exists to refuse.

**The socket moves rather than returns.** A separate `runner` service holds it.
The proxy reaches it over mutual TLS with one narrow endpoint: *run this code
under this run-spec*. The runner holds no credential, and it **constructs the
container spec itself** — the request has no field that reaches `Binds`,
`Privileged`, a capability set, or an image name. The privilege and the
credentials then live in two different processes, which is the inverse of the
mount rather than a softened version of it.

**The rule that rejects most of the alternatives at once.** Any generic container
API — the raw socket, a path-filtering socket proxy, a rootless-Podman sidecar's
REST endpoint, a daemon authorization plugin — takes a *spec*, and a spec has
`Binds` and `Privileged` in it. A filter on the verb is not a constraint on the
spec: a permitted `POST /containers/create` still accepts a body that mounts `/`.
So the process that **constructs** the spec has to be ours, and the request that
reaches it must have no field that reaches the spec. Every shape below fails or
passes on that sentence.

| Shape | Why not |
| --- | --- |
| The socket, mounted here | Root-equivalence in the process holding every tool credential. The original decision; unchanged. |
| A filtering socket proxy | Filters the verb, not the body. See the rule above. |
| Rootless Podman or a user-namespace sandbox inside this process | No daemon, which is genuinely attractive. But it puts container-creation privilege back in the credential-holding process, and it leans on kernel features no instance type in the deployment guide guarantees. |
| Docker-in-Docker sidecar | Wants `--privileged`. Strictly worse than the thing being avoided. |
| An in-process Wasm/WASI or `isolated-vm` sandbox | The cheapest shape and the one that will be proposed again, so it gets a reason rather than silence. It puts the sandbox boundary *inside* the process holding every tool credential, which is the socket trade moved one layer in — a single escape lands on the vault. Its egress story is API interception, which is convention, and the next section is a rejection of convention. And the tool's value is a real toolchain, which an isolate does not have. |
| A host-side runner daemon over a bind-mounted unix socket | Same privilege split, and it would work. It lives outside `docker compose up`, so it needs its own install, upgrade and restart story, and the deployment guide's restart-as-recovery promise is a promise about one compose file. |
| Firecracker or Kata microVMs | Wants `/dev/kvm`, and **no instance type the deployment guide names has nested virtualization** — not the minimum sizes, not the recommended ones. Later work, not a 0.4 option. |

gVisor (`runsc`) is a deployment choice rather than anything this package does:
the runner asks for no runtime, so a daemon defaulting to `runsc` gives a run
one and a daemon that does not, does not. The self-hosting guide says so, and
says plainly that it is untested here.

**Built in #395, and three things the build settled that the design did not.**
The runner is `apps/runner` — a third service, third image, and the only
dependency in it is `@getlibero/schema`, because it speaks the Docker Engine API
over `node:http` with a `socketPath` rather than through a client library. That
is this repository's third hand-rolled HTTP surface for one reason: a package
with a hand on the socket that is equivalent to root on the host is the edge
./server.ts's header tells a reviewer to reject.

The container spec is built in `apps/runner/src/run.ts` from two sources — the
runner's own environment and the request's three numeric caps — and from nothing
else. `SandboxRunRequest` has no field reaching `Image`, `Cmd`, `Binds`,
`Privileged` or a capability set, which is what makes "a compromised proxy can
ask for a code run and nothing else" checkable by reading one schema file.

The proxy's half is ./sandbox-dispatcher.ts, and it holds no credential — an
ESLint block bans it from importing the vault, the token store and the grant
flow by name, so that stays true when somebody wants to pass an upstream token
into a run. The caps ride on the `Decision` for `ToolDispatcher`'s stated reason:
sheets reload on file change, so an arm resolving its own would size a container
against a sheet that changed after a human approved the call.

**The service is opt-in and its image is not.** `deploy/docker-compose.yml` puts
the runner behind a `runner` profile, so a deployment whose channels never grant
`run_code` does not run it and a granted call answers `not_implemented`. CI still
builds it — `docker compose --profile runner build` — because a service nothing
builds is a service that rots, and that is the whole reason it is a profile
rather than a commented-out block.

**The runner must not trust the CA alone.** `scripts/dev-certs.sh` mints one
CA, and its `ca.pem` is shared with both containers — the agent holds client
keys signed by it. A runner whose listener trusted that CA would accept a call
from a compromised agent process: no team sheet, no `decide`, no meter, no audit
row. That is the security property inverted, by a service added to protect it.

Two things close it, and both are load-bearing:

- **A pinned client fingerprint.** The runner accepts exactly one, supplied as
  `RUNNER_CLIENT_PIN`. This is `identity.ts`'s discipline verbatim — a
  CA signature is necessary and not sufficient, and the pin is the
  authorization — so the deployment has one idea in it rather than two.
- **A network the agent has no route to.** The runner sits on its own
  `internal: true` network whose only members are this process and the runner.
  Putting it on the shared bridge, where mutual TLS is the only barrier, is the
  shape to reject: the pin should be the second wall, not the only one.

**What this costs, said plainly.** Compromising the *runner* is host root. That
is a real loss and it is the better trade for four checkable reasons: the runner
holds no credential; it is unreachable from the agent; it parses one fixed-shape
request from one pinned peer; and it treats the run's output as hostile bytes —
bounded, never parsed, never interpolated. That last one matters more than it
looks, because the runner's real input surface is a sandbox's stdout, not its own
request. "A fraction of the proxy's surface" is a claim those four sentences make
checkable rather than a comforting one.

**The seam here.** The runner client is a network client, which is the one thing
`builtin-dispatcher.ts` says its arm does not hold. So the code-execution built-in
gets a **third arm on `createToolDispatcher`**, not a widening of the built-in
arm: `Target` stays `{kind:"builtin", tool}`, the switch branches on the tool
name and still has no I/O in it, and both files' headers stay literally true. The
new arm gets its own `no-restricted-imports` block barring `vault`, `token-store`
and `grant-flow`, which is how "the runner holds no credential" becomes something
CI checks rather than something this paragraph asserts. The run-spec's caps and
allow list ride on the `Decision`, for the reason `ToolDispatcher` already gives:
a dispatcher that resolved the sheet itself could get a different answer than the
decision did, because sheets reload on file change.

`deploy/README.md` has the operational half — what the service mounts, what each
network can reach, and the one variable an operator will get wrong.

## Enforcing `[egress]`

`isEgressAllowed` had adversarial tests and no caller from #73 until #219. The
sandbox is the caller, and the first thing to get right is that **it is not a
call site.** A check on the way out works when the destination is announced;
sandboxed code opens sockets nobody declared, so there is no line to put one on.

**Enforcement is topological.** The sandbox runs on a per-run `internal: true`
network with no route out. The only other member is a CONNECT hop that calls
`isEgressAllowed` once per host. Code that ignores `HTTP_PROXY`, or dials a raw
address, reaches nothing — not because it was checked and refused, but because
there is nowhere for the packet to go. **A sheet with no `[egress]` block gets no
hop and no network at all.**

**Built in #219**, as `apps/runner/src/hop-server.ts` behind a second entrypoint
on the runner's image. What follows was the design; what shipped matches it, with
two things the build settled. The hop runs the runner's *own* image rather than a
second published one, so there is nothing extra to pin — if it were substituted
the runner would already be. And the runner learns of a denial by **following the
hop's log stream** rather than polling it or reading it at the end: polling would
put the interval between the denial and the kill, and reading at the end would
make the denial not terminal at all.

**The hop is ours, and that is not a build-versus-buy preference.** #219's
standing rule is that a caller which reimplements matching instead of calling
`isEgressAllowed` is a review failure — and Squid, tinyproxy, or any off-the-shelf
CONNECT proxy expresses its allowlist in its own ACL syntax, which *is*
reimplementing it. The near-miss behaviour in `egress.ts` is the security
deliverable of that issue, and it is cheaper to write a CONNECT hop that imports
the function than to prove someone else's matcher agrees with it. The hop ships as
a second entrypoint on the runner's image, the way `apps/proxy-server` already
carries `vault`, `audit`, `grant` and `tasks`, so it inherits the image assertions
for free.

**Per-run, not one shared hop.** Four reasons, strongest first:

1. A shared hop has to identify which run is calling it, which means a bearer
   token in the sandbox's environment. The sandbox path's whole claim is that it
   carries no credential, and a shared hop breaks that by construction in the one
   process specifically designed to be untrusted.
2. A shared network lets concurrent runs from different channels reach each
   other. Channel isolation is what the client certificate exists for.
3. A shared hop has to re-resolve the sheet by channel — the second lookup
   `ToolDispatcher` forbids, one process over. A per-run hop is configured from
   the allow list that rode on the `Decision`, so the sheet is still read once
   per call.
4. Only a per-run hop can tear down its own run, which the refusal below needs.

The cost is two containers per concurrent run, against a deployment guide whose
minimum is 2 vCPU and 2 GB. **`PROXY_MAX_UPSTREAM_CONCURRENCY` does not bound
this** — it bounds the MCP pool, and the units are not comparable: that one
counts sockets and this one counts containers with a memory cgroup each.

`PROXY_MAX_SANDBOX_CONCURRENCY` is what bounds it, defaulting to two (#405).
`sandbox-dispatcher.ts` takes a permit from the same `createSemaphore` the pool
uses before it dials the runner, and releases it in a `finally` around every
path out of the call. Three things about it are decided rather than incidental:

- **Per deployment, not per channel.** What is being protected is the host,
  which is a property of the sum, and the semaphore's FIFO queue is what stops a
  busy channel jumping ahead of a quiet one. A per-channel bound is a real thing
  to want under contention and is a second number with nothing behind it yet.
- **In the proxy rather than in the runner**, which is the opposite of where the
  *other* #405 bound went, and the reasons are worth keeping apart. The ceiling
  below has to be in the runner because the runner builds the container spec.
  This one has to be here because the runner has no idea which channel a run is
  for and must not — a channel id on `SandboxRunRequest` is the shape CLAUDE.md
  forbids — so a gate there could never grow the per-channel bound, and because
  enforcement lives in the proxy by invariant. What makes it a real bound rather
  than advice is that the runner pins exactly one peer.
- **The wait comes out of the call's budget, not beside it.** A queued call gets
  `timeoutSeconds + overhead` *minus* what it spent queueing. This gate was built
  that way from the start rather than acquiring the stacking the MCP pool's had
  to have removed (#253), and the two now hold the same discipline for the same
  reason: waiting beside the budget widens the window in which the agent has
  already hung up on a run still holding a container. The one difference is that
  a sandbox run makes exactly one request, so a duration is sufficient here where
  the pool needs a deadline to survive its replay.

A call that does not get a permit within `SANDBOX_QUEUE_WAIT_MS` is
`unavailable` with reason `runner_busy` — a 501 and **not** a refusal. Nothing
about the channel's grant changed; the deployment is full. Spelling it as a
`ToolRefusal` would put a resource fact into a closed set of governance
decisions, which is the same line the timeout already sits on.

### The operator's ceiling over a sheet's caps

The other half of #405, and it lives in the runner. A team sheet sets `cpus`,
`memory_mb` and `timeout_seconds` on its `[[builtin]]` block and the proxy
honours them; `RUNNER_MAX_CPUS`, `RUNNER_MAX_MEMORY_MB` and
`RUNNER_MAX_TIMEOUT_SECONDS` bound what any sheet may ask for. Without them a
block written `memory_mb = 65536` gets 64 GB of RAM and — since the tmpfs is
sized from the memory cap — 64 GB of scratch, with only the schema's own sanity
maximum above it.

It is in `apps/runner/src/run.ts` rather than here for the reason
`packages/schema/src/team-sheet.ts` gives about why it is not in the schema: the
process that builds the container spec is the only one whose bound is a promise
it can keep. `clampCaps` runs before anything is built from the numbers, so
there is no path where a spec, a tmpfs or a wall-time wait is sized from
something the deployment does not allow.

**It clamps rather than refuses**, and the channel is told. Clamping, because
the ceiling is the operator's statement about their host and the sheet is the
same operator's grant — the two disagreeing is a configuration mismatch and not
a channel reaching for something it was not given. Told, because the case this
exists for is a program the OOM reaper killed at a limit its channel was never
configured for, and an operator's log line is not read by the model holding the
corpse: the run reports `appliedCaps`, and the rendered result names each field
that differs in the sheet's own spelling. The runner logs `caps_clamped` beside
it with both numbers.

**Unset means no ceiling**, which is the one place the runner's "required with
no default" rule does not apply. A missing socket path is a deployment that
cannot work; a missing ceiling is one that works exactly as it did before this
landed, and defaulting one in would silently shrink runs on every deployment
whose sheets ask for more. `deploy/docker-compose.yml` ships real values, so the
shipped deployment is bounded without a hand-rolled one changing under its
operator, and the runner logs the ceiling in force at boot — including that
there is none.

**CONNECT only, which decides two things an operator will trip over.** A CONNECT
hop reads a host and a port from the request line and never the payload: no
interception, no CA injected into the sandbox, no plaintext. That is deliberate —
the hop is an allowlist check, not a second redaction point, because redaction
belongs to `outbound.ts` and lives on the credential path, which this is not.
It follows that:

- **Absolute-form requests are refused.** `GET http://host/path` is what a client
  sends when `HTTP_PROXY` is set, and serving it would make the hop a forward
  proxy reading bodies. So plain `http://` does not work.
- **`[egress]` grants HTTP and HTTPS and nothing else.** `git://`, postgres, ssh
  and bare TCP have no route. `allow = ["api.github.com"]` is a narrower grant
  than it reads as: `git clone https://…` works, `git clone git://…` does not.
  This needs saying in the team-sheet documentation too, and #397 owns that.

DNS, the address cases, and why loopback and link-local are denied ahead of the
allowlist while RFC1918 is not, are argued in `packages/schema/src/egress.ts`
beside the matcher they constrain.

### A denied destination ends the run

The first denied host stops the run. The call's audit row — its **one** audit row
— is `outcome = refused`, `refusalReason = egress_denied`, with the destination on
it. It came back through the dispatcher, so it is `Dispatch.refused`, which is
where `credential_unresolved` already sits: a refusal discovered while serving
rather than a permission denied before it.

The alternative was to let the connection fail and the run continue. It lost on
five counts, and they are recorded because it is the humane-looking option and
will be proposed again:

- **One row per call is an invariant, not a habit.** `server.ts` says writing two
  rows would break it and make every count downstream wrong, `server.test.ts`
  locks it, and the `audited` flag makes the closure at-most-once by design. A
  mid-run denial has no second row to live in.
- **The hop could not write one anyway.** The chain is single-writer with a
  unique index on `prev_hash`, so a second writer forks it rather than appending
  to it. The denial can only reach the log by coming back through the run result
  — which is the instant the call's own row is written.
- **Terminal makes at most one destination exist per call**, which is exactly one
  column. The policy and the schema agree instead of negotiating.
- **It closes a gap `audit.ts` names about itself.** `auditRefusalMessage`
  returns `null` for `egress_denied` because the table has no column for the
  destination, and inventing one would be "a fabricated fact in a record whose
  whole value is that it was observed". The remedy that comment implies is to
  make the row say. A nullable `destination` appended at schema version 6 is a
  widening of exactly the kind version 4 already did with three columns, and it
  belongs to #219 alongside the wiring — cheaper there than after 0.4 ships,
  because `migrate` is a rebuild-and-rename and by then there are chained rows in
  the field.
- **It keeps an exfiltration attempt visible.** A run that continued would bury
  the one attack the security page names inside a `ran` row's log line, and would
  still return its result. Killing it makes the attempt a refusal a human reads.

There is precedent in both directions and both point the same way. `outbound.ts`
refuses to follow a redirect to a host nothing declared — it does not fetch and
warn — and that is the only live egress-adjacent check in the tree today.
`schedule_task`'s three caps already refuse from inside the dispatcher after
reading arguments.

**What it costs.** A run that does real work and then touches one unlisted
telemetry host or package CDN loses all of it, and **the refused call was still
metered**, because `recordToolCall` runs before dispatch. That is the same
direction `credential_unresolved` and `schedule_task`'s caps already take, and it
is a real cost rather than an acceptable-sounding one: an operator's first few
`[egress]` blocks will be written by watching runs fail. What makes it liveable
is that **the channel's allow list is declared to the model in the built-in's
tool description**, so a denial is not how the model finds out what it may
reach — it is a bug in generated code or an attack. #394 owns that surface, and
it is a requirement rather than a nicety.

**One distinction to keep, because it is easy to collapse.** A run killed at its
wall-time cap is *not* a refusal and not a `ProxyError` — the request was served.
A denied destination *is* a refusal. The difference is not whether the container
ran. It is that a timeout is a resource fact and a denied destination is a
governance decision the team sheet made.

### The fallback, and why it was not taken

#393 recorded an honest fallback: if the hop ballooned, 0.4 would ship
`network: none` on every run, no hop, no allowlist consulted. It did not
balloon, and #219 built the hop — so this section is kept as the record of a
decision rather than as an open option.

What it would have cost, since that is the part worth keeping: `egress_denied`
would have stayed unconstructed and the `destination` column would have had no
reason to exist; the exfiltration case in the e2e suite would have become "the
container has no network" rather than "the unlisted host was refused", leaving
its positive control nothing to prove; and the v0.4.0 milestone's own definition
of done — which commits in writing to a destination outside the list being
refused before a connection is opened — would have had to be edited rather than
met.

The part that did hold either way is worth repeating: the runner decision was
independent of this one. #395 shipped a working sandbox with no network at all,
and #219 added the hop on top of it without changing the topology underneath.

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
| `GET /v1/budget` | what the gate would say about spending now | `BudgetStatus` out; advisory, and nothing runs on it |
| `POST /v1/approvals` | a human's decision on a held call | `ApprovalDecision` in, `ApprovalDecisionResponse` out; the ticket id is in the body |

**The budget read is advisory, and that is not a hedge** (#335). The proxy
enforces `[budget]` on a tool call, which is the only spend it ever sees — a
model completion goes straight from the agent process to the provider and
arrives here afterwards as a count on `/v1/spend`. So a background turn that
calls no tool met no bound at all, however far over its caps a channel was, and
`GET /v1/budget` is how such a turn asks before it starts.

It is **not** a second enforcement point and must not be described as one. This
process cannot refuse a completion it never sees, so a compromised agent simply
does not ask. What the read buys is cost control for an agent that is working
correctly — the same standing `[ambient]` has on the sheet, honoured by that
process and by nothing else. The property that survives agent compromise is
unchanged and belongs to `/v1/tools/call`: `daily_tool_calls` and `daily_tokens`
still refuse *tool calls*, counted from this process's own observation.

Two things keep the route honest. It closes over `SpendReader` rather than the
meter, so it can neither record a call nor claim the channel's one daily
warning — the mirror of the `TokenRecorder` argument on the spend route. And it
answers through **`exhaustedLimit`, the same function `/v1/tools/call` reaches
through `decide`**, so "the read and the gate agree" is a property of one
function rather than of two that happen to match; `server.test.ts` asserts it by
spending a channel to its cap and comparing the two answers.

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

**Channel scoping is the map's shape.** Tickets are keyed by channel and then by
id, so a lookup cannot reach another channel's — which is why a foreign ticket
and a nonexistent one are one answer rather than two made to look alike.

### The destructive-verb heuristic barely fires on GitHub

`DESTRUCTIVE_VERBS` is delete, drop, transfer, deploy, and it holds a tool whose
sheet entry says nothing either way. Measured against GitHub's real catalog,
`merge_pull_request`, `push_files`, `create_or_update_file`, `issue_write` and
`pull_request_review_write` contain none of those words and so default to running
unreviewed; `delete_file` is the one it catches.

That is the heuristic behaving as designed — it is a default for the entry nobody
thought about, not a classifier — but it is worth knowing before trusting it. The
starter sheet says so in a comment and the docs say so in a table, because a
starter showing only the caught case would teach the wrong lesson. A tool that
must be reviewed gets `approval = "required"` in the sheet.

It fires on **upstream** names only. A built-in's default is declared in
`BUILTIN_APPROVAL_DEFAULT` — see *Built-in tools* above — because this heuristic
exists to guess at names somebody else chose, and there is nothing to guess about
a name that was chosen in this repository. Do not add a verb to that list to
decide something about a built-in: the list is matched against every upstream tool
in every deployment.

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
| no permit within the queue wait | `busy` |

That is safe because a listing is not the enforcement: a missing schema costs
the model accuracy, never the channel a permission. The one thing that does not
degrade is a `RedactionError` — this proxy unable to guarantee its own boundary
rather than an upstream failing — which answers 500, because degrading would
serve a cheerful thin listing to a channel whose every call is about to fail the
same way.

**One tool is dropped from the listing rather than thinned, and it is the only
one** (#200). SEP-2243 lets a tool's `inputSchema` annotate arguments with
`x-mcp-header`, and the vendored codec validates every constraint on one before
deriving a header: non-empty, RFC 9110 `token` syntax, on a primitive type,
case-insensitively unique, and statically reachable through a chain of
`properties` keys — never under `items`, `oneOf`/`anyOf`/`allOf`/`not`,
`if`/`then`/`else`, or a `$ref`. An annotation anywhere else invalidates the
whole tool definition, and the specification's answer is that the client MUST
leave the tool out of the listing. The proxy does: the entry is absent, and one
`catalog_tool_excluded` line names the server, the tool and
`reason: "invalid_annotations"`. `tools_listed` carries an `excluded` count
beside `count`, so a listing that shrank says so on the line reporting it and
not only in the walk that decided it.

That is a departure in *mechanism*, not in the property the doctrine above
protects. Dropping the row removes the tool from the model's context and
deauthorizes nothing — the sheet still names it and `enforce.ts` still decides a
call on it, which is what the wire test asserts. The reason to prefer exclusion
here specifically is that the alternative failure is silent and total: the proxy
cannot derive the headers for such a tool, so a thin entry is a tool the model
can see, will call, and whose every call a server requiring them refuses at the
far end — `-32020` on GitHub. The model retries, burns the channel's turns
against a cap, and the audit log records calls that ran and returned an error.
Showing the model a tool that cannot work is worse than not showing it.

Two things stay as they are. A **schema the scan cannot survive** — the walk is
unbounded in depth and runs on the raw bytes, deliberately — declares nothing
and is still published thin, because a throw establishes nothing about the
schema while a validation failure is a MUST the codec watched being violated.
And the **call path is unchanged**: a call to an excluded tool goes out without
headers exactly as before, since a thin catalog has never been allowed to block
a permitted call. A change that relaxed the codec's walk to be more permissive
would be a security change rather than an ergonomics one — these are
model-authored argument values becoming headers on the one request that carries
a credential, the class `readSessionId` already guards for `mcp-session-id`.

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

Since #500 a result is a block array rather than a string, and this one number
still bounds the whole of it: a text block pays its character count — exactly
what the cap counted when content was a string, so no channel's setting changed
meaning — and a binary block pays its **decoded** bytes. `resultCost` in
`@getlibero/schema` is the rule and carries the argument, including the two
readings declined: a per-block cap, which would let forty blocks cost forty
times what an operator agreed to once, and a second byte-denominated bound for
binary alone, which keeps the units honest at the price of a ceiling that exists
in no sheet and no environment variable and that nobody has ever tuned.

The unit mismatch inside that sum is the price, and what it buys is the default:
32,768 already bounds an image, so **nothing binary reaches a model until an
operator raises a number**, which is the shape every other capability here takes.
Past the cap the two halves do not behave alike — text truncates and says where
it was cut, while a binary block degrades to the placeholder naming its type and
size. Half a base64 payload is a corrupt image rather than a short one, and
there is no notice to append that would make it decode.

**Where a cut lands is one rule in one function** (#509). `cutAt` in
`mcp-bounds.ts` keeps at most `limit` code units and drops one more where the cut
split a surrogate pair: a lone high surrogate is not a character, it survives
`JSON.stringify` as `\ud83d`, and what a tokenizer does with it is the provider's
business rather than something this proxy should be finding out per upstream. All
three places that cut call it — the result bound above, `truncate` on every
upstream-authored label, and `render` on a sandbox run's stdout, which is
arbitrary program output and so the likeliest of the three to hold an emoji at an
arbitrary offset. A caller keeps its own notice and its own ellipsis; none of
them keeps its own slice, so a fourth cutting site is a call rather than a fourth
re-derivation. What follows from that is the number a notice reports: the
**kept** length, not the cap, because the guard makes those different on exactly
the cases it fires for, and the kept length is what `result_bytes` counts.

**The cap is walked in order** (#501), rather than fitted across the array by
some best-fit: the order is the server's own, and the first thing it said is the
thing it led with. Each block is charged against what is left, and the walk stops
once the budget is gone rather than degrading every remaining block to a
sentence — how many blocks an upstream sends is the upstream's choice, so a
sentence per block would be a way to spend a budget the cap would not otherwise
permit. It says how many blocks it emitted of how many there were, and that
notice is only reachable on a multi-block result, so the single-block result
every producer in this tree emits carries exactly the characters it always did.

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

It is a **different number from the cap's**, and `resultBytes` is a second
function rather than an argument to the first. They agree on a binary block and
differ on text, where the cap counts characters and this counts utf8 bytes,
because one answers what a channel may spend and the other what the call moved;
one function serving both would have to be wrong for one of them. A binary block
is counted decoded here too — the encoded length is closer to what the transport
carried, and it was declined because it disagrees with the sentence the model is
handed (`[image omitted: image/png, 4823 bytes]` has always been decoded) and
would inflate the column by a third against every row already written, on a
measure whose whole purpose is comparison over time.

**`result_bytes_by_type` says what crossed** (#501): the same bytes split by
block type, as a JSON object beside the total, whose values sum to it exactly so
a reader can check one against the other. The total says how much and could
never say of what — `4823 bytes` reads the same whether it was a paragraph or a
thumbnail — and the operator question it leaves unanswered is which calls are
moving binary at all, which is the one that matters once a channel has raised
`max_result_chars` to relay images. Written whenever the total is, including on
an all-text result, because a reader telling "all text" from "not recorded"
needs the two to look different; a type with no block is absent rather than
zero, since a zero would be a claim that an empty image crossed.

One text column and not four integer ones. Four would aggregate without parsing,
which is a real thing to want on an operator-facing table — and they would write
`ToolResultBlock`'s membership into the audit schema, so a fifth block type
would become a schema version and a rebuild over every row an operator has. It
is **version 7, and a widening of the easy kind**, like version 6's
`destination`: NULL columns are omitted from the preimage, so every row already
on disk hashes to exactly what it did and the migration costs the chain nothing.

### The third bound, which makes the other two multiply out

`PROXY_MAX_UPSTREAM_CONCURRENCY` (default 8) is how many calls the proxy will
run against one upstream at once (#159). It belongs beside the wire bound and is
owned by the same principal, for a reason the other two do not have: it is the
factor the wire bound was always being multiplied by. One `McpClient` per
upstream is shared by every channel naming it, and until this landed nothing
counted the calls riding one — so a deployment's worst case against an upstream
that accepts connections and never answers was 4 MiB, times the three-to-fivefold
decoding overhead, times an unbounded number of concurrent calls. The product is
now something an operator can compute.

It is also the fairness bound. Channels sharing an upstream share whatever rate
limit its credential carries, and one busy channel could spend all of it.

**"One upstream" is `upstreamKey` — `(transport, url, credential)`.** So two
sheet blocks pointing at one host under two different credentials get a limit
each, which is the right reading (two identities, two rate limits at the far end)
and also the way to run 2N calls at one host. Worth knowing when sizing it.

A call arriving past the limit **waits** rather than being turned away: FIFO, for
a few seconds, and then answered `busy` — `outcome: "ran"` with `isError`, the
same shape a timeout takes, because nothing was denied. Queueing rather than
refusing is deliberate. The budget meter counts a tool call at the moment the
proxy commits to serving it, which is *before* dispatch, so an immediate refusal
would charge a channel's `daily_tool_calls` for a call that never happened and
then charge it again for the retry. The wait is bounded because the agent
abandons its request after 30 seconds, and a permit coming free for a caller that
has stopped listening spends a saturated upstream's scarce capacity on nobody.

**The wait is spent out of the call's budget rather than beside it** (#253).
`gate` reads a deadline before it asks for a permit and passes it to `callTool`,
so a call that queued for five seconds gets twenty-five and not a fresh thirty.
Without that, the gate narrowed the *number* of calls left in flight against an
agent that had already hung up, while slightly widening the window for each one
that remained — which #159 recorded as a known residue rather than fixed.

**A deadline and not a duration, because `callTool` replays.** It makes up to two
`tools/call` requests, one after a session the server forgot is reopened, and a
duration handed in once would bound each of them — so a caller asking for
twenty-five seconds could spend fifty. The same instant read twice cannot, which
is the difference between bounding a request and bounding a call.

What the deadline does not bound is opening the connection. `ensureOpen` and
`reopenSession` are single-flighted and shared between concurrent callers, so
threading a per-call deadline into either would let one channel's remaining
budget bound a handshake another channel is awaiting. Their bound stays the
per-request timeout. The common case — a session already open — is therefore
bounded entirely by the deadline, and the two paths that are not each add one
shared connect.

Listings needed none of this. A `tools/list` page is gated too, but a walk
already runs inside `CATALOG_BUDGET_MS`, which starts before the first page is
asked for and so already covers whatever its wait costs — the same invariant
`LISTING_QUEUE_WAIT_MS` is chosen against. The listing arm was never the arm that
stacked.

Listings are gated too — a `tools/list` walk is a credentialed request to the
same upstream — and a walk that loses degrades to the thin catalog, which has
never been allowed to block a permitted call.

A walk that runs out of its five-second budget stops asking for pages (#252).
Before the permits it cost nothing to let it run to the five-page cap, and there
was a reason to: a walk that finishes late still warms the client for the next
listing or the first tool call. Once a page took a permit, the pages after the
one in flight were queuing against live calls for a result nobody would read.
The request already sent still lands, because the handshake runs inside the first
page and is where the warming actually is.

Answers are cached for five minutes, thirty seconds on a failure or a partial
walk, and single-flighted — so a client polling the route does not become
credentialed load on someone else's server.

**The key is `upstreamKey` alone, and that changed in #188.** It used to be
`(upstream, exact sorted wanted-set)`, which made it a cache of *answers to one
question* rather than of a catalog. That was right while the only caller was this
route and wrong the moment a call wanted one tool's `x-mcp-header` declarations:
a one-name question is a different key and therefore a guaranteed miss — a
five-page walk under a five-second budget, per call, against an upstream walked
seconds ago.

The entry now holds **per-name resolutions**, where `published: null` means
*walked and confirmed absent*. That is a different fact from not-yet-asked and
has to be storable, or a sheet naming a tool the upstream does not offer re-walks
it forever. Freshness is per name, because a walk is per name.

The old key protected something real and it survives: its hazard was two channels
naming one server with different tool lists reading each other's answer, which
was about sharing a *conclusion* drawn under someone else's question. Per-name
facts cannot disagree — a catalog is the server's, and `upstreamKey` already
separates credentials.

What did have to change with it is that **`MAX_DESCRIBED_TOOLS` is both a budget
the caller subtracts from and a cap `assemble` applies.** The cap bounds what
enters a model's context, and definitions are re-sent every turn, so it has to
hold across the *answer* rather than across one walk — otherwise a caller asking
for thirty names and then for all of them carries thirty remembered plus a fresh
hundred. The budget alone was not enough either, because resolutions merge across
questions: two narrow asks can together settle more names than the cap, and a
later wide ask then finds everything fresh and walks nothing. So the bound is
applied where every path returns, in the sheet's order — which makes what
survives the cut the operator's priority rather than the upstream's.

`createListingRoute` closes over `ToolCatalog`, whose only method describes. The
dispatcher — the seam that runs something — is not in scope, and
`eslint.config.mjs` bans the vault, the pool, the client, the dispatcher
implementation, and the outbound sender in that file. One object fills both
seams, because it is still the only thing holding a vault and a client pool.

A refusal is a served request: HTTP 200 with `{ outcome: "refused" | "held",
refusal }`. `ProxyError` stays what it was, the shape of a request that could
not be answered at all. A channel with no team sheet gets an empty listing and
a refusal on every call — which is what revoking a channel looks like.

## The audit log's write discipline

One table, a `channel` column, and the only statement that touches it is an
INSERT. Append-only is enforced by `BEFORE UPDATE` and `BEFORE DELETE` triggers
that `RAISE(ABORT)`: SQLite has neither roles nor grants, so "no UPDATE/DELETE
for the service role" cannot be built as the architecture words it. The
write-only interface the server closes over and the file's permissions are
defence in depth around the triggers, not the mechanism. A failed audit write
**refuses the call** rather than serving it unrecorded.

**Every decided call leaves exactly one row, and that is total** (#124). The row
is written after dispatch — the only place `result_bytes` exists — so anything
throwing in between used to escape to the outer handler's catch, which holds no
per-call state, and left a metered and possibly-executed call unrecorded. A
`RedactionError` on the result's way back was the live path, and the test that
covered it *encoded* the gap. The fix is a `try`/`catch` inside `callTool`,
opening **after** the `audit` closure's `const` — coverage is identical to
opening at the decision, and opening earlier would let the catch reach `audit` in
its temporal dead zone and mask the real failure — and rethrowing, so the 500 is
byte-for-byte unchanged.

**The word is `unanswered`, and `failed` was rejected on a test that already
existed.** `audit.test.ts` asserts the vocabulary refuses `"failed"` and
`"error"` under "including the tool's own error flag", because `outcome` is not a
success/failure flag — `resultIsError` is the separate question. `unanswered`
also says only what is known: it asserts nothing about whether the upstream
acted, so `ran` undercounts upstream effects by exactly these rows.

**The one-row guard is a flag set on *entry* to the `audit` closure, not on
success.** `append` can succeed and the closure still throw afterwards, since
`logger.log` writes to a stream and can fail on EPIPE — a success flag would then
file a second row for a call that already has one. Entry is safe because the
closure is called at most once per request: every call site is followed by a
`return` in a mutually exclusive branch. The fallback append is itself wrapped
and its throw swallowed, the only swallow in the file, because
`audit_write_failed` is already logged and the 500 is about the original failure.

**The migration is a fan-in, not a ladder.** `auditTableDdl` is by construction
*the table this build writes*, so a real v1→v2→v3 ladder would need a frozen v2
DDL literal beside it — the second copy of the columns that parameterised DDL
exists to prevent, and one no test could catch drifting. `rebuildAuditTable` asks
`PRAGMA table_info` which columns the old table can give rather than being told
by a version number. That is also what makes the no-stamp case safe:
`schema_version` carries no triggers, so an operator can delete the stamp from a
v2 file with rows in it, and a rebuild assuming the oldest shape would silently
null every `ticket`.

There is no retention command and a delete-based one should not be added;
rotation is the shape.

### The chain, and what it is evidence of

Version 5 gives every row `prev_hash` and `row_hash` (#354). `row_hash` is
SHA-256 over the predecessor's `row_hash` and a canonical serialization of the
row's own columns; the first row chains from a stated genesis constant.
Recomputing the walk from the first row is what detects an edit.

**Evidence, not prevention, and the two halves do different jobs.** The
append-only triggers stop the *service* rewriting history in normal operation.
The chain catches *whoever holds the file* — the actor the triggers were always
unable to see, and which `audit-db.ts` has said so about since #97.

The serialization is pinned: the column order is a frozen array in the module,
NULL columns are omitted, and both the key and the value go through
`JSON.stringify` so that a model-authored `call_id` cannot forge a field
boundary. Omitting NULLs is the load-bearing rule — it is what makes a future
widening leave every historical hash alone, since every column this module has
ever added is NULL on every row written before it. A change to the encoding is
not a migration; it invalidates every file, which is why it versions with
`schema_version` and why the tag naming it sits in the preimage.

The serving path still runs exactly one statement. The tip is read once at open
and carried in memory, because SQLite cannot compute a SHA-256 and reading the
hash back after the insert would be a second statement.

A **unique index on `prev_hash`** is what makes the one-writer assumption
something SQLite checks rather than something this file asks you to believe. It
matters because the triggers stop UPDATE and DELETE and **not** INSERT: anyone
holding the file can append to it. A forged append takes the tip's successor
slot, so the proxy's next call cannot be recorded — and is therefore refused,
until an operator restarts it. That is a denial of service caused by tampering,
and it is the posture the route already takes when it cannot write a row at all.
Re-seeding the tip on conflict would mean chaining onto the attacker's row and
serving on, which is why it is not done.

**What it catches:** any row rewritten, deleted, or inserted without recomputing
every hash after it. That is what an UPDATE through `sqlite3` does.

**What it does not catch**, stated because "tamper-evident" invites more:

- **A complete recompute.** The chain is unkeyed, so an attacker holding the file
  can rewrite a row and re-derive every hash after it. The answer is anchoring
  the tip outside the file — `node dist/audit.js verify` walks the chain and
  prints it, and the proxy also
  logs it as `chainTip` on `audit_opened`, which is an anchor as far as the logs
  travel and no further. An HMAC was rejected: reading `audit.db` means being on
  the proxy host where the key would be, a key is a thing to lose (turning "no
  evidence" into "evidence destroyed by a mistake"), and an unkeyed chain is
  checkable by anyone holding an archived copy — which for an audit log is the
  feature, not the weakness.
- **Truncation from the tail.** Dropping the last rows leaves a shorter chain
  that is internally perfect. Same answer.
- **A monotone renumbering of `id`.** The chain fixes the order, not the
  numbering: swapping two ids breaks the walk, rewriting 1,2,3 as 10,20,30 does
  not. What that costs is `afterId` as an export cursor, and closing it would
  mean this process assigning the primary key instead of SQLite.
- **Rotation.** A chain is per file. `VACUUM INTO` a dated archive starts a new
  one; tying the new file's genesis to the old file's tip is the operator's act.

Rows written before version 5 are chained *as of the migration*. That vouches for
them from that moment forward and asserts nothing about what happened to them
before it — an important difference from a row written under v5, which was
chained at the moment it was written. Refusing a v4 file and making rotation the
answer was considered and rejected: this log's whole value is not forgetting, and
buying evidence by discarding the evidence is a bad trade.

### Why the arguments are not stored, and why that is settled

#97 shipped a hash of the model's arguments and left capture-behind-a-flag as a
follow-up. #122 designed that follow-up and **declined it**. The reasons are in
`audit-log.ts`'s header in full; the short form, because this is the kind of
decision someone re-opens by accident:

- **Redaction is a backstop, not a boundary** — `redact.ts` says so in its own
  header, at length. A scan for a value finds the value and misses a
  transformation of it. The threat capture exists to investigate is a
  prompt-injected model putting a secret into a tool call, which is an adversary
  rather than a careless upstream, so the mechanism would be weakest exactly
  where it was relied on. The acceptance criterion asked for "a redaction set the
  design argues is complete", and a complete *set* is not complete *redaction*.
- **The plausible set has a side effect.** Redacting against every credential the
  channel's sheet names means *acquiring* them, and acquiring an OAuth credential
  is a token-endpoint round trip. A refused call resolves none today; under that
  design it would mint tokens over the network to have something to redact
  against.
- **A captured secret would be permanent**, now that rows are chained: removing
  it breaks the chain from that row to the tip, so the remedy would be rotating
  the credential *and* the log.

What it cost, stated rather than waved off: a **refused** call reached no
upstream, so nothing anywhere recorded what it attempted. A call that ran leaves
its arguments in the upstream's own record. #364 closed that narrower gap
without reopening the decision — see the attempt store below — and `redact`
stays banned from the writer and the route by ESLint: the exception that kept it
importable was standing on a change that is still not coming, because the store
claims no redaction at all.

### The attempt store: the gap closed off-chain (#364)

`attempts-db.ts` is its own SQLite file beside the audit log, holding the full
argument blob of every **blocked** call — refused captured at refusal, held
captured at mint, which is what covers a later deny or expiry, since by
decision time the ticket store holds only the hash. It threads the three
constraints above instead of arguing with them:

- **It stores raw and claims no redaction.** The content is model-authored,
  labelled hostile on every read, and may contain anything the model saw.
  Nobody believes a redacted column, because there is not one.
- **Nothing is resolved.** Capture stores bytes the proxy already holds, so a
  refusal still causes no token-endpoint traffic — asserted in e2e against a
  live fake issuer.
- **It is not chained, so it is deletable.** The key is the audit row's own
  `arguments_sha256` and the stored bytes are exactly what that digest covers,
  so the read path re-verifies content against key — tamper-evident by
  reference — and deleting a record degrades its rows to hash-only without
  touching the chain. `audit verify` stays green. A secret that lands in a
  record is removed by deleting the record, not by rotating the log.

Its own file rather than a second table, because the write disciplines are
opposites — append-only-and-chained against deletable-by-design — and one file
per discipline keeps each rule checkable by reading the module that opens it.
No channel column: the store is content-addressed and the audit rows are its
index. A capture failure refuses the call it could not record, the audit
writer's rule, so "every blocked call leaves an attempt record" holds with no
exception clause. The operator reads and deletes through `node dist/audit.js
attempt` / `attempt-delete`, which neutralize control characters on the way to
the terminal — the approval card's escaping argument, for an operator's screen.
Capture is on when `PROXY_ATTEMPTS_DB` is set, which the shipped compose file
does; unset is the deployment-level off switch, said once at startup.

**An export is not the verification surface.** The CSV carries both columns,
because an export that drops the chain is an export nobody can verify — but a
*filtered* CSV is a subset whose hashes do not link. Verification is `audit
verify` against the file.

### The priced columns, and what they are not

Version 4 adds `budget_limit`, `day_spend_micro_usd` and `price_version` (#62).
The migration gives every older row `NULL` for each, which is a widening in the
sense that matters: the columns are nullable, no existing row can fail the copy,
and `NULL` is already what these columns read as on any row that was never
priced. An old row saying "no figure exists" is true rather than a gap.

**Neither figure is a per-call cost.** `audit.ts`'s `resultBytes` already refuses
to invent a per-call token count, on the ground that tokens are spent by model
turns rather than by tool calls; money is spent the same way. What the row
carries is the channel's running total for the day *as the decision saw it*, and
the digest of the table that priced it — the pair that makes a past budget
decision reproducible.

The figure comes from `priceDaySpend` in `enforce.ts`, which is the function the
decision itself used, rather than a second computation in `server.ts`: a row
whose number disagreed with the comparison it documents would be worse than no
row. `budget_limit` is taken off the refusal the decision produced for the same
reason.

## Certificates

`scripts/dev-certs.sh` mints the CA, the server certificate, and one client
certificate per channel, laid out by role — `ca.pem` at the root, the proxy's
keypair under `proxy/`, the channel client certs under `agent/` — so each
container mounts only its slice and the CA key is mounted into neither. The
tests run that same script rather than carrying fixtures, so no private key is
committed here and the documented operator path is exercised on every CI run.
It needs `openssl` on PATH.

Client certificates are valid for a year and the CA for ten, and re-running the
script mints only what is missing — a re-mint of a certificate already in
service would stop the fingerprint its team sheet pins from matching. Replacing
one is `--rotate <channel>` (mints beside what is running, prints the new
fingerprint) followed by `--promote <channel>` (swaps it in, and refuses until
the sheet pins the replacement). The overlap where the sheet pins both is what
makes rotation gapless; see the self-hosting doc for the operator's version.
