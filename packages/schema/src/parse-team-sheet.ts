import { TomlError, parse as parseToml } from "smol-toml";
import { TeamSheet } from "./team-sheet.js";

/**
 * Text on disk to a validated team sheet, or a structured account of why not.
 *
 * The file format lives with the schema rather than with the process that reads
 * the file. A team sheet is TOML *and* a shape, and splitting those across two
 * packages means two definitions of "is this a valid sheet" that can disagree —
 * the proxy's answer on every call and, eventually, whatever `libero validate`
 * tells an operator before they deploy one.
 *
 * Never throws. A sheet failing to parse is an ordinary operator error on a
 * path where an exception would either take the process down or, worse, be
 * caught somewhere that treats it as "no restrictions".
 */

export interface TeamSheetIssue {
  /** Dotted path into the sheet, e.g. `mcp_server.0.transport`. Empty at root. */
  readonly path: string;
  /** Zod's issue code — a closed vocabulary, not prose. */
  readonly code: string;
}

export type TeamSheetParse =
  | { readonly ok: true; readonly sheet: TeamSheet }
  | { readonly ok: false; readonly reason: "toml_syntax"; readonly line: number; readonly column: number }
  | { readonly ok: false; readonly reason: "schema_invalid"; readonly issues: readonly TeamSheetIssue[] };

/**
 * The failure side carries positions and issue paths, not messages.
 *
 * Enough for an operator to find the mistake, and nothing that interpolates
 * file content into a string. Team sheets are documented as holding no secrets,
 * so this is defence in depth rather than a live leak — but the proxy's logger
 * takes a closed field set for exactly this reason, and a parser handing it
 * free-form prose would route around that on the first call site that logged it.
 */
export function parseTeamSheet(text: string): TeamSheetParse {
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) {
      return { ok: false, reason: "toml_syntax", line: error.line, column: error.column };
    }
    // smol-toml throws only TomlError for malformed input; anything else is a
    // bug or an OOM, and reporting it as a syntax error at 0:0 is a lie worth
    // avoiding on a path whose whole job is saying precisely what went wrong.
    throw error;
  }

  const result = TeamSheet.safeParse(data);
  if (result.success) {
    return { ok: true, sheet: result.data };
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
