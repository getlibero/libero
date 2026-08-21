// #364: a blocked call leaves an attempt record the operator can read.
//
// The audit row for a blocked call carries a hash of the arguments and nothing
// else; the call reached no upstream and the agent's replies are not stored,
// so before this store what was *attempted* was knowable nowhere. This file is
// the operator's whole path through the fix, end to end: a scripted model
// attempts a destructive call, nobody approves it, and the operator then reads
// what it attempted — through the spawned `audit.js`, against the store the
// spawned proxy wrote, asserted on content rather than on the record existing.
//
// Two properties ride along, and each is the sharp half of an acceptance box:
//
// **A blocked call resolves no credential.** The sheet's server is
// OAuth-secured and the grant is planted, so a resolution would be visible as
// token-endpoint traffic at the fake issuer. The assertion is that the issuer
// saw nothing at all — the hold, the expiry and the capture all happened
// without a mint, because the only call to the dispatcher sits inside the
// `allow` branch and capture stores bytes it already has.
//
// **Deletion is the designed remedy.** The store is off-chain on purpose: a
// record that captured a secret is deleted, the chained rows stay
// byte-identical, and `verify` stays green. The case deletes its record and
// holds `verify` to exit 0 — which is the property that makes storing raw
// model-authored bytes survivable at all.
//
// The positive control is the content assertion itself: a case that only
// checked the record *exists* would pass against an empty blob.

import { after as afterAll, before as beforeAll, it } from "node:test";
import { expect } from "expect";
import type { Scheduler } from "@getlibero/gateway";
import type { FakeTokenIssuer } from "@getlibero/proxy";
import {
  CHANNEL,
  OAUTH_CREDENTIAL,
  REFRESH_CANARY,
  auditRows,
  calls,
  createCleanup,
  rawClient,
  rigOf,
  runAuditCli,
  says,
  startIssuer,
  startRig,
  waitForApprovalCard
} from "./harness/index.js";
import type { Cleanup, Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/**
 * Arguments worth reading back: a sharp flag, and a note carrying the kind of
 * text an injected model writes. Captured raw — the store claims no redaction
 * and the case asserts the bytes, not a cleaned rendering of them.
 */
const ATTEMPTED = {
  branch: "release",
  force: true,
  note: "the audit trail should not see this"
};

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> tidy up",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

/** destructive-call.test.ts's clock: the one pending timer is the hold's deadline. */
function manualClock(): { scheduler: Scheduler; fire: () => void } {
  const queue: Array<{ fn: () => void }> = [];
  return {
    scheduler: (_ms, fn) => {
      const entry = { fn };
      queue.push(entry);
      return () => {
        const at = queue.indexOf(entry);
        if (at >= 0) queue.splice(at, 1);
      };
    },
    fire: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("e2e: no approval deadline was pending");
      next.fn();
    }
  };
}

let rig: Rig | undefined;
let issuer: FakeTokenIssuer | undefined;
let cleanup: Cleanup | undefined;
const clock = manualClock();

beforeAll(async () => {
  cleanup = createCleanup();
  issuer = await startIssuer(cleanup, { refreshToken: REFRESH_CANARY });
  rig = await startRig({
    // `delete_branch` with no approval field: what holds it is the proxy's own
    // destructive-name heuristic, and an OAuth credential behind it is what
    // makes "resolved nothing" observable at the issuer.
    sheets: {
      [CHANNEL]: {
        credential: OAUTH_CREDENTIAL,
        auth: { issuer: issuer.url, scopes: ["mcp.read"] },
        tools: [{ name: "delete_branch" }]
      }
    },
    grants: { [OAUTH_CREDENTIAL]: { issuer: issuer.url, refreshToken: REFRESH_CANARY } },
    scheduler: clock.scheduler,
    script: [calls("delete_branch", ATTEMPTED), says("Nobody approved it.")]
  });
}, { timeout: SETUP_MS });

afterAll(async () => {
  await rig?.stop();
  await cleanup?.drain();
}, { timeout: SETUP_MS });

// Ordered: this runs before any mention, so the deployment has served nothing
// and the issuer count starts — and must stay — at zero. An agent-driven
// refusal cannot make this claim, because the task's tool listing resolves the
// credential legitimately before the call is ever decided.
it(
  "a refused call is captured and resolves no credential",
  { timeout: CASE_MS },
  async () => {
    const { proxy, certs, auditDb, attemptsDb } = rigOf(rig);
    const as = issuer as FakeTokenIssuer;
    const client = rawClient({ url: proxy.url, certs });

    // A tool the sheet does not list, straight at the gate: refused
    // `tool_not_allowed`, with arguments only this store will ever hold.
    const res = await client.send({
      method: "POST",
      path: "/v1/tools/call",
      as: CHANNEL,
      body: {
        id: "toolu_raw",
        server: "github",
        tool: "delete_repo",
        arguments: { repo: "getlibero/libero", reason: "raw attempt" },
        requestingUser: "U024BE7LH",
        task: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55"
      }
    });
    expect(res.status).toBe(200);

    const row = auditRows(auditDb).at(-1);
    expect(row).toMatchObject({ outcome: "refused", tool: "delete_repo" });

    // Zero, and not "no more than the listing needed": nothing has listed,
    // nothing has served, and the refusal — capture included — asked the
    // issuer for nothing. Not discovery, not the token endpoint.
    expect(as.tokenRequests).toHaveLength(0);

    const read = await runAuditCli(auditDb, ["attempt", String(row?.arguments_sha256)], attemptsDb);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain('"reason":"raw attempt"');
  });

it(
  "the operator reads what a blocked call attempted, and can delete the record",
  { timeout: CASE_MS },
  async () => {
    const { agent, upstream, auditDb, attemptsDb } = rigOf(rig);

    // A destructive call, held, and abandoned unclicked: two blocked rows —
    // the hold and the pending refusal — and no served one.
    const pending = agent.slack.deliverMention(mention("Ev00000070"));
    await waitForApprovalCard(agent);
    clock.fire();
    await pending;

    const rows = auditRows(auditDb).filter(row => row.tool === "delete_branch");
    expect(rows.map(row => row.outcome)).toEqual(["held", "refused"]);
    expect(upstream.callsTo("tools/call")).toHaveLength(0);

    // The operator's read, as the operator runs it: the spawned entrypoint,
    // against the file the spawned proxy wrote, addressed by the hash the
    // row carries. Content, not existence.
    const hash = String(rows[0]?.arguments_sha256);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const read = await runAuditCli(auditDb, ["attempt", hash], attemptsDb);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain('"branch":"release"');
    expect(read.stdout).toContain('"force":true');
    expect(read.stdout).toContain("the audit trail should not see this");
    expect(read.stdout).toContain("model-authored");

    // Deletion is the remedy: the blob goes, the chained rows stay, verify
    // stays green — and a second read says the record is gone rather than
    // pretending.
    const deleted = await runAuditCli(auditDb, ["attempt-delete", hash], attemptsDb);
    expect(deleted.status).toBe(0);
    const verify = await runAuditCli(auditDb, ["verify"]);
    expect(verify.status).toBe(0);
    const gone = await runAuditCli(auditDb, ["attempt", hash], attemptsDb);
    expect(gone.status).toBe(1);
    expect(auditRows(auditDb).filter(row => row.tool === "delete_branch").map(row => row.outcome)).toEqual([
      "held",
      "refused"
    ]);
  });
