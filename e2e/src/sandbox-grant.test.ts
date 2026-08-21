// #396: a channel that did not ask for the sandbox does not get it.
//
// The half of that issue which needs no Docker daemon, and it is deliberately
// its own file for that reason: the strongest claim about a dangerous feature is
// that a deployment which never opted in cannot reach it, and that claim should
// be checked on every machine rather than on the ones that happen to have a
// container runtime. `sandbox-attack.test.ts` is the half that needs one.
//
// **Two refusals, and they are different code.** A name the listing never
// carried is refused by the agent's own map before anything is sent — relayed,
// and not audited, because the proxy never saw it. That is `unlisted-tool.test.ts`'s
// distinction and it holds here for the same reason. What is added is the
// listing itself: a channel with no `[[builtin]]` block is never *offered*
// `run_code`, so a well-behaved model would not ask, and a misbehaving one is
// refused before the proxy is dialled.
//
// One rig per case, per unlisted-tool.test.ts: `model.seen`'s length is the
// script cursor for a rig's whole life.

import { afterAll, beforeAll, expect, it } from "vitest";
import { CHANNEL, auditRows, calls, rigOf, says, spendFor, startRig } from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

describeNotOffered();
describeRefusedWhenAsked();
describeNoRunnerIsNotARefusal();

function describeNotOffered(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      // No `builtins` key at all — the state an operator gets by not opting in,
      // written by writing nothing rather than by writing an exclusion.
      sheets: { [CHANNEL]: { tools: [{ name: "list_prs", approval: "none" }] } },
      script: [says("nothing to do")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it("never offers run_code to a channel whose sheet omits it", async () => {
    const { agent, model, auditDb, budgetDb } = rigOf(rig);
    await agent.slack.deliverMention(mention("Ev00000900"));

    const offered = model.seen[0]?.tools?.map(tool => tool.name) ?? [];
    expect(offered).not.toContain("run_code");
    // The positive half: the listing worked and carried what the sheet *did*
    // grant. Without it, "run_code was not offered" would also pass on a rig
    // whose listing failed entirely.
    expect(offered).toContain("list_prs");

    expect(auditRows(auditDb)).toHaveLength(0);
    expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(0);
  }, CASE_MS);
}

function describeRefusedWhenAsked(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      sheets: { [CHANNEL]: { tools: [{ name: "list_prs", approval: "none" }] } },
      // A model that asks anyway. This is the case the listing assertion above
      // cannot make: a compromised or injected model does not restrict itself to
      // what it was offered, and the refusal has to hold without its cooperation.
      script: [calls("run_code", { code: "print(1)" }), says("refused")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it("refuses a run_code the sheet never granted, before the proxy is dialled", async () => {
    const { agent, auditDb, budgetDb, upstream } = rigOf(rig);
    await agent.slack.deliverMention(mention("Ev00000901"));

    await agent.waitForLog({ event: "tool_not_permitted", channel: CHANNEL }, 1);

    // No row, and that is right rather than a gap: the proxy never saw this
    // call, and a row for a call it did not decide would be a record of
    // something it did not observe.
    expect(auditRows(auditDb)).toHaveLength(0);
    expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(0);
    // And nothing was sent anywhere at all.
    expect(upstream.callsTo("tools/call")).toHaveLength(0);
  }, CASE_MS);
}

/**
 * The deployment most operators run: a sheet that grants the sandbox, and no
 * runner to serve it.
 *
 * `not_implemented` rather than a refusal, and the distinction is the whole
 * point of the case. A refusal would tell the channel it was denied, which is
 * false — the sheet is right, and the deployment is unfinished. It is also the
 * state every other file in this suite is in, so pinning it here is what stops
 * a future rig from quietly composing a runner and changing what those files
 * are testing.
 */
function describeNoRunnerIsNotARefusal(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      sheets: {
        [CHANNEL]: {
          tools: [{ name: "list_prs", approval: "none" }],
          builtins: [{ name: "run_code", approval: "none" }]
        }
      },
      script: [calls("run_code", { code: "print(1)" }), says("done")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it("answers a granted run_code not_implemented when no runner is composed", async () => {
    const { agent, model, auditDb } = rigOf(rig);
    await agent.slack.deliverMention(mention("Ev00000902"));

    // Offered, because the sheet grants it — the listing does not know whether a
    // runner exists and should not.
    expect(model.seen[0]?.tools?.map(tool => tool.name)).toContain("run_code");

    const rows = auditRows(auditDb);
    expect(rows).toHaveLength(1);
    // `unavailable`, not `refused`. The row an operator reads says the proxy had
    // nothing to serve the call, which is true, rather than saying the channel
    // was denied, which is not.
    expect(rows[0]).toMatchObject({ channel: CHANNEL, server: "libero", tool: "run_code", outcome: "unavailable" });
    expect(rows[0]?.refusal_reason ?? null).toBeNull();
  }, CASE_MS);
}
