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
That material is cached under `node_modules/.cache/libero-e2e-certs`, keyed on
the request and on the script's own contents, because eighty-one of this suite's
calls ask for exactly the same thing and each one is five RSA keys.
`src/harness/cert-cache.ts` argues it, including why a rotation is never served
from the cache. Deleting the directory costs time and nothing else.

**One file needs a Docker daemon**, and only one: `sandbox-attack.test.ts`, which
is #396's half of the code-execution sandbox. Everything else runs on a machine
that has none. That file's gate is two-sided and deliberately asymmetric — no
daemon and not CI skips it, no daemon and `CI=true` fails at import — because CI
has one and quietly reporting green on a security acceptance is the thing this
repository's "a test that encodes a gap" rule forbids. The gate is probed
synchronously at module load: `describe.skipIf` is evaluated at collection, so a
flag set in a `beforeAll` is still false when the decision is made.

It builds the runner's image if it is absent and leaves a `libero-e2e-egress`
network behind, which holds nothing and is reused. The sandbox half that needs no
daemon — a channel that never granted the built-in, and a deployment with no
runner — is `sandbox-grant.test.ts`, so the strongest claim about the feature is
checked everywhere.

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
LIBERO_GITHUB_PAT=… pnpm --filter @getlibero/e2e exec node --test dist/github-live.test.js
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

