// The token path, attacked by the suite's own discipline (#258).
//
// A scripted authorization server joins the harness beside the fake upstream:
// the proxy holds a planted grant whose refresh token is a canary, mints an
// access token from the fake issuer over a real socket, and serves a call with
// it. Two secrets ride that path where the vault cases have one — the refresh
// token, durable in `tokens.enc`, which should cross exactly one wire (the
// POST to the issuer's token endpoint); and the minted access token, memory
// only, which should cross exactly one other (the `Authorization` header to
// the upstream). Neither may reach any surface the agent process can see.
//
// The pair runs twice, per redaction-detector.test.ts: as shipped, and with
// credential injection gutted inside the spawned process. Shipped must put the
// minted token on the upstream's wire; gutted must be caught by the positive
// control — which is what makes every negative below evidence rather than a
// scan that never saw a token.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CHANNEL,
  OAUTH_CREDENTIAL,
  REFRESH_CANARY,
  auditRows,
  breakCredentialInjection,
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
import type { Cleanup, Rig, RigOptions, SheetInput } from "./harness/index.js";
import type { FakeTokenIssuer } from "@getlibero/proxy";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const SCRIPT = [calls("list_prs", { repo: "getlibero/libero" }), says("Done.")];

/**
 * The issuer's url, byte for byte, in the three places the engine compares it:
 * the sheet's `auth.issuer`, the grant record, and (by the fake's default
 * echo) discovery's `issuer` member. One string, three readers.
 */
const oauthSheet = (issuerUrl: string): SheetInput => ({
  credential: OAUTH_CREDENTIAL,
  auth: { issuer: issuerUrl, scopes: ["mcp.read"] },
  tools: [{ name: "list_prs", approval: "none" }]
});

const oauthRig = (issuerUrl: string): RigOptions => ({
  sheets: { [CHANNEL]: oauthSheet(issuerUrl) },
  grants: { [OAUTH_CREDENTIAL]: { issuer: issuerUrl, refreshToken: REFRESH_CANARY } },
  script: SCRIPT
});

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

asShipped();
withInjectionGutted();

function asShipped(): void {
  let rig: Rig | undefined;
  let issuer: FakeTokenIssuer | undefined;
  let cleanup: Cleanup | undefined;

  beforeAll(async () => {
    // The issuer on its own stack, before the rig: the sheet and the grant
    // both need its url, so the rig cannot start it.
    cleanup = createCleanup();
    issuer = await startIssuer(cleanup, { refreshToken: REFRESH_CANARY });
    rig = await startRig(oauthRig(issuer.url));
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
    await cleanup?.drain();
  }, SETUP_MS);

  it(
    "a token minted at the issuer reaches the upstream, and neither token reaches any agent surface",
    async () => {
      const { agent, upstream, proxy, auditDb, surfaces } = rigOf(rig);
      const as = issuer as FakeTokenIssuer;
      await agent.slack.deliverMention(mention("Ev00000050"));

      // The positive control, first. The mint was real — the proxy presented
      // the planted refresh token to the issuer over a real socket — and the
      // minted token arrived at the upstream as `Bearer <token>`. Without
      // these, every "did not leak" below also passes on a run where no token
      // was ever minted.
      const refreshExchange = as.tokenRequests.find(request => request.form.grant_type === "refresh_token");
      expect(refreshExchange?.form.refresh_token).toBe(REFRESH_CANARY);
      const minted = as.accessTokens.at(-1);
      expect(minted).toBeDefined();
      expectSecretReachedUpstream(upstream, minted as string, "the access token");

      // The claim about the log is made through the log's own pipe.
      await proxy.waitForLog({ event: "token_minted", credential: OAUTH_CREDENTIAL });

      // And neither secret is anywhere the agent process can see — nor in the
      // audit row, which the issue names alongside the agent's surfaces.
      const everywhere = [...surfaces(), surface("an audit row", auditRows(auditDb))];
      expectNoSecret(everywhere, REFRESH_CANARY, "the refresh token");
      for (const token of as.accessTokens) {
        expectNoSecret(everywhere, token, "the access token");
      }

      // The task itself completed: this was a served call, not a survived one.
      expect(agent.slack.posted[0]).toMatchObject({ text: "Done." });
    },
    CASE_MS
  );
}

function withInjectionGutted(): void {
  let rig: Rig | undefined;
  let issuer: FakeTokenIssuer | undefined;
  let cleanup: Cleanup | undefined;

  beforeAll(async () => {
    cleanup = createCleanup();
    issuer = await startIssuer(cleanup, { refreshToken: REFRESH_CANARY });
    rig = await startRig({
      ...oauthRig(issuer.url),
      nodeArgs: ["--import", breakCredentialInjection(cleanup)]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
    await cleanup?.drain();
  }, SETUP_MS);

  it(
    "with credential injection gutted, the positive control fails",
    async () => {
      const { agent, upstream } = rigOf(rig);
      const as = issuer as FakeTokenIssuer;
      await agent.slack.deliverMention(mention("Ev00000051"));

      // The mutation was surgical: the engine still minted — the grant was
      // read, the exchange ran — so what follows isolates the injection.
      expect(as.accessTokens.length).toBeGreaterThan(0);

      // The call went out bare.
      const requests = upstream.callsTo("tools/call");
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(request => request.authorization === undefined)).toBe(true);

      // And the control every case above leans on catches it. This is the
      // assertion the acceptance names — the others describe the setup.
      expect(() => expectSecretReachedUpstream(upstream, as.accessTokens.at(-1) as string, "the access token")).toThrow(
        /never reached the upstream/
      );
    },
    CASE_MS
  );
}
