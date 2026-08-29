// The operator's path into the price-drift record (#239).
//
// A second entrypoint of the proxy process, for ./budget-cli.ts's reason: the
// file lives in a container volume the operator's host cannot open.
//
//   docker compose run --rm proxy node dist/drift.js show
//
// ## What it answers
//
// Two figures priced the same calls. The proxy computed one from the token
// counts the agent reported and the operator's price table; a router — a
// LiteLLM the operator runs, or the sidecar the compose file starts — computed
// the other from its own price map and reported it on the response. Where they
// disagree persistently, the operator's table has gone stale, and that is
// visible here rather than on the provider's invoice a month later.
//
// **The computed side is worked out now, not read back.** The record holds
// counts and what the gateway charged for them; what those counts cost under
// the price table is computed at this moment from the table as it stands. That
// is `PriceTable`'s own rule — cost is never accumulated, it is computed fresh —
// and it is what makes this command a feedback loop: correct a price, run it
// again, and the difference is gone.
//
// ## What it is not
//
// **Not a check, and it has no failing exit code.** 0, 1 and 2 mean what they
// mean in every other command here — ok, an operator error, a usage error — and
// there is deliberately no "drift found" code for a script to gate on. A
// threshold that refused something would be a policy nobody set, and #239's
// wording is emphatic that this must never enforce: enforcement is deterministic
// and lives in the proxy, from the operator's own table. The percentage below
// changes a sentence and nothing else.
//
// Everything is injected — argv, env, both writers — so the behaviour is
// testable without a process. src/drift.ts is the five lines that supply the
// real ones.

import { costMicroUsd, type PricedTokens } from "@getlibero/schema";
import { openDriftDb, openPriceTableStore } from "@getlibero/proxy";
import type { DriftRow, PriceLookup } from "@getlibero/proxy";
import { driftDbFromEnv, priceTableFromEnv } from "./env.js";
import type { Env } from "./env.js";

