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
- `dispatch.ts` — the two seams past the decision: what a channel has spent
  (the budget meter, #38) and what serves an allowed call. Both are required
  options with no defaults, and the provisional stand-ins for them are marked:
  `createProxyServer` throws rather than build a proxy that pairs a dispatcher
  which really serves calls with the meter that never exhausts a budget. A
  dispatcher is handed the team-sheet entry enforcement matched, not the
  sheet — the entry that authorized a call is the entry the call goes to.
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
client pool (#39), the approval broker, the budget meter, and the audit writer.
`http-dispatcher.ts` marks where the egress check slots in.

**The shipped process still answers 501.** `createHttpDispatcher` is a real
dispatcher, so composing it with `createUnmeteredSpend()` is a startup error
until #38 lands a real meter — `apps/proxy-server` therefore keeps both
stand-ins, and injection is exercised against a mock upstream in tests. That
pairing is deliberate: a proxy that serves calls without metering them never
exhausts a budget, and that failure is silent.
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
