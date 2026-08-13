import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openAuditDb } from "@getlibero/proxy";
import type { AuditRecord } from "@getlibero/schema";
import { refusalMessage } from "@getlibero/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIST_LIMIT, EXIT_ERROR, EXIT_OK, EXIT_USAGE, runAuditCommand } from "./audit-cli.js";

const CHANNEL = "C024BE91L";
const OTHER = "C7ZZZ9999";
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);
const NEXT_DAY = Date.UTC(2026, 7, 5, 12, 0, 0);

let dir: string;
let file: string;

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

function run(argv: string[], env?: Record<string, string>): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAuditCommand({
    argv,
    env: env ?? { PROXY_AUDIT_DB: file },
    out: line => void out.push(line),
    err: line => void err.push(line)
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/**
 * Rows written the way the proxy writes them, through the real writer — as the
 * budget CLI's tests drive the real meter. A hand-built file would test the
 * reader against a shape nothing in production produces.
 */
function append(...records: Partial<AuditRecord>[]): void {
  const db = openAuditDb({ file });
  try {
    for (const [index, overrides] of records.entries()) {
      db.append({
        at: NOON + index * 1000,
        channel: CHANNEL,
        requestingUser: "U0ALICE",
        task: "t-1",
        requestId: "r-1",
        callId: `toolu_${index}`,
        server: "github",
        tool: "list_prs",
        argumentsSha256: "c".repeat(64),
        outcome: "ran",
        ...overrides
      });
    }
  } finally {
    db.close();
  }
}

/** The spread every filter case reads against. Ids are 1..7 in this order. */
function seed(): void {
  append(
    { at: NOON, outcome: "ran", resultBytes: 1284, resultIsError: false },
    { at: NOON + 1000, tool: "delete_repo", outcome: "refused", refusalReason: "tool_not_allowed" },
    { at: NOON + 2000, server: "stripe", tool: "create_refund", outcome: "held", refusalReason: "approval_required", ticket: "tk-77" },
    { at: NOON + 3000, server: "stripe", tool: "create_refund", outcome: "approved", approver: "U0BOSS", ticket: "tk-77" },
    { at: NOON + 4000, server: "stripe", tool: "create_refund", outcome: "ran", approver: "U0BOSS", ticket: "tk-77", resultBytes: 612, resultIsError: true },
    { at: NEXT_DAY, channel: OTHER, task: "t-2", outcome: "held", refusalReason: "approval_required", ticket: "tk-lonely" },
    { at: NEXT_DAY + 1000, outcome: "unanswered", tool: "merge_pr" }
  );
}

/** The ids a run printed, read back off its lines. */
const ids = (result: Run): number[] =>
  result.out.filter(line => /^\s*\d+\s+\d{4}-/.test(line)).map(line => Number(line.trim().split(/\s+/)[0]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-audit-cli-"));
  file = join(dir, "audit.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("list", () => {
  beforeEach(seed);

  it("prints every row oldest-first, one line each", () => {
    const result = run(["list"]);

    expect(result.code).toBe(EXIT_OK);
    expect(ids(result)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // One line per row, so grep still works on it.
    expect(result.out.filter(line => line.includes("create_refund"))).toHaveLength(3);
  });

  it("names the call, the outcome and the channel on every line", () => {
    const result = run(["list", "--outcome", "refused"]);

    expect(result.out[0]).toContain("github.delete_repo");
    expect(result.out[0]).toContain("refused");
    expect(result.out[0]).toContain(CHANNEL);
    expect(result.out[0]).toContain("tool_not_allowed");
  });

  // The default the issue asks for: useful rather than the whole table.
  it("shows the most recent rows by default, and says what it dropped", () => {
    append(...Array.from({ length: DEFAULT_LIST_LIMIT + 10 }, (_, n) => ({ at: NEXT_DAY + 10_000 + n })));

    const result = run(["list"]);

    expect(ids(result)).toHaveLength(DEFAULT_LIST_LIMIT);
    expect(result.text).toContain(`the most recent ${DEFAULT_LIST_LIMIT} of ${DEFAULT_LIST_LIMIT + 17}`);
    expect(result.text).toContain("--limit 0 prints all");
  });

  // A page that is the whole answer must not suggest there is more.
  it("says nothing about truncation when it truncated nothing", () => {
    expect(run(["list"]).text).not.toContain("most recent");
    expect(run(["list", "--limit", "0"]).text).not.toContain("most recent");
  });

  it("takes the most recent n and still prints oldest-first", () => {
    expect(ids(run(["list", "--limit", "2"]))).toEqual([6, 7]);
  });

  // An empty result is an empty result, not an error — the acceptance criterion.
  it("reports no matches as success", () => {
    const result = run(["list", "--channel", "C0NOBODY"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.text).toContain("no rows matched");
  });
});

describe("filters", () => {
  beforeEach(seed);

  it("selects on each field on its own", () => {
    expect(ids(run(["list", "--channel", OTHER]))).toEqual([6]);
    expect(ids(run(["list", "--server", "stripe"]))).toEqual([3, 4, 5]);
    expect(ids(run(["list", "--tool", "delete_repo"]))).toEqual([2]);
    expect(ids(run(["list", "--task", "t-2"]))).toEqual([6]);
    expect(ids(run(["list", "--after", "5"]))).toEqual([6, 7]);
    expect(ids(run(["list", "--outcome", "ran"]))).toEqual([1, 5]);
  });

  it("takes an outcome more than once", () => {
    expect(ids(run(["list", "--outcome", "held", "--outcome", "approved"]))).toEqual([3, 4, 6]);
  });

  // A bare date is the whole UTC day, and both bounds are inclusive — so the
  // rows on either side of each boundary are in the file and out of the answer.
  it("bounds a bare date to that whole UTC day, inclusively", () => {
    expect(ids(run(["list", "--since", "2026-08-04", "--until", "2026-08-04"]))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(run(["list", "--since", "2026-08-05"]))).toEqual([6, 7]);
  });

  it("takes an instant as well as a day", () => {
    expect(ids(run(["list", "--since", "2026-08-04T12:00:02.000Z", "--until", "2026-08-04T12:00:03.000Z"]))).toEqual([
      3, 4
    ]);
  });

  // The acceptance criterion: filters compose, and a composition nothing
  // satisfies is an empty result rather than an error.
  it("composes channel, time and outcome with AND", () => {
    const result = run([
      "list",
      "--channel",
      CHANNEL,
      "--since",
      "2026-08-04",
      "--until",
      "2026-08-04",
      "--outcome",
      "ran",
      "--outcome",
      "held"
    ]);

    expect(result.code).toBe(EXIT_OK);
    expect(ids(result)).toEqual([1, 3, 5]);
    expect(run(["list", "--channel", OTHER, "--server", "stripe"]).text).toContain("no rows matched");
  });

  it("refuses a filter it does not have, rather than ignoring it", () => {
    const result = run(["list", "--chanel", CHANNEL]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("")).toContain("--chanel");
  });

  it("refuses a word that is not an outcome, and lists the ones that are", () => {
    const result = run(["list", "--outcome", "bogus"]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err[0]).toContain("not an outcome: bogus");
    expect(result.err[0]).toContain("unanswered");
  });

  // Each of these is a way `Date.parse` says yes and means something the person
  // typing it did not: a non-ISO format read in some other order, an impossible
  // date rolled forward into a real one, and — the quiet one — an ISO datetime
  // with no zone read as local time on a command whose usage says UTC.
  it.each([
    ["a month and a day that do not exist", "2026-13-40"],
    ["a date that rolls over", "2026-02-30"],
    ["a date that rolls over with a time on it", "2026-02-30T00:00:00Z"],
    ["prose", "last tuesday"],
    ["a non-ISO format", "04/08/2026"],
    ["a month name", "Aug 4 2026"],
    ["an instant with no zone", "2026-08-04T12:00:00"],
    ["an hour that does not exist", "2026-08-04T25:00:00Z"]
  ])("refuses %s", (_what, bad) => {
    const result = run(["list", "--since", bad]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.text).toMatch(/not a (date|time)/);
  });

  it("takes a zoned instant, and reads the zone", () => {
    // 14:00+02:00 is 12:00Z, which is row 1's second. If the offset were
    // ignored this would select nothing.
    expect(ids(run(["list", "--since", "2026-08-04T14:00:00+02:00", "--until", "2026-08-04T14:00:00+02:00"]))).toEqual(
      [1]
    );
  });

  // Number() accepts all of these and means something else by them.
  it("refuses a limit that is not a whole number", () => {
    for (const bad of ["1e3", "0x10", "3.5", "abc"]) {
      const result = run(["list", "--limit", bad]);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.text).toContain("whole number");
    }
  });
});

describe("show", () => {
  beforeEach(seed);

  it("prints the whole record, one field per line", () => {
    const result = run(["show", "1"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.text).toContain("channel        C024BE91L");
    expect(result.text).toContain("outcome        ran");
    expect(result.text).toContain("result         1284 bytes");
    expect(result.text).toContain(`arguments      ${"c".repeat(64)}`);
  });

  // The property the whole `auditRefusalMessage` bridge exists for: the
  // operator reading the log and the channel that saw the refusal are told the
  // same thing. Compared against the schema's own function rather than a
  // literal, so prose written here instead of delegated fails this test.
  it("gives the refusal the sentence the channel was given", () => {
    const result = run(["show", "2"]);

    expect(result.text).toContain("refusal        tool_not_allowed");
    expect(result.text).toContain(
      refusalMessage({ reason: "tool_not_allowed", server: "github", tool: "delete_repo" })
    );
  });

  // The row does not carry which budget ran out, so nothing may say which. The
  // assertion is an absence, because the failure mode is picking a plausible
  // variant to satisfy the type.
  it("prints the reason alone when the row lacks the facts for a sentence", () => {
    append({ at: NEXT_DAY + 5000, outcome: "refused", refusalReason: "budget_exhausted" });

    const result = run(["show", "8"]);

    expect(result.text).toContain("refusal        budget_exhausted");
    expect(result.text).not.toContain("daily token budget");
    expect(result.text).not.toContain("daily tool-call budget");
  });

  // Doubles as the "no output path prints a credential value" assertion: the
  // table holds neither the value nor the name, so there is nothing to print
  // and nothing to reconstruct.
  it("names no credential for an unresolved-credential refusal", () => {
    append({ at: NEXT_DAY + 5000, outcome: "refused", refusalReason: "credential_unresolved" });

    const result = run(["show", "8"]);

    expect(result.text).toContain("refusal        credential_unresolved");
    expect(result.text).not.toContain("is named in this channel's team sheet");
  });

  // Absent is not zero and not false: on an `unanswered` row the proxy could
  // not measure a result, which is a different claim from measuring none.
  it("says a result was not recorded rather than printing a zero", () => {
    const result = run(["show", "7"]);

    expect(result.text).toContain("outcome        unanswered");
    expect(result.text).toContain("result         not recorded");
    expect(result.text).toContain("tool error     not recorded");
    expect(result.text).not.toContain("result         0 bytes");
  });

  it("carries the approver and the ticket when the row has them", () => {
    const result = run(["show", "5"]);

    expect(result.text).toContain("approver       U0BOSS");
    expect(result.text).toContain("ticket         tk-77");
  });

  // Unlike `list`, this one promises a single record — so not finding it is an
  // error rather than an empty answer.
  it("fails when there is no such row", () => {
    const result = run(["show", "4210"]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err[0]).toBe("audit: no row with id 4210");
  });

  it("takes exactly one id", () => {
    expect(run(["show"]).code).toBe(EXIT_USAGE);
    expect(run(["show", "1", "2"]).code).toBe(EXIT_USAGE);
  });
});

describe("ticket and open", () => {
  beforeEach(seed);

  // "Every proxied call, refusal, and approval is findable" — an approval's
  // four rows are four requests sharing nothing but this column.
  it("prints one approval's whole lifecycle in order", () => {
    const result = run(["ticket", "tk-77"]);

    expect(result.code).toBe(EXIT_OK);
    expect(ids(result)).toEqual([3, 4, 5]);
    expect(result.text).not.toContain("tk-lonely");
  });

  it("reports an unknown ticket as no rows rather than an error", () => {
    const result = run(["ticket", "tk-never"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.text).toContain("no rows matched");
  });

  // The two questions `AuditOutcome`'s doc poses in prose: a held call nobody
  // resolved, and an approval nobody redeemed.
  it("finds tickets whose last row is held or approved, and no others", () => {
    append({ at: NEXT_DAY + 5000, outcome: "approved", approver: "U0BOSS", ticket: "tk-unredeemed" });

    const result = run(["open"]);

    expect(result.code).toBe(EXIT_OK);
    // tk-77 reached `ran`, so it is finished and must not appear.
    expect(result.text).not.toContain("tk-77");
    expect(ids(result)).toEqual([6, 8]);
  });

  it("scopes to one channel when asked", () => {
    expect(ids(run(["open", "--channel", OTHER]))).toEqual([6]);
    expect(run(["open", "--channel", CHANNEL]).text).toContain("no rows matched");
  });
});

describe("csv", () => {
  beforeEach(seed);

  it("prints a header and one record per row", () => {
    const result = run(["csv"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out[0]).toBe(
      "id,at,channel,requesting_user,task,request_id,call_id,server,tool,arguments_sha256," +
        "outcome,refusal_reason,budget_limit,day_spend_micro_usd,price_version," +
        "result_bytes,result_is_error,approver,ticket"
    );
    expect(result.out).toHaveLength(8);
  });

  // A "no rows" line on stdout would be a corrupt file. A header with no
  // records is a correct empty result that a spreadsheet opens.
  it("prints the header and nothing else when nothing matched", () => {
    const result = run(["csv", "--channel", "C0NOBODY"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).toContain("id,at,channel");
  });

  // Unlike list, an export never silently truncates.
  it("exports every match by default", () => {
    append(...Array.from({ length: DEFAULT_LIST_LIMIT + 10 }, (_, n) => ({ at: NEXT_DAY + 10_000 + n })));

    expect(run(["csv"]).out).toHaveLength(DEFAULT_LIST_LIMIT + 18);
  });

  it("takes the same filters list does", () => {
    expect(run(["csv", "--channel", OTHER]).out).toHaveLength(2);
    expect(run(["csv", "--outcome", "ran"]).out).toHaveLength(3);
  });

  it("writes the token for a refusal, never the sentence", () => {
    const line = run(["csv", "--outcome", "refused"]).out[1] ?? "";

    expect(line).toContain("tool_not_allowed");
    expect(line).not.toContain("team sheet");
  });
});

describe("the file it opens", () => {
  // Migrating is writing, and a reader that repaired a file would be a reader
  // that changed the evidence.
  it("refuses a file from a schema version it does not read", () => {
    const other = join(dir, "old.db");
    const raw = new DatabaseSync(other);
    try {
      raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
      raw.exec("INSERT INTO schema_version (version) VALUES (2)");
    } finally {
      raw.close();
    }

    const result = run(["list"], { PROXY_AUDIT_DB: other });

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("")).toContain("schema version 2");
  });

  // The reader's half of the writer's absent mkdir: a path nobody meant fails
  // loudly rather than reading as a log with nothing in it.
  it("fails on a file that is not there, and does not create one", () => {
    const missing = join(dir, "nope.db");

    const result = run(["list"], { PROXY_AUDIT_DB: missing });

    expect(result.code).toBe(EXIT_ERROR);
    expect(existsSync(missing)).toBe(false);
  });

  it("names the variable when it is not set", () => {
    const result = run(["list"], {});

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("")).toContain("PROXY_AUDIT_DB");
  });

  // The claim the command's header makes. Asserted through the command rather
  // than the reader, because this is the surface an operator has.
  it("leaves the log exactly as it found it", () => {
    seed();
    const before = run(["csv"]).out;

    run(["list"]);
    run(["show", "1"]);
    run(["open"]);
    run(["ticket", "tk-77"]);

    expect(run(["csv"]).out).toEqual(before);
  });
});

describe("usage and errors", () => {
  beforeEach(seed);

  it("prints usage and fails when given no command", () => {
    const result = run([]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.text).toContain("usage: audit <command>");
  });

  it("prints usage and succeeds when asked for help", () => {
    for (const flag of ["--help", "-h", "help"]) {
      const result = run([flag]);
      expect(result.code).toBe(EXIT_OK);
      expect(result.text).toContain("usage: audit <command>");
    }
  });

  it("rejects an unknown command", () => {
    const result = run(["drain"]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err[0]).toBe("audit: unknown command: drain");
  });

  it("rejects a stray argument where filters were expected", () => {
    expect(run(["list", "extra"]).code).toBe(EXIT_USAGE);
    expect(run(["csv", "extra"]).code).toBe(EXIT_USAGE);
    expect(run(["open", "extra"]).code).toBe(EXIT_USAGE);
  });

  // The vault CLI's "command that must never exist" test, for the verbs an
  // operator might reach for on a log that refuses all of them.
  it.each(["delete", "prune", "rotate", "reset", "purge", "truncate"])("has no %j command", command => {
    const result = run([command, "1"]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("")).toContain("unknown command");
  });

  // The usage text is where an operator is told about the one hazard this
  // export deliberately does not mitigate.
  it("warns in usage that a spreadsheet may read a field as a formula", () => {
    expect(run(["--help"]).text).toContain("formula");
  });
});
