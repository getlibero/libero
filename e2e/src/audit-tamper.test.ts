// #356: a rewritten audit row is detected.
//
// The claim, worded narrowly. The append-only triggers stop the *service* from
// rewriting history in normal operation, and `audit-db.ts` has said since #97
// that they stop nobody who holds the file — DROP TRIGGER, `PRAGMA
// writable_schema`, a hex editor. The chain (#354) is the answer to that actor,
// and `verify` (#355) is how an operator asks. This file is where the two are
// shown working against a log a real proxy wrote through the real serving path,
// read back by the real entrypoint in its own process.
//
// **The attack does what an attacker does.** Every tamper here opens its own
// connection and drops both triggers before touching a row. That is not
// ceremony: the second case below shows the same statements being refused while
// the triggers are on, so what the attacks demonstrate is the layer past them
// rather than a hole in them. A case that tampered through the triggers would
// be asserting they do not work, which is a different and false claim.
//
// **Each attack runs against its own copy of the log**, made with `VACUUM INTO`
// — which preserves the row ids and the triggers, so a copy is a real audit log
// and not a weakened one. Three reasons, in order of weight. `verify` names the
// *first* broken row and stops, so a shared file would make every case after
// the first assert about damage the one before it did. Copying is what an
// operator preserving evidence actually does, and `VACUUM INTO` is the rotation
// shape this log's own README documents, so the copy is a deployment operation
// rather than a testing convenience. And the original stays intact under a
// proxy that is still writing to it, which is what lets the positive control be
// re-run at the end.
//
// The last case is the honest limit rather than a detection: an attacker who
// drops rows from the *end* leaves a shorter chain that is internally perfect,
// and `verify` passes it. What changes is the tip — which is why every surface
// that prints one tells the operator to keep it somewhere the file's holder
// does not control. A suite that showed only the detections would be evidence
// for a claim this design deliberately does not make.

import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CANARY, CHANNEL, auditRows, calls, rigOf, runAuditCli, says, startRig } from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const SHEET = { credential: "e2e_canary", tools: [{ name: "list_prs" }] };

let rig: Rig | undefined;
/** The tip a passing walk printed before anything was touched. */
let cleanTip = "";
let copies = 0;

beforeAll(async () => {
  rig = await startRig({
    sheets: { [CHANNEL]: SHEET },
    // Four calls, so there is a middle to delete from and a tail to truncate.
    // Every one is permitted: this file is about the log, not about enforcement,
    // and a refusal row would be one more thing a reader had to hold.
    script: [
      calls("list_prs", { repo: "getlibero/libero" }),
      says("Two are open."),
      calls("list_prs", { repo: "getlibero/site" }),
      says("One is open."),
      calls("list_prs", { repo: "getlibero/docs" }),
      says("None are open."),
      calls("list_prs", { repo: "getlibero/rfcs" }),
      says("Four checked.")
    ]
  });

  const { agent } = rigOf(rig);
  for (let n = 1; n <= 4; n += 1) {
    const ts = `175800000${n}.000100`;
    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: `<@U0BOTBOTB> what is open in ${n}`,
      ts,
      threadTs: ts,
      eventId: `Ev0000000${n}`
    });
  }
}, SETUP_MS);

afterAll(async () => {
  await rig?.stop();
}, SETUP_MS);

/**
 * A copy of the log as it stands, triggers and row ids intact.
 *
 * `VACUUM INTO` rather than copying the bytes, because the proxy holds the
 * original open in WAL mode: a byte copy would capture a database whose most
 * recent commits are in a `-wal` sidecar it did not take. The source connection
 * is opened **read-only**, which SQLite allows here because the only file this
 * writes is the target — so making evidence cannot alter the evidence.
 *
 * It lands beside the log, in the rig's own temp directory, so the rig's
 * cleanup takes it with everything else.
 */
function snapshot(): string {
  const { auditDb } = rigOf(rig);
  const copy = join(dirname(auditDb), `tamper-${(copies += 1)}.db`);
  const source = new DatabaseSync(auditDb, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${copy}'`);
  } finally {
    source.close();
  }
  return copy;
}

/** What an attacker holding the file does: the triggers first, then the row. */
function tamper(file: string, sql: string): void {
  const raw = new DatabaseSync(file);
  try {
    raw.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_update");
    raw.exec("DROP TRIGGER IF EXISTS tool_call_audit_no_delete");
    raw.exec(sql);
  } finally {
    raw.close();
  }
}

/** `verify`, run as an operator runs it — its own process, its own env. */
async function verify(file: string) {
  return runAuditCli(file, ["verify"]);
}

const idOf = (file: string, index: number): number => {
  const id = auditRows(file).at(index)?.id;
  if (id === undefined) throw new Error(`e2e: no row at index ${index} in ${file}`);
  return id;
};

// ---------------------------------------------------------------------------
// Positive controls. Both of them, first, and neither is a formality: the
// detections below are only meaningful if the log has rows in it and if the
// triggers were doing their job right up to the moment they were dropped.
// ---------------------------------------------------------------------------

