// The operator's path into the audit log.
//
// A third entrypoint of the proxy process, beside ./vault-cli.ts and
// ./budget-cli.ts, and it is one for the reason they are:
//
//   docker compose run --rm proxy node dist/audit.js list --channel C024BE91L
//
// **Not the published CLI**, because `PROXY_AUDIT_DB` is `/data/audit/audit.db`
// inside a named Docker volume — the same volume shape as the vault's and the
// budget's — which the operator's host cannot open. `npx @getlibero/cli audit`
// would be a command whose first act is to open a path that is not there. The
// line the deployment already draws is that the CLI owns what the operator
// authors on the host (the channels directory, the certificates, the env file,
// all bind-mounted `:ro` into the services) and the proxy's own entrypoints own
// what the services own inside their volumes.
//
// **Not a route**, for a reason narrower than the budget's and older than both:
// the proxy has no admin principal, identity is `CN=channel:<id>` and nothing
// else, so a read route would have to invent one — and it would put "read every
// channel's history" on the listener the agent talks to.
//
// **This command cannot write.** The connection under `openAuditReader` is
// opened read-only, so SQLite refuses a write before the append-only triggers
// have to, and every statement it prepares is a SELECT. It resolves no
// credential and opens no vault; the audit table holds no credential value and
// there is nothing on this path that could reconstruct one.
//
// No colour is emitted, ever — the argument is in ./audit-format.ts, and it
// applies doubly here because ANSI in a CSV is a corrupt file.
//
// Everything is injected — argv, env, both writers — so the behaviour is
// testable without a process. src/audit.ts is the few lines that supply the real
// ones.

import { parseArgs } from "node:util";
import { AuditOutcome } from "@getlibero/schema";
import { openAuditReader } from "@getlibero/proxy";
import type { AuditEntry, AuditQuery, AuditReader } from "@getlibero/proxy";
import { csvHeader, csvRow } from "./audit-csv.js";
import { listLines, showLines } from "./audit-format.js";
import { auditDbFromEnv } from "./env.js";
import type { Env } from "./env.js";

