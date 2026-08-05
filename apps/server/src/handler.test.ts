// The mapping, and nothing else. What the router does with a request is
// session/router.test.ts; what a task does with settings is session/task.test.ts.
//
// It is worth its own tests because it is the seam a second front-end writes
// its own version of: if the field a request's channel comes from ever drifts,
// every certificate, every team sheet, and every session key drifts with it.

import type { SlackMention } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { createMentionHandler } from "./handler.js";
import type { TaskReply, TaskRequest } from "./session/types.js";

function mention(partial: Partial<SlackMention> = {}): SlackMention {
  return {
    teamId: "T024BE7LD",
    channelId: "C024BE91L",
    userId: "U024BE7LH",
    text: "<@U0BOT> what is the deploy window?",
    ts: "1758000000.000100",
    threadTs: "1758000000.000100",
    eventId: "Ev0PV52K25",
    ...partial
  };
}

/** Captures what the router was handed, and answers with whatever it was given. */
function recordingRouter(reply: TaskReply | undefined = { text: "ok" }): {
  seen: TaskRequest[];
  route: (request: TaskRequest) => Promise<TaskReply | undefined>;
} {
  const seen: TaskRequest[] = [];
  return {
    seen,
    route: request => {
      seen.push(request);
      return Promise.resolve(reply);
    }
  };
}

describe("createMentionHandler", () => {
  it("maps a mention to a request", async () => {
    const router = recordingRouter();
    const handler = createMentionHandler(router.route);

    await handler(mention());

    expect(router.seen).toEqual([
      {
        // `team_id` is Slack's word; `workspace` is the router's, and this is
        // the one place the two meet.
        key: { workspace: "T024BE7LD", channel: "C024BE91L" },
        requestingUser: "U024BE7LH",
        text: "<@U0BOT> what is the deploy window?",
        traceId: "Ev0PV52K25"
      }
    ]);
  });

  it("leaves the mention token in the text", async () => {
    // Stripping it and resolving display names is the context assembler's (#67).
    const router = recordingRouter();
    const handler = createMentionHandler(router.route);

    await handler(mention({ text: "<@U0BOT> ping" }));

    expect(router.seen[0]?.text).toBe("<@U0BOT> ping");
  });

  it("carries no Slack timestamp into the request", async () => {
    // `ts` and `thread_ts` are where a reply goes, which is the gateway's
    // business. A request carries what was asked and by whom, and #66 is what
    // decides whether the router ever needs to know about a thread.
    const router = recordingRouter();
    const handler = createMentionHandler(router.route);

    await handler(mention());

    expect(JSON.stringify(router.seen[0])).not.toContain("1758000000.000100");
  });

  it("posts the router's reply", async () => {
    const handler = createMentionHandler(recordingRouter({ text: "Fridays, 14:00 UTC." }).route);

    await expect(handler(mention())).resolves.toEqual({ text: "Fridays, 14:00 UTC." });
  });

  it("posts nothing when the router replies with nothing", async () => {
    const handler = createMentionHandler(() => Promise.resolve(undefined));

    await expect(handler(mention())).resolves.toBeUndefined();
  });

  it("propagates a rejection to the gateway", async () => {
    // The gateway logs it as `handler_failed` and posts nothing. Swallowing it
    // here would put a synthesized answer in someone's thread.
    const handler = createMentionHandler(() => Promise.reject(new Error("connect ECONNREFUSED")));

    await expect(handler(mention())).rejects.toThrow(/ECONNREFUSED/);
  });
});
