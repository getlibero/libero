// Request in, reply out, one task at a time per channel.
//
// The router is where a request becomes a session: which one it belongs to,
// what it has to wait for, and which sheet the task runs on. It is the only
// thing that knows all three, and it knows nothing about where the request came
// from — that is handler.ts, and an ESLint rule on this directory keeps it that
// way.
//
// Serialization lives here rather than in the gateway, and the gateway should
// go on dispatching concurrently. It acknowledges an inbound event within about
// three seconds or Slack redelivers it, so a mention queued behind a slow task
// must not be holding the acknowledgement. Everything below the acknowledgement
// queues; nothing above it does.

import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import { assembleContext } from "./context.js";
import type { DisplayNameLookup } from "./names.js";
import type { SessionRegistry } from "./registry.js";
import { createSessionRegistry } from "./registry.js";
import type { SheetResolver } from "./sheet.js";
import type { TaskReply, TaskRequest, TaskRunner } from "./types.js";

/** Answers `undefined` for everyone. What a front-end with no directory has. */
const NO_NAMES: DisplayNameLookup = () => Promise.resolve(undefined);

export interface ChannelRouterOptions {
  sheets: SheetResolver;
  task: TaskRunner;
  /** Built here unless a caller — a test asserting on eviction — brings one. */
  sessions?: SessionRegistry;
  /**
   * How a user id becomes a name, for the transcript this assembles.
   *
   * Optional, and its absence is a real front-end rather than a test mode: one
   * with no directory to ask renders every author as its id, which is a
   * readable transcript with worse attribution rather than no transcript. A
   * plain function and not a Slack type, so this directory stays transport
   * neutral — the implementation is wired in compose.ts.
   */
  names?: DisplayNameLookup;
  logger?: Logger;
  now?: () => number;
}

export type ChannelRouter = (request: TaskRequest) => Promise<TaskReply | undefined>;

/**
 * Builds the router.
 *
 * A task that throws propagates unchanged: the caller sees the rejection, the
 * gateway logs `handler_failed` and posts nothing, and the queue behind it
 * drains regardless. Nothing is caught here, because there is nothing this file
 * could say about a provider outage that the task itself has not already
 * decided to say or not say.
 *
 * The per-task wall-time cap is unaffected by queueing. `runAgentTask` starts
 * its timeout when the task starts, so a task is never charged for the time it
 * spent waiting — but end-to-end latency is now queue plus cap, and
 * `replied.durationMs` silently includes the queue half. `queuedMs` is what
 * makes that half visible, and it is the difference between a backed-up channel
 * and a slow model.
 */
export function createChannelRouter(options: ChannelRouterOptions): ChannelRouter {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;
  const sessions = options.sessions ?? createSessionRegistry({ logger, now });
  const names = options.names ?? NO_NAMES;

  return async (request: TaskRequest): Promise<TaskReply | undefined> => {
    // Nothing between here and `run` below may await. `open` sweeps idle
    // sessions, so an await in this window would let a later request's sweep
    // drop the session this one is about to queue on — and the two would then
    // hold different mutexes over one channel.
    const session = sessions.open(request.key);

    // Read before enqueueing, so this call is not in the count yet: anything
    // above zero is already ahead of it. That is exactly when the wait is worth
    // a line, and when it is zero there is nothing to say.
    const waited = session.mutex.pending > 0;
    const arrivedAt = now();

    return session.mutex.run(async () => {
      if (waited) {
        logger.log("info", {
          event: "queued",
          channel: request.key.channel,
          eventId: request.traceId,
          queuedMs: now() - arrivedAt
        });
      }

      try {
        // Inside the lock, so the sheet a task runs on is resolved in the same
        // serialized step as the task itself. An operator's edit lands between
        // two tasks rather than half way through one.
        const settings = await options.sheets(request.key.channel);

        // And so is the transcript, for a second reason on top of that one: the
        // read has to see the messages the previous task's conversation left
        // behind, and a read outside the lock could run while that task was
        // still going. The assembler is here rather than in the sheet resolver
        // because it needs the session — its store and its name cache — and
        // `SheetResolver` is given a channel id and nothing else.
        const messages = await assembleContext({
          store: session.store,
          names: session.names,
          lookup: names,
          request,
          bounds: settings.history
        });

        return await options.task(request, { ...settings, messages });
      } finally {
        session.lastUsedAt = now();
      }
    });
  };
}
