// Where a governed `schedule_task` create becomes a durable ticket (#323).
//
// The tool proxy service decides and this side records, and the split is forced
// rather than chosen: the proxy opens a channel's store `readOnly`, and a writer
// there would be a second writer on one file from the process that must not be
// able to repair a channel's evidence. So the create is served, the proxy hands
// back the ticket it minted, and this converts it to a row.
//
// ## The narrow claim, because the overclaim is near
//
// **Scheduling is not a permission, and none of this is a boundary against a
// compromised agent process.** This process writes the row, so a compromised one
// could write a row nobody approved — and it could call the tools directly
// instead, which is cheaper. What the governed create holds against is the
// *prompt-injected model*: unbidden future work becomes a held, audited, budgeted
// act rather than a free one. What bounds a fired task is the machinery that
// bounds a mention.
//
// The pending cap holds in that same narrow sense, and it holds exactly. The
// proxy counts what this side has written; the loop dispatches a task's tool
// calls one at a time; `node:sqlite` writes are synchronous; and a channel's work
// is serialized on one session mutex. So the row from create *N* is on disk
// before create *N+1* is submitted, and no burst gets past the count. A
// compromised process can, and does not need to.
//
// ## What can be lost, and in which direction
//
// The audit log records the *governed create* and this records the *ticket that
// will fire*, and they can disagree one way: an audited create whose row never
// landed. It cannot be refused retroactively — the call ran — so the model is
// told plainly (`tools.ts` answers it an error result) and the log line here is
// what an operator reads. The other direction is not reachable: nothing writes a
// row the proxy did not serve.
//
// That also makes the proxy's count a *floor* on what is really pending, which is
// the safe direction: a channel gets at most one extra slot, never one fewer.
//
// ## Why this parses rather than `packages/agent`
//
// The client hands over the result's text and this parses it with
// `@getlibero/schema` — the same definition the proxy serialized it with. A
// failure here is a *deployment* fact, two halves that do not agree about a
// shape, and somebody has to log it. That package cannot log and must not learn
// how, so the parse is on this side of the seam, with the logger.

import { msFromScheduledInstant, parseScheduledTask } from "@getlibero/schema";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { MessageStore } from "@getlibero/memory";

/**
 * Records one served create. Answers whether the check will now fire.
 *
 * `false` is every way it will not — unparseable text, a store that rejected the
 * write — because the model's remedy is the same for all of them and the
 * distinction belongs in the log rather than in a channel.
 *
 * **Never throws.** It is called from inside the tool client, on the path that
 * answers the model, so a rejection here would end a task over a confirmation.
 */
export type ScheduledTaskSink = (ticket: string) => boolean;

export interface ScheduledTaskSinkOptions {
  /** The channel's own store, opened by the session. This writes to no other. */
  readonly store: MessageStore;
  /** For the log line. The channel is the one the store was opened for. */
  readonly channel: string;
  readonly logger?: Logger;
}

export function createScheduledTaskSink(options: ScheduledTaskSinkOptions): ScheduledTaskSink {
  const logger = options.logger ?? createSilentLogger();

  return (ticket: string): boolean => {
    const parsed = parseScheduledTask(ticket);
    if (!parsed.ok) {
      // A reason code and never the text. The ticket carries a model-authored
      // prompt, and `LogFields` has no place for one — nor should it, since this
      // line is read by an operator debugging two builds rather than a channel.
      logger.log("error", {
        event: "scheduled_task_unrecorded",
        channel: options.channel,
        reason: parsed.reason
      });
      return false;
    }

    try {
      options.store.scheduleTask({
        id: parsed.task.id,
        task: parsed.task.task,
        prompt: parsed.task.prompt,
        // Milliseconds here, an instant on the wire: `store-db.ts`'s clock
        // columns are numbers, and one exception would be the column somebody
        // compares against the others.
        dueAt: msFromScheduledInstant(parsed.task.dueAt),
        createdAt: msFromScheduledInstant(parsed.task.createdAt)
      });
    } catch (error) {
      logger.log("error", {
        event: "scheduled_task_unrecorded",
        channel: options.channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return false;
    }

    logger.log("info", { event: "scheduled_task_recorded", channel: options.channel });
    return true;
  };
}