export interface DriftCliIo {
  argv: readonly string[];
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 0 ok, 1 an operator error, 2 a usage error. Nothing else — as the budget CLI. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/**
 * How far apart the two figures have to be before a row says so in words.
 *
 * One percent. Below it the two tables agree for every practical purpose —
 * pricing is integer arithmetic on both sides and the remaining fraction is
 * rounding — and above it there is a row to look at. It decides **wording
 * only**: every row is printed either way, with its numbers, and nothing here
 * gates, refuses, or exits differently for having crossed it.
 */
export const NOTABLE_DIFFERENCE = 0.01;

const USAGE = [
  "usage: drift <command>",
  "",
  "  show [channel]   compare the price table against what gateways reported",
  "  days <model>     the same comparison, day by day, for one model",
  "",
  "The comparison is drawn now, from the price table as it stands: fix a price",
  "and the difference goes away on the next run.",
  "",
  "Nothing here enforces. No call was refused or allowed because of any figure",
  "on this page, and there is no exit code for a difference being large.",
  "",
  "Reads PROXY_DRIFT_DB and PROXY_PRICE_TABLE."
].join("\n");

const COMMANDS = ["show", "days"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

export function runDriftCommand(io: DriftCliIo): number {
  const [command, ...rest] = io.argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (!isCommand(command)) {
    io.err(`drift: unknown command: ${command}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const file = driftDbFromEnv(io.env);
  if (file === undefined) {
    // The record being off is a configuration, not a failure — but a command
    // that was asked a question it cannot answer says so rather than printing
    // an empty table that reads as "no drift".
    io.err("drift: PROXY_DRIFT_DB is not set, so no comparison is being recorded");
    return EXIT_ERROR;
  }

  const priceFile = priceTableFromEnv(io.env);
  if (priceFile === undefined) {
    // Half the comparison is missing, and it is the half this deployment owns.
    // A deployment with no price table caps nothing in dollars, which is
    // exactly the deployment with no stale table to find.
    io.err("drift: PROXY_PRICE_TABLE is not set, so there is nothing to compare against");
    return EXIT_ERROR;
  }

  let rows: readonly DriftRow[];
  let prices: PriceLookup;
  const db = (() => {
    try {
      return openDriftDb({ file });
    } catch (error) {
      // A path, at worst. Nothing in this file holds a credential.
      io.err(`drift: ${messageOf(error)}`);
      return undefined;
    }
  })();
  if (db === undefined) return EXIT_ERROR;

  const store = openPriceTableStore({ file: priceFile });
  try {
    rows = db.readAll();
    prices = store.current();
  } catch (error) {
    io.err(`drift: ${messageOf(error)}`);
    return EXIT_ERROR;
  } finally {
    db.close();
    store.close();
  }

  if (command === "show") {
    const channel = rest[0];
    if (rest.length > 1) {
      io.err("drift: show takes at most one channel id");
      return EXIT_USAGE;
    }
    return show(io, rows, prices, channel);
  }

  const model = rest[0];
  if (model === undefined || rest.length > 1) {
    io.err("drift: days takes one model id");
    return EXIT_USAGE;
  }
  return days(io, rows, prices, model);
}

/** One model's totals, and what the two sides say about them. */
interface Comparison {
  readonly key: string;
  readonly turns: number;
  readonly tokens: PricedTokens;
  readonly reportedNanoUsd: bigint;
  /** Absent when the price table cannot price this model at all. */
  readonly computedNanoUsd?: bigint;
}

function compare(key: string, rows: readonly DriftRow[], prices: PriceLookup): Comparison {
  const tokens = {
    inputTokens: sum(rows, row => row.usage.inputTokens),
    outputTokens: sum(rows, row => row.usage.outputTokens),
    cacheReadTokens: sum(rows, row => row.usage.cacheReadTokens),
    cacheWriteTokens: sum(rows, row => row.usage.cacheWriteTokens)
  };
  const model = rows[0]?.model ?? "";
  const price = prices.priceFor(model);

  return {
    key,
    turns: sum(rows, row => row.turns),
    tokens,
    reportedNanoUsd: rows.reduce((total, row) => total + row.reportedNanoUsd, 0n),
    // **Summed counts priced once**, which is exactly the sum of pricing each
    // turn: cost is linear in the counts at a fixed price. It also truncates
    // once rather than once per turn, which matters at this scale — a
    // nine-token embedding costs less than the micro-USD `costMicroUsd`
    // truncates to.
    ...(price === undefined ? {} : { computedNanoUsd: costMicroUsd(price, tokens) * 1000n })
  };
}

function show(
  io: DriftCliIo,
  all: readonly DriftRow[],
  prices: PriceLookup,
  channel: string | undefined
): number {
  const rows = channel === undefined ? all : all.filter(row => row.channel === channel);
  if (rows.length === 0) {
    io.out(
      channel === undefined
        ? "drift: nothing recorded. No gateway has reported a cost — a deployment calling providers directly reports none."
        : `drift: nothing recorded for ${channel}`
    );
    return EXIT_OK;
  }

  const models = [...new Set(rows.map(row => row.model))].sort();
  const dayRange = range(rows.map(row => row.day));

  io.out(`days        ${dayRange} (UTC)`);
  io.out(`price table ${prices.version}`);
  if (channel !== undefined) io.out(`channel     ${channel}`);
  io.out("");

  for (const model of models) {
    const comparison = compare(
      model,
      rows.filter(row => row.model === model),
      prices
    );
    printComparison(io, comparison);
  }

  io.out("");
  io.out("`computed` is this deployment's price table applied to the counts the agent");
  io.out("reported. `reported` is what the gateway that served those calls charged for");
  io.out("them. Only calls a gateway priced are here: a direct provider call reports no");
  io.out("cost and is not part of the comparison.");
  io.out("");
  io.out("Nothing above enforced anything. What a channel may spend is decided from the");
  io.out("price table alone, on the channel's next call.");
  return EXIT_OK;
}

function days(
  io: DriftCliIo,
  all: readonly DriftRow[],
  prices: PriceLookup,
  model: string
): number {
  const rows = all.filter(row => row.model === model);
  if (rows.length === 0) {
    io.out(`drift: nothing recorded for ${model}`);
    return EXIT_OK;
  }

  io.out(`model       ${model}`);
  io.out(`price table ${prices.version}`);
  io.out("");

  for (const day of [...new Set(rows.map(row => row.day))].sort()) {
    printComparison(
      io,
      compare(
        day,
        rows.filter(row => row.day === day),
        prices
      )
    );
  }

  io.out("");
  io.out("The day a difference appears is the day one of the two tables changed. This");
  io.out("one is yours to correct; the gateway's is not.");
  return EXIT_OK;
}

function printComparison(io: DriftCliIo, comparison: Comparison): void {
  const { computedNanoUsd, reportedNanoUsd, turns } = comparison;
  const head = `${comparison.key.padEnd(24)} ${String(turns).padStart(7)} turns`;

  if (computedNanoUsd === undefined) {
    // The model is not in the price table at all, which is a different fault
    // with a different remedy — and one this deployment is already being told
    // about the expensive way, because `daily_usd` fails closed on it.
    io.out(`${head}  computed —  reported ${usd(reportedNanoUsd)}`);
    io.out(`  no price for this model. A channel capped in dollars is already being refused on it.`);
    return;
  }

  io.out(
    `${head}  computed ${usd(computedNanoUsd)}  reported ${usd(reportedNanoUsd)}${difference(
      computedNanoUsd,
      reportedNanoUsd
    )}`
  );

  const note = sentence(computedNanoUsd, reportedNanoUsd);
  if (note !== undefined) io.out(`  ${note}`);
}

/**
 * The gap as a percentage, or nothing when there is no denominator.
 *
 * A float, and the only one in this file: it is a figure to read rather than a
 * figure to act on, and money keeps its integers all the way to `usd`.
 */
function difference(computed: bigint, reported: bigint): string {
  if (computed === 0n) return "";
  const ratio = Number(reported - computed) / Number(computed);
  const sign = ratio >= 0 ? "+" : "";
  return `  ${sign}${(ratio * 100).toFixed(1)}%`;
}

/**
 * What the operator should do about this row, in words, or nothing.
 *
 * The direction is the whole point: which way a stale price is wrong decides
 * whether a dollar cap is letting spend through or cutting it off early, and
 * "the proxy says $4.12 and the gateway says $4.60" does not say that by
 * itself.
 */
function sentence(computed: bigint, reported: bigint): string | undefined {
  if (reported === 0n && computed > 0n) {
    // Priced at zero by the gateway rather than unpriced — an absent figure
    // never reaches this file. Both readings are worth naming, because the
    // remedies differ and the record cannot tell them apart.
    return "the gateway priced these at nothing: either the model is free there, or its own table has no row for it.";
  }
  if (computed === 0n) {
    return reported > 0n
      ? "your table prices these at nothing while the gateway charges for them. A `0` price is a statement that a model is free; check it is the one you meant."
      : undefined;
  }

  const ratio = Number(reported - computed) / Number(computed);
  if (Math.abs(ratio) < NOTABLE_DIFFERENCE) return undefined;

  return ratio > 0
    ? "your table prices this model below the gateway. A channel's daily_usd is allowing more real spend than it reads."
    : "your table prices this model above the gateway. A channel's daily_usd is cutting spend off earlier than it reads.";
}

/**
 * Nano-USD as dollars to four places, in integer arithmetic.
 *
 * Four rather than two because the figures here are small — a day of embeddings
 * is fractions of a cent — and rounding a comparison to the cent would make
 * every embedding row read `$0.00` against `$0.00`. No float touches the money
 * path, for `PriceTable`'s reason.
 */
function usd(nanoUsd: bigint): string {
  const tenThousandths = nanoUsd / 100_000n;
  const whole = tenThousandths / 10_000n;
  const fraction = (tenThousandths % 10_000n).toString().padStart(4, "0");
  return `$${whole}.${fraction}`;
}

function range(days: readonly string[]): string {
  const sorted = [...days].sort();
  const first = sorted[0] ?? "";
  const last = sorted[sorted.length - 1] ?? "";
  return first === last ? first : `${first} to ${last}`;
}

function sum(rows: readonly DriftRow[], of: (row: DriftRow) => number): number {
  return rows.reduce((total, row) => total + of(row), 0);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
