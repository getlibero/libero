// The audit log as lines a person reads.
//
// Pure — entries in, strings out — so every layout decision below is testable
// without a database, and the command that calls it holds no formatting.
//
// ## One line per row, and no colour
//
// `list` is one line per row so `grep` still works on it. That rules out
// wrapping a long field onto a second line: a reader who greps for a tool name
// and gets half a record is worse off than one who gets a wide line.
//
// **No colour.** The design system's rule is that colour is status — green
// allowed and executed, amber awaiting a human, red blocked — and its companion,
// which the approval cards already follow, is that every state also names itself
// in text so the rendering is correct with no colour at all. Here the outcome
// word *is* the status, so colour would restate it.
//
// The mapping does not exist either. Eight outcomes onto three colours leaves
// `unavailable`, `unanswered`, `expired` and `approved` with no member of the
// vocabulary to take — `approved` is "a human said yes and nothing has run yet",
// which is not one of the three — and inventing assignments is exactly what
// "nothing else on screen is coloured" exists to stop. It would also be
// mechanically wrong here: ANSI in a CSV is a corrupt file, and a `isTTY` check
// would push a terminal concern into a seam whose whole shape is
// `(line: string) => void`.

import { auditRefusalMessage } from "@getlibero/schema";
import type { AuditEntry } from "@getlibero/proxy";
import { isoTime } from "./audit-csv.js";

/** Widest of a set, so a page aligns without a fixed width that truncates. */
const widest = (values: readonly string[]): number =>
  values.reduce((width, value) => Math.max(width, value.length), 0);

/** `server.tool`, the pair as the model names it and the sheet allows it. */
const call = (entry: AuditEntry): string => `${entry.server}.${entry.tool}`;

/**
 * The rightmost column: the one fact that outcome makes worth reading.
 *
 * Empty for `unanswered` and `expired`, and that is the honest cell rather than
 * a missing one. Nothing was measured on an `unanswered` row — the proxy could
 * not reach the result — and an expiry is a deadline passing, which has no
 * detail beyond the ticket already joined to it.
 */
function detail(entry: AuditEntry): string {
  if (entry.refusalReason !== undefined) return entry.refusalReason;
  if (entry.resultBytes !== undefined) {
    // The kinds only when there is more than one, so the ordinary row — a
    // result that was all text — reads exactly as it always did and a row that
    // moved something else says so on the one line an operator greps.
    const kinds = Object.keys(entry.resultBytesByType ?? {});
    const shape = kinds.length > 1 ? ` (${kinds.join(", ")})` : "";
    return `${entry.resultBytes} bytes${shape}${entry.resultIsError === true ? ", tool error" : ""}`;
  }
  return entry.approver ?? "";
}

/**
 * One line per entry, columns padded to the widest value in *this* set.
 *
 * Padded per page rather than to a constant, because a constant wide enough for
 * every channel id and every `server.tool` would be mostly whitespace, and one
 * narrow enough to look right would truncate the names this log exists to name.
 */
export function listLines(entries: readonly AuditEntry[]): string[] {
  const idWidth = widest(entries.map(entry => String(entry.id)));
  const channelWidth = widest(entries.map(entry => entry.channel));
  const callWidth = widest(entries.map(call));

  return entries.map(entry =>
    [
      String(entry.id).padStart(idWidth),
      isoTime(entry.at),
      // `unavailable` is the longest of the eight, so this is stable across
      // pages in a way the data-driven widths above deliberately are not.
      entry.outcome.padEnd(11),
      entry.channel.padEnd(channelWidth),
      call(entry).padEnd(callWidth),
      detail(entry)
    ]
      .join("  ")
      .trimEnd()
  );
}

/**
 * One record in full, label and value.
 *
 * Sixteen columns do not belong on a line, so `show` takes `budget show`'s
 * shape instead. `not recorded` rather than `0` or `false` for the result
 * columns, for the reason the CSV leaves them empty: absent means the proxy
 * could not measure a result, not that there was none.
 */
export function showLines(entry: AuditEntry): string[] {
  const lines = [
    `id             ${entry.id}`,
    `at             ${isoTime(entry.at)}`,
    `channel        ${entry.channel}`,
    `requesting     ${entry.requestingUser}`,
    `task           ${entry.task}`,
    `request        ${entry.requestId}`,
    `call           ${entry.callId}`,
    `server         ${entry.server}`,
    `tool           ${entry.tool}`,
    `arguments      ${entry.argumentsSha256}`,
    `outcome        ${entry.outcome}`
  ];

  if (entry.refusalReason !== undefined) {
    lines.push(`refusal        ${entry.refusalReason}`);
    // The sentence the channel was given, from the schema and never from a
    // string written here — and absent rather than invented when the row does
    // not carry the facts it needs. See `auditRefusalMessage`.
    const sentence = auditRefusalMessage(
      entry.refusalReason,
      entry.server,
      entry.tool,
      entry.budgetLimit,
      entry.destination
    );
    if (sentence !== null) lines.push(`               ${sentence}`);
    // Which limit bound, as its own line as well as inside the sentence: an
    // operator scanning a page of refusals reads the left column, and the
    // sentence is a paragraph in.
    if (entry.budgetLimit !== undefined) lines.push(`limit          ${entry.budgetLimit}`);
    // The host that ended a run, on the same argument (#219): a page of
    // refusals is scanned down the left, and "which host" is the first thing an
    // operator wants from an egress row.
    if (entry.destination !== undefined) lines.push(`destination    ${entry.destination}`);
  }

  // Only on rows where something was priced. A `not recorded` line on every row
  // of a deployment that caps no channel in dollars would be a line that is
  // never anything, which is the opposite of what this output is for.
  if (entry.daySpendMicroUsd !== undefined) {
    lines.push(
      // Labelled as the day's, because the reflex is to read a figure on a
      // call's row as that call's cost — and there is no such quantity.
      `spend today    ${usd(entry.daySpendMicroUsd)} (channel, UTC day, at this decision)`,
      `price table    ${entry.priceVersion ?? "not recorded"}`
    );
  }

  lines.push(
    `result         ${entry.resultBytes === undefined ? "not recorded" : `${entry.resultBytes} bytes`}`,
    `result blocks  ${
      entry.resultBytesByType === undefined
        ? "not recorded"
        : Object.entries(entry.resultBytesByType)
            .map(([kind, bytes]) => `${kind} ${String(bytes)}`)
            .join(", ")
    }`,
    `tool error     ${entry.resultIsError === undefined ? "not recorded" : String(entry.resultIsError)}`,
    `approver       ${entry.approver ?? "none"}`,
    `ticket         ${entry.ticket ?? "none"}`
  );

  return lines;
}

/**
 * Micro-USD as a person reads it.
 *
 * Two fraction digits and a pinned locale, matching `budgetWarningMessage` in
 * @getlibero/schema — the figure a channel was shown and the figure an operator
 * reads afterwards must not be formatted two different ways.
 */
function usd(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
