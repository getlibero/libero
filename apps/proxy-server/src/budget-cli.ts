// The operator's path into the budget meter.
//
// A second entrypoint of the proxy process rather than a command in the
// published `libero` CLI or a route on the listener, and both halves of that
// are deliberate.
//
// Not a route, because a reset makes a hard limit soft again. The proxy has no
// admin principal — identity is `CN=channel:<id>` and nothing else, by design —
// so an admin route would mean inventing one, and it would put a state-clearing
// verb on the listener the agent talks to. `daily_tool_calls` surviving
// compromise of the agent process is the whole reason it is worth having, and a
// compromised agent that could reset its own budget would hold nothing.
//
// Not the published CLI, for the reason ./vault-cli.ts gives about the vault:
// the file lives in a container volume the operator's host cannot see.
//
//   docker compose run --rm proxy node dist/budget.js reset C024BE91L
//
// **This takes effect without restarting the proxy.** The database is WAL and
// the meter caches nothing, so a running proxy's next call reads what this
// process just wrote.
//
// Everything is injected — argv, env, both writers — so the behaviour is
// testable without a process. src/budget.ts is the five lines that supply the
// real ones.

import {
  channelDays,
  openBudgetDb,
  pruneTurnReports,
  readChannelSpend,
  resetChannel
} from "@getlibero/proxy";
import type { BudgetDb } from "@getlibero/proxy";
import { budgetDbFromEnv } from "./env.js";
import type { Env } from "./env.js";

export interface BudgetCliIo {
  argv: readonly string[];
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Clock, injected so `show` and `reset` can be tested on a fixed day. */
  now?: () => number;
}

/** 0 ok, 1 an operator error, 2 a usage error. Nothing else — as the vault CLI. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** How much history `prune` drops, matching the meter's own retention. */
export const PRUNE_OLDER_THAN_MS = 48 * 60 * 60 * 1000;

const USAGE = [
  "usage: budget <command>",
  "",
  "  show <channel>    print today's counters for a channel",
  "  days <channel>    print the days a channel has recorded spend on",
  "  reset <channel>   clear today's counters for a channel",
  "  prune             drop reported turn ids older than 48h",
  "",
  "A reset takes effect on the proxy's next call. It does not need a restart,",
  "and it clears today only — earlier days are left as they are.",
  "",
  "Reads PROXY_BUDGET_DB."
].join("\n");

const COMMANDS = ["show", "days", "reset", "prune"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

export function runBudgetCommand(io: BudgetCliIo): number {
  const [command, ...rest] = io.argv;
  const now = io.now ?? (() => Date.now());

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (!isCommand(command)) {
    io.err(`budget: unknown command: ${command}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  let file: string;
  try {
    file = budgetDbFromEnv(io.env);
  } catch (error) {
    io.err(messageOf(error));
    return EXIT_ERROR;
  }

  let db: BudgetDb;
  try {
    db = openBudgetDb({ file });
  } catch (error) {
    // A path, at worst. Nothing in this file holds a credential, so there is
    // nothing here for a message to carry.
    io.err(`budget: ${messageOf(error)}`);
    return EXIT_ERROR;
  }

  try {
    return run(io, db, command, rest, now);
  } catch (error) {
    io.err(`budget: ${messageOf(error)}`);
    return EXIT_ERROR;
  } finally {
    db.close();
  }
}

function run(
  io: BudgetCliIo,
  db: BudgetDb,
  command: Command,
  rest: readonly string[],
  now: () => number
): number {
  if (command === "prune") {
    if (rest.length > 0) {
      io.err("budget: prune takes no arguments");
      return EXIT_USAGE;
    }
    const removed = pruneTurnReports(db, now() - PRUNE_OLDER_THAN_MS);
    io.out(`budget: pruned ${removed} turn ${removed === 1 ? "report" : "reports"}`);
    return EXIT_OK;
  }

  const channel = rest[0];
  if (channel === undefined || rest.length > 1) {
    io.err(`budget: ${command} takes one channel id`);
    return EXIT_USAGE;
  }

  switch (command) {
    case "show": {
      const { day, spend } = readChannelSpend(db, channel, now());
      io.out(`channel     ${channel}`);
      io.out(`day         ${day} (UTC)`);
      io.out(`tool calls  ${spend.toolCalls}`);
      // Raw, and labelled as raw. What the budget was charged depends on the
      // channel's `cache_read_weight` and `cache_write_weight`, which are read
      // at decision time and are none of the meter's business.
      io.out(`input       ${spend.inputTokens}`);
      io.out(`output      ${spend.outputTokens}`);
      io.out(`cache read  ${spend.cacheReadTokens}`);
      io.out(`cache write ${spend.cacheWriteTokens}`);
      io.out("");
      io.out("Token counts are unweighted. The sheet's cache weights decide what");
      io.out("they cost against daily_tokens.");
      return EXIT_OK;
    }
    case "days": {
      const days = channelDays(db, channel);
      if (days.length === 0) {
        io.out(`budget: ${channel} has recorded no spend`);
        return EXIT_OK;
      }
      for (const day of days) io.out(day);
      return EXIT_OK;
    }
    case "reset": {
      const day = resetChannel(db, channel, now());
      io.out(`budget: reset ${channel} for ${day} (UTC)`);
      return EXIT_OK;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}
