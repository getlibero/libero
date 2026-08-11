// #130's acceptance list, in CI, against the shape the real GitHub server has.
//
// The live run against `api.githubcopilot.com` is manual and lives in
// `github-live.test.ts`. This is the half CI can hold, and its whole reason for
// existing beside `smoke.test.ts` is that the two upstreams are not the same
// upstream. `smoke.test.ts` runs the fake's defaults: stateless `2026-07-28`,
// JSON framing, one page, two hand-named tools. GitHub's hosted server is none
// of those — it refuses `server/discover`, so the client falls back to
// `initialize`, holds a session id it must then carry, frames replies as SSE,
// pages its catalog, and publishes tool descriptions long enough to be
// truncated. Every one of those was built and tested inside
// `packages/proxy`; none of them had ever been exercised through both halves at
// once.
//
// So the three assertions here are #130's three, and the claim each makes is
// "…against *this* upstream". Nothing is being restated: `exfiltration.test.ts`
// attacks redaction, `unlisted-tool.test.ts` attacks the allowlist, and neither
// takes the legacy path to get there.
//
// **The credential goes out on `initialize` before it goes out on
// `tools/call`**, which is why the positive control below is asserted twice.
// That handshake request is a surface `smoke.test.ts` cannot see, and it is the
// one a legacy upstream reflects first.
//
// One rig per case: `model.seen` is a script cursor shared by every task in a
// rig, and the catalog is cached per upstream for five minutes, so cases sharing
// a rig would be coupled through two things neither of them names.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CANARY_CREDENTIAL,
  CHANNEL,
  auditRows,
  calls,
  expectCanaryReachedUpstream,
  expectNoCanary,
  rigOf,
  says,
  spendFor,
  startRig
} from "./harness/index.js";
import type { FakeCatalogTool } from "@getlibero/proxy";
import type { Rig, UpstreamOptions } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/**
 * The fake wearing the hosted server's shape.
 *
 * Each field is a thing the real server does and the fake's defaults do not.
 * `pageSize` is 2 against a catalog of 5, and the sheet's second tool is the
 * catalog's last, so the walk really pages: it stops as soon as every wanted
 * name is found, and a fixture that put both on page one would test the
 * `nextCursor` branch by never entering it.
 */
const AS_GITHUB: UpstreamOptions = {
  protocol: "legacy",
  sessions: true,
  framing: "sse",
  pageSize: 2
};

/**
 * GitHub's own tool names, and one description past the 1,024-character cap.
 *
 * The names matter beyond decoration: `merge_pull_request` is the one that
 * proves the destructive-verb heuristic is a default rather than a policy — it
 * contains no delete/drop/transfer/deploy, so a sheet that says nothing about it
 * runs it. `delete_file` is the one the heuristic does catch. Both are here so a
 * reader can see the pair.
 *
 * The long description is `pull_request_read`'s real shape: GitHub documents
 * nine `method` values inline, which is well past what the proxy will publish.
 * That tool is deliberately last, so it is on the third page — see `AS_GITHUB`.
 * It is also what found the truncation bug this PR fixes: the proxy appended an
 * ellipsis *past* the bound its own client parses against, so any upstream with
 * a description over 1,024 characters produced a listing the agent rejected as
 * `malformed_response`, ending the task.
 */
const GITHUB_CATALOG: readonly FakeCatalogTool[] = [
  {
    name: "list_pull_requests",
    description: "List pull requests",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } },
      required: ["owner", "repo"]
    }
  },
  { name: "search_pull_requests", description: "Search pull requests" },
  { name: "merge_pull_request", description: "Merge pull request" },
  { name: "delete_file", description: "Delete file" },
  {
    name: "pull_request_read",
    description: `Get details for a single pull request. ${"Possible options: get, get_diff, get_status, get_files, get_commits, get_review_comments, get_reviews, get_comments, get_check_runs. ".repeat(
      12
    )}`,
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, pullNumber: { type: "integer" } },
      required: ["owner", "repo", "pullNumber", "method"]
    }
  }
];

const READ_TOOLS = [
  { name: "list_pull_requests", approval: "none" as const },
  { name: "pull_request_read", approval: "none" as const }
];

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> what is open on getlibero/libero",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

describeTheCallCompletes();
describeTheSheetlessChannelIsRefused();
describeTheCredentialDoesNotLeak();

