// The operator's path into a channel's scheduled checks (#324).
//
// **A second entrypoint of the gateway+agent process**, and where it lives was
// forced rather than chosen — twice over.
//
// Not the published `libero` CLI, for the reason #98 gave the audit log: the
// store is a named volume (`store-data`), so `npx @getlibero/cli` would open a
// path that is not on the operator's host. That is the rule the compose file
// already draws — the CLI owns what the operator authors on the host, and a
// service's own entrypoints own what that service owns inside its volumes.
//
// Not the *proxy's* entrypoints either, even though it mounts the same volume,
// because it mounts it `readOnly` by design. A cancel is a write, so it can only
// be this process's — which makes this `apps/server`'s first operator entrypoint,
// beside the four `apps/proxy-server` already carries.
//
//   docker compose run --rm server node dist/tasks.js list C024BE91L
//   docker compose run --rm server node dist/tasks.js cancel C024BE91L <id>
//   docker compose run --rm server node dist/tasks.js cancelled C024BE91L
//
// **It is not a route and there is no admin principal.** Nothing about this is
// reachable from the model: a channel's checks are created through a governed,
// approved tool call, and cancelled by a person with a shell on the host. There
// is no verb here the agent process can invoke on itself.
//
// **A cancel leaves a record** (#349), because the check it calls off is one a
// person in the channel approved — the store's schema comment carries the
// argument, and `cancelled` is the record's read.
//
// **This takes effect without restarting anything.** The database is WAL, the
// clock reads a channel's next due instant on every scan rather than caching one,
// so a running process's next scan sees what this just wrote — which is the
// property that read was chosen for.
//
// Everything is injected — argv, env, both writers, the opener — so the behaviour
// is testable without a process. ./tasks.ts is the handful of lines that supply
// the real ones.

import { openMessageStore } from "@getlibero/memory";
import type { CancelledScheduledTask, MessageStore, StoredScheduledTask } from "@getlibero/memory";
import { ChannelId } from "@getlibero/schema";
import { storeRootFromEnv } from "./env.js";
import type { Env } from "./env.js";

/** 0 ok, 1 an operator error, 2 a usage error. The vault and budget CLIs' set. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * How many checks `list` prints.
 *
 * Above `SCHEDULED_TASK_MAX_PENDING` so a channel at its cap is shown whole —
 * an operator reading this is usually deciding what to cancel, and a listing that
 * silently stopped at the interesting one would be the worst place to truncate.
 * It is a bound rather than a page: there is no `--limit`, because a channel that
 * could hold more than this has a cap that was raised on purpose and a listing
 * that says so is better than one that pretends.
 */
export const LIST_LIMIT = 50;

const USAGE = [
  "usage: tasks <command>",
  "",
  "  list <channel>           print the checks a channel is waiting on",
  "  cancel <channel> <id>    call off one check that has not run yet",
  "  cancelled <channel>      print the checks that were called off, newest first",
  "",
  "Reads AGENT_STORE_ROOT. A cancel ends the check and leaves a record — the row",
  "cancelled prints — because the check it calls off is one a human approved."
].join("\n");

export interface TasksCliIo {
  argv: readonly string[];
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injected so a test states the clock rather than reading one. */
  now?: () => number;
  /** Injected so a test drives a store it built. Defaults to the real opener. */
  open?: (channel: string, root: string) => MessageStore;
}

/**
 * One check, as a person reads it.
 *
 * Tab-separated and never a table, `audit-csv.ts`'s reason one step smaller: the
 * id has to be copy-pasteable into a `cancel`, and column alignment puts padding
 * between a cursor and the thing somebody is about to select. No colour, ever —
 * the audit CLI's rule, and there is no status here for a colour to mean anyway.
 *
 * The prompt is model-authored and goes out whole rather than truncated: an
 * operator deciding whether to cancel a check needs to read what it says, and a
 * cut sentence is exactly the input that makes that decision wrong. Newlines are
 * flattened so one check is one line, which is what makes the output greppable.
 */
function render(task: StoredScheduledTask): string {
  const due = new Date(task.dueAt).toISOString().slice(0, 19).replace("T", " ");
  return `${task.id}\t${due}Z\t${task.prompt.replace(/\s*\n\s*/g, " ")}`;
}

/**
 * One cancellation record, as a person reads it (#349). `render`'s rules, one
 * column wider: when it was called off first — the reader is asking "what
 * happened lately" — then when it would have run, then the prompt whole.
 */
function renderCancelled(record: CancelledScheduledTask): string {
  const cancelled = new Date(record.cancelledAt).toISOString().slice(0, 19).replace("T", " ");
  const due = new Date(record.dueAt).toISOString().slice(0, 19).replace("T", " ");
  return `${record.id}\t${cancelled}Z\twas due ${due}Z\t${record.prompt.replace(/\s*\n\s*/g, " ")}`;
}

export function runTasksCommand(io: TasksCliIo): number {
  const [command, channel, id, ...rest] = io.argv;

  if (command === undefined || channel === undefined || rest.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  // The same validation everything that touches a channel id does, and it earns
  // its place here for the reason `openMessageReader` states: the id becomes a
  // path segment, and this one comes off a command line.
  if (!ChannelId.safeParse(channel).success) {
    io.err(`tasks: ${JSON.stringify(channel)} is not a valid channel id`);
    return EXIT_USAGE;
  }

  let root: string;
  try {
    root = storeRootFromEnv(io.env);
  } catch (error) {
    io.err(`tasks: ${error instanceof Error ? error.message : "AGENT_STORE_ROOT is not set"}`);
    return EXIT_ERROR;
  }

  let store: MessageStore;
  try {
    store = (io.open ?? ((name, at) => openMessageStore({ channel: name, root: at })))(channel, root);
  } catch (error) {
    // A channel with no directory is the ordinary way here: `openMessageStore`
    // creates none, which is the gate `session/store.ts` keeps. Said as an
    // operator error rather than an empty listing, because "no such channel" and
    // "nothing scheduled" are different answers.
    io.err(`tasks: no store for ${channel} (${error instanceof Error ? error.name : "unknown"})`);
    return EXIT_ERROR;
  }

  try {
    switch (command) {
      case "list": {
        const tasks = store.listScheduledTasks(LIST_LIMIT);
        if (tasks.length === 0) {
          io.out(`no scheduled checks waiting in ${channel}`);
          return EXIT_OK;
        }
        for (const task of tasks) io.out(render(task));
        return EXIT_OK;
      }
      case "cancel": {
        if (id === undefined) {
          io.err(USAGE);
          return EXIT_USAGE;
        }
        // `false` covers a wrong id, another channel's id, and one that has
        // already run — three things an operator would want told apart, and the
        // store cannot tell them apart without reading rows this command has no
        // reason to read. What it can say truthfully is that nothing was
        // cancelled — and nothing is recorded either, so a failed cancel
        // cannot invent history.
        if (!store.cancelScheduledTask(id, (io.now ?? Date.now)())) {
          io.err(`tasks: ${channel} has no waiting check with that id`);
          return EXIT_ERROR;
        }
        io.out(`cancelled ${id}`);
        return EXIT_OK;
      }
      case "cancelled": {
        const records = store.listCancelledScheduledTasks(LIST_LIMIT);
        if (records.length === 0) {
          io.out(`no cancelled checks recorded in ${channel}`);
          return EXIT_OK;
        }
        for (const record of records) io.out(renderCancelled(record));
        return EXIT_OK;
      }
      default:
        io.err(USAGE);
        return EXIT_USAGE;
    }
  } finally {
    store.close();
  }
}
