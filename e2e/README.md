# @getlibero/e2e

The end-to-end security suite. Both halves of the system, composed for real, with
a scripted model playing the attacker.

**What is faked is exactly two things: the Slack socket and the model.**
Everything between them is the shipped code — real mutual TLS, real certificate-
backed channel identity, real team-sheet enforcement, the real vault, real
credential injection and redaction, the real budget meter, the real audit log,
and the real MCP client against a recording upstream.

That is the point. `packages/proxy` tests the proxy against a hand-written
client, and `packages/agent` tests the client against a hand-written listener.
Both pass, and neither shows that the two agree — as
`packages/agent/src/proxy/transport.test.ts` says in its own header: *"The two
halves meeting for real is the e2e suite's job."* This is that.

## Running it

```sh
pnpm -r build            # required: the suite spawns apps/proxy-server/dist
pnpm --filter @getlibero/e2e test
```

The build is not optional. The suite spawns the proxy's built entrypoint and
resolves every `@getlibero/*` import through `dist`, so a stale or missing build
fails with a message telling you to run it. CI builds before it tests, so this
is only a local concern.

`openssl` must be on `PATH` — `scripts/dev-certs.sh` mints the certificates.

**The files run in parallel, and the absence of `--no-file-parallelism` is a
decision rather than an omission.** The flag was here from the rig's first
commit with no stated reason, and it cost 49 of the build job's 73 seconds:
`e2e` depends on every package, so `pnpm -r` schedules it last and the runner's
other cores idle through it.

