// A hostile authorization server, against the spawned proxy (#258).
//
// The issue's fourth case: a token endpoint that hangs, 500s, or answers with
// something that is not a token produces `unavailable` within the call's
// budget — never a refusal, because nothing was denied, and never a wedged
// pool, because a failed mint is not memoized and the next call after the
// issuer recovers is served by the same process.
//
// One rig serves every case, in order. That is safe here for the reason the
// engine's contract states: a mint failure is never cached, so each case's
// attempt is real, and the recovery case at the end is itself the "not
// wedged" proof. Two knobs make the attacks reach the wire at all:
//
// - `upstreamTimeoutMs: 2_000` — the deployment budget the hang case is
//   about. Its elapsed-time bound doubles as the check that the knob threaded:
//   were `PROXY_UPSTREAM_TIMEOUT_MS` silently dropped, the hang would cost the
//   package's thirty seconds and fail the bound.
// - `expiresInSeconds: 1` — dead on arrival against the engine's thirty-second
//   margin, so every call mints fresh and meets the hook. A token living the
//   default hour would be minted once in the warm-up and never again, and
//   every hostile case would assert against a hook nothing consulted.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CHANNEL,
  OAUTH_CREDENTIAL,
  REFRESH_CANARY,
  auditRows,
  calls,
  createCleanup,
  expectNoSecret,
  expectSecretReachedUpstream,
  lastAuditId,
  relays,
  rigOf,
  says,
  startIssuer,
  startRig,
  surface
} from "./harness/index.js";
import type { Cleanup, Rig } from "./harness/index.js";
import type { FakeTokenIssuer } from "@getlibero/proxy";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/** What the channel reads when no token could be minted — server.ts's sentence. */
const MINT_FAILED_SENTENCE = "no live access token could be minted for its upstream";

/**
 * Five tasks: a clean warm-up (which also fills the pool's catalog cache, so
 * the hostile tasks' listings never dial the upstream and each case's one mint
 * is its tool call's), three attacks whose model relays the tool error into
 * the thread, and the recovery.
 */
const SCRIPT = [
  calls("list_prs", { repo: "getlibero/libero" }),
  says("Warm."),
  calls("list_prs", { repo: "getlibero/libero" }, "call-2"),
  relays(),
  calls("list_prs", { repo: "getlibero/libero" }, "call-3"),
  relays(),
  calls("list_prs", { repo: "getlibero/libero" }, "call-4"),
  relays(),
  calls("list_prs", { repo: "getlibero/libero" }, "call-5"),
  says("Recovered.")
];

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

let rig: Rig | undefined;
let issuer: FakeTokenIssuer | undefined;
let cleanup: Cleanup | undefined;

beforeAll(async () => {
  cleanup = createCleanup();
  issuer = await startIssuer(cleanup, { refreshToken: REFRESH_CANARY, expiresInSeconds: 1 });
  rig = await startRig({
    upstreamTimeoutMs: 2_000,
    sheets: {
      [CHANNEL]: {
        credential: OAUTH_CREDENTIAL,
        auth: { issuer: issuer.url, scopes: ["mcp.read"] },
        tools: [{ name: "list_prs", approval: "none" }]
      }
    },
    grants: { [OAUTH_CREDENTIAL]: { issuer: issuer.url, refreshToken: REFRESH_CANARY } },
    script: SCRIPT
  });
}, SETUP_MS);

afterAll(async () => {
  await rig?.stop();
  await cleanup?.drain();
}, SETUP_MS);

it(
  "the path works before the attacks",
  async () => {
    const { agent, upstream } = rigOf(rig);
    const as = issuer as FakeTokenIssuer;
    await agent.slack.deliverMention(mention("Ev00000070"));

    // The warm-up is the file's positive control: with the same grant, sheet
    // and issuer, a call is served — so a hostile case's failure below is the
    // hook's doing and not the fixture's.
    expectSecretReachedUpstream(upstream, as.accessTokens.at(-1) as string, "the access token");
    expect(agent.slack.posted.at(-1)).toMatchObject({ text: "Warm." });
  },
  CASE_MS
);

/** One hostile shape, asserted the same way each time. */
function attacked(
  name: string,
  eventId: string,
  respond: NonNullable<FakeTokenIssuer["respondToken"]>,
  reason: string
): void {
  it(
    name,
    async () => {
      const { agent, upstream, auditDb } = rigOf(rig);
      const as = issuer as FakeTokenIssuer;
      const callsBefore = upstream.callsTo("tools/call").length;
      const auditBefore = lastAuditId(auditDb);
      as.respondToken = respond;

      const started = Date.now();
      await agent.slack.deliverMention(mention(eventId));
      // "Within the call's budget": the deployment timeout is 2s, so a task
      // that took the package's default thirty would fail here — which is also
      // what detects PROXY_UPSTREAM_TIMEOUT_MS silently not threading.
      expect(Date.now() - started).toBeLessThan(10_000);

      // The precise failure is a log claim, made through the log's own pipe.
      // The audit row is the single word `unavailable` for all of them.
      await rigOf(rig).proxy.waitForLog({ event: "token_mint_failed", credential: OAUTH_CREDENTIAL, reason });
      await rigOf(rig).proxy.waitForLog({ event: "dispatch_grant_unavailable", credential: OAUTH_CREDENTIAL, reason });
      const rows = auditRows(auditDb, auditBefore);
      expect(rows.map(row => row.outcome)).toEqual(["unavailable"]);

      // A failure, never a refusal — nothing was denied — and the sentence the
      // channel read says what to do about it.
      const reply = agent.slack.posted.at(-1)?.text ?? "";
      expect(reply).toContain(MINT_FAILED_SENTENCE);
      expect(reply).not.toContain("not permitted");

      // Failed before connecting: no bare call reached the upstream.
      expect(upstream.callsTo("tools/call")).toHaveLength(callsBefore);
    },
    CASE_MS
  );
}

attacked("a hanging token endpoint is unavailable within the budget", "Ev00000071", () => ({ hang: true }), "timed_out");

attacked(
  "a 500ing token endpoint is unavailable, not a refusal",
  "Ev00000072",
  () => ({ status: 500, body: { error: "server_error" } }),
  "exchange_failed"
);

attacked(
  "a non-token body is unavailable",
  "Ev00000073",
  () => ({ body: "not a token {" }),
  "malformed_token_response"
);

it(
  "the pool is not wedged: the next call after the issuer recovers is served",
  async () => {
    const { agent, upstream, auditDb, surfaces } = rigOf(rig);
    const as = issuer as FakeTokenIssuer;
    const auditBefore = lastAuditId(auditDb);
    as.respondToken = undefined;

    await agent.slack.deliverMention(mention("Ev00000074"));

    expectSecretReachedUpstream(upstream, as.accessTokens.at(-1) as string, "the access token");
    expect(agent.slack.posted.at(-1)).toMatchObject({ text: "Recovered." });
    expect(auditRows(auditDb, auditBefore).map(row => row.outcome)).toEqual(["ran"]);

    // The refresh token crossed the wire five times in this file — the
    // warm-up's two mints, three hostile attempts, the recovery — and still
    // reached no agent-visible surface, in failure as in success.
    const everywhere = [...surfaces(), surface("an audit row", auditRows(auditDb))];
    expectNoSecret(everywhere, REFRESH_CANARY, "the refresh token");
    for (const token of as.accessTokens) {
      expectNoSecret(everywhere, token, "the access token");
    }
  },
  CASE_MS
);
