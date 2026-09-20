// The three lines this command adds to a skill file, and the sentence it says
// when it will not add them.
//
// Both halves are pure text, and they are here together because they are the
// two places #569's acceptance criteria actually live: what a re-vendor's diff
// looks like, and what an operator reads when a skill will not go in.
//
// ## The edit is an insertion, not a rewrite
//
// `serializeSkillFile` exists and is not used. It drops `allowed-tools` (it is
// in `DISCARDED_KEYS`, and the runtime is right to ignore a second statement of
// permission) and it writes the four keys it knows in a fixed order — so
// round-tripping a vendored file through it would silently edit two things
// upstream wrote, in a file whose whole purpose is to be a reviewable copy of
// somebody else's. #569 asks for "a diff of exactly the changed files plus the
// three metadata lines", and that only holds if the bytes are otherwise
// untouched. So: the parser is the authority on whether a file is valid, and it
// is never the thing that produces one.
//
// ## This file quotes the file it read, and the parser deliberately does not
//
// `SkillFileParse`'s header says the failure side carries "positions and codes,
// never file content", because a channel's skill is model-written and anything
// interpolated lands in whatever log or channel the caller reports to. The
// reasoning does not reach here and the inversion is deliberate: this runs on
// the operator's host, on a file they just asked for by name, and prints to
// their terminal. A line number with no line is the thing that makes a valid
// YAML file look like a broken one. So the parser stays the single authority on
// ok-or-not, and this reads the text again only to say *why* — which is why
// `explainSkillFailure` takes the parse result rather than re-deciding it.

import { SKILL_DESCRIPTION_MAX_CHARS } from "@getlibero/schema";
import type { SkillFileParse } from "@getlibero/schema";

const FENCE = "---";

/** The keys this command owns inside `metadata:`. Rewritten, never appended to. */
const PROVENANCE_KEYS = ["libero-source", "libero-ref", "libero-sha"] as const;

/** YAML's block scalar markers, which this grammar has no reading of. */
const BLOCK_SCALAR = /^[>|][+-]?$/;

export interface Provenance {
  /** The address as given, without its `@ref`. */
  readonly source: string;
  readonly ref: string;
  readonly sha: string;
}

export type SkillFileFailure = Extract<SkillFileParse, { ok: false }>;

/**
 * `SKILL.md` with `metadata:` carrying where it came from.
 *
 * Idempotent: the three keys are removed from an existing block before they are
 * written, so vendoring twice adds three lines rather than six, and a re-vendor
 * at a new ref changes exactly the two that moved.
 */
export function insertProvenance(text: string, provenance: Provenance): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const close = closingFence(lines);

  const entries = [
    `libero-source: ${provenance.source}`,
    `libero-ref: ${provenance.ref}`,
    `libero-sha: ${provenance.sha}`
  ];

  const block = findMetadata(lines, close);
  if (block === null) {
    lines.splice(close, 0, "metadata:", ...entries.map(entry => `  ${entry}`));
    return lines.join(eol);
  }

  const first = block.index + 1;
  const kept = lines.slice(first, block.end).filter(line => !isProvenance(line));
  lines.splice(first, block.end - first, ...kept, ...entries.map(entry => `${block.indent}${entry}`));
  return lines.join(eol);
}

function closingFence(lines: readonly string[]): number {
  if (lines[0]?.trim() !== FENCE) {
    throw new Error("its SKILL.md has no frontmatter to record provenance in. This is a bug.");
  }
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === FENCE) return index;
  }
  throw new Error("its SKILL.md has frontmatter that never closes. This is a bug.");
}

interface MetadataBlock {
  /** The line holding `metadata:` itself. */
  readonly index: number;
  /** One past the block's last entry, blank lines trimmed. */
  readonly end: number;
  /** The block's own indent, so a four-space file stays four-space. */
  readonly indent: string;
}

/**
 * The `metadata:` block, or `null` when there is none to join.
 *
 * Only the first is considered: the parser refuses a key given twice, so a
 * second one never reaches here. A `metadata:` carrying a *value* is refused
 * rather than worked around — the grammar reads that key as a map or as nothing
 * (see `DEFINED_KEYS`), so there is nowhere to put provenance that would not
 * mean rewriting a line upstream wrote.
 */
