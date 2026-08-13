import { TomlError, parse as parseToml } from "smol-toml";
import { PriceTable } from "./price-table.js";

/**
 * Text on disk to a validated price table, or a structured account of why not.
 *
 * `parseTeamSheet`'s shape and its discipline, deliberately — the two files are
 * the operator's two authored artifacts, they are read by the same process on
 * the same terms, and an operator who has learned to read one failure should not
 * have to learn a second vocabulary for the other. See ./parse-team-sheet.ts for
 * the argument that the format belongs beside the shape.
 *
 * Never throws, for the same reason: a mistyped price is an ordinary operator
 * error, and an exception on this path would either take the proxy down at
 * startup or be caught somewhere that treats it as "no prices", which is the one
 * reading that must never be reachable by accident.
 */

export interface PriceTableIssue {
  /** Dotted path into the table, e.g. `model.2.input`. Empty at root. */
  readonly path: string;
  /** Zod's issue code — a closed vocabulary, not prose. */
  readonly code: string;
}

export type PriceTableParse =
  | { readonly ok: true; readonly table: PriceTable }
  | { readonly ok: false; readonly reason: "toml_syntax"; readonly line: number; readonly column: number }
  | { readonly ok: false; readonly reason: "schema_invalid"; readonly issues: readonly PriceTableIssue[] };

/**
 * The failure side carries positions and issue paths, not messages.
 *
 * A price table holds no secrets — it is model ids and integers — so this is
 * defence in depth rather than a live leak. It is here because the proxy's
 * logger takes a closed field set, and a parser handing it free-form prose would
 * route around that on the first call site that logged a failure.
 */
export function parsePriceTable(text: string): PriceTableParse {
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) {
      return { ok: false, reason: "toml_syntax", line: error.line, column: error.column };
    }
    // smol-toml throws only TomlError for malformed input; anything else is a
    // bug or an OOM. See ./parse-team-sheet.ts.
    throw error;
  }

  const result = PriceTable.safeParse(data);
  if (result.success) {
    return { ok: true, table: result.data };
  }
  return {
    ok: false,
    reason: "schema_invalid",
    issues: result.error.issues.map(issue => ({
      path: issue.path.join("."),
      code: issue.code
    }))
  };
}
