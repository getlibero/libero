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
        thread: "1758000000.000100",
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

  it("carries the thread and no other Slack timestamp", async () => {
    // #66 decided this, and the earlier version of this test said it would.
    // The router needs a thread — it is what the transcript is read from and
    // what a follow-up is matched against — and it needs nothing else Slack
    // times. The mention's own `ts` is where a reply goes, which stays the
    // gateway's business.
    const router = recordingRouter();
    const handler = createMentionHandler(
      router.route
    );

    await handler(mention({ ts: "1758000000.000900", threadTs: "1758000000.000100" }));

    expect(router.seen[0]?.thread).toBe("1758000000.000100");
    expect(JSON.stringify(router.seen[0])).not.toContain("1758000000.000900");
  });

  it("uses the reply target as the thread, so a top-level mention gets its own", async () => {
    // `SlackMention.threadTs` is already `thread_ts ?? ts`, so a mention that
    // starts a thread names the thread it is about to start. That is the right
    // identity either way: the answer lands there, and so does the reply to it.
    const router = recordingRouter();
    const handler = createMentionHandler(router.route);

    await handler(mention({ ts: "1758000000.000900", threadTs: "1758000000.000900" }));

    expect(router.seen[0]?.thread).toBe("1758000000.000900");
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

  // The card needs the mention's channel and thread, and this is where they are
  // captured: on the Slack side of the seam, so what crosses into the router is
  // a closure. The timestamp test above still passes — a function does not
  // stringify — which is exactly the invariant: the router carries the ability
  // to ask, never the Slack facts behind it.
  it("builds the held-call prompter for the mention's channel and thread", async () => {
    const router = recordingRouter();
    const targets: Array<{ channelId: string; threadTs: string }> = [];
    const prompter = () => Promise.resolve();
    const handler = createMentionHandler(router.route, target => {
      targets.push(target);
      return prompter;
    });

    await handler(mention({ threadTs: "1758000000.000042" }));

    expect(targets).toEqual([{ channelId: "C024BE91L", threadTs: "1758000000.000042" }]);
    expect(router.seen[0]?.onHeld).toBe(prompter);
  });

  it("builds no prompter when no factory was given", async () => {
    const router = recordingRouter();
    const handler = createMentionHandler(router.route);

    await handler(mention());

    expect(router.seen[0]?.onHeld).toBeUndefined();
    expect("onHeld" in (router.seen[0] ?? {})).toBe(false);
  });
});