function findMetadata(lines: readonly string[], close: number): MetadataBlock | null {
  for (let index = 1; index < close; index += 1) {
    const match = /^metadata[ \t]*:[ \t]*(.*)$/.exec(lines[index] ?? "");
    if (match === null) continue;

    if ((match[1] ?? "").trim() !== "") {
      throw new Error(
        `its SKILL.md writes \`${(lines[index] ?? "").trim()}\` as a value on one line, and a ` +
          "shared skill reads metadata only as an indented block — so there is nowhere to " +
          "record where this came from.\nlibero:   Vendor a fork whose metadata: opens a block."
      );
    }

    let end = index + 1;
    while (end < close && ((lines[end] ?? "").trim() === "" || /^[ \t]/.test(lines[end] ?? ""))) end += 1;
    while (end > index + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;

    let indent = "  ";
    for (let entry = index + 1; entry < end; entry += 1) {
      const found = /^([ \t]+)\S/.exec(lines[entry] ?? "");
      if (found !== null) {
        indent = found[1] as string;
        break;
      }
    }
    return { index, end, indent };
  }
  return null;
}

function isProvenance(line: string): boolean {
  const match = /^[ \t]+([A-Za-z][A-Za-z0-9_-]*)[ \t]*:/.exec(line);
  return match !== null && (PROVENANCE_KEYS as readonly string[]).includes(match[1] as string);
}

/**
 * Why a skill file did not parse, in sentences rather than a line number.
 *
 * The headline first, then continuations the caller indents. Six of the
 * nineteen skills in `anthropics/skills` land here, so this is the command's
 * ordinary output rather than its error path.
 */
export function explainSkillFailure(text: string, failure: SkillFileFailure, where: string): readonly string[] {
  const lines = text.split(/\r?\n/);
  const at = (line: number): string => lines[line - 1] ?? "";

  switch (failure.reason) {
    case "no_frontmatter":
      return lines[0]?.trim() === FENCE
        ? [`${where} has frontmatter that never closes — no second --- line`]
        : [`${where} has no --- fenced frontmatter`];

    case "empty_body":
      return [`${where} has frontmatter and no body`];

    case "duplicate_key": {
      const key = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:/.exec(at(failure.line))?.[1] ?? "a key";
      return [
        `${where} names ${key} twice, the second time on line ${failure.line}`,
        "There is no answer to which one was meant, so this refuses rather than taking the last."
      ];
    }

    case "malformed_line":
      return malformedLine(lines, failure.line, where);

    case "schema_invalid":
      return schemaInvalid(lines, failure, where);
  }
}

function malformedLine(lines: readonly string[], line: number, where: string): readonly string[] {
  const offending = lines[line - 1] ?? "";

  // The common case by a wide margin, and the one a line number explains worst:
  // `description: >` reads as the value ">", so no map opens, and the prose
  // under it is a line the grammar has no reading of. Look back for the marker
  // rather than reporting the line the parser tripped on.
  for (let above = line - 2; above >= 1; above -= 1) {
    const candidate = lines[above] ?? "";
    if (/^[ \t]/.test(candidate) || candidate.trim() === "") continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(candidate);
    const value = (match?.[2] ?? "").trim();
    if (match !== null && BLOCK_SCALAR.test(value)) {
      const kind = value.startsWith(">") ? "folded" : "literal";
      return [
        `${where} writes \`${match[1] as string}: ${value}\`, a YAML ${kind} scalar continued on line ${line}`,
        "A shared skill's frontmatter is one value per line: no folded (>) or literal (|) " +
          "scalars, no escapes, no comments and no list values.",
        "Vendor a fork with it on one line, or ask upstream for one."
      ];
    }
    break;
  }

  if (/^[ \t]*#/.test(offending)) {
    return [
      `${where} has a # comment on line ${line}, and this grammar has no comment syntax`,
      "Vendor a fork without it."
    ];
  }

  if (/^[ \t]*-[ \t]/.test(offending)) {
    return [
      `${where} has a YAML list on line ${line}, and this grammar reads a key's map as indented key: value lines`,
      "Vendor a fork that writes it as a single value, or drops it — the team sheet is the allowlist here."
    ];
  }

  return [
    `${where} has a line ${line} that is neither key: value nor an indented entry under a bare key`,
    "The frontmatter is --- fenced key: value lines, one per line, and a markdown body under it."
  ];
}

function schemaInvalid(
  lines: readonly string[],
  failure: Extract<SkillFileFailure, { reason: "schema_invalid" }>,
  where: string
): readonly string[] {
  const described = failure.issues.find(issue => issue.path === "description");
  if (described !== undefined) {
    const value = scalarValue(lines, "description");
    if (value !== null && value.length > SKILL_DESCRIPTION_MAX_CHARS) {
      return [
        `${where} has a ${value.length}-character description, and the cap is ${SKILL_DESCRIPTION_MAX_CHARS}`,
        "The description is what retrieval matches against, so a truncated one is a different " +
          "skill — this refuses rather than cutting it.",
        "Vendor a fork with a shorter description."
      ];
    }
    if (value === null || value === "") {
      return [`${where} has no description, and a skill is retrieved by its description`];
    }
  }

  const named = failure.issues.find(issue => issue.path === "name");
  if (named !== undefined) {
    return [
      `${where} has a name its frontmatter cannot carry: ${scalarValue(lines, "name") ?? "(none)"}`,
      "Lowercase words joined by single dashes, letters and digits only, up to 64 characters."
    ];
  }

  const where_ = failure.issues.map(issue => `${issue.path || "(root)"} (${issue.code})`).join(", ");
  return [`${where} has frontmatter the grammar rejects: ${where_}`];
}

/** One column-0 scalar's value, unquoted the way the grammar unquotes it. */
function scalarValue(lines: readonly string[], key: string): string | null {
  for (const line of lines.slice(1)) {
    if (line.trim() === FENCE) break;
    const match = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`).exec(line);
    if (match === null) continue;
    const trimmed = (match[1] ?? "").trim();
    const first = trimmed[0];
    if (trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
  return null;
}
