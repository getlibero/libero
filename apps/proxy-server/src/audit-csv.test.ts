import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openAuditDb } from "@getlibero/proxy";
import type { AuditEntry } from "@getlibero/proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_CSV_COLUMNS, csvField, csvHeader, csvRow, isoTime } from "./audit-csv.js";

const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    at: NOON,
    channel: "C024BE91L",
    requestingUser: "U0ALICE",
    task: "t-1",
    requestId: "r-1",
    callId: "toolu_01",
    server: "github",
    tool: "list_prs",
    argumentsSha256: "c".repeat(64),
    outcome: "ran",
    ...overrides
  };
}

/**
 * A minimal RFC 4180 reader, so a row is asserted by reading it back rather
 * than by comparing against a literal written to match the writer.
 *
 * It reads a whole document rather than a line, because that is the point: a
 * field carrying a newline makes one record span several lines, and a reader
 * that split on `\n` first would be agreeing with a bug rather than catching
 * one.
 */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = (): void => {
    fields.push(field);
    field = "";
    started = false;
  };
  const endRecord = (): void => {
    endField();
    records.push(fields);
    fields = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\n") {
      endRecord();
    } else {
      field += char;
      started = true;
    }
  }
  if (field !== "" || fields.length > 0) endRecord();
  return records;
}

const CALL_ID = AUDIT_CSV_COLUMNS.findIndex(column => column.header === "call_id");

describe("the column contract", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libero-audit-csv-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The export's headers are the table's column names, so a CSV column and a
  // SQL column are the same thing under the same name. Asserted against SQLite
  // itself, so a column added to the table without a decision here fails rather
  // than being silently absent from every export.
  it("names every column the table has, in the table's order", () => {
    const file = join(dir, "audit.db");
    openAuditDb({ file }).close();

    const raw = new DatabaseSync(file, { readOnly: true });
    let names: string[];
    try {
      names = raw.prepare("PRAGMA table_info(tool_call_audit)").all().map(row => row["name"] as string);
    } finally {
      raw.close();
    }

    expect(AUDIT_CSV_COLUMNS.map(column => column.header)).toEqual(names);
  });

  it("puts the headers in the header row", () => {
    expect(csvHeader()).toBe(AUDIT_CSV_COLUMNS.map(column => column.header).join(","));
    expect(csvHeader().split(",")).toHaveLength(16);
  });
});

describe("escaping", () => {
  // Not hypothetical: `call_id` is the model's tool-use id and its schema
  // constrains only its length, so these are values the proxy will faithfully
  // record if it is sent them. Every other text column is an identifier or a
  // certificate subject and can carry none of this.
  it.each([
    ["a comma", "a,b"],
    ["a double quote", 'he said "no"'],
    ["both", 'a,"b"'],
    ["a newline", "line1\nline2"],
    ["a carriage return", "line1\r\nline2"],
    ["leading whitespace", " leading"],
    ["trailing whitespace", "trailing "],
    ["only whitespace", " "],
    ["an empty string", ""],
    ["a formula", "=1+1"]
  ])("round-trips %s in call_id", (_what, callId) => {
    // A whole document — header, then the record — because a field carrying a
    // newline makes that record span lines, and a reader has to survive it for
    // the assertion to mean anything. No sentinel substitution: swapping
    // control bytes in and out would be the test agreeing with the writer
    // rather than reading what it produced.
    const document = `${csvHeader()}\n${csvRow(entry({ callId }))}\n`;
    const records = parseCsv(document);

    expect(records).toHaveLength(2);
    expect(records[1]).toHaveLength(AUDIT_CSV_COLUMNS.length);
    expect(records[1]?.[CALL_ID]).toBe(callId);
  });

  it("quotes only what needs quoting", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("has,comma")).toBe('"has,comma"');
    expect(csvField('has"quote')).toBe('"has""quote"');
    expect(csvField("has\nnewline")).toBe('"has\nnewline"');
    expect(csvField(" padded ")).toBe('" padded "');
    expect(csvField("")).toBe("");
  });

  // The trade is stated in the module header and in --help: this exports an
  // append-only log, so it records values rather than altering them. The test
  // exists so flipping that decision is deliberate rather than incidental.
  it("does not alter a field a spreadsheet would treat as a formula", () => {
    for (const dangerous of ["=1+1", "+1", "-1", "@SUM(A1)"]) {
      expect(csvField(dangerous)).toBe(dangerous);
    }
  });
});

describe("values", () => {
  it("writes time as ISO-8601 UTC with milliseconds", () => {
    expect(isoTime(NOON)).toBe("2026-08-04T12:00:00.000Z");
    expect(Date.parse(isoTime(NOON))).toBe(NOON);
  });

  const cell = (row: string, header: string): string | undefined =>
    parseCsv(row)[0]?.[AUDIT_CSV_COLUMNS.findIndex(column => column.header === header)];

  // The distinction `AuditRecord` insists on: absent means the proxy could not
  // measure a result, which is not the same claim as measuring none. A `false`
  // here would make an `unanswered` row read as a tool that ran and succeeded.
  it("leaves a result column empty when the row does not carry one", () => {
    const row = csvRow(entry({ outcome: "unanswered" }));

    expect(cell(row, "result_bytes")).toBe("");
    expect(cell(row, "result_is_error")).toBe("");
  });

  it("tells an empty result column from a false one", () => {
    const ran = csvRow(entry({ resultBytes: 0, resultIsError: false }));

    expect(cell(ran, "result_bytes")).toBe("0");
    expect(cell(ran, "result_is_error")).toBe("false");
  });

  it("writes the enumerated refusal reason, never the sentence", () => {
    const row = csvRow(entry({ outcome: "refused", refusalReason: "tool_not_allowed" }));

    expect(cell(row, "refusal_reason")).toBe("tool_not_allowed");
    expect(row).not.toContain("team sheet");
  });

  it("leaves approver and ticket empty when the row met no human", () => {
    const row = csvRow(entry());

    expect(cell(row, "approver")).toBe("");
    expect(cell(row, "ticket")).toBe("");
  });

  it("carries the approval columns when it did", () => {
    const row = csvRow(entry({ outcome: "approved", approver: "U0BOSS", ticket: "tk-77" }));

    expect(cell(row, "approver")).toBe("U0BOSS");
    expect(cell(row, "ticket")).toBe("tk-77");
  });
});
