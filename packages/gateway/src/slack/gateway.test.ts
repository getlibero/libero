// The gateway is faked at the SocketSource/MessagePoster seam, not at the
// WebSocket.
//
// socket-mode.test.ts drives the real adapter through an injected client to
// prove it translates the SDK's events correctly. Reusing that here would tie
// every dispatch case to eventemitter3 call shapes — exactly the coupling the
// seam exists to remove. Keep the two apart.

import type { ApprovalTicket } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import type { LogFields, Logger, LogLevel } from "../log.js";
import { renderApprovalCard } from "./approval-card.js";
import { createGateway } from "./gateway.js";
import type { Scheduler } from "./gateway.js";
import {
  STUB_APP_USER_ID,
  STUB_WORKSPACE_ID,
  appMentionEnvelope,
  blockActionsEnvelope,
  createStubSlack
} from "./stub-slack.js";
import { GatewayError } from "./types.js";
import type {
  MentionHandler,
  MessageHandler,
  MessagePoster,
  RevisionHandler,
  SlackDecision,
  SlackMention,
  SlackMessage,
  SlackRevision
} from "./types.js";

const BACKOFF = { baseMs: 1_000, maxMs: 30_000, resetAfterMs: 60_000 };

const TICKET: ApprovalTicket = {
  id: "0f2c9b3e-7a41-4c0d-9d2b-6e1f5a8c3b90",
  expiresAt: 1_749_998_700_123
};

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
    // Concurrent dispatch is the correct behaviour here, not a placeholder for
    // it. Dispatch acknowledges the inbound event, and a mention queued behind
    // a slow task must not hold that acknowledgement — so the channel router
    // serializes above this file, and this stays asserted.
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

  it("reports a token revoked after start, which start() can no longer throw", async () => {
    // The gap this closes: start() resolved, so its rejection is long spent,
    // and the ladder stops on a non-retryable failure. Without the callback the
    // process stays up, healthy to every probe, and never answers again.
    const clock = manualClock();
    const slack = createStubSlack({
      connectFailures: [undefined, new GatewayError("auth_rejected", false)]
    });
    const fatal: GatewayError[] = [];
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: () => Promise.resolve(undefined),
      backoff: BACKOFF,
      scheduler: clock.scheduler,
      random: () => 1,
      onFatal: error => fatal.push(error)
    });

    await gateway.start();
    slack.drop();
    await flush();
    await clock.fire();
    await flush();

    expect(fatal.map(error => error.reason)).toEqual(["auth_rejected"]);
    // And no further ladder is left running behind it.
    expect(clock.pending()).toEqual([]);
  });

  it("swallows the same failure when no onFatal was given", async () => {
    // The default is what this did before the seam existed: a composing app
    // that has no opinion does not get an unhandled rejection.
    const clock = manualClock();
    const slack = createStubSlack({
      connectFailures: [undefined, new GatewayError("auth_rejected", false)]
    });
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
    await flush();
    await expect(clock.fire()).resolves.toBeUndefined();
    await flush();

    expect(slack.connected()).toBe(false);
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

  describe("draining on stop", () => {
    /**
     * A handler that blocks until the test lets it go.
     *
     * `finished` is what a drain assertion needs and a resolved promise cannot
     * give: the question is whether `stop()` returned *before* the handler got
     * to its own last line, and only the handler can say when that was.
     */
    function blockingHandler(): {
      handler: MentionHandler;
      release: () => void;
      finished: () => boolean;
    } {
      let release: (() => void) | undefined;
      let finished = false;
      return {
        finished: () => finished,
        release: () => release?.(),
        handler: async () => {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          finished = true;
          return undefined;
        }
      };
    }

    it("waits for a dispatch that was already running", async () => {
      const clock = manualClock();
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const blocked = blockingHandler();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: blocked.handler,
        scheduler: clock.scheduler,
        logger
      });

      await gateway.start();
      const inFlight = slack.deliverMention();
      await flush();

      let stopped = false;
      const stopping = gateway.stop({ drainMs: 8_000 }).then(() => {
        stopped = true;
      });
      await flush();

      // The socket is closed and dispatching has stopped, but the drain is
      // still holding: this is the window the spend report lands in.
      expect(slack.connected()).toBe(false);
      expect(stopped).toBe(false);
      expect(blocked.finished()).toBe(false);

      blocked.release();
      await stopping;
      await inFlight;

      expect(blocked.finished()).toBe(true);
      expect(lines).toContainEqual(expect.objectContaining({ event: "drained", dispatches: 1 }));
      // The bound was cancelled rather than left holding the process open.
      expect(clock.pending()).toEqual([]);
    });

    it("gives up at the bound, and says how much it abandoned", async () => {
      const clock = manualClock();
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const blocked = blockingHandler();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: blocked.handler,
        scheduler: clock.scheduler,
        logger
      });

      await gateway.start();
      void slack.deliverMention();
      await flush();

      let stopped = false;
      const stopping = gateway.stop({ drainMs: 8_000 }).then(() => {
        stopped = true;
      });
      await flush();
      expect(stopped).toBe(false);
      expect(clock.pending()).toEqual([8_000]);

      await clock.fire();
      await stopping;

      // Exceeding the bound is logged rather than silent, and the handler is
      // still running: a drain abandons work, it does not cancel it. What
      // cancels a task is the composing app's own signal, before `stop()`.
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: "warn",
          event: "drain_timeout",
          drainMs: 8_000,
          dispatches: 1
        })
      );
      expect(blocked.finished()).toBe(false);
    });

    it("drains a click, not only a mention", async () => {
      const clock = manualClock();
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      let release: (() => void) | undefined;
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onDecision: () =>
          new Promise<void>(resolve => {
            release = resolve;
          }),
        scheduler: clock.scheduler,
        logger
      });

      await gateway.start();
      const inFlight = slack.deliverDecision({ ticketId: TICKET.id });
      await flush();

      let stopped = false;
      const stopping = gateway.stop({ drainMs: 8_000 }).then(() => {
        stopped = true;
      });
      await flush();
      expect(stopped).toBe(false);

      release?.();
      await stopping;
      await inFlight;

      expect(lines).toContainEqual(expect.objectContaining({ event: "drained", dispatches: 1 }));
    });

    it("returns without waiting when no drain was asked for", async () => {
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const blocked = blockingHandler();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: blocked.handler,
        logger
      });

      await gateway.start();
      const inFlight = slack.deliverMention();
      await flush();

      // The pre-#118 contract, and still the default: a composing app that has
      // not said how long it can wait gets the socket closed and nothing else.
      await gateway.stop();
      expect(blocked.finished()).toBe(false);
      expect(lines.some(line => line.event === "drained")).toBe(false);

      blocked.release();
      await inFlight;
    });

    it("schedules no timer and logs nothing when nothing is in flight", async () => {
      const clock = manualClock();
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        scheduler: clock.scheduler,
        logger
      });

      await gateway.start();
      await slack.deliverMention();
      await gateway.stop({ drainMs: 8_000 });

      // A quiet shutdown is the common one, and a `drained: 0` line on every
      // restart would be noise rather than information.
      expect(clock.pending()).toEqual([]);
      expect(lines.some(line => line.event === "drained")).toBe(false);
    });
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

  describe("ordinary messages", () => {
    /** Records every message the gateway hands down. */
    function recordingIngest(): { onMessage: MessageHandler; seen: SlackMessage[] } {
      const seen: SlackMessage[] = [];
      return {
        seen,
        onMessage: message => {
          seen.push(message);
          return Promise.resolve(undefined);
        }
      };
    }

    it("hands a normalized message down with its raw thread ts", async () => {
      const slack = createStubSlack();
      const { onMessage, seen } = recordingIngest();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage
      });

      await gateway.start();
      await slack.deliverMessage({ channelId: "C0OPS", ts: "1717171717.000300" });
      await slack.deliverMessage({
        channelId: "C0OPS",
        ts: "1717171717.000400",
        threadTs: "1717171717.000300"
      });

      expect(seen.map(message => message.threadTs)).toEqual([null, "1717171717.000300"]);
    });

    it("acknowledges a message before running the handler", async () => {
      const order: string[] = [];
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage: () => {
          order.push("handler");
          return Promise.resolve(undefined);
        }
      });

      await gateway.start();
      await slack.deliverMessage();

      expect(order).toEqual(["handler"]);
      expect(slack.acked).toHaveLength(1);
    });

    it("acknowledges and drops a message when nothing composed a handler", async () => {
      // The subscription belongs to the Slack app, not to what this process
      // wired up. Not subscribing is not an option — an unacknowledged envelope
      // is redelivered forever.
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined)
      });

      await gateway.start();
      await slack.deliverMessage();

      expect(slack.acked).toHaveLength(1);
    });

    it("posts nothing for a message the handler does not answer", async () => {
      // `forbiddenPoster` rejects, so a path that tried would fail loudly. This
      // is the ordinary case and stays the default: a message is recorded and
      // not answered unless the layer above says otherwise.
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage: () => Promise.resolve(undefined)
      });

      await gateway.start();
      await slack.deliverMessage();
      await flush();
    });

    it("posts an answered message back into its own thread", async () => {
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onMessage: () => Promise.resolve({ text: "reverted" })
      });

      await gateway.start();
      await slack.deliverMessage({
        channelId: "C0OPS",
        ts: "1717171717.000400",
        threadTs: "1717171717.000300"
      });

      expect(slack.posted).toEqual([
        { channelId: "C0OPS", threadTs: "1717171717.000300", text: "reverted" }
      ]);
    });

    it("refuses to start a thread on a top-level message it answered", async () => {
      // The one thing this path must not be able to do. `threadTs ?? ts` here
      // would post into the channel on a message nobody addressed the app in,
      // so the answer is dropped and said out loud instead.
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        logger,
        onMessage: () => Promise.resolve({ text: "an answer with nowhere to go" })
      });

      await gateway.start();
      await slack.deliverMessage({ channelId: "C0OPS" });
      await flush();

      expect(slack.posted).toEqual([]);
      expect(lines.find(line => line.reason === "no_thread")).toMatchObject({
        level: "warn",
        event: "ignored",
        channel: "C0OPS"
      });
    });

    it("logs a follow-up rather than a reply when a message is answered", async () => {
      // Its own word: "how often does this agent answer people who did not
      // address it" is the question #66 creates, and it should be one grep.
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        logger,
        onMessage: () => Promise.resolve({ text: "reverted" })
      });

      await gateway.start();
      await slack.deliverMessage({ channelId: "C0OPS", threadTs: "1717171717.000300" });

      expect(lines.find(line => line.event === "follow_up")).toMatchObject({
        level: "info",
        channel: "C0OPS",
        threadTs: "1717171717.000300"
      });
      expect(lines.some(line => line.event === "replied")).toBe(false);
    });

    it("logs post_failed and stays up when a follow-up cannot be posted", async () => {
      const slack = createStubSlack({
        postFailure: new GatewayError("post_failed", false, { slackError: "not_in_channel" })
      });
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        logger,
        onMessage: () => Promise.resolve({ text: "reverted" })
      });

      await gateway.start();
      await slack.deliverMessage({ channelId: "C0OPS", threadTs: "1717171717.000300" });

      expect(lines.find(line => line.event === "post_failed")).toMatchObject({
        level: "error",
        channel: "C0OPS",
        slackError: "not_in_channel"
      });
      expect(slack.connected()).toBe(true);
    });

    it("does not post an answer that arrived after the gateway stopped", async () => {
      const slack = createStubSlack();
      let release: (() => void) | undefined;
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage: async () => {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          return { text: "too late" };
        }
      });

      await gateway.start();
      const inFlight = slack.deliverMessage({ threadTs: "1717171717.000300" });
      await flush();
      await gateway.stop();
      release?.();
      await inFlight;

      expect(slack.posted).toEqual([]);
    });

    it("loses one message and stays up when the handler throws", async () => {
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      let calls = 0;
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        logger,
        onMessage: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new GatewayError("post_failed", false))
            : Promise.resolve(undefined);
        }
      });

      await gateway.start();
      await slack.deliverMessage({ ts: "1717171717.000300", channelId: "C0OPS" });
      await slack.deliverMessage({ ts: "1717171717.000400" });

      expect(calls).toBe(2);
      const failed = lines.find(line => line.event === "message_failed");
      expect(failed).toMatchObject({ level: "error", channel: "C0OPS", reason: "post_failed" });
    });

    it("logs nothing at all for a message that arrives and is handled", async () => {
      // Deliberate, and the argument is in `dispatchMessage`: ids are legal in a
      // log line, but one line per message turns stdout into a record of who
      // spoke in which channel and when. A drop is silent for the same reason.
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        logger,
        onMessage: () => Promise.resolve(undefined)
      });

      await gateway.start();
      const before = lines.length;
      await slack.deliverMessage();
      await slack.deliverMessage({ ts: "1717171717.000400", subtype: "channel_join" });
      await slack.deliverMessage({ ts: "1717171717.000500", botId: "B0BOT" });

      expect(lines.slice(before)).toEqual([]);
    });

    it("does not spend the mention dedupe budget on messages", async () => {
      // `seen` is bounded and evicts oldest-first. If messages went in, a busy
      // workspace would flush every remembered mention id and a redelivered
      // mention would run a second model turn. The store's own UNIQUE ts is what
      // makes a redelivered message a no-op instead.
      const slack = createStubSlack();
      const { handler, seen } = recordingHandler("on it");
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onMessage: () => Promise.resolve(undefined)
      });

      await gateway.start();
      await slack.deliverMention({ eventId: "Ev0MENTION" });
      for (let i = 0; i < 1_100; i += 1) {
        await slack.deliverMessage({ eventId: `Ev0MSG${i}`, ts: `1717171717.${i}` });
      }
      await slack.deliverMention({ eventId: "Ev0MENTION" });

      expect(seen).toHaveLength(1);
    });

    it("stops handing messages down once the gateway has stopped", async () => {
      const slack = createStubSlack();
      const { onMessage, seen } = recordingIngest();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage
      });

      await gateway.start();
      await gateway.stop();
      await slack.deliverMessage();

      expect(seen).toHaveLength(0);
    });
  });

  describe("deletions and edits", () => {
    /** Records every revision the gateway hands down. */
    function recordingMirror(): { onRevision: RevisionHandler; seen: SlackRevision[] } {
      const seen: SlackRevision[] = [];
      return {
        seen,
        onRevision: revision => {
          seen.push(revision);
          return Promise.resolve();
        }
      };
    }

    it("routes a deletion and an edit off the message subscription", async () => {
      // One subscription carries all three. What decides where an envelope goes
      // is `toMessage`'s answer, so this also proves the two paths do not
      // overlap: neither revision reaches `onMessage`.
      const slack = createStubSlack();
      const { onRevision, seen } = recordingMirror();
      const messages: SlackMessage[] = [];
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage: message => {
          messages.push(message);
          return Promise.resolve(undefined);
        },
        onRevision
      });

      await gateway.start();
      await slack.deliverRevision({ kind: "deleted", channelId: "C0OPS", ts: "1717171717.000300" });
      await slack.deliverRevision({
        kind: "edited",
        channelId: "C0OPS",
        ts: "1717171717.000400",
        text: "the deploy went out at five"
      });

      expect(seen).toEqual([
        {
          kind: "deleted",
          teamId: "T00000000",
          channelId: "C0OPS",
          ts: "1717171717.000300",
          eventId: "Ev00000003"
        },
        {
          kind: "edited",
          teamId: "T00000000",
          channelId: "C0OPS",
          ts: "1717171717.000400",
          text: "the deploy went out at five",
          eventId: "Ev00000003"
        }
      ]);
      expect(messages).toHaveLength(0);
    });

    it("acknowledges a revision exactly once, before the handler runs", async () => {
      // The ack happens in `dispatchMessage`, before the envelope's kind is
      // known — the only order Slack's three-second window allows. The count is
      // the assertion: a revision path that acked again would ack an envelope
      // Slack has already stopped waiting on.
      const order: string[] = [];
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onRevision: () => {
          order.push("handler");
          return Promise.resolve();
        }
      });

      await gateway.start();
      await slack.deliverRevision();

      expect(order).toEqual(["handler"]);
      expect(slack.acked).toHaveLength(1);
    });

    it("mirrors revisions for a process that composed no message handler", async () => {
      // The two are independent options over one subscription. Reading the
      // message handler's absence as "nothing to do here" would leave a store
      // filing messages it can never let go of.
      const slack = createStubSlack();
      const { onRevision, seen } = recordingMirror();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onRevision
      });

      await gateway.start();
      await slack.deliverRevision();

      expect(seen).toHaveLength(1);
    });

    it("acknowledges and drops a revision when nothing composed a handler", async () => {
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage: () => Promise.resolve(undefined)
      });

      await gateway.start();
      await slack.deliverRevision();

      expect(slack.acked).toHaveLength(1);
    });

    it("survives a mirror that throws, and mirrors the next revision", async () => {
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const seen: string[] = [];
      let first = true;
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onRevision: revision => {
          if (first) {
            first = false;
            return Promise.reject(new Error("the store is gone"));
          }
          seen.push(revision.ts);
          return Promise.resolve();
        },
        logger
      });

      await gateway.start();
      await slack.deliverRevision({ ts: "1717171717.000300" });
      await slack.deliverRevision({ ts: "1717171717.000400" });

      expect(seen).toEqual(["1717171717.000400"]);
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: "revision_failed",
          revision: "deleted",
          reason: "Error"
        })
      );
    });

    it("stops mirroring once the gateway has stopped", async () => {
      const slack = createStubSlack();
      const { onRevision, seen } = recordingMirror();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onRevision
      });

      await gateway.start();
      await gateway.stop();
      await slack.deliverRevision();

      expect(seen).toHaveLength(0);
    });

    it("says nothing on stdout about a revision that landed", async () => {
      // The message path's rule, and it binds harder here: a line per revision
      // would be a running record of who retracted what and when, built out of
      // ids that are each individually fine to log.
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onRevision: () => Promise.resolve(),
        logger
      });

      await gateway.start();
      const before = lines.length;
      await slack.deliverRevision({ kind: "deleted" });
      await slack.deliverRevision({ kind: "edited", text: "the deploy went out at five" });

      expect(lines.slice(before)).toEqual([]);
    });

    it("never writes an edit's text to a log line", async () => {
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onRevision: () => Promise.reject(new Error("the store is gone")),
        logger
      });

      await gateway.start();
      await slack.deliverRevision({ kind: "edited", text: "sk-live-000-do-not-log-me" });

      expect(JSON.stringify(lines)).not.toContain("sk-live-000-do-not-log-me");
    });
  });

  describe("knowing which app it is", () => {
    /** Records every message the gateway hands down. */
    function recordingIngest(): { onMessage: MessageHandler; seen: SlackMessage[] } {
      const seen: SlackMessage[] = [];
      return {
        seen,
        onMessage: message => {
          seen.push(message);
          return Promise.resolve(undefined);
        }
      };
    }

    it("asks who it is before opening the socket", async () => {
      // Before, and not after: the two tokens are different, and a bot token
      // Slack will never accept should stop the process at startup rather than
      // an hour later when a reply does not appear.
      const order: string[] = [];
      const slack = createStubSlack();
      const gateway = createGateway({
        source: {
          ...slack.source,
          connect: () => {
            order.push("connect");
            return slack.source.connect();
          }
        },
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        identity: {
          identify: () => {
            order.push("identity");
            return slack.identity.identify();
          }
        }
      });

      await gateway.start();

      expect(order).toEqual(["identity", "connect"]);
    });

    it("logs the id it resolved", async () => {
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        identity: slack.identity,
        logger
      });

      await gateway.start();

      expect(lines.find(line => line.event === "identified")).toMatchObject({
        user: STUB_APP_USER_ID,
        team: STUB_WORKSPACE_ID
      });
    });

    it("fails to start when Slack will never accept the bot token", async () => {
      const slack = createStubSlack({
        identityFailure: new GatewayError("auth_rejected", false, { slackError: "invalid_auth" })
      });
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        identity: slack.identity
      });

      await expect(gateway.start()).rejects.toMatchObject({ reason: "auth_rejected" });
      expect(slack.connected()).toBe(false);
    });

    it("retries a lookup that failed for a reason waiting could fix", async () => {
      // A rate limit is `connect_failed`, which is the same ladder a refused
      // socket goes round. One shared loop rather than two, so a bad minute at
      // Slack does not need a second retry policy.
      const clock = manualClock();
      let attempts = 0;
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        identity: {
          identify: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(new GatewayError("connect_failed", true, { slackError: "ratelimited" }))
              : slack.identity.identify();
          }
        },
        backoff: BACKOFF,
        scheduler: clock.scheduler,
        random: () => 0.5
      });

      const started = gateway.start();
      await flush();
      await clock.fire();
      await started;

      expect(attempts).toBe(2);
      expect(slack.connected()).toBe(true);
    });

    it("asks once and keeps the answer across a reconnect", async () => {
      const clock = manualClock();
      let attempts = 0;
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        identity: {
          identify: () => {
            attempts += 1;
            return slack.identity.identify();
          }
        },
        backoff: BACKOFF,
        scheduler: clock.scheduler,
        random: () => 0.5
      });

      await gateway.start();
      slack.drop();
      await flush();
      await clock.fire();

      expect(attempts).toBe(1);
    });

    it("answers the workspace it is installed in, once it has asked", async () => {
      // The ambient scheduler's one input from this side (#317): it enumerates
      // channels off the filesystem, where the channel id is and the workspace
      // is not.
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        identity: slack.identity
      });

      expect(gateway.workspace).toBeUndefined();
      await gateway.start();
      expect(gateway.workspace).toBe(STUB_WORKSPACE_ID);
    });

    it("answers no workspace when nothing was ever asked", async () => {
      // A gateway composed with no identity never makes the call, so it never
      // learns either answer. `undefined` and not a guess: a scheduler that
      // invented a workspace would key a second session over a live channel.
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined)
      });

      await gateway.start();

      expect(gateway.workspace).toBeUndefined();
    });

    it("marks a message that mentions the app, and only that message", async () => {
      // The whole point of asking. A mention arrives on both subscriptions, so
      // the copy that lands here has to be distinguishable from a follow-up or
      // the layer above answers one question twice.
      const slack = createStubSlack();
      const { onMessage, seen } = recordingIngest();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        identity: slack.identity,
        onMessage
      });

      await gateway.start();
      await slack.deliverMessage({ ts: "1.1", text: `<@${STUB_APP_USER_ID}> what broke` });
      await slack.deliverMessage({ ts: "1.2", text: `<@${STUB_APP_USER_ID}|libero> what broke` });
      await slack.deliverMessage({ ts: "1.3", text: "no, the other cluster" });
      await slack.deliverMessage({ ts: "1.4", text: "<@U0ALICE> does that look right" });

      expect(seen.map(message => message.mentionsApp)).toEqual([true, true, false, false]);
    });

    it("treats any mention token as the app when it does not know its own id", async () => {
      // Fails closed. Losing a follow-up costs a message the user can repeat;
      // mistaking a mention for one runs the task twice and posts two answers.
      const slack = createStubSlack();
      const { onMessage, seen } = recordingIngest();
      const gateway = createGateway({
        source: slack.source,
        poster: forbiddenPoster(),
        handler: () => Promise.resolve(undefined),
        onMessage
      });

      await gateway.start();
      await slack.deliverMessage({ ts: "1.1", text: "<@U0ALICE> does that look right" });
      await slack.deliverMessage({ ts: "1.2", text: "no, the other cluster" });

      expect(seen.map(message => message.mentionsApp)).toEqual([true, false]);
    });
  });

  describe("approval cards", () => {
    it("acknowledges a click before running the handler", async () => {
      // Same three-second window a mention has, and a decision handler is an
      // HTTP round trip plus a card edit. Acking after it means Slack
      // redelivers.
      const order: string[] = [];
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: () => {
          order.push("handler");
          return Promise.resolve();
        }
      });

      await gateway.start();
      await slack.deliverInteraction(
        blockActionsEnvelope({}, () => {
          order.push("ack");
          return Promise.resolve();
        })
      );

      expect(order).toEqual(["ack", "handler"]);
    });

    it("hands the decision down with the approver on it", async () => {
      const seen: SlackDecision[] = [];
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: decision => {
          seen.push(decision);
          return Promise.resolve();
        }
      });

      await gateway.start();
      await slack.deliverDecision({
        channelId: "C0OPS",
        userId: "U0DANA",
        ticketId: "ticket-abc",
        verdict: "approve"
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        channelId: "C0OPS",
        approverId: "U0DANA",
        ticketId: "ticket-abc",
        verdict: "approve"
      });
    });

    it("acks and logs a malformed click rather than throwing", async () => {
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      let calls = 0;
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: () => {
          calls += 1;
          return Promise.resolve();
        },
        logger
      });

      await gateway.start();
      let acked = 0;
      await slack.deliverInteraction({
        ack: () => {
          acked += 1;
          return Promise.resolve();
        },
        body: { type: "view_submission" }
      });

      expect(acked).toBe(1);
      expect(calls).toBe(0);
      expect(lines).toContainEqual(
        expect.objectContaining({ event: "ignored", reason: "not_an_interaction" })
      );
    });

    it("loses one click and no more when the handler throws", async () => {
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const seen: string[] = [];
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: decision => {
          seen.push(decision.ticketId);
          return seen.length === 1
            ? Promise.reject(new Error("card edit blew up"))
            : Promise.resolve();
        },
        logger
      });

      await gateway.start();
      await slack.deliverDecision({ ticketId: "ticket-1" });
      await slack.deliverDecision({ ticketId: "ticket-2" });

      expect(seen).toEqual(["ticket-1", "ticket-2"]);
      expect(lines).toContainEqual(
        expect.objectContaining({ event: "decision_failed", ticket: "ticket-1" })
      );
      // Nothing was posted: a card that could not be updated is the card
      // owner's to word, not the adapter's to invent.
      expect(slack.posted).toHaveLength(0);
    });

    it("acks a click it has no handler for", async () => {
      // Interactivity being on is a Slack app setting, not this process's, so a
      // click can arrive with no broker composed. Unacked, Slack retries it
      // forever, so it is acked and dropped with a reason.
      const slack = createStubSlack();
      const { logger, lines } = captureLogger();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        logger
      });

      await gateway.start();
      await slack.deliverDecision({ ticketId: "ticket-orphan" });

      expect(slack.acked).toHaveLength(1);
      expect(lines).toContainEqual(
        expect.objectContaining({
          event: "ignored",
          reason: "no_decision_handler",
          ticket: "ticket-orphan"
        })
      );
    });

    it("acks a click after stopping but does not dispatch it", async () => {
      const slack = createStubSlack();
      let calls = 0;
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: () => {
          calls += 1;
          return Promise.resolve();
        }
      });

      await gateway.start();
      await gateway.stop();
      await slack.deliverDecision();

      expect(slack.acked).toHaveLength(1);
      expect(calls).toBe(0);
    });

    it("passes a double click through twice, and that is the intent", async () => {
      // Mentions are deduped because nothing downstream of one is idempotent.
      // The proxy is already the authority on a decision: a ticket is decided
      // once, and a second click answers `already_decided` with the first
      // verdict standing. Two mechanisms that can disagree are worse than one.
      const slack = createStubSlack();
      const seen: string[] = [];
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: decision => {
          seen.push(decision.verdict);
          return Promise.resolve();
        }
      });

      await gateway.start();
      await slack.deliverDecision({ ticketId: "ticket-1" });
      await slack.deliverDecision({ ticketId: "ticket-1" });

      expect(seen).toEqual(["approve", "approve"]);
    });

    it("goes amber, then green, by editing one message", async () => {
      // The issue's third acceptance bullet, end to end against a stub: a card
      // goes up, a human clicks, and the same message becomes green. Nothing
      // here holds a timer — the caller drives every transition, which is what
      // makes the expiry case below reachable without one.
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: async decision => {
          await slack.poster.updateCard({
            channelId: decision.channelId,
            messageTs: decision.messageTs,
            card: renderApprovalCard({
              toolName: "github.pr.merge",
              status: { state: "approved", approver: decision.approverId }
            })
          });
        }
      });
      await gateway.start();

      const posted = await slack.poster.postCard({
        channelId: "C0OPS",
        threadTs: "1717171717.000100",
        card: renderApprovalCard({
          toolName: "github.pr.merge",
          status: { state: "awaiting", ticket: TICKET }
        })
      });
      expect(slack.cards).toHaveLength(1);
      expect(slack.cardAt(posted.messageTs)?.color).toBe("#F5B544");

      await slack.deliverDecision({
        channelId: "C0OPS",
        messageTs: posted.messageTs,
        ticketId: TICKET.id,
        verdict: "approve"
      });

      // Edited, not spammed: one card, one edit, same ts.
      expect(slack.cards).toHaveLength(1);
      expect(slack.edits).toHaveLength(1);
      expect(slack.edits[0]?.messageTs).toBe(posted.messageTs);
      const showing = slack.cardAt(posted.messageTs);
      expect(showing?.color).toBe("#1BA85A");
      // And the buttons are gone, so it cannot be clicked again.
      expect(showing?.blocks.some(block => block.type === "actions")).toBe(false);
    });

    it("goes red on a deny, and red again on an expiry the caller drives", async () => {
      const slack = createStubSlack();
      const gateway = createGateway({
        source: slack.source,
        poster: slack.poster,
        handler: () => Promise.resolve(undefined),
        onDecision: async decision => {
          await slack.poster.updateCard({
            channelId: decision.channelId,
            messageTs: decision.messageTs,
            card: renderApprovalCard({
              toolName: "github.pr.merge",
              status: { state: "denied", approver: decision.approverId }
            })
          });
        }
      });
      await gateway.start();

      const denied = await slack.poster.postCard({
        channelId: "C0OPS",
        threadTs: "1717171717.000100",
        card: renderApprovalCard({
          toolName: "github.pr.merge",
          status: { state: "awaiting", ticket: TICKET }
        })
      });
      await slack.deliverDecision({
        channelId: "C0OPS",
        messageTs: denied.messageTs,
        verdict: "deny"
      });

      expect(slack.cardAt(denied.messageTs)?.color).toBe("#FF6B5B");

      // Expiry is the same edit with no click behind it. The deadline belongs to
      // whoever holds the ticket; this package renders the state on request and
      // never notices a clock passing.
      const stale = await slack.poster.postCard({
        channelId: "C0OPS",
        threadTs: "1717171717.000100",
        card: renderApprovalCard({
          toolName: "github.deploy",
          status: { state: "awaiting", ticket: TICKET }
        })
      });
      await slack.poster.updateCard({
        channelId: "C0OPS",
        messageTs: stale.messageTs,
        card: renderApprovalCard({ toolName: "github.deploy", status: { state: "expired" } })
      });

      const expired = slack.cardAt(stale.messageTs);
      expect(expired?.color).toBe("#FF6B5B");
      expect(expired?.blocks.some(block => block.type === "actions")).toBe(false);
    });
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

  it("never writes a card's contents to a log line either", async () => {
    // The same rule, on the surface that grew a second kind of content: a card
    // renders tool-call arguments, which are the model's words about a team's
    // data. A decision line carries ids and a verdict, and no card text.
    const secret = "prod-db-password-hunter2";
    const slack = createStubSlack();
    const { logger, lines } = captureLogger();
    const gateway = createGateway({
      source: slack.source,
      poster: slack.poster,
      handler: () => Promise.resolve(undefined),
      onDecision: async decision => {
        await slack.poster.updateCard({
          channelId: decision.channelId,
          messageTs: decision.messageTs,
          card: renderApprovalCard({
            toolName: "github.pr.merge",
            arguments: secret,
            status: { state: "approved", approver: decision.approverId }
          })
        });
      },
      logger
    });
    await gateway.start();

    const posted = await slack.poster.postCard({
      channelId: "C0OPS",
      threadTs: "1717171717.000100",
      card: renderApprovalCard({
        toolName: "github.pr.merge",
        arguments: secret,
        status: { state: "awaiting", ticket: TICKET }
      })
    });
    await slack.deliverDecision({
      channelId: "C0OPS",
      messageTs: posted.messageTs,
      ticketId: TICKET.id
    });

    const emitted = JSON.stringify(lines);
    expect(emitted).not.toContain("hunter2");
    expect(emitted).not.toContain(secret);
    // And the decision was logged, with the ids that make it correlatable.
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "decision", ticket: TICKET.id, verdict: "approve" })
    );
  });
});