**And every sheet the harness writes pins the certificate the rig minted for
that channel** (#79), so a case that says nothing about pinning gets the identity
it would have had before the field existed. A case that is about pinning sets
`SheetSpec.pins` — `certs.fingerprint(label)` is the digest of any minted
certificate, and `certs.rotate` / `certs.promote` drive the real script.
`src/certificate-pinning.test.ts` is the worked example: a second certificate
minted through `rawCns` with the *same* CN is the leaked key, and pinning one of
the two is what tells them apart.

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
holds the promise, `await waitForApprovalCard(agent)` for the card, and then
delivers a decision. The ticket id is the proxy's — read it off the `held` audit row it
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

**And `waitForApprovalCard` to reach it the first time**, because the card is not
there when the mention is delivered — the model has to call, the proxy has to
mint a ticket and write its `held` row, and the tool client has to post. It
returns the card, so a case binds it rather than reading it twice, and it throws
with what the thread actually held rather than leaving a bare
`expected undefined to be defined`. `approvalCardOf` on its own is for reading
the card *again* after a decision, where nothing is being waited for.

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
which no fake timer can drive, so no case here installs `mock.timers`.
`src/harness-shape.test.ts` greps for that, and for vitest's old spelling beside
it, because a fake clock is not visible in an assertion.

**Every wait says how long it will wait.** `node:test` has no default timeout at
all, so a case that passes none can hang a CI job rather than failing it — keep
passing them, in the form the runner takes: `beforeAll(fn, { timeout: SETUP_MS })`
and `it(name, { timeout: CASE_MS }, fn)`. The three defaults vitest had are gone
with it, including the 1 s on `vi.waitFor` that #329 was: waiting here is the
harness's, through `proxy.waitForLog`, `agent.waitForLog` and
`waitForApprovalCard`, which all default to ten seconds and all say what they
were waiting for when they give up. Where something more general is needed,
`@getlibero/test-kit`'s `waitFor` takes its timeout as a required argument, so
the shape of #329 is a type error now rather than a grep. Use the sheet's
`max_task_seconds` to bound a hang inside a task, so it fails as a cap with a
stop reason rather than as a bare runner timeout.

**The model's transcript now carries channel history, and that is a canary
surface.** Since #67 a task is seeded with the channel's recent messages rather
than the mention alone, so anything stored in a channel reaches the model on the
next mention. `expectNoCanary(surfaces())` already reads the transcript, and it
now has something in it. `startRig({ users })` seeds the directory those
messages are attributed by; an author with no entry renders as their id, which
is a real state rather than a gap.

**`[skills]` is off in every sheet this harness writes too, and for a stronger
version of curation's reason.** The schema prefaults `[skills] enabled = true`,
so a sheet that said nothing would give every case here a reconcile and a
retrieval at the head of every task — and, above the threshold, an author turn,
which is a model turn that consumes the next script entry. `channels.ts` writes
`enabled = false` unless a `SheetSpec.skills` says otherwise. `authorAfterToolCalls`
is on that spec because the default of five would make a case about the write
half script six served calls to reach it; the schema's floor is `1` and the
comparison is strictly greater, so `1` means "two served calls".

**No embedding client is wired unless a case asks for one, so skill retrieval
runs on full text alone.** That is a real deployment rather than a gap — the team
sheet names it the behaviour for a process with no embedding provider — and it is
what three of the four background passes degrade to: the sweep writes a summary
with no vector, the embedding pass returns before it reads a sheet, and the
curator proposes nothing, because overlap is a question about two vectors and,
unlike retrieval, there is no lexical answer to fall back on. The consequence for
a retrieval case is unchanged: **word the question to share vocabulary with the
skill it should reach**, or the arrival assertion fails for a reason that has
nothing to do with what is under test.

**`startRig({ embedding: "constant" })` is the one fake there is, and its shape is
the whole of why it is allowed.** The original refusal ran two arguments
together. *A second live provider the ESLint block exists to keep out* — true, and
a fake answers that rather than being an instance of it; `createEmbeddingClient`
now sits beside `createCompletionClient` in that block, so reaching for the real
one is a lint error. *A hand-built vector space between an attack and the thing
it attacks* — true only of a fake that **ranks**, and this one answers the same
vector for every text. It is an observation point, exactly as the fake upstream
is for tool calls: what a case reads is `rig.embeddings.texts()`.

So there is a rule that comes with it. **No case may assert that retrieval
reached a skill through the vector leg**, because with one constant vector every
skill is equidistant from every query and `nearest` answers in an order nothing
here chose. What the fake exists for is one claim that cannot be made without it:
the embedding pass bounds itself to *the description and never the body*, a skill
body is where a credential ends up when a failed call's text is written into a
playbook, and `texts()` is where "a playbook's body never left this process" is
checkable — with the description's arrival as the positive control that comes
first.

**A case that needs a vector to exist plants one.** `deletion-derived.test.ts`'s
rule and its argument: wiring a pass and a provider to arrive at a row the test
could have written directly is machinery, not coverage.
`store.putEmbedding({ source: { kind: "skill", ref: name }, … })` through a second
`openMessageStore` handle is how the curator's pair is nominated. Plant exactly
two — the nomination is a *mutual* nearest pair, which two skills satisfy
trivially and three make depend on arithmetic the case did not choose.

**The author turn is post-reply, exactly like curation.** `deliverMention`
resolves while it is still to run, so an assertion about a skill file has to wait
on `agent.waitForLog({ event: "authored" }, N)` first. Same counting rule, same
reason.

**The four background passes are opt-in, one per case, and they have their own
clock.** `startRig({ passes: ["lifecycleSkills"], passClock })` composes exactly
what it names and nothing else — which is why every file written before #308
still passes untouched. They fire from the message ingest on an ordinary
`deliverMessage`, **never on `deliverMention`**, queue on one session mutex in
`ingest.ts`'s order, and none is awaited by the delivery, so every assertion goes
behind a counted `agent.waitForLog`. The event words are `summarized`,
`skills_embedded`, `skills_adopted` / `skills_marked_stale` / `skills_archived`,
and `skill_merge_proposed`.

**Name only the pass under test.** Four wired at once is four writers to one
directory, and a case's assertion behind three of them.

**`passClock` is real time plus an offset, moving forward only.** It reaches the
passes and nothing else — not the loop's `AbortSignal.timeout`, which no clock
here fakes, so "everything runs on real time" is unchanged. Start it at
`Date.now()` and only add: the ingest stamps `at` and retrieval stamps
`last_used_at` on the real clock, and a lifecycle threshold compares against
both, so a clock set to a fiction makes every stamp look like the future. Step
over the interval you mean **by name** — `SWEEP_INTERVAL_MS`,
`LIFECYCLE_INTERVAL_MS`, `CURATE_INTERVAL_MS` — rather than by a literal nobody
can check. A `passClock` or an `embedding` with no `passes` throws at
`startRig`, because a knob that silently does nothing is worse than one that is
missing.

**Ambient is a separate switch, and it is off twice** (#321).
`startRig({ ambient: true, passClock })` composes the clock, the channel
enumerator and the heartbeat — and a channel still gets nothing until its sheet
says `[ambient] enabled = true`. The two are not redundant: the first keeps every
case written before this composing what it composed before, and the second is
what makes "a channel that never opted in sees nothing" assertable, since only a
rig with the wiring present can show that the *sheet* is what withheld it.
`passClock` reaches the heartbeat and the rate window alike when `ambient` is
set, so a case stepping past `HEARTBEAT_POST_WINDOW_MS` is stepping past a window
that can see it.

**Fire one with `rig.heartbeat(at)`, which scans twice.** Nothing starts a
timer — `AmbientScheduler.scan` is documented as the whole of the scheduler's
behaviour so a test drives it — and the first scan of a channel **never fires**,
because a channel newly seen enabled is scheduled at `now + cadence`. So the
helper does the sighting scan for you and then the real one at `at`, and answers
how many channels fired. The event words are `heartbeat_posted`,
`heartbeat_silent`, `heartbeat_deferred`, `heartbeat_unusable` and
`heartbeat_failed`; a post lands in `agent.slack.channelPosts`, which is its own
array precisely so a case cannot mistake one for a reply.

**Fire a due scheduled check with `rig.check(at)`, which scans once.** The same
scan, counting the other kind of due thing — and one scan rather than two,
because a ticket has no first-sight rule. A heartbeat's deadline is invented by
the scheduler and cannot already have passed; a ticket's instant is on disk
before the scan starts, so the first scan past it fires. At most one per channel
per scan, earliest first. The event words are `check_posted`, `check_silent`,
`check_declined`, `check_failed` and `check_unposted`, plus `ambient_check_due`
from the clock.

**Do not scan at exactly the instant you asked for.** A ticket's due time is the
*proxy's* clock at the moment the create was served, which is your `at` plus
however long the rig took to start — so a case proving a check fired should scan
generously past it, and only the case proving it does **not** fire early should
scan tight. Both halves are in `schedule-task.test.ts`'s positive control, and
that pairing is what makes it demonstrably able to fail.

**A built-in the sheet omits never reaches the proxy.** It is not published to the
model, so the flat name maps to nothing and the client refuses locally: the audit
log stays empty and the refusal shows up as a `tool_not_permitted` line on the
agent's side. A case asserting "unlisted is refused" for a built-in that asserts
on an audit row is asserting the wrong thing.

**`max_tool_calls_per_task` defaults to 5 in a harness sheet**, which is below
several of the bounds a case might want to reach — the pending cap among them. A
case about a different bound has to raise it, or it silently tests the loop's.

**The lifecycle job's first run on a file writes nothing.** It adopts what the
file says as its baseline, which is what makes a hand-set status survive — so a
case that wants a status moved needs two runs, and the second has to clear
**both** the pass's interval and the sheet's stale clock. Clearing only one is a
silent no-op.

**A message that triggers a sweep is also a thread that sweep can see.**
`staleThreads` has no minimum message count, so a trigger message with an old
`ts` gets summarized alongside the thread you meant — and `MAX_THREADS_PER_SWEEP`
is three, so that is three script entries rather than one. Compute timestamps
from the pass clock with `toSlackTs`: old for what should be summarized, fresh
for the trigger.

**A background pass that throws is swallowed.** `ingest.ts` fires each as
`void session.mutex.run(…).catch(() => {})`, and every pass catches its own
failures and logs a `*_failed` word. So a script that ran out inside a pass does
**not** fail with "the model was asked for turn N" — it fails ten seconds later
as a `waitForLog` timeout on an event that never came, pointing at the wrong
thing. Assert that `summary_failed`, `summary_unusable`, `skill_embed_failed`,
`skills_lifecycle_failed`, `skill_merge_failed` and `skill_reconcile_failed` are
absent before looking anywhere else.

**A pass's tokens land on the proxy's meter.** The rig builds the same
`reportTurn` `index.ts` does, over the same transport, so `spendFor(budgetDb,
CHANNEL)` is where a sweep's or a curator's spend shows up — which is the whole
reason these cases are worth running here rather than in `apps/server`. Give each
turn a distinctive `withUsage` so the number identifies itself.

**A task's opening context is not `model.seen[n]`.** Dropping the author turns by
`system === SKILL_AUTHOR_SYSTEM_PROMPT` leaves every *turn* of every task, and a
tool-heavy task has several — so "the second task" is not the second entry.
`memory-curation.test.ts` gets away with indexing because each of its tasks is a
single turn; a skills case does not. Filter to the turns seeded with exactly one
message: `assembleContext` returns one `user` message however much it packed into
it, and every later turn of the same task carries the transcript grown from it.
`openingContexts` in `harness/model.ts` is that filter. **Its first half is a
named set, not one prompt**, and it has to gain a member whenever the composition
grows a turn nobody asked for: the author turn, the curation turn, the
summarization turn and the merge turn all seed exactly one message, so a filter
that named only one of them would silently count the others as tasks and put
every index after them off by one.

**A `respond` hook must envelope its result.** `completeResult` (and
`completeListResult` for a catalog) adds the `resultType` the 2026-07-28
revision made mandatory, and a real client refuses a result without it. A
hand-built object fails as *"the tool server's answer could not be read as
MCP"* — on **every** call the hook let through, not only the one being poisoned,
which reads like the fall-through is broken rather than like the envelope is
missing.

**Curation, summarization and merge curation are all off in every sheet this
harness writes, and turning one on is a case's own decision.** The schema prefaults `[memory] enabled = true`, so a
sheet that said nothing would give every case in this suite a curation turn —
and a curation turn is a model turn, which consumes the next entry of a script
written before curation existed. Files would fail with "the model was asked for
turn N; the script has N", and the ones that did not would be asserting against
a transcript with an extra call in it. So `channels.ts` writes `enabled = false`
unless a `SheetSpec` says otherwise, for the reason `dailyUsd` is absent by
default: the value a fixture takes should be the one that leaves every other
case as it was.

**`[memory] summarize` and `[skills] curate` are written out too, and they are
the pair that would have bitten silently.** The sweep gates on `summarize` and
**not** on `enabled`; the curator gates on `enabled && curate`. Both prefault
`true`, so before #308 every sheet this harness wrote already carried
`summarize = true` — invisible only because no sweep was composed. The moment one
was, `staleThreads` has no minimum message count and every fixture `ts` here is
months in the past, so four files would have got up to three summarization turns
each, three of them against one-entry scripts. `channels.ts` now writes both
`false` unless a case asks.

**A curation turn is not finished when the mention that started it is.** It is
enqueued on the session's queue behind the reply and deliberately not awaited
(#227), so `deliverMention` resolves while the write is still to happen. Waiting
on the agent's own line is what makes an assertion about the file a real one:
`await agent.waitForLog({ event: "curated" }, 2)`. It counts, unlike the proxy's
`waitForLog`, because curation happens once per task and a case asserting after
its second mention has to say which turn it means.

**The message store is written by the agent side and read by both, and it has no
helper.** `rig.storeRoot` is one `<channel>/store.db` per channel that has a
sheet, written by the composition as an ordinary `message` arrives on
`agent.slack.deliverMessage`. There is deliberately no `messagesIn` beside
`auditRows` and `spendFor` — open the file with your own `node:sqlite` handle.
Reading it through `@getlibero/memory` would prove the writer and the reader
agree about a schema, which is a weaker claim than the row being in the file,
and the whole reason a case reaches for it is the one-file-per-channel boundary.

A channel's curated `MEMORY.md` is in that same directory and is read the same
way — `readFileSync` on `<storeRoot>/<channel>/MEMORY.md`, not through
`@getlibero/memory`, for the reason above.

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
- `src/harness/model.ts` — the scripted `CompletionClient`, and
  `openingContexts`.
- `src/harness/embedding.ts` — the constant fake embedder, and the rule it
  carries.
- `src/harness/ambient.ts` — the clock, the enumerator, the heartbeat and the
  fire path, when a
  case asks. `passes.ts`'s shape, and it shares that file's `meteringClosures` so
  a background turn and a heartbeat are metered by one pair of closures over the
  wrapped transport, exactly as `index.ts` shares them.
- `src/harness/passes.ts` — the four background passes, mirroring
  `apps/server/src/index.ts` rather than restating it.
- `src/harness/client.ts` — the attacker's own mutual-TLS client.
- `src/harness/records.ts` — reading the audit log and the meter back.
- `src/harness/budget-cli.ts` — the operator's `budget` entrypoint, spawned.
- `src/harness/audit-cli.ts` — the operator's `audit` entrypoint, spawned, and
  the header says why spawning is the point rather than a detail.
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
- `src/memory-curation.test.ts` — #228, the curation write path: the cap and the
  malformed operations refused with the file provably unchanged, the curation
  turn's own tokens on the proxy's meter, and the one case here that documents
  an exposure rather than a defence.
- `src/summary-sweep.test.ts` — #308/#231, the quiescence sweep: a quiet thread
  summarized into the channel's own file with no vector behind it, charged to
  the proxy's meter from a call nobody asked for; and a summarization turn
  reaching for a proxied tool reaching no upstream and no audit row. The other
  half of `deletion-derived.test.ts`, which plants what this writes.
- `src/skill-maintenance.test.ts` — #308/#305/#294/#295, the background half of
  the skill layer: the embedding pass sending descriptions and provably never a
  body; the lifecycle job writing nothing on first sight and then moving exactly
  one line, leaving a hand-archived playbook alone; and the curator writing a
  proposal beside the skills, rewriting none of them, and never reading it back
  into a later task.
- `src/skill-poisoning.test.ts` — #293, the skill layer: a skill authored,
  landed on the split roots and provably arriving in a later task's opening
  context; the write path's traversal and oversize attempts leaving the
  filesystem untouched; a planted hostile skill changing nothing about what the
  channel may do, refused at both gates — the agent's name map and the proxy's
  approval hold, the second with the audit row to show for it; and the surface
  this suite had not met, a skill as a *persistent* place a credential could come
  to rest, attacked over both the elided path and the kept one.
- `src/audit.test.ts` — #98, the read path: three real lifecycles driven through
  the rig and then found again by the spawned `dist/audit.js`, which is the only
  place the *connection* can be shown — a second process opening the log
  read-only while the proxy still holds it open for writing.
- `src/audit-tamper.test.ts` — #356, the chain: a governed run leaving a log
  `verify` passes, the triggers refusing the very edits the attack then makes
  with them dropped, a rewritten row and a deleted one each named by id, and the
  limit stated as a case rather than only as a paragraph — a truncated tail
  verifies clean, and only the tip says otherwise. Every attack runs against its
  own `VACUUM INTO` copy, because `verify` names the first break and stops, so a
  shared file would make each case assert about the damage the one before it did.
- `src/deletion-derived.test.ts` — #233, Slack retention reaching derived data:
  a real `message_deleted`, `message_changed` and tombstone event through the
  gateway, each taking the thread's summary and that summary's embedding with
  it, and each with the positive control first. It also found the gap that made
  it necessary — the rig was never passing `onRevision` to `createGateway`, so
  every deletion and edit this suite ever delivered went nowhere and nothing
  failed. #177 shipped that path in phase 1 and no case here had exercised it.

## What is enforced rather than asserted

An ESLint block on `e2e/**` bans `@slack/*`, the provider SDKs, and
`createCompletionClient` — the last because it is re-exported from
`@getlibero/agent` and would otherwise build a real provider client without
naming an SDK. "No Slack and no live model" is a rule here, not a habit.

The agent/proxy import ban deliberately does **not** apply. This is the one
package that legitimately composes both sides, which is also why
`scripts/boundary-check.sh` does not scan it.
