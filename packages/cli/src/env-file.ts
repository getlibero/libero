// Merging an environment file, as text.
//
// No filesystem and no knowledge of which variables Libero has — ./init-cli.ts
// supplies those. This module answers one question, "which of these names does
// the file already assign, and is the value empty", and renders the result.
//
// **It is not a dotenv implementation, and must not become one.** Quoting,
// escapes, interpolation and multi-line values are Docker Compose's business,
// and a value this code never rewrites is a value it never has to understand.
// What it needs is the set of assigned names, which a line-oriented match gives
// exactly.
//
// The one ambiguity worth naming is a line that looks like an assignment while
// sitting inside a multi-line quoted value. This code will count it as a name
// the file already has, and so will write *less* than it otherwise would —
// never more, and never over the top of anything. That is the safe direction,
// and it is why the ambiguity is documented rather than parsed away.

/** One variable in the file, with the value `init` writes when it is absent. */
export interface EnvVar {
  readonly name: string;
  /** Empty for anything an operator has to supply. Never a credential. */
  readonly value: string;
}

/** A comment paragraph and the variables it explains. Rendered together. */
export interface EnvBlock {
  readonly comment: readonly string[];
  readonly vars: readonly EnvVar[];
}

export interface MergeResult {
  readonly text: string;
  /** Names appended because the file did not assign them. */
  readonly appended: readonly string[];
  /** Names whose empty assignment was given a value. */
  readonly filled: readonly string[];
}

/**
 * Assignment lines, by name, to whether the value is empty.
 *
 * `export FOO=` counts: Compose ignores the keyword, but a file carrying it
 * has assigned the name, and appending a second assignment for it would leave
 * two lines where the last one silently wins.
 */
export function assignedNames(text: string): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match === null) continue;
    const name = match[1] as string;
    const value = (match[2] as string).trim();
    const empty = value === "" || value === '""' || value === "''";
    // First assignment wins the record, because that is the one a later fill
    // would rewrite. Compose reads the last, which is a reason not to append a
    // duplicate rather than a reason to track one.
    if (!found.has(name)) found.set(name, empty);
  }
  return found;
}

/**
 * The same lines, as values.
 *
 * `init` never needed this — the rule above is that a value it never rewrites
 * is a value it never has to understand — but `doctor` does: whether the vault
 * key decodes to 32 bytes, whether the provider is one of two, whether the
 * token that says `xoxb-` is in the variable that wants one.
 *
 * It stays a subset of what Compose reads, and deliberately: one pair of
 * matching surrounding quotes is stripped and nothing else is interpreted — no
 * escapes, no interpolation, no multi-line values. Everything it hands back is
 * therefore either the value Compose will see or a value doctor should not
 * pronounce on, and every caller checks a *shape*, so an unparsed oddity
 * surfaces as a check that failed loudly rather than as a wrong answer.
 */
export function assignedValues(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match === null) continue;
    // The last assignment wins here, because that is the one Compose reads —
    // the opposite of `assignedNames`, which records the first because that is
    // the one a fill would rewrite. Both are right for what they are for.
    found.set(match[1] as string, unquote((match[2] as string).trim()));
  }
  return found;
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(value);
  if (quoted === null) return value;
  return (quoted[1] ?? quoted[2]) as string;
}

/** The whole file, for a path that does not exist yet. */
export function renderEnvFile(header: readonly string[], blocks: readonly EnvBlock[]): string {
  const lines: string[] = [...header.map(commentLine), ""];
  for (const block of blocks) {
    lines.push(...block.comment.map(commentLine));
    for (const variable of block.vars) lines.push(`${variable.name}=${variable.value}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * An existing file, plus whatever it is missing.
 *
 * Every byte the operator wrote survives: comments, ordering, and — the rule
 * this whole module exists to hold — every value that is not empty. Absent
 * names are appended at the end under the comment that explains them, so the
 * addition reads as one block rather than as a bare name with no account of
 * itself.
 */
export function mergeEnvFile(existing: string, blocks: readonly EnvBlock[]): MergeResult {
  const assigned = assignedNames(existing);
  const appended: string[] = [];
  const filled: string[] = [];
  let text = existing;

  for (const block of blocks) {
    for (const variable of block.vars) {
      const empty = assigned.get(variable.name);
      if (empty === undefined) {
        appended.push(variable.name);
      } else if (empty && variable.value !== "") {
        text = fill(text, variable);
        filled.push(variable.name);
      }
    }
  }

  if (appended.length > 0) {
    const additions: string[] = [];
    for (const block of blocks) {
      const missing = block.vars.filter(variable => appended.includes(variable.name));
      if (missing.length === 0) continue;
      additions.push("", ...block.comment.map(commentLine));
      for (const variable of missing) additions.push(`${variable.name}=${variable.value}`);
    }
    text = `${text.trimEnd()}\n${additions.join("\n")}\n`;
  }

  return { text, appended, filled };
}

/** Rewrites the first empty assignment of one name, leaving the rest alone. */
function fill(text: string, variable: EnvVar): string {
  let done = false;
  return text
    .split("\n")
    .map(line => {
      if (done) return line;
      const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (match === null || match[2] !== variable.name) return line;
      if ((match[3] as string).trim() !== "") return line;
      done = true;
      return `${match[1] as string}${variable.name}=${variable.value}`;
    })
    .join("\n");
}

function commentLine(text: string): string {
  return text === "" ? "#" : `# ${text}`;
}
