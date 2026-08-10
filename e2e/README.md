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
import { CHANNEL, auditRows, calls, expectNoCanary, says, spendFor, startRig } from "./harness/index.js";

const rig = await startRig({
  sheets: { [CHANNEL]: { credential: "e2e_canary", tools: [{ name: "list_prs", approval: "none" }] } },
  script: [calls("list_prs", { repo: "x" }), says("Two are open.")]
});

await rig.agent.slack.deliverMention({ channelId: CHANNEL, /* … */ });

expect(rig.agent.slack.posted).toHaveLength(1);
expect(auditRows(rig.auditDb)[0]).toMatchObject({ outcome: "ran" });
expectNoCanary(rig.surfaces());
await rig.stop();
```

`startRig` is the whole API; `src/smoke.test.ts` is the worked example. Everything
it returns — `agent`, `proxy`, `upstream`, `model`, `channelsRoot`, `auditDb`,
`budgetDb` — is there so a case can assert without reaching into rig internals.
If you find yourself needing one, add it to the rig rather than rebuilding a
piece of it.

## Things that will cost you an afternoon otherwise

**The positive control is not optional.** Every "the credential did not leak"
assertion also passes on a run where no credential was ever resolved — which is
the one failure a leak suite must never report as a pass. Assert that the canary
*did* arrive at the upstream as `Bearer <canary>`, then assert it reached nothing
else. `src/smoke.test.ts` does both, in that order.

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
did not carry is refused client-side: no `/v1/tools/call`, no audit row, and the
model gets *"`x` is not a tool this channel permits."* That is correct, and it
means a case testing the **proxy's** enforcement has to submit a call the listing
*did* carry — change the sheet between the listing and the call, or remove the
channel's sheet mid-task, rather than simply scripting a name nobody published.

**Everything runs on real time.** The loop's wall clock is `AbortSignal.timeout`,
which no fake timer can drive, so there is no `vi.useFakeTimers()` anywhere here.
Vitest's defaults (5 s per test, 10 s per hook) are too short for certificate
minting plus a spawn, so pass timeouts explicitly — `beforeAll(fn, 60_000)`,
`it(name, fn, 30_000)`. Use the sheet's `max_task_seconds` to bound a hang, so it
fails as a cap with a stop reason rather than as a bare vitest timeout.

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
- `src/harness/records.ts` — reading the audit log and the meter back.
- `src/harness/cleanup.ts` — the teardown stack.
- `src/smoke.test.ts` — the rig proving itself.

## What is enforced rather than asserted

An ESLint block on `e2e/**` bans `@slack/*`, the provider SDKs, and
`createCompletionClient` — the last because it is re-exported from
`@getlibero/agent` and would otherwise build a real provider client without
naming an SDK. "No Slack and no live model" is a rule here, not a habit.

The agent/proxy import ban deliberately does **not** apply. This is the one
package that legitimately composes both sides, which is also why
`scripts/boundary-check.sh` does not scan it.
