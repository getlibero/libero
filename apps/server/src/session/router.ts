// Request in, reply out, one task at a time per channel.
//
// The router is where a request becomes a session: which one it belongs to,
// what it has to wait for, and which sheet the task runs on. It is the only
// thing that knows all three, and it knows nothing about where the request came
// from — that is handler.ts, and an ESLint rule on this directory keeps it that
// way.
//
// Since #66 it is also where a thread becomes one the agent will answer without
// being addressed again. That belongs here rather than in either caller for the
// same reason the sheet read does: this is the layer that holds the session and
// resolves the settings, and the window is one of them. Both entry points —
// mention and follow-up — run through this one function, so a follow-up
// refreshes its own thread and there is no second place that has to remember
// to.
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
import type { MemoryFileOpener } from "./memory.js";
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
  /**
   * How a channel's `MEMORY.md` is opened, when it has one.
   *
   * Optional, and its absence is a process that answers exactly as it did before
   * phase 2: no curated memory in a task's context, and no curation turn. Opened
   * here rather than in the registry because the cap comes from the team sheet
   * and the sheet is read per task, inside this lock — see `session/memory.ts`.
   */
  memory?: MemoryFileOpener;
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

    // Filled by the critical section below, and read after it. The task builds
    // it because everything it closes over is the task's; this file decides when
    // it runs, because the queue is this file's.
    let curate: (() => Promise<void>) | undefined;

    const reply = await session.mutex.run(async () => {
      if (waited) {
        logger.log("info", {
          event: "queued",
          channel: request.key.channel,
          eventId: request.traceId,
          queuedMs: now() - arrivedAt
        });
      }

      // The window this task's thread stays warm for, once the sheet has said.
      // Held out here so the refresh below can reach it whichever way the task
      // ended: a task that threw still worked in this thread, and a thread that
      // went cold because the provider was down is a user typing a follow-up
      // into silence.
      //
      // `undefined` means the sheet never answered, which is the one case where
      // this leaves the thread exactly as it found it. The sheet is the only
      // thing that gets to say how long a window is, and a resolver that threw
      // — it is documented total, so this is defence rather than a path — has
      // said nothing rather than said zero.
      let followUpWindowMs: number | undefined;

      try {
        // Inside the lock, so the sheet a task runs on is resolved in the same
        // serialized step as the task itself. An operator's edit lands between
        // two tasks rather than half way through one.
        const settings = await options.sheets(request.key.channel);
        followUpWindowMs = settings.followUpWindowMs;

        // Marked active before the task runs, not after, so a message arriving
        // while this one is still thinking is routed rather than dropped — it
        // then queues on the mutex behind this task, which is the serialization
        // working rather than a way around it. Refreshed in the `finally`, so
        // the window a person actually gets is measured from the answer.
        session.threads.activate(request.thread, now(), followUpWindowMs);

        // And so is the transcript, for a second reason on top of that one: the
        // read has to see the messages the previous task's conversation left
        // behind, and a read outside the lock could run while that task was
        // still going. The assembler is here rather than in the sheet resolver
        // because it needs the session — its store and its name cache — and
        // `SheetResolver` is given a channel id and nothing else.
        // Opened inside the lock for the reason everything else here is: it is
        // read now and written by the curation turn queued below, and both have
        // to be ordered against the next task's read. A channel whose sheet
        // disables curation opens nothing — there is no read half without a
        // write half, and a task that could see a file it may never update would
        // be showing the model something nobody can correct.
        const memoryFile =
          settings.memory.enabled === true
            ? (options.memory?.(request.key.channel, settings.memory.maxFileChars) ?? undefined)
            : undefined;

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
          bounds: settings.history,
          memory: memoryFile?.read() ?? ""
        });

        const outcome = await options.task(request, {
          ...settings,
          messages,
          ...(memoryFile !== undefined ? { memoryFile } : {})
        });

        curate = outcome.curate;
        return outcome.reply;
      } finally {
        const finishedAt = now();
        session.lastUsedAt = finishedAt;
        if (followUpWindowMs !== undefined) {
          session.threads.activate(request.thread, finishedAt, followUpWindowMs);
        }
      }
    });

    // Queued on the same mutex, and deliberately not awaited (#227).
    //
    // **Not awaited**, so the reply is not held behind a second model call. The
    // person who asked gets their answer at the same moment they always did.
    //
    // **On the mutex**, for three things at once: the next task's context read
    // is serialized against this write rather than racing it, `pending` stays
    // above zero so the registry cannot evict the session mid-curation, and the
    // ordering is a queue position rather than a timing accident.
    //
    // **Enqueued synchronously here**, before this function yields again, so in
    // the ordinary case curation is next in line and the following task sees
    // what it wrote. A follow-up that queued *while the task ran* is already
    // ahead of it and will read the file as it was — deterministic, and the
    // README says so rather than leaving it to be discovered. Its own curation
    // turn then runs against the file both wrote.
    //
    // `void` and no `catch`: the thunk is documented never to reject, and it
    // swallows into a log line where it has a logger. A `.catch` here would be
    // asserting otherwise.
    if (curate !== undefined) void session.mutex.run(curate);

    return reply;
  };
}