export interface AuditCliIo {
  argv: readonly string[];
  env: Env;
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * 0 ok, 1 an operator error, 2 a usage error — as the two peers — and 3.
 *
 * The fourth is `verify`'s alone and it is a deliberate departure from the
 * vocabulary the other entrypoints share (#355). A broken chain is not an
 * operator error: nothing failed, the command did exactly what it was asked and
 * the answer is bad news about the file. Spelling that as 1 would make it
 * indistinguishable from a missing file or a schema version this build cannot
 * read — and `verify` is the one command here written to be run unattended, on a
 * timer, by something that has to decide whom to wake. "The audit log has been
 * altered" and "the audit log could not be opened" want different people.
 *
 * A code rather than a line on stdout, because the caller that most needs to
 * tell them apart is a shell, and asking a shell to grep for prose makes the
 * wording a contract.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_TAMPERED = 3;

/**
 * What `list` shows when nobody said otherwise.
 *
 * The issue's "default to something useful rather than the whole table". `csv`
 * deliberately has no such default: a human view shows the tail, and an export
 * gives you what you asked for or tells you it did not.
 */
export const DEFAULT_LIST_LIMIT = 50;

const USAGE = [
  "usage: audit <command> [filters]",
  "",
  "  list              print matching rows, oldest first",
  "  csv               print matching rows as CSV, oldest first",
  "  show <id>         print one row in full",
  "  ticket <id>       print every row for one approval ticket",
  "  open              print held and approved rows with no successor",
  "  verify            walk the hash chain; print the row count and the tip",
  "",
  "Filters, for list and csv:",
  "",
  "  --channel <id>    one channel",
  "  --since <when>    on or after",
  "  --until <when>    on or before",
  "  --server <name>   exact",
  "  --tool <name>     exact",
  "  --task <id>       exact; the meter's turn ids are <task>.<n>",
  "  --outcome <word>  repeatable: ran, held, refused, unavailable, unanswered,",
  "                    approved, denied, expired",
  "  --after <id>      rows after this id, for exporting what is new",
  "  --limit <n>       the most recent n rows, printed oldest first. list",
  `                    defaults to ${DEFAULT_LIST_LIMIT}; 0 means every match, as csv does`,
  "",
  "Times are UTC. A bare date is that whole day, so --since 2026-08-04 --until",
  "2026-08-04 is one day; 2026-08-04T12:00:00Z is that instant. A time must",
  "carry a zone, because one without a zone would be read as the host's, which",
  "is not what this prints. Both bounds are inclusive.",
  "",
  "open takes --channel. show and ticket take an id and nothing else.",
  "",
  "verify takes no filters and no arguments. The chain links consecutive rows,",
  "so a subset of them is a set of rows whose neighbours are missing, and a",
  "filtered walk would report a break at the second row of every query. It",
  "exits 0 when the chain holds, 3 when it does not, and 1 if the log could",
  "not be read at all.",
  "",
  "Write the tip hash down somewhere this file's holder does not control. The",
  "chain is unkeyed, so it detects a row altered without recomputing the rest;",
  "an attacker who recomputes the whole chain, or who drops rows from the end,",
  "leaves a file that verifies. The tip is what a kept copy is compared against.",
  "",
  "The file is opened read-only and this command has no statement that writes",
  "it. A CSV field beginning with = + - or @ is a formula to a spreadsheet;",
  "call_id is model-authored, and this export records values rather than",
  "altering them.",
  "",
  "Reads PROXY_AUDIT_DB."
].join("\n");

const COMMANDS = ["list", "csv", "show", "ticket", "open", "verify"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * A usage failure carrying the sentence to print.
 *
 * Filters are parsed in one place and validated in several, and every failure
 * is the same answer — say what was wrong, print usage, exit 2. A thrown value
 * keeps the parsing readable as a sequence of checks rather than a chain of
 * result types, and it never escapes `runAuditCommand`.
 */
class UsageError extends Error {}

/**
 * `YYYY-MM-DD`, optionally followed by a time that must carry a zone.
 *
 * Anchored, so anything else is refused before a date library gets an opinion.
 */
const TIME_BOUND =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/**
 * A time bound, by rule rather than by whatever `Date` will accept.
 *
 * `Date.parse` is lenient in three ways that each select a window nobody asked
 * for, and all three are load-bearing here rather than theoretical:
 *
 *   - it accepts non-ISO formats — `04/08/2026` is April 8th to a runtime and
 *     the 4th of August to most of the people who would type it, and
 *     `Aug 4 2026` parses too;
 *   - it *rolls over* an impossible date rather than refusing it, so
 *     `2026-02-30T00:00:00Z` silently becomes March 2nd;
 *   - it reads an ISO datetime with **no zone** as local time, which on a
 *     command whose usage says "times are UTC" is a quiet lie whose size is
 *     whatever the host's offset happens to be.
 *
 * So the shape is checked first, a zone designator is required whenever a time
 * is given, and the calendar date is validated by round-trip — which is what
 * catches the roll-over, since `Date.UTC` and `Date.parse` will both happily
 * absorb a 30th of February.
 *
 * `end` is what makes a bare date inclusive at both ends: `--until 2026-08-04`
 * means through 23:59:59.999Z of the 4th, not midnight at its start.
 */
function timeBound(value: string, end: boolean): number {
  const parts = TIME_BOUND.exec(value);
  if (parts === null) {
    throw new UsageError(
      `audit: not a time: ${value}. Use YYYY-MM-DD, or an instant with a zone such as 2026-08-04T12:00:00Z.`
    );
  }

  // The calendar date on its own, so February 30th is refused rather than
  // absorbed. Checked before the value is parsed, because the parse is what
  // would have hidden it.
  const [, year, month, day] = parts;
  const midnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(midnight).toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    throw new UsageError(`audit: not a date: ${value}`);
  }

  // A bare date is the whole UTC day. `parts[4]` is the hour, present only when
  // a time was given.
  if (parts[4] === undefined) {
    return end ? midnight + 86_400_000 - 1 : midnight;
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    // A shape this regex admits but the clock does not — 25:00, say.
    throw new UsageError(`audit: not a time: ${value}`);
  }
  return at;
}

/**
 * A non-negative integer, by regex rather than by `Number`.
 *
 * `Number("1e3")` is 1000, `Number("0x10")` is 16, and `Number(" 7 ")` is 7.
 * None of those is a thing an operator typed on purpose, and a `--limit` that
 * quietly means something else than it says is worse than one that is refused.
 */
function count(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`audit: ${flag} takes a whole number, not: ${value}`);
  }
  return Number(value);
}