it(
  "a governed run leaves a log that verifies",
  async () => {
    const { auditDb } = rigOf(rig);
    const result = await verify(auditDb);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    // The row count, so every detection below is about tampering rather than
    // about an empty table — four permitted calls, four `ran` rows.
    const rows = auditRows(auditDb);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(result.stdout).toContain(`rows: ${rows.length}`);

    const tip = /^tip: {2}([0-9a-f]{64})$/m.exec(result.stdout)?.[1];
    expect(tip).toBeDefined();
    // The tip is the last row's hash, which is what makes it a commitment to the
    // whole file rather than to some row in it.
    expect(tip).toBe(rows.at(-1)?.row_hash);
    cleanTip = tip ?? "";

    // A new surface is a new place for a credential to appear. Narrow claim: the
    // table holds no credential value and this does not reconstruct one.
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
  },
  CASE_MS
);

it(
  "the triggers refuse the same edits while they are still there",
  async () => {
    const file = snapshot();
    const raw = new DatabaseSync(file);
    try {
      expect(() => raw.exec("UPDATE tool_call_audit SET tool = 'delete_repo'")).toThrow(/append-only/);
      expect(() => raw.exec("DELETE FROM tool_call_audit")).toThrow(/append-only/);
    } finally {
      raw.close();
    }

    // And the copy is still a log that verifies, so the refusals above left it
    // exactly as `VACUUM INTO` produced it.
    expect((await verify(file)).status).toBe(0);
  },
  CASE_MS
);

// ---------------------------------------------------------------------------
// The attacks.
// ---------------------------------------------------------------------------

it(
  "a rewritten row is named by verify",
  async () => {
    const file = snapshot();
    const target = idOf(file, 1);
    tamper(file, `UPDATE tool_call_audit SET tool = 'delete_repo' WHERE id = ${target}`);

    const result = await verify(file);

    // The row, by id, and the exit code — not merely that the command ran.
    // #325's habit: a case that asserted only a non-zero status would pass on a
    // verify that crashed, and one that asserted only the exit code would pass
    // on a verify that named the wrong row.
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`broken at row ${target}`);
    expect(result.stderr).toContain("do not hash to the value stored with them");
    // The rows before it still verify, and the walk says how many. One here,
    // because the second row was the one edited.
    expect(result.stderr).toContain("1 row(s) before it verify");
    expect(result.stdout).not.toContain("tip:");
  },
  CASE_MS
);

it(
  "a deleted mid-chain row is detected",
  async () => {
    const file = snapshot();
    const removed = idOf(file, 1);
    const successor = idOf(file, 2);
    tamper(file, `DELETE FROM tool_call_audit WHERE id = ${removed}`);

    const result = await verify(file);

    expect(result.status).toBe(3);
    // The **successor**, not the deleted row: the deleted row is gone, and what
    // is left to observe is that the one after it names a predecessor the file
    // no longer holds. Its own columns still hash correctly, which is why the
    // walk checks the link first and calls this what it is.
    expect(result.stderr).toContain(`broken at row ${successor}`);
    expect(result.stderr).toContain("does not follow the row before it");
    expect(result.stderr).not.toContain(`broken at row ${removed}`);
  },
  CASE_MS
);

it(
  "names only the first break, however many there are",
  async () => {
    const file = snapshot();
    const first = idOf(file, 1);
    const later = idOf(file, 3);
    tamper(file, `UPDATE tool_call_audit SET tool = 'x' WHERE id IN (${first}, ${later})`);

    const result = await verify(file);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`broken at row ${first}`);
    // Everything past the first break was hashed over a predecessor the walk
    // cannot vouch for, so those rows are unverified rather than wrong. Naming
    // the later one would present a guess as a finding.
    expect(result.stderr).not.toContain(`broken at row ${later}`);
    expect(result.stderr).toContain("unverified, not vouched for");
  },
  CASE_MS
);

// ---------------------------------------------------------------------------
// The limit, stated as a case rather than only as a paragraph.
// ---------------------------------------------------------------------------

it(
  "a truncated tail verifies clean, and only the tip says otherwise",
  async () => {
    const file = snapshot();
    const last = idOf(file, -1);
    const before = auditRows(file).length;
    tamper(file, `DELETE FROM tool_call_audit WHERE id = ${last}`);

    const result = await verify(file);

    // Passing, and that is the honest answer: the rows that remain are a
    // complete, internally consistent chain. Nothing inside the file can say a
    // row was removed from the end of it.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`rows: ${before - 1}`);

    // What did change is the tip — the value an operator was told to keep. This
    // is the whole of why `verify` prints it with an instruction attached, and
    // the reason the READMEs say a chain alone is not evidence.
    const tip = /^tip: {2}([0-9a-f]{64})$/m.exec(result.stdout)?.[1];
    expect(cleanTip).toMatch(/^[0-9a-f]{64}$/);
    expect(tip).not.toBe(cleanTip);
  },
  CASE_MS
);

it(
  "the log the proxy is still writing was never touched",
  async () => {
    const { auditDb } = rigOf(rig);

    // Every attack above ran against a copy, so the original still verifies and
    // still ends where it did. Without this, a case that had accidentally
    // tampered with the live file would leave the suite passing and the claim
    // about copies unproven.
    const result = await verify(auditDb);
    expect(result.status).toBe(0);
    // The same tip the first case recorded, which is the strong form: not
    // merely that the log still verifies, but that it verifies to the same
    // value — so nothing was appended to it either.
    expect(result.stdout).toContain(`tip:  ${cleanTip}`);
  },
  CASE_MS
);
