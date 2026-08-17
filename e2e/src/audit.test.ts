// #98: every proxied call, refusal, and approval is findable.
//
// That sentence is #38's acceptance criterion, and until there was a read path
// it could only be asserted about the *table* — by a harness holding its own
// SELECT, in the same worker that wrote the rows. What it claims, though, is
// about an operator: someone who was not there, has no handle on the process,
// and finds out what happened by running a command.
//
// So this drives three real lifecycles through the rig — a call that ran, a
// call the sheet refused, and a call a human approved — and then asks the
// spawned `dist/audit.js` for each of them. Nothing here reads the file
// directly; `auditRows` is used only to bookmark where the case started, so a
// shared file read forward is still the demonstration `records.ts` describes.
//
// **The property only this file can show** is the connection. The reader opens
// the log read-only while the proxy is still running and still holding it open
// for writing — a second process against a live WAL database, which is the
// thing the unit tests replace with a file nobody is writing. If the read-only
// open were wrong about `-shm`, or the version check were run against a handle
// the proxy had migrated out from under it, this is where it would show.
//
// The credential assertion is here for the reason it is everywhere else in this
// suite: an export is a new surface, and a new surface is a new place for a
// canary to appear. `expectNoCanary` over the CLI's own stdout is the narrow
// claim — the audit table holds no credential value, and the reader does not
// reconstruct one.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CANARY,
  CHANNEL,
  auditRows,
  calls,
  lastAuditId,
  rigOf,
  runAuditCli,
  says,
  startRig,
  waitForApprovalCard
} from "./harness/index.js";
import type { AuditRow, Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const APPROVER = "U0G9QF9C6";

/**
 * Three tools, one per lifecycle.
 *
 * `delete_branch` is held by the destructive-name heuristic rather than by a
 * sheet field, so the approval half exercises the default. `merge_pr` is
 * deliberately *absent* from the sheet below, which is what makes a call to it
 * a refusal the proxy decides rather than an upstream error.
 */
const CATALOG = [
  { name: "list_prs", description: "Lists pull requests.", inputSchema: { type: "object", properties: {} } },
  { name: "merge_pr", description: "Merges a pull request.", inputSchema: { type: "object", properties: {} } },
  {
    name: "delete_branch",
    description: "Deletes a branch.",
    inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] }
  }
];

/**
 * All three, so the listing carries `merge_pr` and the model is offered it.
 *
 * It is revoked mid-task below, which is what makes the refusal one the *proxy*
 * decides. A tool the sheet never named would be refused by the agent's own
 * name map before anything was sent, and would rightly leave no row at all —
 * see `unlisted-tool.test.ts`, which states both halves. This file needs the
 * half that produces a row, because a row is what an operator can find.
 */
const SHEET = {
  credential: "e2e_canary",
  tools: [{ name: "list_prs" }, { name: "merge_pr" }, { name: "delete_branch" }]
};

/** The sheet after the operator revokes `merge_pr`, mid-task. */
const REVOKED = [{ name: "list_prs" }, { name: "delete_branch" }];

/**
 * The turn on which that revocation lands.
 *
 * Two turns per mention and the hook fires before the loop acts on the answer,
 * so turn 3 is the `merge_pr` call of the second mention: after its listing,
 * before its dispatch.
 */
const REVOKE_ON_TURN = 3;

const mention = (eventId: string, text: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text,
  ts: `1758000000.0001${eventId.slice(-2)}`,
  threadTs: `1758000000.0001${eventId.slice(-2)}`,
  eventId
});

/** The ticket the proxy minted for the held call — destructive-call.test.ts's. */
function heldTicket(rows: readonly AuditRow[]): string {
  const held = rows.find(row => row.outcome === "held");
  if (held?.ticket == null) throw new Error("e2e: no held row with a ticket — the call was not held");
  return held.ticket;
}

let rig: Rig | undefined;
let start = 0;

beforeAll(async () => {
  rig = await startRig({
    catalog: CATALOG,
    sheets: { [CHANNEL]: SHEET },
    script: [
      // 1. a call that runs
      calls("list_prs", {}),
      says("Two are open."),
      // 2. a call the sheet does not permit
      calls("merge_pr", {}),
      says("I am not allowed to merge."),
      // 3. a call a human has to approve
      calls("delete_branch", { branch: "stale" }),
      says("Branch deleted."),
      // 4. one more, for the case that reads while the proxy is still writing
      calls("list_prs", {}),
      says("Still two.")
    ],
    onModelTurn: turn => {
      if (turn !== REVOKE_ON_TURN) return;
      const live = rigOf(rig);
      live.channelsRoot.write(CHANNEL, {
        url: live.upstream.url,
        credential: "e2e_canary",
        tools: REVOKED
      });
    }
  });

  const { agent } = rigOf(rig);
  start = lastAuditId(rig.auditDb);

  await agent.slack.deliverMention(mention("Ev00000001", "<@U0BOTBOTB> what is open"));
  await agent.slack.deliverMention(mention("Ev00000002", "<@U0BOTBOTB> merge it"));

  // The approval lifecycle: the mention holds, the click approves, the
  // re-submission runs. Three rows sharing one ticket.
  const pending = agent.slack.deliverMention(mention("Ev00000003", "<@U0BOTBOTB> tidy the branches"));
  // The card is what says the hold has happened and the row is written; reading
  // the ticket before it appears is a race the run would lose intermittently.
  const card = await waitForApprovalCard(agent);
  // The ticket comes off the proxy's own `held` row rather than being invented
  // here — the card offers the proxy's id, and a click has to carry it back.
  const ticket = heldTicket(auditRows(rig.auditDb, start));
  await agent.slack.deliverDecision({
    teamId: "T024BE7LD",
    channelId: CHANNEL,
    userId: APPROVER,
    ticketId: ticket,
    verdict: "approve",
    messageTs: card?.messageTs ?? "",
    threadTs: card?.threadTs ?? ""
  });
  await pending;
}, SETUP_MS);

