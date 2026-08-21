// #130's acceptance, against GitHub itself.
//
// Skipped unless `LIBERO_GITHUB_PAT` is set, so CI collects this file, reaches
// no network, and needs no secret. Run it by hand:
//
//   pnpm -r build
//   LIBERO_GITHUB_PAT=… pnpm --filter @getlibero/e2e exec node --test dist/github-live.test.js
//
// **This is the acceptance run, not a demonstration of one.** #130 asks for a
// real GitHub tool call end to end through the proxy, recorded in the PR. A
// screenshot records it once; this records it every time anyone runs it, which
// matters because the thing being asserted about — a hosted server GitHub
// changes without telling us — is the half most likely to move.
//
// What is real here: the spawned proxy process, mutual TLS, the vault, the team
// sheet, the budget meter, the audit log, the MCP client, the protocol ladder,
// and `api.githubcopilot.com`. What is faked is exactly what the whole suite
// fakes — the Slack socket and the model. `github.test.ts` is the same three
// claims against a fake wearing this server's shape, and it is the one CI runs.
//
// **The positive control changes shape, and that is the interesting part.**
// Every other file reads the credential off a recording upstream: the canary
// arrived as `Bearer <canary>`, so the negative scan below is scanning for
// something that existed. There is no recording upstream here. The control is
// that GitHub *answered with data it will not give an anonymous caller* — the
// endpoint is a 401 without a token — so a tool result naming this repository's
// pull request is proof the vault resolved and `injectCredential` fired. It is
// asserted before the leak scan, in that order, for the reason canary.ts gives.
//
// The token is planted through `RigOptions.credentials`, the one documented
// exception to "plant a canary, not a plausible token" (harness/vault.ts). The
// canary is still in the vault and nothing names it.
//
// The rig also stands up its loopback fake upstream, which nothing here calls:
// the sheet overrides `url`. Harmless, and cheaper than a seam for switching it
// off.

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "expect";
import {
  CHANNEL,
  auditRows,
  calls,
  expectNoSecret,
  relays,
  rigOf,
  says,
  spendFor,
  startRig,
  surface
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const PAT = process.env["LIBERO_GITHUB_PAT"];

/** The credential name the sheets below refer to. Names travel; values do not. */
const CREDENTIAL = "github_service_account";

/**
 * Read-only, one toolset, exactly as `/docs/github/` recommends for a first
 * connection. The path is the only configuration this proxy can reach — a team
 * sheet carries no request headers — so `/readonly` here is a real second
 * boundary beside the allowlist rather than a restatement of it.
 */
const GITHUB_URL = "https://api.githubcopilot.com/mcp/x/pull_requests/readonly";

/**
 * A merged pull request in this repository, so the answer is fixed.
 *
 * Public, so a least-privilege token can read it, and merged, so nothing about
 * it moves. The title is what the assertion looks for: it is data GitHub holds
 * and the request did not carry, which is what makes it a control rather than an
 * echo of the arguments.
 */
const PR = { owner: "getlibero", repo: "libero", pullNumber: 184 } as const;

/**
 * A fragment of that pull request's title, chosen to survive the round trip.
 *
 * **No apostrophe, deliberately.** GitHub's MCP server HTML-escapes text it
 * returns, so the real title comes back as `the audit log&#39;s read path` — a
 * transformation nothing in this proxy performs and nothing in the assertion
 * should have to know about. The first version of this case used the possessive
 * and failed on a call that had in fact completed, which is the most misleading
 * way for a control to break.
 */
const PR_TITLE_FRAGMENT = "read path (#98)";

const SETUP_MS = 60_000;
const CASE_MS = 60_000;

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: `<@U0BOTBOTB> what is pull request ${String(PR.pullNumber)} about`,
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

const sheet = {
  url: GITHUB_URL,
  credential: CREDENTIAL,
  tools: [
    { name: "list_pull_requests", approval: "none" as const },
    { name: "pull_request_read", approval: "none" as const }
  ],
  // Generous, and it has to be: this one spends real seconds on a real network,
  // and the loop's cap is an `AbortSignal.timeout` no fake timer can drive.
  maxTaskSeconds: 55
};

describe("against api.githubcopilot.com", { skip: PAT === undefined || PAT === "" }, () => {
  describeTheGovernedPathReachesGitHub();
  describeTheCallCompletes();
  describeTheRevokedChannelIsRefused();
});

// Acceptance 1 and 3, as far as they hold today: the governed path reaches
// GitHub, and the token is on no agent-visible surface.
//
// One case rather than two, deliberately. The leak scan needs a run in which the
// credential was actually resolved and sent, and that is this run — splitting
// them would mean a second rig doing the same GitHub traffic to assert the other
// half of the same event.
function describeTheGovernedPathReachesGitHub(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      credentials: { [CREDENTIAL]: PAT ?? "" },
      sheets: { [CHANNEL]: sheet },
      // `relays` rather than a fixed sentence: the model posts the tool result
      // verbatim, which is the most damaging honest thing it can do and makes
      // the thread reply a real surface for the scan instead of a string this
      // file wrote.
      script: [calls("pull_request_read", { method: "get", ...PR }), relays()]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "handshakes, lists, and authenticates against GitHub, and the token reaches nothing else",
    { timeout: CASE_MS },
    async () => {
      const { agent, model, surfaces } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000140"));

      // **The positive control.** `api.githubcopilot.com` answers 401 to an
      // anonymous caller at `initialize` — verified by hand, and the reason this
      // assertion is a control rather than a smoke test: a catalog carrying
      // GitHub's own tool schemas is something no unauthenticated run can
      // produce. So this is proof the credential left the vault, was injected by
      // `callUpstream`, and was accepted.
      //
      // It also exercises #150's ladder for real. GitHub refuses
      // `server/discover` with `-32601` and negotiates `2025-11-25` through the
      // legacy `initialize` handshake, which is the path that fallback exists
      // for and the first time it has run against a server that is not ours.
      const offered = model.seen[0]?.tools ?? [];
      expect(offered.map(tool => tool.name)).toEqual(["list_pull_requests", "pull_request_read"]);
      expect(offered.every(tool => (tool.description ?? "").length > 0)).toBe(true);

      // And the schemas came back with the annotation the next case is about,
      // which is what makes that case a statement about GitHub rather than about
      // a fixture someone wrote.
      const schema = offered.find(tool => tool.name === "pull_request_read")?.inputSchema;
      const properties = (schema as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties;
      expect(properties?.["owner"]?.["x-mcp-header"]).toBe("owner");

      // The token is on none of the five surfaces this process can see: the
      // thread, the cards, the model's transcript, the agent's log, and the
      // proxy's own output. The failure message masks the value.
      expectNoSecret(surfaces(), PAT ?? "", "the GitHub token");
    });
}

/**
 * Acceptance 1's remaining half, and #130's close.
 *
 * **This case used to pin a gap and now pins the property.** GitHub's tool
 * schemas carry `x-mcp-header` on `owner` and `repo`, and it requires those
 * argument values mirrored into `Mcp-Param-{name}` request headers — on the
 * legacy `2025-11-25` connection it negotiates, declining SEP-2243's optional
 * headerless-legacy courtesy. Until #188 the proxy sent none, so GitHub refused
 * every annotated tool with JSON-RPC `-32020`, which was essentially all of
 * them. The old form of this case asserted that refusal verbatim and told
 * whoever closed the gap to invert it; this is that inversion.
 *
 * No published SDK closes it either — the SDK mirrors only on a `2026-07-28`
 * connection, which is spec-correct because `x-mcp-header` exists in no earlier
 * revision. The headers here come from the codec vendored at
 * `packages/proxy/src/vendor/mcp-param-headers.ts`. Filed upstream as
 * modelcontextprotocol/typescript-sdk#2639.
 */
function describeTheCallCompletes(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      credentials: { [CREDENTIAL]: PAT ?? "" },
      sheets: { [CHANNEL]: sheet },
      script: [calls("pull_request_read", { method: "get", ...PR }), relays()]
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "completes against GitHub, with x-mcp-header mirrored into Mcp-Param-* headers",
    { timeout: CASE_MS },
    async () => {
      const { agent, auditDb, budgetDb, surfaces } = rigOf(rig);
      const before = auditRows(auditDb).length;

      await agent.slack.deliverMention(mention("Ev00000142"));

      const reply = agent.slack.posted[0]?.text ?? "";
      expect(agent.slack.posted).toHaveLength(1);

      // The answer came back, which is #130's acceptance. The fragment is a
      // merged pull request's title: data an anonymous caller cannot get, so it
      // is also the positive control this file uses in place of a recording
      // upstream — the credential reached GitHub and GitHub answered from it.
      expect(reply).toContain(PR_TITLE_FRAGMENT);
      expect(reply).not.toContain("missing Mcp-Param-owner header");

      // One row, and now a `ran` one. The property held while the call was
      // refused too — a decided call leaves exactly one row whether or not the
      // upstream answered usefully — so what changed here is the outcome, not
      // the accounting.
      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: CHANNEL,
        server: "github",
        tool: "pull_request_read",
        outcome: "ran",
        result_is_error: 0
      });
      // The audit row holds a hash of the arguments and never a value, so this
      // is also the assertion that the log is safe to hand to an auditor.
      //
      // Through `expectNoSecret` rather than `expect(…).not.toContain(PAT)`,
      // and that is the point rather than a style preference: a failing
      // `not.toContain` prints the *expected substring*, so the plain form
      // writes a live credential to the terminal on exactly the run where one
      // has already leaked. `expectNoSecret` masks it.
      expectNoSecret([surface("the audit row", rows[0])], PAT ?? "", "the GitHub token");

      // Metered whatever the upstream said: the count is the proxy's own, taken
      // from calls it served, which is what makes it hold against an agent that
      // reports nothing.
      expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(1);

      // And GitHub's answer is upstream-authored, so it is a surface too.
      expectNoSecret(surfaces(), PAT ?? "", "the GitHub token");
    });
}