interface Parsed {
  readonly query: AuditQuery;
  readonly positionals: readonly string[];
}

/**
 * `argv` after the subcommand, as a query.
 *
 * `parseArgs` from `node:util` rather than a dependency: this package has none
 * beyond the workspace, and the license gate is one of the things the issue asks
 * to stay green. `strict` is what makes `--chanel` an error rather than a filter
 * silently not applied, which on a query surface is the difference between "no
 * rows matched" and "every row matched".
 */
function parseFilters(rest: readonly string[]): Parsed {
  let values: Record<string, string | string[] | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: {
        channel: { type: "string" },
        server: { type: "string" },
        tool: { type: "string" },
        task: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        after: { type: "string" },
        limit: { type: "string" },
        // Repeatable, so `--outcome ran --outcome held` is a set rather than the
        // last one winning.
        outcome: { type: "string", multiple: true }
      }
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    // Node's message already names the offending flag and often suggests the
    // one that was meant; only the capital needs changing to match house style.
    const text = error instanceof Error ? error.message : "bad arguments";
    throw new UsageError(`audit: ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
  }

  const outcomes: AuditOutcome[] = [];
  for (const word of asList(values["outcome"])) {
    const parsed = AuditOutcome.safeParse(word);
    if (!parsed.success) {
      throw new UsageError(`audit: not an outcome: ${word}. One of ${AuditOutcome.options.join(", ")}.`);
    }
    outcomes.push(parsed.data);
  }

  const query: AuditQuery = {
    ...(str(values["channel"]) !== undefined ? { channel: str(values["channel"]) as string } : {}),
    ...(str(values["server"]) !== undefined ? { server: str(values["server"]) as string } : {}),
    ...(str(values["tool"]) !== undefined ? { tool: str(values["tool"]) as string } : {}),
    ...(str(values["task"]) !== undefined ? { task: str(values["task"]) as string } : {}),
    ...(str(values["since"]) !== undefined ? { sinceMs: timeBound(str(values["since"]) as string, false) } : {}),
    ...(str(values["until"]) !== undefined ? { untilMs: timeBound(str(values["until"]) as string, true) } : {}),
    ...(str(values["after"]) !== undefined ? { afterId: count(str(values["after"]) as string, "--after") } : {}),
    ...(str(values["limit"]) !== undefined ? { limit: count(str(values["limit"]) as string, "--limit") } : {}),
    ...(outcomes.length > 0 ? { outcomes } : {})
  };

  return { query, positionals };
}

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const str = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.at(-1) : value;

export function runAuditCommand(io: AuditCliIo): number {
  const [command, ...rest] = io.argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (!isCommand(command)) {
    io.err(`audit: unknown command: ${command}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  let parsed: Parsed;
  try {
    parsed = parseFilters(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err(USAGE);
      return EXIT_USAGE;
    }
    throw error;
  }

  let file: string;
  try {
    file = auditDbFromEnv(io.env);
  } catch (error) {
    io.err(messageOf(error));
    return EXIT_ERROR;
  }

  let reader: AuditReader;
  try {
    reader = openAuditReader({ file });
  } catch (error) {
    // A path and a schema version, at worst. Nothing on this path holds a
    // credential, so there is nothing here for a message to carry.
    io.err(`audit: ${messageOf(error)}`);
    return EXIT_ERROR;
  }

  try {
    return run(io, reader, command, parsed);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    io.err(`audit: ${messageOf(error)}`);
    return EXIT_ERROR;
  } finally {
    reader.close();
  }
}

function run(io: AuditCliIo, reader: AuditReader, command: Command, parsed: Parsed): number {
  const { query, positionals } = parsed;

  switch (command) {
    case "list": {
      requireNoPositionals(positionals, "list");
      const limit = query.limit ?? DEFAULT_LIST_LIMIT;
      const entries = reader.page({ ...query, limit });
      if (entries.length === 0) {
        io.out("audit: no rows matched");
        return EXIT_OK;
      }
      for (const line of listLines(entries)) io.out(line);

      // Only when something was actually dropped. A page that happens to be the
      // whole answer should not suggest there is more.
      const total = reader.count(query);
      if (total > entries.length) {
        io.out("");
        io.out(
          `audit: showing the most recent ${entries.length} of ${total} matching rows. --limit 0 prints all.`
        );
      }
      return EXIT_OK;
    }

    case "csv": {
      requireNoPositionals(positionals, "csv");
      // The header goes out even when nothing matched: a "no rows" line on
      // stdout would be a corrupt file, and a file with a header and no records
      // is a correct empty result that a spreadsheet opens.
      io.out(csvHeader());
      for (const entry of reader.page(query)) io.out(csvRow(entry));
      return EXIT_OK;
    }

    case "show": {
      const id = onePositional(positionals, "show", "an id");
      const entry = reader.byId(count(id, "show"));
      if (entry === undefined) {
        // The one command that promises a single record. Zero matches is an
        // answer for `list`; here it means the thing asked for is not there.
        io.err(`audit: no row with id ${id}`);
        return EXIT_ERROR;
      }
      for (const line of showLines(entry)) io.out(line);
      return EXIT_OK;
    }

    case "ticket": {
      const ticket = onePositional(positionals, "ticket", "a ticket id");
      return printOrEmpty(io, reader.byTicket(ticket));
    }

    case "open": {
      requireNoPositionals(positionals, "open");
      return printOrEmpty(io, reader.openApprovals(query.channel));
    }

    case "verify": {
      requireNoPositionals(positionals, "verify");
      // Refused rather than ignored. A filter here would silently answer a
      // different question — the chain links consecutive rows, so a walk over a
      // subset breaks at its second row — and a command whose whole output is a
      // verdict must not have a way to be given one nobody asked for.
      if (Object.keys(query).length > 0) {
        throw new UsageError("audit: verify takes no filters — it walks the whole log");
      }

      const verdict = reader.verifyChain();
      if (!verdict.ok) {
        // stderr, and named. Everything after a break was computed over a
        // predecessor this walk cannot vouch for, so those rows are unverified
        // rather than wrong — `verified` says how much of the log still holds
        // and the sentence stops there.
        io.err(
          verdict.reason === "content"
            ? `audit: the chain is broken at row ${verdict.brokenAt}: its columns do not hash to the ` +
                `value stored with them. ${verdict.verified} row(s) before it verify.`
            : `audit: the chain is broken at row ${verdict.brokenAt}: it does not follow the row ` +
                `before it. ${verdict.verified} row(s) before it verify.`
        );
        io.err("audit: rows after it are unverified, not vouched for.");
        return EXIT_TAMPERED;
      }

      io.out(`rows: ${verdict.rows}`);
      io.out(`tip:  ${verdict.tip}`);
      // The instruction, not a flourish. A tip nobody kept is a checksum of the
      // file against itself, which an attacker who rewrote the file can produce
      // as easily as this can — see the chain's limits in packages/proxy.
      io.out("");
      io.out("audit: keep the tip somewhere this file's holder does not control.");
      return EXIT_OK;
    }
  }
}

function printOrEmpty(io: AuditCliIo, entries: readonly AuditEntry[]): number {
  if (entries.length === 0) {
    io.out("audit: no rows matched");
    return EXIT_OK;
  }
  for (const line of listLines(entries)) io.out(line);
  return EXIT_OK;
}

function requireNoPositionals(positionals: readonly string[], command: string): void {
  if (positionals.length > 0) {
    throw new UsageError(`audit: ${command} takes filters, not arguments`);
  }
}

function onePositional(positionals: readonly string[], command: string, what: string): string {
  const [only] = positionals;
  if (only === undefined || positionals.length > 1) {
    throw new UsageError(`audit: ${command} takes ${what}`);
  }
  return only;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}