// Acceptance 1: an agent in an allowlisted channel completes a GitHub tool call
// end to end through the proxy.
function describeTheCallCompletes(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      upstream: AS_GITHUB,
      catalog: GITHUB_CATALOG,
      sheets: { [CHANNEL]: { credential: CANARY_CREDENTIAL, tools: READ_TOOLS } },
      script: [
        calls("list_pull_requests", { owner: "getlibero", repo: "libero", state: "open" }),
        says("Two are open.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "completes a permitted call against a legacy, session-bearing, SSE-framed upstream",
    async () => {
      const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);
      const before = auditRows(auditDb).length;

      await agent.slack.deliverMention(mention("Ev00000130"));

      expect(agent.slack.posted).toHaveLength(1);
      expect(agent.slack.posted[0]).toMatchObject({ channelId: CHANNEL, text: "Two are open." });

      // The ladder was actually taken. A `server/discover` that was refused, an
      // `initialize` that answered, and the notification that follows it — if
      // the fake had been left stateless, all three of these would be zero and
      // the case would silently be `smoke.test.ts` again.
      expect(upstream.callsTo("server/discover").length).toBeGreaterThan(0);
      expect(upstream.callsTo("initialize").length).toBeGreaterThan(0);
      expect(upstream.callsTo("notifications/initialized").length).toBeGreaterThan(0);

      // And the session it issued was carried on the call, which is the half a
      // stateless upstream cannot ask for.
      const call = upstream.callsTo("tools/call")[0];
      expect(call?.headers["mcp-session-id"]).toEqual(expect.any(String));

      // The catalog was paged. The walk stops as soon as every wanted name is
      // found, and the sheet's second tool is the catalog's fifth, so two pages
      // at least — a fixture that put both on page one would assert nothing.
      expect(upstream.callsTo("tools/list").length).toBe(3);

      // The sheet decides what is published, not the catalog. Three of GitHub's
      // five reached the model as two, because the sheet named two.
      const offered = model.seen[0]?.tools?.map(tool => tool.name);
      expect(offered).toEqual(["list_pull_requests", "pull_request_read"]);

      // The over-long description was truncated rather than dropped — and this
      // is the assertion that would have failed before the truncation fix, not
      // by being wrong but by never running: the whole listing was rejected as
      // `malformed_response` and the task died with no tools at all.
      //
      // Asserted on the shape rather than the length, because what the model
      // sees is not what the proxy published: `tool-names.ts` appends its own
      // "Called as …" sentence, so the model-facing string is deliberately
      // longer than MAX_TOOL_DESCRIPTION. The bound the proxy owns is pinned in
      // packages/proxy/src/mcp-protocol.test.ts against the schema itself.
      const read = model.seen[0]?.tools?.find(tool => tool.name === "pull_request_read");
      expect(read?.description?.startsWith("Get details for a single pull request.")).toBe(true);
      expect(read?.description).toContain("… Called as `github.pull_request_read`");

      // The positive control, twice: the credential left the proxy on the
      // handshake as well as on the call, and the handshake is the request this
      // upstream shape adds.
      expectCanaryReachedUpstream(upstream, "initialize");
      expectCanaryReachedUpstream(upstream);

      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: CHANNEL,
        server: "github",
        tool: "list_pull_requests",
        outcome: "ran"
      });

      expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(1);
    },
    CASE_MS
  );
}

// Acceptance 2: the same call from a channel whose sheet omits the server is
// refused.
//
// The sheet is rewritten between the listing and the call, which is the only way
// to make this a claim about the *proxy*: a tool the listing never carried is
// refused by the agent's own map before anything is sent, which is a different
// (and separately covered) property. See unlisted-tool.test.ts.
function describeTheSheetlessChannelIsRefused(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      upstream: AS_GITHUB,
      catalog: GITHUB_CATALOG,
      sheets: { [CHANNEL]: { credential: CANARY_CREDENTIAL, tools: READ_TOOLS } },
      script: [
        calls("list_pull_requests", { owner: "getlibero", repo: "libero" }),
        says("I could not do that.")
      ],
      onModelTurn: turn => {
        if (turn !== 1) return;
        // The channel's sheet, gone. This is a revocation mid-task — the proxy
        // re-reads the sheet per call, so the listing that already happened does
        // not carry over.
        rigOf(rig).channelsRoot.remove(CHANNEL);
      }
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "refuses the same call from a channel whose sheet no longer names the server",
    async () => {
      const { agent, upstream, model, auditDb } = rigOf(rig);
      const before = auditRows(auditDb).length;
      const listed = upstream.received.length;

      await agent.slack.deliverMention(mention("Ev00000131"));

      // The load-bearing precondition: the model really was offered the tool, so
      // what follows is the gate refusing and not the agent's map.
      expect(model.seen[0]?.tools?.map(tool => tool.name)).toContain("list_pull_requests");

      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: CHANNEL,
        tool: "list_pull_requests",
        outcome: "refused",
        refusal_reason: "no_team_sheet"
      });

      // Refused before dispatch, so nothing after the listing reached GitHub.
      expect(upstream.received.slice(listed).map(request => request.rpc?.method)).not.toContain(
        "tools/call"
      );

      // Relayed rather than fatal: the task answered the thread.
      expect(JSON.stringify(model.seen[1]?.messages)).toContain("no team sheet");
      expect(agent.slack.posted).toHaveLength(1);
    },
    CASE_MS
  );
}

// Acceptance 3: the credential appears in no tool result, log, or error visible
// to the agent.
//
// `echoHeaders: "text"` so the upstream is actively hostile rather than merely
// quiet — a run against a well-behaved upstream passes this without the scrub
// ever being reached.
function describeTheCredentialDoesNotLeak(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      upstream: { ...AS_GITHUB, echoHeaders: "text", echoIntoResponseHeader: true },
      catalog: GITHUB_CATALOG,
      sheets: { [CHANNEL]: { credential: CANARY_CREDENTIAL, tools: READ_TOOLS } },
      script: [
        calls("list_pull_requests", { owner: "getlibero", repo: "libero" }),
        says("Here is what came back.")
      ]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "keeps the credential off every agent-visible surface when the upstream reflects it",
    async () => {
      const { agent, upstream, surfaces } = rigOf(rig);

      await agent.slack.deliverMention(mention("Ev00000132"));

      expect(agent.slack.posted).toHaveLength(1);

      // Both controls first. The upstream saw the real value on the handshake
      // and on the call, so the scan below is scanning for something that
      // existed.
      expectCanaryReachedUpstream(upstream, "initialize");
      expectCanaryReachedUpstream(upstream);

      // The upstream did reflect it — otherwise this is a leak test against a
      // cooperative server, which every implementation passes.
      const reflected = upstream.callsTo("tools/call").length;
      expect(reflected).toBeGreaterThan(0);

      expectNoCanary(surfaces());
    },
    CASE_MS
  );
}