afterAll(async () => {
  await rig?.stop();
}, SETUP_MS);

/** The command, run as an operator runs it, against the log the proxy is writing. */
async function audit(...args: string[]) {
  const { auditDb } = rigOf(rig);
  const result = await runAuditCli(auditDb, [...args, "--after", String(start)]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

it(
  "finds the call that ran, the call that was refused, and the call a human approved",
  async () => {
    const { model } = rigOf(rig);

    // The guard `unlisted-tool.test.ts` names: if the revocation had landed
    // before the listing, the model would never have been offered `merge_pr`,
    // its own name map would have refused the call, no row would exist, and
    // this case would have quietly become a test of the wrong half.
    expect(model.seen[0]?.tools?.map(tool => tool.name)).toContain("merge_pr");

    const listed = await audit("list");

    // Every lifecycle, by the words the proxy recorded.
    expect(listed).toContain("github.list_prs");
    expect(listed).toContain("ran");
    expect(listed).toContain("github.merge_pr");
    expect(listed).toContain("refused");
    expect(listed).toContain("tool_not_allowed");
    expect(listed).toContain("github.delete_branch");
    expect(listed).toContain("held");
    expect(listed).toContain("approved");
    expect(listed).toContain(APPROVER);
  },
  CASE_MS
);

it(
  "reads the log while the proxy is still writing it",
  async () => {
    const { agent } = rigOf(rig);

    const before = (await audit("csv")).trimEnd().split("\n").length;

    // The proxy is still up and still holding the file open for writing —
    // proved by it serving another call rather than asserted about the process,
    // because serving one is what makes the next read a read of a live WAL
    // database. A read against a cleanly-closed file is the easy half.
    await agent.slack.deliverMention(mention("Ev00000009", "<@U0BOTBOTB> what is open again"));

    // A row the proxy wrote after the first read is visible to the second, from
    // a separate process, with no restart and no checkpoint.
    const after = (await audit("csv")).trimEnd().split("\n").length;
    expect(after).toBeGreaterThan(before);
  },
  CASE_MS
);

it(
  "filters compose, and an empty result is an empty result",
  async () => {
    expect(await audit("list", "--outcome", "refused")).toContain("merge_pr");
    expect(await audit("list", "--outcome", "refused")).not.toContain("list_prs");

    // Channel plus outcome plus tool, all at once.
    const composed = await audit("list", "--channel", CHANNEL, "--outcome", "ran", "--tool", "list_prs");
    expect(composed).toContain("list_prs");
    expect(composed).not.toContain("merge_pr");

    // Nothing matched is success with a sentence, not an error — asserted
    // through `audit`, which already requires status 0 and an empty stderr.
    expect(await audit("list", "--channel", "C0NOBODY")).toContain("no rows matched");
  },
  CASE_MS
);

it(
  "exports a CSV carrying every lifecycle, and no credential",
  async () => {
    const csv = await audit("csv");
    const [header, ...records] = csv.trimEnd().split("\n");

    expect(header).toBe(
      "id,at,channel,requesting_user,task,request_id,call_id,server,tool,arguments_sha256," +
        "outcome,refusal_reason,budget_limit,day_spend_micro_usd,price_version," +
        "result_bytes,result_is_error,approver,ticket"
    );
    expect(records.length).toBeGreaterThanOrEqual(6);
    expect(csv).toContain("list_prs");
    expect(csv).toContain("merge_pr");
    expect(csv).toContain("delete_branch");
    expect(csv).toContain(APPROVER);

    // An export is a new surface. The table holds no credential value and this
    // does not reconstruct one — the narrow claim, and the true one.
    expect(csv).not.toContain(CANARY);

    // The approval's rows share one ticket, which is what ties four requests
    // together for someone reading this file a month later.
    const tickets = records
      .map(line => line.split(",").at(-1))
      .filter((ticket): ticket is string => ticket !== undefined && ticket !== "");
    expect(new Set(tickets).size).toBe(1);
    expect(tickets.length).toBeGreaterThanOrEqual(3);
  },
  CASE_MS
);

it(
  "cannot write to the log it reads",
  async () => {
    const { auditDb } = rigOf(rig);
    const before = await audit("csv");

    // There is no verb for it — the surface is the assertion, as the vault
    // CLI's "no get command" test is.
    for (const verb of ["delete", "prune", "rotate", "reset"]) {
      const result = await runAuditCli(auditDb, [verb, "1"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown command");
    }

    expect(await audit("csv")).toBe(before);
  },
  CASE_MS
);