// Acceptance 2: the same call from a channel whose sheet omits the server is
// refused — and costs GitHub nothing, because the proxy refuses before dispatch.
//
// The sheet is removed between the listing and the call, which is the only way
// to make this a claim about the proxy: a tool the listing never carried is
// refused by the agent's own map before anything is sent. See
// unlisted-tool.test.ts.
function describeTheRevokedChannelIsRefused(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      credentials: { [CREDENTIAL]: PAT ?? "" },
      sheets: { [CHANNEL]: sheet },
      script: [calls("pull_request_read", { method: "get", ...PR }), says("I could not do that.")],
      onModelTurn: turn => {
        if (turn !== 1) return;
        rigOf(rig).channelsRoot.remove(CHANNEL);
      }
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "refuses the same call once the channel's sheet is gone, without dialling GitHub",
    { timeout: CASE_MS },
    async () => {
      const { agent, model, auditDb, surfaces } = rigOf(rig);
      const before = auditRows(auditDb).length;

      await agent.slack.deliverMention(mention("Ev00000141"));

      // The precondition: the model really was offered the tool, so what follows
      // is the gate refusing rather than the agent's map.
      expect(model.seen[0]?.tools?.map(tool => tool.name)).toContain("pull_request_read");

      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: CHANNEL,
        tool: "pull_request_read",
        outcome: "refused",
        refusal_reason: "no_team_sheet"
      });

      // Relayed rather than fatal, and the token is still nowhere.
      expect(agent.slack.posted).toHaveLength(1);
      expectNoSecret(surfaces(), PAT ?? "", "the GitHub token");
    });
}
