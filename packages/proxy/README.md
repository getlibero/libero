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
- `mcp-bounds.ts` — what an upstream is allowed to say and how much of it:
  the channel's bound on a result, the caps on a description and a schema, and
  the per-entry rule for reading a page of a catalog. No `Secret`, no `fetch`,
  no I/O. It is policy rather than protocol, which is why it outlived the wire
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
  through one client are counted (#159).
- `semaphore.ts` — FIFO permits with a bounded wait, and a waiter that gave up
  leaves the queue rather than being handed a permit nobody is waiting for.
- `mcp-fake-server.ts` — a real `node:http` MCP server for the tests, speaking
  either protocol and holding real session state on the legacy one, with the
  knobs the leak assertions need: both framings, an upstream that echoes its
  auth header plainly or JSON-escaped, and one that advertises versions we do
  not speak.
- `vault.ts` — the credential vault, read side. One AES-256-GCM blob over the
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
enforces by name.

Still to come, with its own issue: the egress allowlist (#73).
`http-dispatcher.ts` marks where the egress check slots in.

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

**A second store, not a writable vault.** Grant material lives in `tokens.enc`
beside `vault.enc` — the path is fixed as the vault's sibling, because a second
path variable would be a second way to point the two writers at different
files. Same envelope byte for byte, two constants apart: magic `LBTOKEN`, HKDF
info `libero.tokens.v1` — the separation `vault.ts`'s info string was written
to anticipate. A token store opened as a vault fails `not_a_vault` before any
key is used, and even a forged header cannot decrypt one file under the
other's subkey. Whole-set encryption and the size caps carry over: a list of
grant names is an inventory of what the deployment reaches, the vault's own
argument. The alternative — the serving process writing the vault itself —
dies on `vault.ts`'s first rule: "it never writes" is proved by an import
list, and one file with two writers deletes that proof for both.

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
exchange. What does not exist yet is sender-constraining (DPoP), which would
make a stolen token unusable rather than merely loud — parked as #260.

**The invariant, re-worded.** Tool credentials at rest live in two stores: the
vault, which the operator writes and the serving process only reads, and the
token store, which the serving process writes — because an authorization
server rotates a refresh token by handing back its successor. Today both are
encrypted files on the proxy's volume, under one master key and one envelope.
The process serving tool calls still never writes the vault; what it writes is
the token store, and the only values that can reach it are values an
authorization server just issued for an upstream a team sheet already names.
There is still no `get`, in either store: a value leaves only as a `Secret`,
and only `outbound.ts` ever unwraps one — to spend a credential on an upstream
call, whose reply it scrubs, or to exchange a refresh token at the issuer that
minted it, whose reply is never returned to any caller. And neither store is
the authorization source, so a stale read can refuse a call and can never
widen one.

**The store is the contract; the files are the built form.** What #255–#257
build against is the paragraph above plus the write discipline — disjoint
writers, provenance, persist-before-use, replace-not-stack — none of which
names a filesystem. A managed backend (GCP Secret Manager, AWS Secrets
Manager; parked as #261) would re-implement the mechanism with stronger
enforcement — writer separation as IAM roles, replace-not-stack as
add-version/destroy-old, the master key from KMS through `vaultKeyFromEnv`,
the one acquisition seam both stores already share — and change nothing above
this sentence.

## Built-in tools

Not every permitted call goes to an upstream. Two are served by this process:
`search_channel_history`, which reads the calling channel's message store
(`@getlibero/memory`, opened read-only), and `schedule_task`, which creates one
future check. `builtins.ts` holds the definitions and the strict argument parser;
`builtin-dispatcher.ts` is the executor.

**`schedule_task`'s executor is #323 and is not here yet.** The definition, the
enum member, the declared hold and the sheet's grant landed in #322, so a channel
that lists it today gets the whole governed path — the listing, the card, the
audit row — and a `501` from the dispatcher's `unavailable` arm. That word is
exact: it means the upstream kind is not built, where the `unanswered` a throw
produces means a built-in that exists and broke. Nothing is denied and nothing is
promised.

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

Adding a built-in is four parts that fail the build separately: a member on
`BuiltinToolName` in `@getlibero/schema`, an entry in `BUILTIN_APPROVAL_DEFAULT`
beside it, a definition in `BUILTIN_TOOLS`, and a case in the executor's
exhaustive switch. Two `Record`s over the enum and one switch, so there is no
order in which a half-added built-in compiles — and the approval entry is in that
list because a built-in with no declared default would silently inherit a guess
about somebody else's naming.

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
