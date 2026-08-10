// #133, property 2, through the agent: the model cannot widen its tool surface.
//
// **Two claims, not one.** The issue asks that every refusal be "the structured
// shape with the right reason, relayed to the thread, and audited", and that is
// true of one of these cases and deliberately false of the other. A name the
// listing never carried is refused by the agent's own map before anything is
// sent — relayed, and *not* audited, because the proxy never saw it and should
// write no row for a call it did not decide. A name the listing did carry
// reaches the gate and is refused there, with a row. Stating them separately is
// the point; a single case would have to be vague about which half held.
//
// The identity half of #133 is in identity.test.ts, because it cannot go
// through the agent at all.
//
// One rig per case, and not for tidiness. `model.seen`'s length is the script
// cursor across every task in a rig, and the catalog is cached per upstream for
// five minutes — so cases sharing a rig would be coupled through two things
// neither of them mentions.

import { afterAll, beforeAll, expect, it } from "vitest";
import { CHANNEL, auditRows, calls, rigOf, says, startRig } from "./harness/index.js";
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

/** The sheet the mid-task case starts from, and loses half of. */
const TWO_TOOLS = {
  credential: "e2e_canary",
  tools: [
    { name: "list_prs", approval: "none" as const },
    { name: "merge_pr", approval: "none" as const }
  ]
};

describeRefusedBeforeTheProxy();
describeRefusedByTheProxy();
describeAmbiguousServer();

function describeRefusedBeforeTheProxy(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      script: [calls("delete_everything", { repo: "getlibero/libero" }), says("I could not do that.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "a name the listing never carried is refused before the proxy, and leaves no row",
    async () => {
      const { agent, upstream, model, auditDb } = rigOf(rig);
      const listed = upstream.received.length;

      await agent.slack.deliverMention(mention("Ev00000020"));

      // The attack was really attempted. Nothing upstream and nothing in the
      // audit log can say so — the proxy was never asked — so this line is the
      // only record there is, which is what #170 added it for.
      const refused = agent
        .log()
        .filter(line => line.level === "warn" && line.fields.event === "tool_not_permitted");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.fields).toMatchObject({ channel: CHANNEL, tool: "delete_everything" });
      expect(refused[0]?.fields.task).toEqual(expect.any(String));

      // And the model was told, so it could try something else rather than the
      // task dying on an invented name.
      expect(JSON.stringify(model.seen[1]?.messages)).toContain("not a tool this channel permits");
      expect(agent.slack.posted).toHaveLength(1);

      // Nothing was sent. Asserted on `received` rather than on `callsTo`,
      // because a refused call must not open a connection at all — the listing's
      // own requests are what `listed` holds out.
      expect(upstream.received.slice(listed).map(request => request.rpc?.method)).not.toContain(
        "tools/call"
      );
      expect(auditRows(auditDb)).toHaveLength(0);
    },
    CASE_MS
  );
}

function describeRefusedByTheProxy(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      sheets: { [CHANNEL]: TWO_TOOLS },
      script: [calls("merge_pr", { number: 42 }), says("I could not do that.")],
      // Between the listing and the call: the loop lists once and only then
      // asks the model, so a sheet rewritten here was in force for neither the
      // listing above nor anything before it, and is in force for the gate.
      // This is an operator revoking a tool while a task is in flight.
      onModelTurn: turn => {
        if (turn !== 1) return;
        const live = rigOf(rig);
        live.channelsRoot.write(CHANNEL, {
          url: live.upstream.url,
          credential: "e2e_canary",
          tools: [{ name: "list_prs", approval: "none" }]
        });
      }
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "a name the listing did carry is refused at the gate, relayed, and audited",
    async () => {
      const { agent, upstream, model, auditDb } = rigOf(rig);
      const before = auditRows(auditDb).length;
      const listed = upstream.received.length;

      await agent.slack.deliverMention(mention("Ev00000021"));

      // The load-bearing assertion of this file. If the rewrite had landed
      // early, `merge_pr` would not be here, the agent's own map would have
      // refused the call, and this case would have quietly become the one
      // above — passing, and testing the wrong half.
      expect(model.seen[0]?.tools?.map(tool => tool.name)).toContain("merge_pr");

      // The proxy decided it, so there is a row, and the reason is the sheet's.
      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: CHANNEL,
        server: "github",
        tool: "merge_pr",
        outcome: "refused",
        refusal_reason: "tool_not_allowed"
      });

      // Refused before dispatch, so the upstream saw the listing's traffic and
      // nothing else.
      expect(upstream.received.slice(listed).map(request => request.rpc?.method)).not.toContain(
        "tools/call"
      );

      // Relayed: the structured refusal became a tool result the model read,
      // and the task answered the thread rather than dying.
      expect(JSON.stringify(model.seen[1]?.messages)).toContain("merge_pr");
      expect(agent.slack.posted).toHaveLength(1);
    },
    CASE_MS
  );
}

function describeAmbiguousServer(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({
      script: [calls("list_prs", { repo: "getlibero/libero" }), says("I could not do that.")]
    });
  }, SETUP_MS);

  afterAll(async () => {
    await rig?.stop();
  }, SETUP_MS);

  it(
    "a tool two blocks disagree about is listed, then refused, and never dialled",
    async () => {
      const { agent, upstream, model, auditDb, channelsRoot } = rigOf(rig);

      // Two blocks with one name and two urls. Written by hand because
      // `SheetSpec` emits a single server block — which is the right default
      // and the wrong thing for the one case that is about disagreement.
      channelsRoot.writeRaw(
        CHANNEL,
        [
          `[channel]`,
          `name = "e2e"`,
          `description = "End-to-end suite."`,
          ``,
          `[llm]`,
          `max_task_seconds = 30`,
          `max_tool_calls_per_task = 5`,
          ``,
          `[budget]`,
          `daily_tokens = 1000000`,
          `daily_tool_calls = 200`,
          ``,
          `[[mcp_server]]`,
          `name = "github"`,
          `transport = "http"`,
          `url = "${upstream.url}"`,
          `credential = "e2e_canary"`,
          ``,
          `  [[mcp_server.tool]]`,
          `  name = "list_prs"`,
          `  approval = "none"`,
          ``,
          `[[mcp_server]]`,
          `name = "github"`,
          `transport = "http"`,
          `url = "${upstream.url}/second"`,
          `credential = "e2e_canary"`,
          ``,
          `  [[mcp_server.tool]]`,
          `  name = "list_prs"`,
          `  approval = "none"`
        ].join("\n")
      );

      const before = auditRows(auditDb).length;
      await agent.slack.deliverMention(mention("Ev00000022"));

      // Listed, because the sheet named it — the listing is not the enforcement,
      // and a tool whose source cannot be resolved loses its description, not
      // its row.
      expect(model.seen[0]?.tools?.map(tool => tool.name)).toContain("list_prs");

      const rows = auditRows(auditDb).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: CHANNEL,
        server: "github",
        tool: "list_prs",
        outcome: "refused",
        refusal_reason: "server_ambiguous"
      });

      // Neither url was dialled, and not just for the call: a sheet the proxy
      // cannot resolve to one upstream gives it nothing to describe either, so
      // the whole task opened no connection at all.
      expect(upstream.received).toHaveLength(0);
      expect(agent.slack.posted).toHaveLength(1);
    },
    CASE_MS
  );
}
