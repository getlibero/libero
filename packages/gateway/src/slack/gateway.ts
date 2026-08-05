// Dispatch and the reconnect supervisor.
//
// This file holds no Slack SDK type. It is written against SocketSource and
// MessagePoster, which is what makes the whole path — mention in, handler,
// reply out, socket drops, socket comes back — runnable with no network at all.
//
// Concurrency is deliberately absent: two mentions in one channel dispatch
// concurrently here, and they should go on doing so. Serializing a channel's
// mentions is the channel router's, above this file — because dispatch also
// acknowledges the inbound event, and Slack redelivers one that is not
// acknowledged within about three seconds. A mention waiting its turn behind a
// slow task must not be holding that acknowledgement.

import { createSilentLogger } from "../log.js";
import type { Logger } from "../log.js";
import { DEFAULT_BACKOFF, nextDelayMs } from "./backoff.js";
import type { BackoffPolicy } from "./backoff.js";
import { toMention } from "./mention.js";
import { GatewayError } from "./types.js";
import type {
  MentionHandler,
  MessagePoster,
  SlackEnvelope,
  SlackGateway,
  SocketSource
} from "./types.js";

/**
 * Runs `fn` after `ms` and returns a cancel function.
 *
 * A seam rather than a bare `setTimeout` for two reasons: a test drives the
 * reconnect ladder without waiting real seconds, and `stop()` can cancel a
 * pending attempt instead of leaving a timer holding the process open for the
 * length of the backoff.
 */
export type Scheduler = (ms: number, fn: () => void) => () => void;

const defaultScheduler: Scheduler = (ms, fn) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** How many event ids to remember. See the note on deduplication below. */
const SEEN_EVENT_LIMIT = 1000;

export interface GatewayOptions {
  source: SocketSource;
  poster: MessagePoster;
  handler: MentionHandler;
  /** Defaults to silent, so a test asserting on behaviour is not also a log sink. */
  logger?: Logger;
  backoff?: BackoffPolicy;
  /**
   * The gateway died after `start()` resolved, for a reason retrying cannot
   * fix — a revoked or rotated token, most often.
   *
   * `start()` can report that only while it is still pending. Afterwards the
   * socket is down, the reconnect ladder has stopped, and nothing else in the
   * process knows: the gateway is not going to answer another mention and will
   * happily stay up not doing so. What to do about that is the composing app's
   * call, so it is a callback rather than a policy here — `apps/server` exits
   * non-zero and lets the restart policy pick the process back up.
   *
   * Defaults to doing nothing, which is what this did before the seam existed.
   */
  onFatal?: (error: GatewayError) => void;
  /** Injected for tests. Omitted in production. */
  scheduler?: Scheduler;
  /** Jitter source. Injected for tests. */
  random?: () => number;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * A code for a log line, from an error of unknown provenance.
 *
 * Never the error's message: an SDK's message can carry a URL, a request body,
 * or an echoed header, and this process holds the app and bot tokens. A class
 * name is a name, in the same sense a channel id is.
 */
function reasonOf(error: unknown): string {
  if (error instanceof GatewayError) return error.reason;
  return error instanceof Error ? error.name : "non_error";
}

export function createGateway(options: GatewayOptions): SlackGateway {
  const { source, poster, handler, onFatal } = options;
  const logger = options.logger ?? createSilentLogger();
  const policy = options.backoff ?? DEFAULT_BACKOFF;
  const schedule = options.scheduler ?? defaultScheduler;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  let state: "idle" | "running" | "stopped" = "idle";
  let attempt = 0;
  /** When the current connection came up, or undefined while it is down. */
  let connectedAt: number | undefined;
  /** True while a connect ladder is running, so only ever one is. */
  let connecting = false;
  let cancelPending: (() => void) | undefined;
  let wakePending: (() => void) | undefined;

  // Slack redelivers an event it believes went unacknowledged, and a redelivery
  // can arrive on a new socket after a drop — which acking early does not cover.
  // Insertion-ordered, bounded: an event id is only useful for as long as a
  // retry could still show up, and an unbounded set in a long-lived process is
  // a leak.
  const seen = new Set<string>();

  function remember(eventId: string): void {
    seen.add(eventId);
    if (seen.size > SEEN_EVENT_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  /** Resolves after `ms`, or immediately when `stop()` cancels it. */
  function delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const done = (): void => {
        cancelPending = undefined;
        wakePending = undefined;
        resolve();
      };
      cancelPending = schedule(ms, done);
      wakePending = done;
    });
  }

  /**
   * Connects, retrying while the failure is one that waiting could fix. Throws
   * the first non-retryable failure, which is how `start()` reports credentials
   * Slack will never accept.
   */
  async function connectWithRetry(): Promise<void> {
    while (state === "running") {
      logger.log("info", { event: "connecting", attempt });
      try {
        await source.connect();
        connectedAt = now();
        logger.log("info", { event: "connected", attempt });
        return;
      } catch (error) {
        if (error instanceof GatewayError && !error.retryable) {
          state = "stopped";
          logger.log("error", { event: "auth_rejected", reason: error.reason });
          throw error;
        }
        const delayMs = nextDelayMs(policy, attempt, random);
        logger.log("warn", { event: "reconnecting", attempt, delayMs, reason: reasonOf(error) });
        attempt += 1;
        await delay(delayMs);
      }
    }
  }

