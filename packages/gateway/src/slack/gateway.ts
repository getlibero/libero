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
import { toDecision } from "./decision.js";
import { toMention } from "./mention.js";
import { toMessage } from "./message.js";
import { toRevision } from "./revision.js";
import { GatewayError } from "./types.js";
import type {
  AppIdentity,
  DecisionHandler,
  MentionHandler,
  MessageHandler,
  MessagePoster,
  RevisionHandler,
  SlackEnvelope,
  SlackGateway,
  SlackInteractionEnvelope,
  SocketSource,
  StopOptions
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
  /**
   * A human clicked a button on an approval card.
   *
   * Optional, because a process that composes no approval broker still receives
   * clicks the moment the Slack app has interactivity switched on — and still
   * has to acknowledge them. Absent, a click is acked and dropped with a
   * reason, which is the only safe way to ignore one.
   */
  onDecision?: DecisionHandler;
  /**
   * An ordinary message arrived in a channel this app is in.
   *
   * Optional for the same reason `onDecision` is: the subscription is a
   * property of the Slack app, not of what this process composed, so a process
   * with nowhere to put a message still receives one and still has to
   * acknowledge it. Absent, a message is acked and dropped.
   */
  onMessage?: MessageHandler;
  /**
   * A message already recorded was deleted or edited by its author.
   *
   * Optional on `onMessage`'s terms, and independent of it: the two arrive on
   * one subscription but a process can compose either alone. Absent, a revision
   * is acked and dropped — which means a store that has one is a store keeping
   * text its author retracted, so a composing app with a store passes both.
   */
  onRevision?: RevisionHandler;
  /**
   * Who this app is, asked once before the socket comes up.
   *
   * Optional, and its absence is a degradation rather than a failure: without
   * it every message carrying any mention token is treated as addressing the
   * app, which costs follow-ups and never causes a duplicate. See `mentionsApp`
   * in message.ts.
   */
  identity?: AppIdentity;
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
  const { source, poster, handler, onDecision, onMessage, onRevision, identity, onFatal } =
    options;
  const logger = options.logger ?? createSilentLogger();
  const policy = options.backoff ?? DEFAULT_BACKOFF;
  const schedule = options.scheduler ?? defaultScheduler;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  let state: "idle" | "running" | "stopped" = "idle";
  let attempt = 0;
  /** When the current connection came up, or undefined while it is down. */
  let connectedAt: number | undefined;
  /**
   * This app's own Slack user id, once asked for. Resolved once and kept across
   * reconnects — an app does not change its id, and re-asking on every drop
   * would spend a bot-token call on a socket recycle.
   */
  let appUserId: string | undefined;
  /**
   * The workspace this app is installed in, from the same answer (#317).
   *
   * Kept beside the id rather than folded into it because the two are read by
   * different things at different times — the id decides whether a message is a
   * mention arriving twice, and the workspace is what the ambient scheduler
   * needs to key a session it built from a directory listing.
   */
  let appWorkspace: string | undefined;
  /** True while a connect ladder is running, so only ever one is. */
  let connecting = false;
  let cancelPending: (() => void) | undefined;
  let wakePending: (() => void) | undefined;

  // Slack redelivers an event it believes went unacknowledged, and a redelivery
  // can arrive on a new socket after a drop — which acking early does not cover.
  // Insertion-ordered, bounded: an event id is only useful for as long as a
  // retry could still show up, and an unbounded set in a long-lived process is
  // a leak.
  //
  // Decisions get no equivalent, and the asymmetry is deliberate. This set
  // exists because nothing downstream of a mention is idempotent: a second
  // delivery runs a second model turn and costs money. A second click costs one
  // HTTP round trip, and the proxy is already the authority on it — a ticket is
  // decided once, and a double click, a stale card, or a retry all answer
  // `already_decided` with the first verdict standing. Two idempotency
  // mechanisms that can disagree are worse than one that is authoritative.
  // There is also no honest key to use: an interactive payload carries no
  // `event_id`.
  //
  // Ordinary messages get no entry either, on the same argument. The message
  // store is authoritative for them: its `ts` column is UNIQUE and its insert
  // is `ON CONFLICT DO NOTHING`, so a redelivery is already a no-op — and that
  // key is the better one, being the message's own identity and surviving a
  // restart, which this set does not. Adding them would also break the thing
  // this set is for: it is bounded at SEEN_EVENT_LIMIT and evicts oldest-first,
  // so a busy workspace's message traffic would flush every remembered mention
  // id within seconds.
  const seen = new Set<string>();

  // Dispatches that have started and not finished, so `stop()` can wait for
  // them (#118). The set is the only place "in flight" is observable: the
  // source calls a listener and does not keep the promise, and everything a
  // task does — the model turn, the tool calls, the spend report it sends on
  // the way out — happens inside one of these.
  //
  // Interactions are tracked alongside mentions and messages even though a
  // click is short. A decision in flight is a card mid-repaint and a task
  // waiting on the verdict; dropping it at exit leaves the amber card an
  // operator would have to explain.
  const inFlight = new Set<Promise<void>>();

  /** Registers a listener that records itself as in flight while it runs. */
  function tracked<T>(dispatcher: (envelope: T) => Promise<void>): (envelope: T) => Promise<void> {
    return envelope => {
      // `.finally` returns a new promise, and it is that one the set holds and
      // the callback deletes — the callback runs in a microtask, well after the
      // assignment, so the reference is always resolved by the time it is read.
      const running = dispatcher(envelope).finally(() => {
        inFlight.delete(running);
      });
      inFlight.add(running);
      return running;
    };
  }

  /**
   * Waits for in-flight dispatches, for at most `ms`.
   *
   * `allSettled` rather than `all`: the three dispatchers catch their own
   * failures, but a drain that rejected on one would abandon the rest, and
   * this runs on the way to an exit where there is nobody left to catch it.
   *
   * The timer goes through `schedule` so a test drives the bound without
   * waiting real seconds, and is cancelled when the drain wins so it is not
   * left holding the event loop open in a process that had no other reason to
   * stay up.
   */
  async function drain(ms: number): Promise<void> {
    if (inFlight.size === 0) return;

    const started = now();
    const pending = inFlight.size;
    let cancelBound: (() => void) | undefined;
    const bound = new Promise<"timeout">(resolve => {
      cancelBound = schedule(ms, () => {
        resolve("timeout");
      });
    });

    const outcome = await Promise.race([
      Promise.allSettled([...inFlight]).then(() => "drained" as const),
      bound
    ]);
    cancelBound?.();

    if (outcome === "timeout") {
      // `warn`, not `error`: nothing is broken and the bound did what it was
      // for. What it costs is named rather than implied — `dispatches` is how
      // many are about to be abandoned, read at the timeout rather than at the
      // start, so it counts what is still running and not what began.
      logger.log("warn", { event: "drain_timeout", drainMs: ms, dispatches: inFlight.size });
      return;
    }
    logger.log("info", { event: "drained", dispatches: pending, durationMs: now() - started });
  }

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
   *
   * Identity is resolved inside the same loop rather than beside it, so the one
   * ladder covers both halves of coming up: an `invalid_auth` from `auth.test`
   * stops the process the way a refused socket does, and a rate-limited one
   * waits the same backoff. It is asked before `connect` on purpose — the two
   * tokens are different, and a bot token Slack will never accept should be a
   * startup failure rather than a reply that does not appear an hour later.
   */
  async function connectWithRetry(): Promise<void> {
    while (state === "running") {
      logger.log("info", { event: "connecting", attempt });
      try {
        if (identity !== undefined && appUserId === undefined) {
          const self = await identity.identify();
          appUserId = self.userId;
          appWorkspace = self.workspace;
          // The id, once, at startup. It is what decides whether a message is a
          // mention arriving on its second subscription, and an operator
          // debugging "the agent answered twice" needs to see which id it
          // matched on. The workspace rides the same line because it came out of
          // the same call and an operator staring at a silent ambient scheduler
          // wants to see that this process knows where it is installed.
          logger.log("info", { event: "identified", user: appUserId, team: appWorkspace });
        }
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

  /**
   * A message in, and — since #66 — sometimes a reply back into its thread.
   *
   * Since #177 it is also the fan-out point for revisions. Slack carries a
   * deletion and an edit as subtypes of this same event rather than as events of
   * their own, so one subscription and one listener deliver all three, and where
   * an envelope goes is decided by `toMessage`'s answer rather than by a second
   * subscription.
   *
   * Still the quietest of the three paths. It logs nothing on the way through
   * and nothing for an ordinary drop: no `message` line, no `ignored` line for
   * a subtype or a bot, and nothing at all for the overwhelming majority that
   * are recorded and not answered.
   *
   * `log.ts` permits ids, so a line carrying channel, user and ts would be
   * legal by the letter of that rule. It is still wrong here: at message volume
   * the log becomes a running record of who spoke in which channel and when,
   * which is the shape of the thing the "no message text" rule is protecting,
   * assembled out of fields that are individually fine. Stdout should scale
   * with an operator's problems, not with a channel's conversation.
   *
   * An *answered* message is not message volume — it is a task, and it is the
   * thing #66 introduced that an operator has a reason to count. It gets
   * `follow_up` rather than `replied` so that "how often is this agent
   * answering people who did not address it" is one grep rather than a
   * subtraction.
   *
   * The rest of what gets logged is rare and actionable, and is logged by
   * whoever can say something useful: a handler that throws gets
   * `message_failed` here, and a store that cannot be opened or written says so
   * from the process that owns it.
   */
  async function dispatchMessage(envelope: SlackEnvelope): Promise<void> {
    // Ack first, for the reason `dispatch` gives. A follow-up handler is now a
    // model turn like a mention's, so this window is as tight as that one.
    try {
      await envelope.ack();
    } catch (error) {
      logger.log("warn", { event: "ignored", reason: reasonOf(error) });
      return;
    }
    if (state !== "running") return;

    const result = toMessage(envelope, appUserId);
    if ("ignored" in result) {
      // The one ignore code that is a handoff. `toMessage` recognizes the two
      // revision subtypes and declines them as new messages; what they are
      // instead is `toRevision`'s to say. Everything else here stays silent.
      if (result.ignored === "message_edit") await dispatchRevision(envelope);
      return;
    }
    // After the normalization rather than before it, so a process composing a
    // revision handler and no message handler still mirrors deletions. The
    // decode is pure and costs a process with neither nothing that matters.
    if (onMessage === undefined) return;
    const message = result.message;

    const startedAt = now();
    let reply;
    try {
      reply = await onMessage(message);
    } catch (error) {
      // One message is lost and the socket stays up, exactly as a failed
      // handler loses one mention. Nothing is posted: a channel does not want
      // to be told its own message was not filed.
      logger.log("error", {
        event: "message_failed",
        channel: message.channelId,
        eventId: message.eventId,
        reason: reasonOf(error)
      });
      return;
    }

    if (reply === undefined) return;
    // A handler that was still running when the gateway stopped does not get to
    // post, exactly as on the mention path.
    if (state !== "running") return;

    // The reply target, and the only one there is. A message with no thread has
    // nowhere for an answer to go — `?? ts` here would start a thread on a
    // message nobody addressed the app in, which is the one thing this path
    // must not be able to do. A handler should not have answered such a message
    // at all, so this is a guard rather than a branch, and it is worth a line
    // because the symptom otherwise is an answer that silently never appears.
    if (message.threadTs === null) {
      logger.log("warn", {
        event: "ignored",
        reason: "no_thread",
        channel: message.channelId,
        eventId: message.eventId
      });
      return;
    }

    try {
      await poster.postThreadReply({
        channelId: message.channelId,
        threadTs: message.threadTs,
        text: reply.text
      });
    } catch (error) {
      logger.log("error", {
        event: "post_failed",
        channel: message.channelId,
        eventId: message.eventId,
        threadTs: message.threadTs,
        reason: reasonOf(error),
        ...(error instanceof GatewayError && error.slackError !== undefined
          ? { slackError: error.slackError }
          : {})
      });
      return;
    }

    logger.log("info", {
      event: "follow_up",
      channel: message.channelId,
      eventId: message.eventId,
      threadTs: message.threadTs,
      durationMs: now() - startedAt
    });
  }

  /**
   * A deletion or an edit in, and nothing out.
   *
   * Reached from `dispatchMessage` rather than registered as a listener, and it
   * therefore **does not ack** — the envelope was acknowledged before its kind
   * was known, which is the only order Slack's three-second window allows. A
   * second ack here would be an ack of an envelope already acked.
   *
   * As quiet as the message path and for the same reason: a line per revision
   * would be a running record of who retracted what and when, assembled out of
   * ids that are individually fine. Only a handler that threw gets one, and the
   * layer that owns the store logs its own failure with more to say.
   */
  async function dispatchRevision(envelope: SlackEnvelope): Promise<void> {
    if (onRevision === undefined) return;

    const result = toRevision(envelope);
    if ("ignored" in result) return;
    const revision = result.revision;

    try {
      await onRevision(revision);
    } catch (error) {
      // One revision lost and the socket stays up, exactly as a failed handler
      // loses one message. Nothing is posted: a channel that deleted a message
      // does not want to be told about it in the channel.
      logger.log("error", {
        event: "revision_failed",
        channel: revision.channelId,
        eventId: revision.eventId,
        revision: revision.kind,
        reason: reasonOf(error)
      });
    }
  }

  /**
   * A click in, and nothing out.
   *
   * Mirrors `dispatch` deliberately, including the order: the ack comes first
   * for the same reason, and the decoder's failures are logged rather than
   * thrown for the same reason. What it does not do is post anything — a
   * click's visible answer is the card being edited, and the card belongs to
   * whoever holds the ticket.
   */
  async function dispatchInteraction(envelope: SlackInteractionEnvelope): Promise<void> {
    try {
      await envelope.ack();
    } catch (error) {
      logger.log("warn", { event: "ignored", reason: reasonOf(error) });
      return;
    }
    if (state !== "running") return;

    const result = toDecision(envelope);
    if ("ignored" in result) {
      logger.log("info", { event: "ignored", reason: result.ignored });
      return;
    }
    const decision = result.decision;

    // Acked above, so Slack stops retrying, and then dropped: a click nobody
    // composed a handler for is not an error, but it is worth a line, because
    // the symptom otherwise is a card that never changes and no explanation.
    if (onDecision === undefined) {
      logger.log("info", {
        event: "ignored",
        reason: "no_decision_handler",
        channel: decision.channelId,
        ticket: decision.ticketId
      });
      return;
    }

    logger.log("info", {
      event: "decision",
      team: decision.teamId,
      channel: decision.channelId,
      user: decision.approverId,
      threadTs: decision.threadTs,
      messageTs: decision.messageTs,
      ticket: decision.ticketId,
      verdict: decision.verdict
    });

    const startedAt = now();
    try {
      await onDecision(decision);
    } catch (error) {
      // One click is lost and the socket stays up, exactly as a failed handler
      // loses one mention. Nothing is posted: a card that could not be updated
      // is the card owner's to word, not the adapter's to invent.
      logger.log("error", {
        event: "decision_failed",
        channel: decision.channelId,
        ticket: decision.ticketId,
        durationMs: now() - startedAt,
        reason: reasonOf(error)
      });
    }
  }

  return {
    get workspace(): string | undefined {
      return appWorkspace;
    },

    async start(): Promise<void> {
      if (state !== "idle") throw new GatewayError("connect_failed", false);
      state = "running";
      // Registered before connecting, so no event can arrive unlistened. The
      // interaction and message listeners go on unconditionally, even with no
      // `onDecision` and no `onMessage`: an unacknowledged envelope is
      // redelivered, so a gateway that simply did not subscribe would be
      // retried at forever.
      source.onMention(tracked(dispatch));
      source.onMessage(tracked(dispatchMessage));
      source.onInteraction(tracked(dispatchInteraction));
      source.onDrop(handleDrop);
      connecting = true;
      try {
        await connectWithRetry();
      } finally {
        connecting = false;
      }
    },

    // `stopOptions` rather than `options`, which is the whole `GatewayOptions`
    // object this closure was built from and is still in scope here.
    async stop(stopOptions?: StopOptions): Promise<void> {
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
      // After the close, not before: draining first would be draining a set
      // that is still being added to. `state` is already `stopped`, so a
      // dispatch that started before this call returns without running its
      // handler, and one that arrives during the close is acked and dropped.
      if (stopOptions?.drainMs !== undefined) await drain(stopOptions.drainMs);
    }
  };
}