Nothing in the rig needs the serialisation. A case gets its own temporary
directory, its own certificates, its own vault, budget and audit files, and its
own proxy process — and that process binds `PROXY_PORT: "0"`, so the OS picks
the port precisely so nothing has to reserve one and race the rest of the host.
Ten runs on CI's four-core hardware were green at 20–28s against a 48s serial
control on the same runner class, which is what changed this from a plausible
argument into a measured one (#205).

If you add a case that needs a resource it cannot get a private copy of, isolate
that case rather than restoring the flag — `describe.sequential` is the smaller
instrument, and re-serialising the whole suite to protect one file is how the 49
seconds came back.

## The shape

```
                    stub Slack          scripted model
                         │                    │
                         ▼                    ▼
  ┌──────────────────────────────────────────────────┐
  │  this process:  createServer(deps)               │   apps/server/src/compose.ts
  │                 the production composition       │   — the same call index.ts makes
  └───────────────────────┬──────────────────────────┘
                          │  real mutual TLS, real client certificate
                          ▼
  ┌──────────────────────────────────────────────────┐
  │  spawned process:  apps/proxy-server/dist         │
  │  vault · sheets · meter · audit · MCP client      │
  └───────────────────────┬──────────────────────────┘
                          │  Bearer <credential>
                          ▼
                  recording MCP upstream
```

**Why the proxy is spawned and the agent side is not.** The security claim is
that tool credentials live only in the proxy, so the half that must be a
separate operating-system process is the half holding the vault — otherwise
"the credential never reached the agent" is a claim about JavaScript module
scope. The agent side cannot be spawned: `createSlackSurface` builds the real
`SocketModeClient` and `WebClient`, forwards neither of the injection seams
beneath it, and sets no `slackApiUrl`, so a spawned `apps/server/dist/index.js`
reaches slack.com or nothing. Running it here through the *same* `createServer`
that `index.ts` calls is what keeps this the production composition rather than
a restatement of it.

## Writing a case

```ts
let rig: Rig | undefined;

beforeAll(async () => {
  rig = await startRig({
    sheets: { [CHANNEL]: { credential: "e2e_canary", tools: [{ name: "list_prs", approval: "none" }] } },
    script: [calls("list_prs", { repo: "x" }), says("Two are open.")]
  });
}, 60_000);

afterAll(async () => {
  await rig?.stop();
}, 60_000);

it("…", async () => {
  const { agent, upstream, auditDb, surfaces } = rigOf(rig);

  await agent.slack.deliverMention({ channelId: CHANNEL, /* … */ });

  expect(agent.slack.posted).toHaveLength(1);
  expect(upstream.callsTo("tools/call")[0]?.authorization).toBe(`Bearer ${CANARY}`);
  expectNoCanary(surfaces());
  expect(auditRows(auditDb)[0]).toMatchObject({ outcome: "ran" });
}, 30_000);
```

`rigOf` and the `?.` in `afterAll` are not ceremony. `beforeAll` assigns and a
case reads, so the variable is `Rig | undefined` however confident the case is —
and without them a setup that threw reports `TypeError: Cannot read properties
of undefined` from every case *and* from the teardown, several lines below the
real cause and looking nothing like it.

`startRig` is the whole API; `src/smoke.test.ts` is the worked example. Everything
it returns — `agent`, `proxy`, `upstream`, `model`, `channelsRoot`, `auditDb`,
`budgetDb`, `storeRoot` — is there so a case can assert without reaching into
rig internals.
If you find yourself needing one, add it to the rig rather than rebuilding a
piece of it.

## The one case that leaves the machine

`src/github-live.test.ts` is #130's acceptance run against GitHub's hosted MCP
server. It is skipped unless `LIBERO_GITHUB_PAT` is set, so CI collects it,
reaches no network, and needs no secret:

```sh
pnpm -r build
LIBERO_GITHUB_PAT=… pnpm --filter @getlibero/e2e exec vitest run src/github-live.test.ts
```

Its positive control has a different shape from the rest of the suite's, and
that is the point: there is no recording upstream to read a header off, so the
control is that GitHub answered with data an anonymous caller cannot get — a
merged pull request's title, which the request did not carry. Pick a fragment
GitHub will not transform: it HTML-escapes what it returns, so a fragment
containing an apostrophe fails on a call that in fact completed.

The token is planted through `startRig({ credentials })`, which is the **only**
sanctioned use of that option and the one documented exception to
`harness/vault.ts`'s rule that a rig plants a canary and never a plausible
token. The canary is still there; nothing in that file names it.

`src/github.test.ts` is the half CI runs: the same three claims against the fake
configured to present the shape the real server does — a refused
`server/discover` and the legacy `initialize` fallback, a session id it must
carry, SSE framing, a paged catalog, `x-mcp-header` annotations it *enforces*
(`requireParamHeaders`, so a client that sends no `Mcp-Param-*` gets the `-32020`
GitHub gives), and a description long enough to be truncated. That last one is not decoration. The proxy used to append its
ellipsis *past* `MAX_TOOL_DESCRIPTION`, which is the same constant
`PermittedTool.description` parses against, so any upstream with a description
over 1,024 characters produced a listing the agent rejected as
`malformed_response` — killing the task rather than shortening a sentence. No
fixture in the suite had a description that long until this one did.

## Things that will cost you an afternoon otherwise

**The positive control is not optional.** Every "the credential did not leak"
assertion also passes on a run where no credential was ever resolved — which is
the one failure a leak suite must never report as a pass. Assert that the canary
*did* arrive at the upstream as `Bearer <canary>`, then assert it reached nothing
else. `expectCanaryReachedUpstream(upstream)` is that first half, and
`src/smoke.test.ts` does both, in that order. Its second argument is the
JSON-RPC method to look on, because the credential goes out on more than one
kind of request: a case attacking the **listing** is controlled by
`tools/list`, and one against a legacy upstream by `initialize`, not by a call
that may never have happened.

There is one case with no recording upstream to read a header off —
`src/github-live.test.ts`, which calls the real GitHub — and it does not skip
the control, it changes its shape: the endpoint answers 401 to an anonymous
caller, so a tool result carrying a pull request's *title* is data the request
did not carry and could only have come from an authenticated call. If you write
a case against a real upstream, find that assertion before you write the scan.

**The listing is a leak surface too, and the worse one.** A tool `description`
and `inputSchema` are upstream-authored text that enters the model's context on
every turn, so an upstream that reflects its `Authorization` into a description
leaks a credential repeatedly rather than once. Today the same scrub covers it —
the catalog walk goes through `callUpstream` like everything else — but that is
a property of the current code rather than a law, which is why
`src/exfiltration.test.ts` attacks the listing path separately from the
tool-result path, and re-runs the listing case with redaction gutted.

**One string appears in three places.** A channel id is the client certificate's
subject (`CN=channel:<id>`) and filename, the directory holding that channel's
sheet, and the `channelId` on the mention the stub delivers. Only the certificate
is authoritative — the proxy reads the channel from it and from nowhere else — so
a mismatch surfaces as `no_team_sheet` rather than as anything naming the real
cause. `CHANNEL_ID_PATTERN` in `@getlibero/schema` is the only constraint on the
id; `dev-certs.sh --channels` adds none.

**The model-facing tool name is the bare one.** A sheet naming one server
publishes `list_prs`, not `github__list_prs` — the flat name is chosen from the
server and tool alone, and only collides when two servers offer the same tool.
Script `calls("list_prs", …)`.

**An unlisted name never reaches the proxy.** The agent decodes a flat name to a
`(server, tool)` pair through a map built from the listing, so a name the listing
did not carry is refused client-side (`packages/agent/src/proxy/tools.ts`, the
`mapped === undefined` branch of `execute`): no `/v1/tools/call`, no audit row,
and the model gets *"`x` is not a tool this channel permits."* That is correct —
*"the proxy is not asked about a tool it never published"* — and it means a case
testing the **proxy's** enforcement has
to submit a call the listing *did* carry. Two ways: rewrite the channel's sheet
between the listing and the call (`rig.channelsRoot.write`, which the proxy
re-reads per call), or remove it entirely (`rig.channelsRoot.remove`). Scripting
a name nobody published tests the agent's map, which is a different claim.

**The refused-here half is asserted on the log, not the upstream.** Because
nothing is sent, `upstream` and `auditDb` are both silent, and a case proving
*"the attack was really attempted"* has only one surface: `agent.log()` carries a
`warn` line, `event: "tool_not_permitted"`, with the model's name in `tool` and
the task in `task` (#170). That is the only record of a call this system refused
before deciding it, and it is deliberately on the agent side — the proxy never
saw the call and rightly writes no row for it.

**Making the agent misbehave is a transport wrapper, not a config flag.** The
agent is the untrusted half, so a claim about what the proxy holds when it stops
cooperating should interfere with the wire rather than switch a mode nothing
deploys. `startRig({ spendReports: "dropped" })` swallows `/v1/spend` — which is
how #134's narrow claim gets made: `daily_tool_calls` is the proxy's own count
and must still bite when `daily_tokens` never moves. `spendReports: "replayed"`
is the opposite failure, every report sent twice, and the turn id is what makes
the second one a `duplicate` that moves nothing. `harness/transport.ts` has the
decorators; `wrapTransport` on `startAgent` takes any of your own.

**Size a budget off `TURN_TOKENS`, not off a number you counted.** A scripted
turn reports a fixed usage, and `daily_tokens: 2 * TURN_TOKENS` says "the third
call is over the line" in a way that survives someone changing what a turn
reports. `withUsage(turn, usage)` overrides it for the one case that needs a
turn to report cache tokens and nothing else. Both are in `harness/model.ts`.

**The operator's reset is spawned, not called.** `runBudgetCli(budgetDb,
["reset", CHANNEL])` runs the built `dist/budget.js` — the documented
`docker compose run --rm proxy node dist/budget.js reset <channel>` — against a
rig's meter, with the same built-from-nothing environment the proxy gets.
`resetChannel` from `@getlibero/proxy` would demonstrate the file-sharing half
and skip the entrypoint, the env contract, and the exit code. What the case is
really asserting is a claim about processes: the proxy has no admin route, so
a reset is a second process against the same file, and WAL plus an uncached
meter is what makes it land on the running proxy's next call.

**Driving a human's click needs three things, and the rig has all of them.**
`agent.slack.deliverMention` does not resolve while a call is held, so a case
holds the promise, waits for `approvalCardOf(agent)` to appear, and then delivers
a decision. The ticket id is the proxy's — read it off the `held` audit row it
wrote before it answered, which is also how a case can assert the button
carries that same id rather than one the agent invented. `agent.slack.cardAt`
is the card showing now, which is the assertion most cases want ("it is green,
and it names the approver").

**Use `approvalCardOf`, never `slack.cards[0]`.** Since #68 a tool-calling task
also posts a live checklist, so a thread that holds a call has two cards in it
and which one is first is a race — the checklist is posted from the loop and the
approval card from the tool client. `approvalCardOf` picks by the actions block,
which is exact rather than a heuristic: only the amber card draws buttons, and a
checklist has no interactive element in any state.

**Green now means the call ran** (#143). An approve repaints the card to an
uncoloured `running` face and it goes green only when the re-submission answers,
so a case asserting green is asserting an execution. An approved call the proxy
then refuses goes red and still names the approver.

**The approval clock is one-sided, and a case has to say which half it moved.**
`startRig({ scheduler })` reaches the approval prompter and nothing else
(`compose.ts` routes it there deliberately), so a manual scheduler's single
pending timer is the hold's deadline and firing it is the agent giving up on
its wait. It does not move the *proxy's* clock: `APPROVAL_TTL_MS` is a module
constant in a spawned process, so its ticket is still alive and a re-submission
comes back `approval_pending` rather than `approval_expired`. That is the right
thing to assert — abandoning a wait converts nothing — and the true timeout is
covered in `packages/proxy/src/approvals.test.ts` with an injected clock.

**`resubmission: { arguments }` is approve-then-mutate.** The client re-submits
the identical body plus the ticket, by design, so an agent that swaps the
arguments after a human has looked at them is a compromised one and lives on
the wire like the spend knobs. The proxy answers `approval_mismatch` on the
argument hash, and deliberately does not spend the ticket.

**A front-end with no card path is a real shape, not a test mode.**
`startRig({ approvals: "none" })` composes with no prompter, because
`SlackSurfaceLike.cards` is optional and its absence means "no one to ask". A
held call then degrades to the refusal-shaped result `tools.ts` documents:
audited as `held` by the proxy, never run, and relayed to the model. That is
#135's degraded-mode case, and the composition reads the absent card path rather
than posting into a stub that swallows it.

`src/harness-knobs.test.ts` pins both, so a case built on either is testing the
property it means to rather than a seam that quietly did nothing.

**You can break the proxy on purpose, and you should.** A leak test that has
never seen a leak is a test that passes. `breakRedaction(cleanup)` writes a
module loader hook, and `startRig({ nodeArgs: ["--import", hook] })` registers it
inside the spawned proxy, where it rewrites `redactSecrets` into the identity
function as Node loads it. Combined with `upstream: { echoHeaders: "text" }` —
which makes the upstream reflect its `Authorization` header into the tool
result — that is a real, complete leak: the credential lands verbatim in the
model's transcript.

`src/redaction-detector.test.ts` runs that scenario twice, as shipped and
gutted, and requires `expectNoCanary` to pass the first and **throw** the
second. It is the answer to "would this suite notice?", which no negative
assertion can answer about itself.

A loader hook rather than a stub because the proxy is a separate process and its
imports are ESM bindings — nothing in the test process can reach them, and the
launch is the only seam there is. It patches compiled output, so the hook throws
if its needle no longer matches; a mutation that silently applied to nothing
would be the exact failure it exists to prevent.

**Some attacks cannot go through the agent at all.** `createProxyToolClient`
sends no `channel` field and cannot be made to — `ToolCall` is strict, so a body
carrying one is refused by the proxy rather than stripped — and it will only
present the certificate matching the channel it was asked for. A case attacking
identity resolution has to be its own client: `rawClient({ url: rig.proxy.url,
certs: rig.certs })`, then `send({ method, path, as, body, headers })`. `as` is
the certificate to present, by the name `dev-certs.sh` wrote it under — a
channel id from `channels`, or the label half of a `startRig({ rawCns })` entry,
which is how a certificate claims something the CA never meant. `path` carries
its own query string and `body` is serialized verbatim as `unknown`, because a
client that could only send well-formed calls could not attack the parser. That
is the only way to put a header, a query parameter, and a body field in
disagreement with a certificate and watch the certificate win.
`src/identity.test.ts` is the worked example.

The trust anchor is not one of the knobs. The CA the *server* is verified
against is always the rig's, whichever client certificate is being presented;
swap both and the case fails at its own end of the handshake, proving nothing.

**A model that answers with what it was handed is `relays()`.** A script entry
is normally a constant — `calls`, `says` — and may instead be a function of the
`CompletionRequest` that provoked it (`ScriptTurn`). `relays()` is the one such
entry that exists: it answers with every tool message in the request, so a
compromised model posts its whole tool result into the channel. Use it when the
thread reply has to be a real surface for the canary scan rather than a fixed
string the case wrote. A computed turn is resolved *after* `onModelTurn` fires,
so it sees whatever that hook changed.

**A side effect that has to land mid-task goes on the model, not the upstream.**
`startRig({ onModelTurn })` fires as the model is asked for each turn, and the
loop lists tools once before its first turn — so a hook on turn 1 is provably
after the listing was built and before the call it provokes is submitted. That
is the ordering the one case needs that rewrites a team sheet between them
(`src/unlisted-tool.test.ts`), and it is how the proxy's own gate gets handed a
call the listing really did carry.

Hooking the upstream's `respond` instead looks equivalent and is not: it also
fires for `server/discover`, and the catalog is cached per upstream for five
minutes, so whether a later task asks the upstream anything at all stops being
the case's to decide.

**Assert on the proxy's log through `proxy.waitForLog`, never `proxy.log()`.** A
log line and the response it accompanies cross two different pipes. The proxy
writes `identity_rejected` before it sends the 401, but the two arrive here in
whatever order the kernel delivers them, so a case that reads `log()` the moment
its request settles is a coin flip — and some lines have no response at all to
be ordered against, since `tls_client_rejected` fires on a socket event.
`waitForLog({ event, reason })` matches on the fields given and resolves with the
parsed line. `log()` stays for the canary scan, which reads everything and races
nothing.

**Everything runs on real time.** The loop's wall clock is `AbortSignal.timeout`,
which no fake timer can drive, so there is no `vi.useFakeTimers()` anywhere here.
Vitest's defaults (5 s per test, 10 s per hook) are too short for certificate
minting plus a spawn, so pass timeouts explicitly — `beforeAll(fn, 60_000)`,
`it(name, fn, 30_000)`. Use the sheet's `max_task_seconds` to bound a hang, so it
fails as a cap with a stop reason rather than as a bare vitest timeout.

**The model's transcript now carries channel history, and that is a canary
surface.** Since #67 a task is seeded with the channel's recent messages rather
than the mention alone, so anything stored in a channel reaches the model on the
next mention. `expectNoCanary(surfaces())` already reads the transcript, and it
now has something in it. `startRig({ users })` seeds the directory those
messages are attributed by; an author with no entry renders as their id, which
is a real state rather than a gap.

**The message store is written by the agent side and read by both, and it has no
helper.** `rig.storeRoot` is one `<channel>/store.db` per channel that has a
sheet, written by the composition as an ordinary `message` arrives on
`agent.slack.deliverMessage`. There is deliberately no `messagesIn` beside
`auditRows` and `spendFor` — open the file with your own `node:sqlite` handle.
Reading it through `@getlibero/memory` would prove the writer and the reader
agree about a schema, which is a weaker claim than the row being in the file,
and the whole reason a case reaches for it is the one-file-per-channel boundary.

Since #64 the rig passes the same directory to the spawned proxy as
`PROXY_STORE_ROOT`, which is what makes `src/channel-history.test.ts` a real
two-process claim: the agent writes a message and a *separate* process reads it
back to answer `search_channel_history`. Grant it with `builtins` on a sheet
spec; omit the field and the channel does not have the tool, which is the
refusal fixture.

**A `search_channel_history` assertion has to be narrowed to the tool result.**
The seeded turn already carries a `<channel-history>` block of the channel's
recent messages (#67), so `expect(JSON.stringify(model.seen)).toContain(…)` is
answered by the context assembler rather than by the tool, and a negative is
answered by it too. `channel-history.test.ts`'s `toolResults` helper is the
narrowing. It is also the honest account of what the built-in adds: the
assembler seeds the last few messages, and the tool reaches the rest.

It is a **separate root from the sheets**, exactly as in production, and that is
what makes "nothing was written to `channelsRoot`" assertable. The channels
directory is where the proxy reads its authorization from; an agent able to
write there could rewrite a `channel.toml` and widen its own channel.

**Read the databases while the proxy is still running.** Both are WAL with
`synchronous = FULL`, so a row the proxy acknowledged is on disk and visible to
another process. Nothing has to be torn down before an assertion. The audit table
is append-only by trigger and nothing can truncate it, so a file shared by several
cases is read forward with `lastAuditId` as a cursor.

**Teardown is a stack, not an `afterAll` body.** `startRig` registers every
resource as it acquires one, so a setup that dies half-way still brings down what
it had. Always `await rig.stop()` in `afterAll`; a crashed worker is covered
separately by a `process.on("exit")` SIGKILL, so a proxy holding a vault cannot
outlive the run.

## Layout

- `src/harness/rig.ts` — `startRig`, and the ordering constraint that governs it.
- `src/harness/proxy-process.ts` — spawn, readiness by log line, SIGTERM/SIGKILL.
- `src/harness/agent.ts` — the production composition over the two fakes.
- `src/harness/canary.ts` — the planted secret and the surface scan.
- `src/harness/certs.ts` · `channels.ts` · `vault.ts` — the material the proxy reads.
- `src/harness/upstream.ts` — the recording MCP server.
- `src/harness/model.ts` — the scripted `CompletionClient`.
- `src/harness/client.ts` — the attacker's own mutual-TLS client.
- `src/harness/records.ts` — reading the audit log and the meter back.
- `src/harness/budget-cli.ts` — the operator's `budget` entrypoint, spawned.
- `src/harness/cleanup.ts` — the teardown stack.
- `src/smoke.test.ts` — the rig proving itself.
- `src/exfiltration.test.ts` — #132, over both paths a credential could come
  back on: a tool result and a tool description.
- `src/exceed-budget.test.ts` — #134, both meters at their boundary, and the
  operator's reset against a running proxy.
- `src/destructive-call.test.ts` — #135, the approval broker's two halves
  meeting: a click that runs a call, and four ways of not having one.
- `src/unlisted-tool.test.ts` · `src/identity.test.ts` — #133, through the agent
  and around it.
- `src/message-intake.test.ts` — #176, the one claim `apps/server`'s own
  acceptance suite cannot make: two real channels, two real files, and nothing
  written into the proxy's authorization source.
- `src/context.test.ts` — #67, the same shape: `[llm] max_history_messages`
  followed out of a real `channel.toml`, through the shipped schema and
  resolver, into the prompt.

## What is enforced rather than asserted

An ESLint block on `e2e/**` bans `@slack/*`, the provider SDKs, and
`createCompletionClient` — the last because it is re-exported from
`@getlibero/agent` and would otherwise build a real provider client without
naming an SDK. "No Slack and no live model" is a rule here, not a habit.

The agent/proxy import ban deliberately does **not** apply. This is the one
package that legitimately composes both sides, which is also why
`scripts/boundary-check.sh` does not scan it.
