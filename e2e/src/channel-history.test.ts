// #64: `search_channel_history` as a proxied built-in.
//
// The claim under test is **"a built-in is not a bypass"**, and it needs a
// two-process run to mean anything. The gateway writes a channel's messages into
// `store.db` from the in-process agent; the proxy reads them back from its
// spawned process, through a mount, to answer a tool call. Everything between
// those two facts — the sheet, the meter, the audit log — is the same machinery
// an MCP call goes through, and each assertion below is the MCP suite's with the
// server name swapped.
//
// The one thing that is genuinely different is the scope. An MCP tool's
// destination is a url in the sheet; a built-in's is a channel, and the channel
// comes from the client certificate. So the last case here is about the absence
// of a mechanism, and carries a positive control for the reason `expectNoCanary`
// does: an assertion that another channel's text is missing passes just as well
// on a search that returned nothing at all.

import { afterEach, it } from "node:test";
import { expect } from "expect";
import {
  CHANNEL,
  OTHER_CHANNEL,
  auditRows,
  calls,
  rigOf,
  says,
  spendFor,
  startRig
} from "./harness/index.js";
import type { Rig, SheetInput } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/** A sheet that grants the built-in and one upstream tool, so order is visible. */
const GRANTED: SheetInput = {
  tools: [{ name: "list_prs", approval: "none" }],
  builtins: [{ name: "search_channel_history", approval: "none" }]
};

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
}, { timeout: SETUP_MS });

/**
 * Every tool result the model was handed, as text.
 *
 * Assertions here are about what the *tool* returned, and they have to be
 * narrowed to it: the seeded turn already carries a `<channel-history>` block
 * of the channel's recent messages (#67), so a match against the whole
 * transcript would be answered by the context assembler rather than by the
 * tool. That is also the honest account of what this built-in adds — the
 * assembler seeds the last few messages, and `search_channel_history` reaches
 * the rest.
 */
function toolResults(seen: readonly { messages?: readonly unknown[] }[]): string {
  return JSON.stringify(
    seen.flatMap(turn => (turn.messages ?? []).filter(m => (m as { role?: string }).role === "tool"))
  );
}

/** One inbound message, on the `message` subscription that fills the store. */
async function say(
  active: Rig,
  text: string,
  ts: string,
  channelId = CHANNEL,
  threadTs?: string
): Promise<void> {
  await active.agent.slack.deliverMessage({
    teamId: "T024BE7LD",
    channelId,
    userId: "U024BE7LH",
    text,
    ts,
    ...(threadTs !== undefined ? { threadTs } : {})
  });
}

it(
  "answers from the channel's own store, and is metered and audited like any tool",
  { timeout: CASE_MS },
  async () => {
    rig = await startRig({
      sheets: { [CHANNEL]: GRANTED },
      script: [calls("search_channel_history", { query: "vault" }), says("You decided to ship it.")]
    });
    const { agent, upstream, model, auditDb, budgetDb } = rigOf(rig);

    // Written by the agent process, through the real ingest path.
    await say(rig, "we decided to ship the vault behind the sheet", "1758000000.000100");
    await say(rig, "lunch is at one", "1758000000.000200");

    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "<@U0BOTBOTB> what did we decide about the vault",
      ts: "1758000000.000300",
      threadTs: "1758000000.000300",
      eventId: "Ev00000003"
    });

    expect(agent.slack.posted).toHaveLength(1);
    expect(agent.slack.posted[0]).toMatchObject({ text: "You decided to ship it." });

    // The model was offered the tool, with the description and schema the proxy
    // publishes for it. A built-in is described from the proxy's own constants,
    // so unlike an upstream's this can never arrive thin.
    const offered = model.seen[0]?.tools?.find(tool => tool.name === "search_channel_history");
    expect(offered).toBeDefined();
    expect(offered?.description).toContain("Search this Slack channel's message history");

    // The result reached the model, and it is the stored message rather than a
    // refusal. This is the positive control for every negative below: without
    // it they would pass on a search that found nothing.
    const results = toolResults(model.seen);
    expect(results).toContain("we decided to ship the vault behind the sheet");
    // Full-text search and not a dump: the unrelated message was stored and is
    // not in the answer. It *is* in the seeded history block, which is #67's
    // job and a different path — see `toolResults`.
    expect(results).not.toContain("lunch is at one");

    // Nothing left the process. The built-in arm holds no vault and no pool,
    // and the one MCP tool the sheet also grants was never called.
    expect(upstream.callsTo("tools/call")).toHaveLength(0);

    // The audit log has it, under the reserved server name, with the channel
    // the certificate named — there is no other way for it to have got there.
    const rows = auditRows(auditDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: CHANNEL,
      server: "libero",
      tool: "search_channel_history",
      outcome: "ran"
    });

    // And the meter counted it. This is the narrow claim: a built-in draws on
    // the channel's own budget, so it is not a way to do work for free.
    expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(1);
  });

