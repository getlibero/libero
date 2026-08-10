// The two knobs that make the agent misbehave, proven to misbehave.
//
// Neither is an attack case — #134 and #135 are. What this file pins is that
// the knobs do what their names say, so a case built on one is testing the
// property it means to rather than a seam that quietly did nothing. A harness
// option that silently no-ops is worse than one that does not exist: the case
// still passes.

import { afterAll, beforeAll, expect, it } from "vitest";
import { CHANNEL, auditRows, calls, rigOf, says, spendFor, startRig } from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const HELD_SHEET = {
  credential: "e2e_canary",
  tools: [{ name: "merge_pr", approval: "required" as const }]
};

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

describeSpendDropped();
describeNoCards();

function describeSpendDropped(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      spendReports: "dropped",
      script: [calls("list_prs", { repo: "getlibero/libero" }), says("Done.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "spendReports: dropped moves the proxy's own count and not the reported one",
    async () => {
      const { agent, upstream, budgetDb } = rigOf(rig);
      await agent.slack.deliverMention(mention("Ev00000010"));

      // The call really ran, so this is a claim about the meter rather than
      // about a task that never got going.
      expect(upstream.callsTo("tools/call")).toHaveLength(1);

      const spend = spendFor(budgetDb, CHANNEL);
      // Counted by the proxy from a call it served: holds against an agent that
      // says nothing, which is the whole point of #134's narrow claim.
      expect(spend.toolCalls).toBe(1);
      // Counted from what the agent reported, and it reported nothing.
      expect(spend.inputTokens).toBe(0);
      expect(spend.outputTokens).toBe(0);
    },
    CASE_MS
  );
}

function describeNoCards(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      approvals: "none",
      sheets: { [CHANNEL]: HELD_SHEET },
      script: [calls("merge_pr", { number: 42 }), says("I could not do that.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "approvals: none degrades a held call to a refusal, and nothing runs",
    async () => {
      const { agent, upstream, model, auditDb } = rigOf(rig);
      await agent.slack.deliverMention(mention("Ev00000011"));

      // No prompter, so no card was ever posted — the composition read the
      // absent card path rather than posting into a stub that swallowed it.
      expect(agent.slack.cards).toHaveLength(0);

      // The proxy held it, so it decided and audited; what it did not do is run
      // it, because no click ever arrived.
      expect(upstream.callsTo("tools/call")).toHaveLength(0);

      // And the model was told, in the refusal-shaped result the seam documents.
      const transcript = JSON.stringify(model.seen[1]?.messages);
      expect(transcript).toContain("approval");

      // One row, and it is not `ran`. Asserted as an exact shape rather than as
      // "no row says ran", which an empty table would also satisfy.
      const rows = auditRows(auditDb);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: CHANNEL, tool: "merge_pr", outcome: "held" });
    },
    CASE_MS
  );
}