  async function reconnect(): Promise<void> {
    connecting = true;
    try {
      // Every drop goes through the ladder, including the first. At attempt 0
      // that is full jitter over [0, baseMs), so Slack's routine connection
      // refresh comes back in well under a second — and a socket that connects
      // and drops immediately still cannot spin, which it could if the first
      // reconnect were unconditionally instant.
      const delayMs = nextDelayMs(policy, attempt, random);
      logger.log("warn", { event: "reconnecting", attempt, delayMs });
      attempt += 1;
      await delay(delayMs);
      if (state !== "running") return;
      await connectWithRetry();
    } finally {
      connecting = false;
    }
  }

  function handleDrop(): void {
    // A failed reconnect attempt can itself emit a drop. Without this guard
    // that starts a second ladder alongside the first, and the second one's
    // timer overwrites the handle `stop()` cancels — so a shutdown would leave
    // a timer running.
    if (state !== "running" || connecting) return;
    logger.log("warn", { event: "disconnected" });

    // A connection that held is evidence the credentials and the network are
    // fine, so a routine Slack recycle starts the ladder over rather than
    // inheriting the delay from an outage hours ago.
    if (connectedAt !== undefined && now() - connectedAt >= policy.resetAfterMs) attempt = 0;
    connectedAt = undefined;

    void reconnect().catch((error: unknown) => {
      // connectWithRetry has already logged auth_rejected and stopped the loop.
      // start() resolved long ago, so this callback is the only way the failure
      // reaches the process that owns the decision. Default is to do nothing.
      if (error instanceof GatewayError) onFatal?.(error);
    });
  }

  async function dispatch(envelope: SlackEnvelope): Promise<void> {
    // Ack before anything else. Slack's window is about three seconds and a
    // handler is a model turn, so acking after it guarantees redelivery.
    try {
      await envelope.ack();
    } catch (error) {
      logger.log("warn", { event: "ignored", reason: reasonOf(error) });
      return;
    }
    if (state !== "running") return;

    const result = toMention(envelope);
    if ("ignored" in result) {
      logger.log("info", { event: "ignored", reason: result.ignored });
      return;
    }
    const mention = result.mention;

    if (seen.has(mention.eventId)) {
      logger.log("info", {
        event: "ignored",
        reason: "duplicate",
        channel: mention.channelId,
        eventId: mention.eventId
      });
      return;
    }
    remember(mention.eventId);

    logger.log("info", {
      event: "mention",
      team: mention.teamId,
      channel: mention.channelId,
      user: mention.userId,
      eventId: mention.eventId,
      threadTs: mention.threadTs
    });

    const startedAt = now();
    let reply;
    try {
      reply = await handler(mention);
    } catch (error) {
      // A handler that throws loses its mention and nothing else. The socket
      // stays up, and nothing is posted to the thread: a user-visible refusal
      // is the loop's to word, not the adapter's to invent.
      logger.log("error", {
        event: "handler_failed",
        channel: mention.channelId,
        eventId: mention.eventId,
        durationMs: now() - startedAt,
        reason: reasonOf(error)
      });
      return;
    }
    if (reply === undefined) return;
    // A handler that was still running when the gateway stopped does not get to
    // post. The socket is closed and the operator asked for quiet.
    if (state !== "running") return;

    try {
      await poster.postThreadReply({
        channelId: mention.channelId,
        threadTs: mention.threadTs,
        text: reply.text
      });
    } catch (error) {
      logger.log("error", {
        event: "post_failed",
        channel: mention.channelId,
        eventId: mention.eventId,
        threadTs: mention.threadTs,
        reason: reasonOf(error),
        ...(error instanceof GatewayError && error.slackError !== undefined
          ? { slackError: error.slackError }
          : {})
      });
      return;
    }

    logger.log("info", {
      event: "replied",
      channel: mention.channelId,
      eventId: mention.eventId,
      threadTs: mention.threadTs,
      durationMs: now() - startedAt
    });
  }

  return {
    async start(): Promise<void> {
      if (state !== "idle") throw new GatewayError("connect_failed", false);
      state = "running";
      // Registered before connecting, so no event can arrive unlistened.
      source.onMention(dispatch);
      source.onDrop(handleDrop);
      connecting = true;
      try {
        await connectWithRetry();
      } finally {
        connecting = false;
      }
    },

    async stop(): Promise<void> {
      if (state === "stopped") return;
      state = "stopped";
      logger.log("info", { event: "stopping" });
      // Cancel the timer first, then wake whoever is awaiting it: the loop
      // checks `state` after the delay and exits without another attempt.
      cancelPending?.();
      cancelPending = undefined;
      wakePending?.();
      wakePending = undefined;
      await source.close();
    }
  };
}
