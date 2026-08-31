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
//
// A third block (#506) runs the same path *sender-constrained*: an issuer that
// verifies proofs, an upstream that verifies them too, and a sheet that says
// `require`. Its positive control is the same shape — the token has to reach the
// upstream as `DPoP <token>` with a proof, or the attack that follows proves
// nothing — and its attack is the one the whole workstream exists for: the
// minted token, in a hand that does not hold the key, cannot be presented.

import { after as afterAll, before as beforeAll, it } from "node:test";
import { expect } from "expect";
import {
  CHANNEL,
  OAUTH_CREDENTIAL,
  REFRESH_CANARY,
  auditRows,
  breakCredentialInjection,
  calls,
  createCleanup,
  expectBoundSecretReachedUpstream,
  expectNoSecret,
  expectSecretReachedUpstream,
  rigOf,
  says,
  startIssuer,
  startRig,
  surface
} from "./harness/index.js";
import type { Cleanup, Rig, RigOptions, SheetInput } from "./harness/index.js";
import {
  createDpopProof,
  mintSigningKeyMaterial,
  parseSigningKeyMaterial
} from "@getlibero/proxy";
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
senderConstrained();

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
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
    await cleanup?.drain();
  }, { timeout: SETUP_MS });

  it(
    "a token minted at the issuer reaches the upstream, and neither token reaches any agent surface",
    { timeout: CASE_MS },
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
    });
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
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
    await cleanup?.drain();
  }, { timeout: SETUP_MS });

  it(
    "with credential injection gutted, the positive control fails",
    { timeout: CASE_MS },
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
    });
}

/**
 * Sender-constrained tokens, end to end (#506).
 *
 * The three parties are all real over loopback: an authorization server that
 * advertises DPoP and verifies the proof it gets, a proxy that mints a key,
 * proves for the exchange and proves again on every upstream call, and a
 * resource server that refuses a token presented without a proof made by the
 * key that token was issued to.
 *
 * The positive control is the whole reason the attack below is evidence. Every
 * "a stolen token cannot be presented" assertion also passes against a run where
 * no token ever reached the upstream at all, so the first thing asserted is that
 * the ordinary path works: the task completed, and the token crossed the wire as
 * `DPoP <token>` with a proof beside it.
 */
function senderConstrained(): void {
  let rig: Rig | undefined;
  let issuer: FakeTokenIssuer | undefined;
  let cleanup: Cleanup | undefined;

  beforeAll(async () => {
    cleanup = createCleanup();
    issuer = await startIssuer(cleanup, { refreshToken: REFRESH_CANARY, dpop: true });
    rig = await startRig({
      sheets: {
        [CHANNEL]: {
          credential: OAUTH_CREDENTIAL,
          // `require`, so a downgrade is a failed task rather than a quietly
          // bearer one. The point of the case is what binding buys, and a
          // fallback would make every assertion below ambiguous.
          auth: { issuer: issuer.url, scopes: ["mcp.read"], dpop: "require" },
          tools: [{ name: "list_prs", approval: "none" }]
        }
      },
      grants: { [OAUTH_CREDENTIAL]: { issuer: issuer.url, refreshToken: REFRESH_CANARY } },
      upstream: { dpop: true },
      script: SCRIPT
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
    await cleanup?.drain();
  }, { timeout: SETUP_MS });

  it(
    "a bound token serves the call, and the same token in another hand cannot be presented",
    { timeout: CASE_MS },
    async () => {
      const { agent, upstream, proxy } = rigOf(rig);
      const as = issuer as FakeTokenIssuer;
      await agent.slack.deliverMention(mention("Ev00000052"));

      // The positive control, in three parts. The exchange was proved for —
      // the issuer verified a signature, a method, a url, a freshness and a
      // jti, and refused nothing.
      expect(as.dpopFailures).toEqual([]);
      expect(as.boundThumbprint).toBeDefined();

      // The call was proved for: the token crossed as `DPoP <token>` with a
      // proof, and the upstream — which verifies them — refused nothing.
      const minted = as.accessTokens.at(-1) as string;
      expectBoundSecretReachedUpstream(upstream, minted, "the access token");
      expect(upstream.dpopFailures).toEqual([]);

      // And the task completed, so this was a served call rather than a
      // survived one.
      expect(agent.slack.posted[0]).toMatchObject({ text: "Done." });
      await proxy.waitForLog({ event: "token_minted", credential: OAUTH_CREDENTIAL });

      // Now the attack. The thief holds the access token — every byte of it,
      // which is more than a stolen token store yields — and no key. The
      // upstream is told what the token was bound to, which is what a real one
      // learns from the token itself.
      upstream.options.dpopThumbprint = as.boundThumbprint ?? null;
      const before = upstream.received.length;

      const present = async (headers: Record<string, string>): Promise<number> => {
        const response = await fetch(`${upstream.url}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_prs" } })
        });
        return response.status;
      };

      // As a bearer token, which is what the token *is* to anyone who does not
      // know it was bound.
      expect(await present({ authorization: `Bearer ${minted}` })).toBe(401);
      // Under the right scheme and with no proof, which is the best a thief
      // with no key can do.
      expect(await present({ authorization: `DPoP ${minted}` })).toBe(401);

      // And with a proof the thief made themselves, from a key of their own —
      // a real signature over the real request, refused because it is not the
      // key this token was issued to. This is the assertion the whole feature
      // exists for.
      const thief = forgedProof(`${upstream.url}/mcp`, minted);
      expect(await present({ authorization: `DPoP ${minted}`, dpop: thief })).toBe(401);

      expect(upstream.dpopFailures).toEqual(["wrong_auth_scheme", "missing_proof", "wrong_key"]);
      // Three attempts, three refusals, and the upstream answered none of them
      // with anything a caller could use.
      expect(upstream.received.length - before).toBe(3);
    });
}

/**
 * A proof signed by a key that is not the proxy's.
 *
 * Made with the same maker the proxy uses, deliberately: the point is that a
 * *well-formed* proof from the wrong key is refused, so a hand-mangled one
 * would prove something weaker.
 */
function forgedProof(url: string, accessToken: string): string {
  const key = parseSigningKeyMaterial(mintSigningKeyMaterial());
  if (key === null) throw new Error("e2e: fixture key failed to parse");
  return createDpopProof({ key, method: "POST", url, accessToken });
}
