// The gateway is faked at the SocketSource/MessagePoster seam, not at the
// WebSocket.
//
// socket-mode.test.ts drives the real adapter through an injected client to
// prove it translates the SDK's events correctly. Reusing that here would tie
// every dispatch case to eventemitter3 call shapes — exactly the coupling the
// seam exists to remove. Keep the two apart.

import { describe, expect, it } from "vitest";
import type { LogFields, Logger, LogLevel } from "../log.js";
import { createGateway } from "./gateway.js";
import type { Scheduler } from "./gateway.js";
import { appMentionEnvelope, createStubSlack } from "./stub-slack.js";
import { GatewayError } from "./types.js";
import type { MentionHandler, MessagePoster, SlackMention } from "./types.js";

const BACKOFF = { baseMs: 1_000, maxMs: 30_000, resetAfterMs: 60_000 };

/** Lets a microtask chain settle without waiting on a real backoff. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** A scheduler whose timers only fire when a test says so. */
function manualClock(): {
  scheduler: Scheduler;
  pending: () => number[];
  fire: () => Promise<void>;
} {
  const queue: Array<{ ms: number; fn: () => void }> = [];
  return {
    scheduler: (ms, fn) => {
      const entry = { ms, fn };
      queue.push(entry);
      return () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    pending: () => queue.map(entry => entry.ms),
    async fire(): Promise<void> {
      const next = queue.shift();
      if (next === undefined) throw new Error("no timer was pending");
      next.fn();
      await flush();
    }
  };
}

function captureLogger(): { logger: Logger; lines: Array<{ level: LogLevel } & LogFields> } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return {
    lines,
    logger: {
      log(level, fields): void {
        lines.push({ level, ...fields });
      }
    }
  };
}

/** Records every mention and answers with a fixed reply. */
function recordingHandler(reply?: string): {
  handler: MentionHandler;
  seen: SlackMention[];
} {
  const seen: SlackMention[] = [];
  return {
    seen,
    handler: mention => {
      seen.push(mention);
      return Promise.resolve(reply === undefined ? undefined : { text: reply });
    }
  };
}

/** Fails the test loudly rather than quietly accepting a post that should not happen. */
function forbiddenPoster(): MessagePoster {
  return {
    postThreadReply: () => Promise.reject(new Error("unexpected post"))
  };
}

