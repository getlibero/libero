// Rotation, across a real process death (#258).
//
// OAuth 2.1's posture is that a refresh token is spent by using it: the
// authorization server invalidates the one presented and issues a successor.
// The custody decision (#254) exists for exactly this moment — the successor
// is a durable credential the operator never wrote, and if it lives only in
// process memory, every restart is a re-grant. This file is that claim made
// against the shipped entrypoint: mint and rotate, kill the proxy, restart it,
// and require the next call to succeed on the rotated token that only
// `tokens.enc` could have carried across.
//
// The unit suite proves the same with an in-process reopen; what this adds is
// the process boundary — the successor was fsynced by one operating-system
// process and read back by another, through the same startup path a deployment
// takes.

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

/** Two tasks: one before the death, one after. */
const SCRIPT = [
  calls("list_prs", { repo: "getlibero/libero" }),
  says("First done."),
  calls("list_prs", { repo: "getlibero/libero" }, "call-2"),
  says("Second done.")
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
  // `rotate` is the fake's default; written out because it is what the whole
  // file is about.
  issuer = await startIssuer(cleanup, { refreshToken: REFRESH_CANARY, rotate: true });
  rig = await startRig({
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
  "the issuer invalidates the used refresh token, and the restarted proxy succeeds on the rotated one",
  async () => {
    const { agent, upstream, auditDb, surfaces } = rigOf(rig);
    const as = issuer as FakeTokenIssuer;

    await agent.slack.deliverMention(mention("Ev00000060"));

    // The first task's positive control: the planted refresh token bought a
    // real access token, and that token served the call.
    expect(as.tokenRequests[0]?.form.refresh_token).toBe(REFRESH_CANARY);
    const firstToken = as.accessTokens[0];
    expect(firstToken).toBeDefined();
    expectSecretReachedUpstream(upstream, firstToken as string, "the access token");
    await rigOf(rig).proxy.waitForLog({ event: "token_rotated", credential: OAUTH_CREDENTIAL });

    // The invalidation is the issuer's real behaviour, not leniency the case
    // would inherit: presenting the spent token again — as a thief holding the
    // planted value would — is answered `invalid_grant`.
    const replay = await fetch(`${as.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_CANARY }).toString()
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    // The log is per process, so the first one's is captured before the death
    // and scanned alongside the successor's below.
    const firstProcessLog = rigOf(rig).proxy.log();

    await rigOf(rig).restartProxy();
    await rigOf(rig).proxy.waitForLog({ event: "token_store_opened" });

    await agent.slack.deliverMention(mention("Ev00000061"));

    // The heart of the case: the second process presented the *successor* —
    // which existed nowhere but `tokens.enc` — and was served. Its access
    // token is new, because minted tokens are memory only and died with the
    // first process.
    const exchanges = as.tokenRequests.filter(request => request.form.grant_type === "refresh_token");
    expect(exchanges.at(-1)?.form.refresh_token).toBe("rt_rotated_1");
    const secondToken = as.accessTokens.at(-1);
    expect(secondToken).not.toBe(firstToken);
    expectSecretReachedUpstream(upstream, secondToken as string, "the access token");
    expect(agent.slack.posted.map(post => post.text)).toEqual(["First done.", "Second done."]);

    // Neither process ever presented a stale token: `invalid_grant` is the
    // theft signal, and a proxy that earned one would have lost the grant.
    const bothLogs = [...firstProcessLog, ...rigOf(rig).proxy.log()];
    expect(bothLogs.filter(line => line.includes(`"invalid_grant"`))).toEqual([]);

    // And nothing durable or minted reached any agent-visible surface — the
    // first process's output included, which `surfaces()` no longer holds.
    const everywhere = [
      ...surfaces(),
      surface("the first proxy's output", firstProcessLog),
      surface("an audit row", auditRows(auditDb))
    ];
    expectNoSecret(everywhere, REFRESH_CANARY, "the refresh token");
    expectNoSecret(everywhere, "rt_rotated_1", "the rotated refresh token");
    expectNoSecret(everywhere, as.currentRefreshToken, "the current refresh token");
    for (const token of as.accessTokens) {
      expectNoSecret(everywhere, token, "the access token");
    }
  },
  CASE_MS
);
