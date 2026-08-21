// #133, property 2: the certificate decides which channel this is, and nothing
// else does.
//
// **These cases cannot go through the agent, and that is the finding rather
// than an inconvenience.** `createProxyToolClient` sends no `channel` field and
// cannot be made to — `ToolCall` is strict, so a body carrying one is refused
// rather than stripped — and the transport presents only the certificate
// matching the channel it was asked for. Both are correct, and both mean the
// supported client is incapable of the attack. So every case here is its own
// mutual-TLS client (harness/client.ts): a compromised agent process, which is
// the threat model, sending what the shipped one will not.
//
// What is claimed here and nowhere else is the *composed* half. The proxy's own
// suite drives the same gate in-process against a stub dispatcher; the spawned
// process reached over real TLS, with a real vault, a real meter and a real
// audit file behind it, is what makes "the certificate wins, including against
// the meter" a system property rather than a unit one. Cases already settled
// there — a foreign CA, no certificate at all, `CN=channel:../../etc`, the
// Cyrillic and case-variant name sets — are deliberately not restated; see
// packages/proxy/src/server.test.ts and packages/proxy/src/enforce.test.ts.
//
// Adjacent and separate: a certificate for a channel that is still in use, whose
// key leaked, is `certificate-pinning.test.ts` (#79). Nothing here needs it —
// one channel's certificate cannot act as another's whether or not a sheet pins
// anything — and the sheets these cases write pin their own channel by default.
//
// One rig, no mentions: `script` is empty because no task ever runs, so the
// cases are coupled through nothing but the audit and upstream cursors they
// each take for themselves.

import { after as afterAll, before as beforeAll, it } from "node:test";
import { expect } from "expect";
import {
  CANARY,
  CHANNEL,
  OTHER_CHANNEL,
  auditRows,
  lastAuditId,
  rawClient,
  rigOf,
  spendFor,
  startRig
} from "./harness/index.js";
import type { RawClient, Rig } from "./harness/index.js";

const SETUP_MS = 120_000;
const CASE_MS = 30_000;

/** A channel with a certificate and a sheet that has never parsed. */
const BROKEN_CHANNEL = "CBROKEN01";

let rig: Rig | undefined;
let client: RawClient | undefined;

/** A well-formed call on the one tool the default sheet permits. */
const permittedCall = (id: string) => ({
  id,
  server: "github",
  tool: "list_prs",
  arguments: { repo: "getlibero/libero" },
  requestingUser: "U024BE7LH",
  task: "task-identity"
});

function clientOf(): RawClient {
  if (client === undefined) throw new Error("e2e: the rig did not start — the failure above is the real one");
  return client;
}

beforeAll(async () => {
  rig = await startRig({
    // BROKEN_CHANNEL gets a certificate and deliberately no sheet here: the
    // junk one is written below, and the state it must land in — "has a file,
    // has never parsed" — is only reachable if nothing resolved it first. A
    // sheet that once parsed is retained and enforced when a later write
    // breaks it, which is a different claim and a correct one.
    channels: [CHANNEL, OTHER_CHANNEL, BROKEN_CHANNEL],
    rawCns: ["noprefix=agent"],
    script: []
  });
  rig.channelsRoot.writeRaw(BROKEN_CHANNEL, "this is not a team sheet [[[\n");
  client = rawClient({ url: rig.proxy.url, certs: rig.certs });
}, { timeout: SETUP_MS });

afterAll(async () => {
  await rig?.stop();
}, { timeout: SETUP_MS });

it(
  "serves a permitted call over a client of its own, so the refusals below mean something",
  { timeout: CASE_MS },
  async () => {
    const { upstream, auditDb, budgetDb } = rigOf(rig);
    const since = lastAuditId(auditDb);

    const answer = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: CHANNEL,
      body: permittedCall("call-control")
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "ran", id: "call-control" });

    // The positive control, in the two halves the README insists on: the call
    // really reached the upstream, and it carried the vault's value. Every
    // "nothing reached the upstream" assertion below also passes on a rig where
    // nothing worked at all, and this is what rules that out.
    const calls = upstream.callsTo("tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe(`Bearer ${CANARY}`);

    expect(auditRows(auditDb, since)).toMatchObject([
      { channel: CHANNEL, server: "github", tool: "list_prs", outcome: "ran" }
    ]);
    expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(1);
  });

it(
  "ignores a channel asserted in a header and in the query string",
  { timeout: CASE_MS },
  async () => {
    const { upstream, auditDb, budgetDb } = rigOf(rig);
    const since = lastAuditId(auditDb);
    const served = upstream.callsTo("tools/call").length;
    const before = spendFor(budgetDb, CHANNEL).toolCalls;

    // The same call as the control, presenting the same certificate, saying
    // `C7ZZZ9999` in the two places outside the body that could carry one. The
    // path is written out rather than built, because the query string is the
    // attack and a reader should see it.
    const answer = await clientOf().send({
      method: "POST",
      path: `/v1/tools/call?channel=${OTHER_CHANNEL}`,
      as: CHANNEL,
      headers: { "x-libero-channel": OTHER_CHANNEL, "x-channel-id": OTHER_CHANNEL },
      body: permittedCall("call-asserted")
    });

    // Served, and served identically: the assertions were not rejected, they
    // were never read. A 400 here would be a weaker property — it would mean
    // the proxy has somewhere for a channel to be asserted and merely refuses
    // it, rather than having nowhere.
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "ran", id: "call-asserted" });
    expect(upstream.callsTo("tools/call")).toHaveLength(served + 1);

    // Attributed to the certificate in the log...
    expect(auditRows(auditDb, since)).toMatchObject([{ channel: CHANNEL, tool: "list_prs" }]);

    // ...and charged to the certificate at the meter, which is the half a log
    // assertion alone would miss. A channel that could redirect its spending
    // could spend another channel's cap without ever appearing in its rows.
    expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(before + 1);
    expect(spendFor(budgetDb, OTHER_CHANNEL).toolCalls).toBe(0);
  });