it(
  "is refused, structurally, in a channel whose sheet does not grant it",
  { timeout: CASE_MS },
  async () => {
    rig = await startRig({
      // The default sheet grants an upstream tool and no built-in — obtained by
      // writing nothing, which is the state an operator gets by not opting in.
      sheets: { [CHANNEL]: { tools: [{ name: "list_prs", approval: "none" }] } },
      script: [calls("search_channel_history", { query: "vault" }), says("I could not.")]
    });
    const { agent, model, auditDb, budgetDb } = rigOf(rig);

    await say(rig, "we decided to ship the vault behind the sheet", "1758000000.000100");

    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "<@U0BOTBOTB> what did we decide",
      ts: "1758000000.000300",
      threadTs: "1758000000.000300",
      eventId: "Ev00000003"
    });

    // Never offered, so a well-behaved model would not have asked.
    expect(model.seen[0]?.tools?.map(tool => tool.name)).not.toContain("search_channel_history");

    // The agent's own client refuses a name the listing did not publish, before
    // anything is sent — so the proxy sees no call and rightly writes no row.
    // That is `onUnmappedCall`'s path (#170), and it is why this asserts an
    // empty log rather than a `refused` row.
    expect(auditRows(auditDb)).toHaveLength(0);
    expect(spendFor(budgetDb, CHANNEL).toolCalls).toBe(0);

    // What the model got back is a refusal naming the tool, and no search
    // result. The stored message is still in the seeded history block, which is
    // #67's path and is not what this channel was refused — the tool is.
    const results = toolResults(model.seen);
    expect(results).toContain("not a tool this channel permits");
    expect(results).not.toContain("ship the vault");
  });

it(
  "cannot be pointed at another channel, because there is no argument for it",
  { timeout: CASE_MS },
  async () => {
    rig = await startRig({
      sheets: { [CHANNEL]: GRANTED, [OTHER_CHANNEL]: GRANTED },
      script: [
        // The model asks for another channel by name, in the two spellings an
        // attacker would try. Both are extra keys on a `.strict()` parser.
        calls("search_channel_history", { query: "vault", channel: OTHER_CHANNEL }),
        calls("search_channel_history", { query: "vault" }),
        says("Only this channel.")
      ]
    });
    const { agent, model, auditDb } = rigOf(rig);

    await say(rig, "the vault in this channel", "1758000000.000100");
    await say(rig, "the vault in the other channel", "1758000000.000200", OTHER_CHANNEL);

    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "<@U0BOTBOTB> search everywhere for the vault",
      ts: "1758000000.000300",
      threadTs: "1758000000.000300",
      eventId: "Ev00000003"
    });

    const results = toolResults(model.seen);

    // The forged argument is refused rather than ignored, so the attempt is
    // visible to whoever reads the transcript.
    expect(results).toContain("invalid arguments");

    // The positive control: the honest call in turn 2 did find this channel's
    // message. Without it every assertion here passes on a search that returned
    // nothing, which is the one failure this case must not report as a pass.
    expect(results).toContain("the vault in this channel");

    // And the other channel's conversation is nowhere in what the model saw —
    // not in a tool result, and not in the seeded history either, since the
    // assembler reads the calling channel's store and only that one.
    expect(results).not.toContain("the vault in the other channel");
    expect(JSON.stringify(model.seen)).not.toContain("the vault in the other channel");

    // Both calls are on the log, under this channel. The refused-arguments one
    // is a `ran` row with an error result, because it reached the proxy and the
    // proxy did work on it — the model's arguments are not a governance
    // decision, and `ToolRefusal` has no member for them.
    const rows = auditRows(auditDb);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.channel === CHANNEL)).toBe(true);
    expect(rows.every(row => row.server === "libero")).toBe(true);
  });


it(
  "leaves the calling thread out, and widens the query when nothing holds every word",
  { timeout: CASE_MS },
  async () => {
    // **#522, end to end and in the shape it was reported.** A fact is said
    // top-level; the question about it is asked inside a thread, where the
    // prompt is thread-scoped (#66) and this tool is therefore the only path to
    // the rest of the channel. Two things then went wrong at once and both are
    // asserted below.
    //
    // The asking message is already a row by the time the tool runs, and it
    // shares every word with the query the model writes out of it — so under
    // the index's implicit AND the rows matching all of *what did I do this
    // weekend* were exactly the other questions, and the answer was excluded
    // outright. Measured against the deployment's own `store.db`, the natural
    // query returned only questions.
    rig = await startRig({
      sheets: { [CHANNEL]: GRANTED },
      script: [
        // The question, relayed as the model relays one. Not a trimmed query:
        // the point is that this is what actually gets sent.
        calls("search_channel_history", { query: "what did I do this weekend?" }),
        says("You went to medieval times.")
      ]
    });
    const { agent, model } = rigOf(rig);

    // The answer, top-level and outside the thread the question is asked in.
    await say(rig, "I went to medieval times this weekend", "1758000000.000100");

    // A thread, and the question inside it. The question is stored because
    // Slack delivers a mention on both subscriptions — which is exactly how the
    // model's own words got into the corpus it is told to search.
    await say(rig, "hello", "1758000000.000200");
    await say(
      rig,
      "what did I do this weekend?",
      "1758000000.000300",
      CHANNEL,
      "1758000000.000200"
    );

    await agent.slack.deliverMention({
      teamId: "T024BE7LD",
      channelId: CHANNEL,
      userId: "U024BE7LH",
      text: "what did I do this weekend?",
      ts: "1758000000.000300",
      threadTs: "1758000000.000200",
      eventId: "Ev00000003"
    });

    const results = toolResults(model.seen);

    // The answer came back. Under AND alone this was empty, which is the whole
    // bug: no message contains every word of a question.
    expect(results).toContain("I went to medieval times this weekend");

    // And the model's own question did not, because the thread it was asked in
    // is left out. Without that, the widened retry hands back the question
    // ahead of the answer — bm25 ranks it first, since it matches every term.
    expect(results).not.toContain("what did I do this weekend?");
  });
