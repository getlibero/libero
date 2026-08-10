// A channel's conversation reaching the model, through real files.
//
// #67's own acceptance criteria are proved in `apps/server`'s context.test.ts,
// over the same `createServer` composition. This file exists for the one claim
// that suite cannot make: that `[llm] max_history_messages` in a real
// `channel.toml` reaches the assembler. There the sheet resolver is stubbed
// with an object; here the number is parsed out of TOML by the shipped schema,
// resolved by the shipped resolver, and applied by the shipped assembler.
//
// It is also the run where the model's transcript actually contains channel
// history, which the canary scan reads — so the standing "no credential on any
// surface" assertion now covers a surface that was empty before.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CHANNEL,
  expectNoCanary,
  rigOf,
  says,
  startRig
} from "./harness/index.js";
import type { Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

const TEAM = "T024BE7LD";

let rig: Rig | undefined;

/** The one seed message the model was asked with on its first turn. */
function transcript(model: Rig["model"]): string {
  const first = model.seen[0];
  const seed = first?.messages[0];
  if (seed === undefined || seed.role !== "user") throw new Error("expected a user message");
  return seed.content;
}

beforeAll(async () => {
  rig = await startRig({
    sheets: {
      [CHANNEL]: {
        credential: "github_token",
        tools: [{ name: "list_prs", approval: "none" }],
        // The number this file exists to follow from the file to the prompt.
        maxHistoryMessages: 3
      }
    },
    users: { U0ALICE: "alice", U0SAM: "Sam" },
    script: [says("Noted.")]
  });
}, SETUP_MS);

afterAll(async () => {
  await rig?.stop();
}, SETUP_MS);

it(
  "assembles a channel's stored messages into the prompt, bounded by its own sheet",
  async () => {
    const { agent, model, surfaces } = rigOf(rig);

    // Five messages, and the sheet asks for three.
    for (const [index, text] of [
      "the staging deploy failed again",
      "same stack trace?",
      "connection refused on the migration step",
      "I rolled back an hour ago",
      "that would explain it"
    ].entries()) {
      await agent.slack.deliverMessage({
        teamId: TEAM,
        channelId: CHANNEL,
        userId: index % 2 === 0 ? "U0SAM" : "U0ALICE",
        text,
        ts: `17580000${String(index).padStart(2, "0")}.000100`
      });
    }

    await agent.slack.deliverMention({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U0ALICE",
      text: "<@U0BOTBOTB> what was the error?",
      ts: "1758000099.000100"
    });

    const seed = transcript(model);

    // Attributed, by the name the directory gave.
    expect(seed).toContain("@Sam: connection refused on the migration step");
    expect(seed).toContain("@alice: I rolled back an hour ago");

    // Bounded by the sheet's own number, newest kept, and it says so.
    expect(seed).not.toContain("the staging deploy failed again");
    expect(seed).toContain("Earlier messages are not shown.");

    // And the channel's text is context rather than instruction — in the user
    // message, never in the system prompt.
    expect(model.seen[0]?.system ?? "").not.toContain("connection refused");

    // The transcript is a canary surface now that it carries history.
    expectNoCanary(surfaces());
  },
  CASE_MS
);
