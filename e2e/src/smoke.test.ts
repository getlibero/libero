// The rig itself: a benign mention, all the way through both halves.
//
// Nothing here is an attack. What it proves is that the machinery the attack
// cases stand on actually works end to end — that a mention reaches the model,
// that the model's tool call crosses a real mutual-TLS connection to a separate
// process, that the proxy resolves the channel from the certificate, reads that
// channel's sheet, resolves the credential from the vault, calls the upstream,
// redacts the reply, meters it, audits it, and that the answer comes back as a
// thread reply.
//
// If this file fails, no assertion in #132-#135 means anything, which is why it
// asserts on every stage rather than only on the reply.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CANARY,
  CHANNEL,
  auditRows,
  calls,
  expectNoCanary,
  says,
  spendFor,
  startRig
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

// Real time throughout: the loop's wall clock is `AbortSignal.timeout`, which
// no fake timer can drive. So these are generous, and the sheet's own
// max_task_seconds is what fails a hang with a reason.
const SETUP_MS = 60_000;
const CASE_MS = 30_000;

let rig: Rig;

beforeAll(async () => {
  rig = await startRig({
    // Turn 1 calls the tool, turn 2 answers. The name is the bare `list_prs`
    // rather than `github__list_prs`: the flat name a model sees is chosen from
    // the server and tool alone, and a one-server sheet never collides.
    script: [calls("list_prs", { repo: "getlibero/libero" }), says("Two are open.")]
  });
}, SETUP_MS);

afterAll(async () => {
  await rig.stop();
}, SETUP_MS);

it(
  "a benign mention completes a permitted tool call through the composed pair",
  async () => {
    const before = auditRows(rig.auditDb).length;

    await rig.agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "<@U0BOTBOTB> what is open",
      ts: "1758000000.000100",
      threadTs: "1758000000.000100",
      eventId: "Ev00000001"
    });

    // The answer, in the thread.
    expect(rig.agent.slack.posted).toHaveLength(1);
    expect(rig.agent.slack.posted[0]).toMatchObject({
      channelId: CHANNEL,
      text: "Two are open."
    });

    // The model was given the tool, and got a result back rather than a refusal.
    const offered = rig.model.seen[0]?.tools?.map(tool => tool.name);
    expect(offered).toContain("list_prs");
    expect(JSON.stringify(rig.model.seen[1]?.messages)).toContain("role\":\"tool");

    // The call really left the proxy, as the channel's sheet named it.
    expect(rig.upstream.callsTo("tools/call")).toHaveLength(1);

    // The positive control. Without this, every assertion below passes just as
    // well on a run where no credential was ever resolved — which is the one
    // failure a leak suite must not report as a pass.
    expect(rig.upstream.callsTo("tools/call")[0]?.authorization).toBe(`Bearer ${CANARY}`);

    // And the credential is on no surface this process can see.
    expectNoCanary(rig.surfaces());

    // The proxy wrote the call down. The channel is the one the certificate
    // named — there is no other way for it to have got there.
    const rows = auditRows(rig.auditDb).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: CHANNEL,
      server: "github",
      tool: "list_prs",
      outcome: "ran"
    });

    // And metered it. Tool calls are the proxy's own count, so they hold against
    // a compromised agent; the four token counts are what the agent reported per
    // turn, which holds against a prompt-injected model and no further. The
    // meter stores them raw and weighs them itself — which is why there are
    // four numbers here and never a total.
    const spend = spendFor(rig.budgetDb, CHANNEL);
    expect(spend.toolCalls).toBe(1);
    expect(spend.inputTokens).toBeGreaterThan(0);
    expect(spend.outputTokens).toBeGreaterThan(0);
  },
  CASE_MS
);