it(
  "refuses a body that asserts a channel rather than ignoring the field",
  { timeout: CASE_MS },
  async () => {
    const { upstream, auditDb } = rigOf(rig);
    const since = lastAuditId(auditDb);
    const served = upstream.received.length;

    const answer = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: CHANNEL,
      body: { ...permittedCall("call-body"), channel: OTHER_CHANNEL }
    });

    // Refused, not stripped. A field that had to be ignored to stay safe is a
    // trap for whoever wires up the next endpoint, so `ToolCall` is strict and
    // there is no such field to ignore.
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({
      error: { code: "bad_request", message: "the request body is not a valid tool call" }
    });

    // And the error names the certificate's channel, not the asserted one —
    // the proxy answering in the identity it resolved rather than the one it
    // was handed.
    expect((answer.body as { error: { channel?: unknown } }).error.channel).toBe(CHANNEL);

    // Nothing to attribute a row to: no server, no tool, no task survived the
    // parse, and a row of nulls would be worse than the log line, because it
    // would be counted.
    expect(auditRows(auditDb, since)).toHaveLength(0);
    expect(upstream.received).toHaveLength(served);
  });

it(
  "refuses a certificate that is not a channel principal, and says so only in its own log",
  { timeout: CASE_MS },
  async () => {
    const { proxy, auditDb } = rigOf(rig);
    const since = lastAuditId(auditDb);

    // Signed by the same authority, well-formed, and claiming nothing the
    // proxy will read as a channel.
    const answer = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: "noprefix",
      body: permittedCall("call-noprefix")
    });

    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({
      error: { code: "unauthenticated", message: "the client certificate does not identify a channel" }
    });
    // No channel on the error, because there is no channel: the rejection
    // happens before routing, and a field here would be the proxy guessing.
    expect((answer.body as { error: Record<string, unknown> }).error).not.toHaveProperty("channel");

    // Why it was rejected stays on the operator's side of the boundary. Waited
    // for rather than read, because the line and the response cross different
    // pipes and arrive in whichever order the kernel chooses.
    await expect(
      proxy.waitForLog({ event: "identity_rejected", reason: "not_a_channel_principal" })
    ).resolves.toMatchObject({ commonName: "agent" });

    expect(auditRows(auditDb, since)).toHaveLength(0);
  });

it(
  "denies a certificate for a channel that was never provisioned, under its own name",
  { timeout: CASE_MS },
  async () => {
    const { upstream, auditDb } = rigOf(rig);
    const since = lastAuditId(auditDb);
    const served = upstream.received.length;

    // A certificate this authority really did mint, for a channel with no
    // sheet. Authentication and authorization are different questions, and
    // this is the second one answering no.
    const answer = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: OTHER_CHANNEL,
      body: permittedCall("call-unprovisioned")
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      outcome: "refused",
      id: "call-unprovisioned",
      refusal: { reason: "no_team_sheet" }
    });

    // Under `C7ZZZ9999`, and not under the channel whose sheet would have
    // permitted the call. Revocation is removing a sheet, and this is what
    // that looks like from outside.
    expect(auditRows(auditDb, since)).toMatchObject([
      { channel: OTHER_CHANNEL, tool: "list_prs", outcome: "refused", refusal_reason: "no_team_sheet" }
    ]);
    expect(upstream.received).toHaveLength(served);
  });

it(
  "denies a channel whose sheet has never parsed, and says which mistake it was",
  { timeout: CASE_MS },
  async () => {
    const { upstream, auditDb } = rigOf(rig);
    const since = lastAuditId(auditDb);
    const served = upstream.received.length;

    const answer = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: BROKEN_CHANNEL,
      body: permittedCall("call-broken")
    });

    // A distinct reason from the case above, and the distinction is the point:
    // both deny every call, but "there is no sheet" and "the sheet is broken"
    // are different operator mistakes with different fixes, and a refusal that
    // cannot tell them apart sends someone to look for a typo in a file that
    // does not exist.
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      outcome: "refused",
      refusal: { reason: "team_sheet_unreadable" }
    });
    expect(auditRows(auditDb, since)).toMatchObject([
      { channel: BROKEN_CHANNEL, outcome: "refused", refusal_reason: "team_sheet_unreadable" }
    ]);
    expect(upstream.received).toHaveLength(served);
  });

it(
  "finds nothing on Object.prototype for a tool named constructor",
  { timeout: CASE_MS },
  async () => {
    const { upstream, auditDb } = rigOf(rig);
    const since = lastAuditId(auditDb);
    const served = upstream.received.length;

    // `constructor` is a perfectly good `ResourceName`, so unlike the Cyrillic
    // and underscore-prefixed near-misses it survives the parse and reaches the
    // gate. The gate scans the sheet's array rather than indexing a lookup
    // object, which is what this case exists to prove from outside the process.
    const answer = await clientOf().send({
      method: "POST",
      path: "/v1/tools/call",
      as: CHANNEL,
      body: { ...permittedCall("call-constructor"), tool: "constructor" }
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      outcome: "refused",
      refusal: { reason: "tool_not_allowed", server: "github", tool: "constructor" }
    });
    expect(auditRows(auditDb, since)).toMatchObject([
      { channel: CHANNEL, tool: "constructor", outcome: "refused", refusal_reason: "tool_not_allowed" }
    ]);
    expect(upstream.received).toHaveLength(served);
  });