describe("createGateway", () => {
  it("delivers a mention to the handler and posts the reply into its thread", async () => {
    const slack = createStubSlack();
    const { handler, seen } = recordingHandler("on it");
    const gateway = createGateway({ source: slack.source, poster: slack.poster, handler });

    await gateway.start();
    await slack.deliverMention({ channelId: "C0OPS", ts: "1717171717.000100" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.channelId).toBe("C0OPS");
    // The acceptance criterion, in unit form: the reply lands in a thread on
    // the mentioning message.
    expect(slack.posted).toEqual([
      { channelId: "C0OPS", threadTs: "1717171717.000100", text: "on it" }
    ]);
  });

  it("replies inside the parent thread when the mention was in one", async () => {
    const slack = createStubSlack();
    const { handler } = recordingHandler("still on it");
    const gateway = createGateway({ source: slack.source, poster: slack.poster, handler });

    await gateway.start();
    await slack.deliverMention({ ts: "1717171800.000200", threadTs: "1717171717.000100" });

    expect(slack.posted[0]?.threadTs).toBe("1717171717.000100");
  });

  it("acknowledges the envelope before running the handler", async () => {
    // Slack's ack window is about three seconds and a handler is a model turn.
    // Acking after it means Slack redelivers and the thread gets two answers.
    const order: string[] = [];
    const slack = createStubSlack();
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: () => {
        order.push("handler");
        return Promise.resolve({ text: "hi" });
      }
    });

    await gateway.start();
    await slack.deliver(
      appMentionEnvelope({}, () => {
        order.push("ack");
        return Promise.resolve();
      })
    );

    expect(order).toEqual(["ack", "handler"]);
  });

  it("posts nothing when the handler declines", async () => {
    const slack = createStubSlack();
    const { handler, seen } = recordingHandler();
    const gateway = createGateway({ source: slack.source, poster: forbiddenPoster(), handler });

    await gateway.start();
    await slack.deliverMention();

    expect(seen).toHaveLength(1);
    expect(slack.posted).toHaveLength(0);
  });

  it("answers a redelivered event only once", async () => {
    const slack = createStubSlack();
    const { handler, seen } = recordingHandler("once");
    const gateway = createGateway({ source: slack.source, poster: slack.poster, handler });

    await gateway.start();
    await slack.deliverMention({ eventId: "Ev0SAME" });
    await slack.deliverMention({ eventId: "Ev0SAME" });

    expect(seen).toHaveLength(1);
    expect(slack.posted).toHaveLength(1);
  });

  it("never shows the handler an envelope normalization rejected", async () => {
    const slack = createStubSlack();
    const { handler, seen } = recordingHandler("hi");
    const { logger, lines } = captureLogger();
    const gateway = createGateway({
      source: slack.source,
      poster: forbiddenPoster(),
      handler,
      logger
    });

    await gateway.start();
    const envelope = appMentionEnvelope();
    (envelope.event as Record<string, unknown>)["bot_id"] = "B0BOT";
    await slack.deliver(envelope);

    expect(seen).toHaveLength(0);
    expect(lines.some(line => line.event === "ignored" && line.reason === "bot_message")).toBe(
      true
    );
  });

  it("survives a handler that throws, and answers the next mention", async () => {
    const slack = createStubSlack();
    const { logger, lines } = captureLogger();
    let calls = 0;
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      logger,
      handler: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new TypeError("boom"));
        return Promise.resolve({ text: "recovered" });
      }
    });

    await gateway.start();
    await slack.deliverMention({ eventId: "Ev0FIRST" });
    await slack.deliverMention({ eventId: "Ev0SECOND" });

    // Nothing was posted for the failure: wording a refusal is the loop's job,
    // not the adapter's.
    expect(slack.posted).toEqual([
      { channelId: "C00000000", threadTs: "1717171717.000100", text: "recovered" }
    ]);
    const failure = lines.find(line => line.event === "handler_failed");
    expect(failure?.reason).toBe("TypeError");
    expect(slack.connected()).toBe(true);
  });

  it("survives a failed post and records Slack's own error code", async () => {
    const slack = createStubSlack({
      postFailure: new GatewayError("post_failed", false, { slackError: "not_in_channel" })
    });
    const { logger, lines } = captureLogger();
    const { handler } = recordingHandler("hello");
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler,
      logger
    });

    await gateway.start();
    await slack.deliverMention();

    const failure = lines.find(line => line.event === "post_failed");
    expect(failure?.slackError).toBe("not_in_channel");
    expect(slack.connected()).toBe(true);
  });

  it("dispatches concurrent mentions rather than queueing them", async () => {
    // Serializing a channel's mentions behind a session mutex is the channel
    // router's job. Asserting today's behaviour explicitly means that change
    // shows up as a changed test rather than as a silent one.
    const slack = createStubSlack();
    let inFlight = 0;
    let maxInFlight = 0;
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        inFlight -= 1;
        return { text: "ok" };
      }
    });

    await gateway.start();
    await Promise.all([
      slack.deliverMention({ eventId: "Ev0A" }),
      slack.deliverMention({ eventId: "Ev0B" })
    ]);

    expect(maxInFlight).toBe(2);
    expect(slack.posted).toHaveLength(2);
  });

  it("retries a connect failure that waiting could fix", async () => {
    const clock = manualClock();
    const slack = createStubSlack({
      connectFailures: [new GatewayError("connect_failed", true)]
    });
    const { handler } = recordingHandler("up");
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler,
      backoff: BACKOFF,
      scheduler: clock.scheduler,
      random: () => 1
    });

    const started = gateway.start();
    await flush();
    expect(clock.pending()).toEqual([1_000]);

    await clock.fire();
    await started;
    expect(slack.connected()).toBe(true);
  });

  it("gives up on credentials Slack will never accept", async () => {
    const clock = manualClock();
    const slack = createStubSlack({
      connectFailures: [new GatewayError("auth_rejected", false)]
    });
    const { logger, lines } = captureLogger();
    const { handler } = recordingHandler();
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler,
      logger,
      scheduler: clock.scheduler
    });

    await expect(gateway.start()).rejects.toThrow(GatewayError);
    // No retry was even scheduled: waiting does not fix a revoked token.
    expect(clock.pending()).toEqual([]);
    expect(lines.some(line => line.event === "auth_rejected")).toBe(true);
  });

  it("reconnects after a drop, and answers again once it is back", async () => {
    const clock = manualClock();
    const slack = createStubSlack();
    const { handler, seen } = recordingHandler("back");
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler,
      backoff: BACKOFF,
      scheduler: clock.scheduler,
      random: () => 1
    });

    await gateway.start();
    slack.drop();
    await flush();

    expect(slack.connected()).toBe(false);
    expect(clock.pending()).toEqual([1_000]);

    await clock.fire();
    expect(slack.connected()).toBe(true);

    await slack.deliverMention();
    expect(seen).toHaveLength(1);
  });

  it("runs one reconnect ladder no matter how many drops arrive", async () => {
    // A failed reconnect attempt can itself emit a drop. Two ladders would each
    // hold a timer, and stop() can only cancel the one it knows about.
    const clock = manualClock();
    const slack = createStubSlack();
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: () => Promise.resolve(undefined),
      backoff: BACKOFF,
      scheduler: clock.scheduler,
      random: () => 1
    });

    await gateway.start();
    slack.drop();
    slack.drop();
    slack.drop();
    await flush();

    expect(clock.pending()).toEqual([1_000]);

    await gateway.stop();
    expect(clock.pending()).toEqual([]);
  });

  it("starts the ladder over after a connection that held", async () => {
    const clock = manualClock();
    const slack = createStubSlack();
    let clockMs = 0;
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: () => Promise.resolve(undefined),
      backoff: BACKOFF,
      scheduler: clock.scheduler,
      random: () => 1,
      now: () => clockMs
    });

    await gateway.start();

    // A drop after a short-lived connection advances the ladder.
    clockMs = 5_000;
    slack.drop();
    await flush();
    expect(clock.pending()).toEqual([1_000]);
    await clock.fire();

    clockMs = 6_000;
    slack.drop();
    await flush();
    expect(clock.pending()).toEqual([2_000]);
    await clock.fire();

    // A connection that stayed up past resetAfterMs is evidence nothing is
    // wrong, so a routine Slack recycle does not inherit an outage's delay.
    clockMs = 6_000 + BACKOFF.resetAfterMs;
    slack.drop();
    await flush();
    expect(clock.pending()).toEqual([1_000]);
  });

  it("returns from stop() without waiting out a pending backoff", async () => {
    const clock = manualClock();
    const slack = createStubSlack({
      connectFailures: [
        new GatewayError("connect_failed", true),
        new GatewayError("connect_failed", true)
      ]
    });
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: () => Promise.resolve(undefined),
      backoff: BACKOFF,
      scheduler: clock.scheduler,
      random: () => 1
    });

    const started = gateway.start();
    await flush();
    expect(clock.pending()).toEqual([1_000]);

    await gateway.stop();
    await started;

    // The timer was cancelled rather than left holding the process open, and
    // the loop woke, saw the stop, and did not try again.
    expect(clock.pending()).toEqual([]);
    expect(slack.connected()).toBe(false);
  });

  it("stops dispatching once stopped, and stops twice without complaint", async () => {
    const slack = createStubSlack();
    const { handler, seen } = recordingHandler("late");
    const gateway = createGateway({
      source: slack.source,
      poster: forbiddenPoster(),
      handler
    });

    await gateway.start();
    await gateway.stop();
    await gateway.stop();
    await slack.deliverMention();

    expect(seen).toHaveLength(0);
  });

  it("never writes message text to a log line", async () => {
    // The gateway is where a team's words arrive. Ids identify a thread; what
    // was said belongs to the channel's members and is not an operator's to
    // read out of a log collector.
    const secret = "the deploy password is hunter2";
    const slack = createStubSlack();
    const { logger, lines } = captureLogger();
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: () => Promise.resolve({ text: `echo: ${secret}` }),
      logger
    });

    await gateway.start();
    await slack.deliverMention({ text: `<@U0BOT> ${secret}` });

    const emitted = JSON.stringify(lines);
    expect(emitted).not.toContain("hunter2");
    expect(emitted).not.toContain(secret);
    // And it did log the mention — the assertion above is not passing because
    // nothing was written.
    expect(lines.some(line => line.event === "replied")).toBe(true);
  });
});
