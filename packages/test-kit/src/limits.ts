// Every hard-coded figure in the tree, found the way #538 defines one.
//
// This is the sweep `limits-inventory.test.ts` asserts against the inventory
// page. It lives beside `workspace.ts` rather than inside the test for the
// reason that file gives: the test is the assertion, and the walk it asserts
// over is a thing you want to be able to run on its own while writing a row.
//
// ## Two categories, and why exactly these two
//
// #538 names them: a module-level numeric constant, and an inline numeric zod
// bound. They are the two shapes a chosen figure takes in this repository, and
// between them they cover every limit #465's table sampled.
//
// A `.max(SOME_CONSTANT)` is deliberately **not** a third category. It is a
// reader of a figure decided elsewhere, and giving it a row of its own would
// put the same decision on the page twice — once where it was made and once
// where it is used — which is how a table stops being read. The constant gets
// the row; the derived site is a fact about the constant.
//
// Object-literal cap fields — `DEFAULT_AGENT_LOOP_CAPS`' four, the hop caps in
// `apps/runner/src/run.ts` — are outside the net, and the inventory says so on
// the page rather than letting the omission be inferred. Matching them would
// mean knowing which object literals are caps and which are configuration,
// which is parsing TypeScript, which this package may not do: it declares no
// runtime dependencies, and that is what lets every other package import it.
//
// ## Brittle on purpose
//
// `ci-partition.test.ts` makes this argument for its own parser, and it applies
// here in one place rather than everywhere. A `const` whose right-hand side is
// not a number is dropped — most of them are strings and regexes, and throwing
// on those would be a sweep that cannot read its own tree. What throws is the
// case where dropping would *lose* something: two different figures under one
// `file:symbol` key, which the page has no way to tell apart. Picking one and
// carrying on would put a number on the page that the reader cannot find in the
// file it names, and a wrong row is worse than a failing check.
//
// The cost of the drop is real and worth naming: a figure spelled in a way
// `figureFrom` does not recognise leaves the sweep silently. That is what the
// non-vacuity guard in the test is for, and why the recognised spellings are
// the ones this repository actually writes rather than a general grammar.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, sources, workspacePackages } from "./workspace.js";

/** One hard-coded figure, keyed the way the inventory page addresses it. */
export interface Limit {
  /** Repository-relative path, e.g. `packages/proxy/src/approvals.ts`. */
  readonly file: string;
  /** The constant's name, or `field` for an inline bound on a zod field. */
  readonly symbol: string;
  /** The figure as written, e.g. `48 * 60 * 60 * 1000` or `1..10`. */
  readonly figure: string;
  /** How the page addresses it: `<file>:<symbol>`. */
  readonly key: string;
}

/**
 * Symbols that are numeric and are not limits, each with the reason.
 *
 * The reporter's `ALLOWED_SKIPS` in the same package, applied to a different
 * question. The point of the list is the same: excluding something from a check
 * becomes a line somebody wrote and a reviewer can argue with, rather than a
 * regex quietly not matching. An exit code is not a bound on anything, and
 * neither is the size of an AES key — but both are `const NAME = <number>` at
 * the top of a module, and nothing about their spelling says which they are.
 *
 * Keyed by symbol name rather than by path: every name here means the same
 * thing everywhere it appears, and five CLIs spelling `EXIT_OK` is five copies
 * of one fact rather than five decisions.
 */
export const NOT_A_LIMIT: Readonly<Record<string, string>> = {
  EXIT_OK: "a process exit code, not a bound on anything",
  EXIT_ERROR: "a process exit code",
  EXIT_USAGE: "a process exit code",
  EXIT_TAMPERED: "a process exit code — #355's fourth, so that an altered log and an unreadable one reach different people",

  AUDIT_SCHEMA_VERSION: "a migration marker; it counts versions, it does not bound one",
  BUDGET_SCHEMA_VERSION: "a migration marker",
  DRIFT_SCHEMA_VERSION: "a migration marker",
  MESSAGE_STORE_SCHEMA_VERSION: "a migration marker",
  ENVELOPE_VERSION: "a wire-format version",
  VERSION: "the token store's wire-format version",

  VAULT_KEY_BYTES: "the AES-256 key size, fixed by the cipher rather than chosen",
  MAGIC_LEN: "the envelope's magic-string length, fixed by the format",
  SALT_LEN: "the scrypt salt size, fixed by the format",
  IV_LEN: "the GCM nonce size, fixed by the cipher",
  TAG_LEN: "the GCM tag size, fixed by the cipher",

  DEFAULT_PORT: "a port, not a bound",
  DEFAULT_HOP_PORT: "a port, not a bound",

  MICRO_USD_PER_USD: "a unit conversion",
  NANO_USD_PER_USD: "a unit conversion",
  TOKENS_PER_PRICE_UNIT: "a unit conversion",

  UNAUTHENTICATED: "an HTTP status code",
  METHOD_NOT_FOUND: "a JSON-RPC error code",
};

/**
 * The packages swept.
 *
 * #538's own list is seven, and this is nine. `packages/gateway` and
 * `packages/cli` are here because the question the issue asks — what bounds a
 * deployment, and which of those bounds an operator may move — does not stop at
 * the two services. #465 makes the CLI's case in its own words: it bundles the
 * schema, so a published `libero` carries the numbers with it. The gateway's
 * are what a channel sees of a card.
 *
 * `e2e`, the two conformance packages and `test-kit` itself are not swept: a
 * figure in a test is a fixture, and this is a check on what ships.
 */
export const SWEPT = [
  "@getlibero/schema",
  "@getlibero/agent",
  "@getlibero/proxy",
  "@getlibero/memory",
  "@getlibero/gateway",
  "@getlibero/cli",
  "@getlibero/server",
  "@getlibero/proxy-server",
  "@getlibero/runner",
] as const;

/** A module-level numeric constant: `const NAME = 5;`, exported or not. */
const CONSTANT = /^(?:export )?const ([A-Z][A-Z0-9_]*) = ([^;]+);$/;

/**
 * An inline numeric zod bound: `.max(64)` or `.min(1)` with a literal.
 *
 * `.max(SOME_CONSTANT)` does not match, and that is the category boundary
 * above rather than a limitation of the pattern.
 */
const BOUND = /\.(max|min)\((\d[\d_]*)\)/g;

/**
 * What a bound is attributed to: a zod field, or a `const` holding a schema.
 *
 * Both spellings are here because both are how this repository writes one.
 * `top_k: z.number().int().min(1).max(10)` is a field on an object; `ModelId =
 * z.string().min(1).max(128)` is a schema bound once and reused, and the second
 * is no less a decision for having a name instead of a key.
 */
const BINDING = /^\s*(?:(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\s*:|(?:export )?const ([A-Za-z_][A-Za-z0-9_]*)\s*=)/;

/** A line that continues the chain above it, as a wrapped zod schema does. */
const CONTINUATION = /^\s*\./;

/**
 * The right-hand side of a constant, if it is a number.
 *
 * Accepts what this repository actually writes: a plain integer, `_`
 * separators, a `n` bigint suffix, a decimal, and the products that spell a
 * duration (`48 * 60 * 60 * 1000`). Anything else is not a figure and the
 * caller drops it — a string, an object, a call. Deliberately not an
 * expression evaluator: what goes on the page is the source text, so the sweep
 * only has to recognise a number, not compute one.
 */
function figureFrom(rhs: string): string | undefined {
  const trimmed = rhs.trim();
  return /^\d[\d_]*n?(\.\d+)?(\s*\*\s*\d[\d_]*)*$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Whether a set of bounds on one field is a limit or a presence check.
 *
 * `z.string().min(1)` says the string is not empty and `.nonnegative()`'s
 * cousin `.min(0)` says the number is not negative. Neither is a figure anybody
 * chose: they are the type saying what it is, spelled in zod. Giving them rows
 * would put ninety non-decisions on a page whose whole use is that every line
 * on it was decided.
 *
 * A `.max()` is always a limit. A `.min()` of anything but nought or one is a
 * floor somebody argued for — `summarize_after_idle_minutes`' five minutes is
 * the worked example, and its header argues the figure at length.
 */
function isLimit(bounds: { kind: string; figure: string }[]): boolean {
  return bounds.some(b => b.kind === "max" || (b.figure !== "0" && b.figure !== "1"));
}

/** Every figure in one file, in source order. */
export function limitsIn(file: string, text: string): Limit[] {
  const found: Limit[] = [];
  const seen = new Map<string, string>();
  const add = (symbol: string, figure: string) => {
    const key = `${file}:${symbol}`;
    const already = seen.get(key);
    if (already === figure) return; // The same figure restated — one decision, one row.
    if (already !== undefined) {
      // Two figures under one key, so the page could not address them apart.
      // Throwing beats picking: renaming one of them is a smaller thing to owe
      // than an inventory row that names a number the reader cannot find.
      throw new Error(
        `${key} is two different figures (${already} and ${figure}); the inventory addresses a limit by file and symbol, so one of them needs its own name`
      );
    }
    seen.set(key, figure);
    found.push({ file, symbol, figure, key });
  };

  // The binding a wrapped zod chain belongs to. A schema written across six
  // lines states its bounds on lines that name nothing, so the name is carried
  // down from the line that opened it and dropped at the first line that is
  // neither a continuation nor a new binding.
  let binding: string | undefined;
  let bounds: { kind: string; figure: string }[] = [];

  const flush = () => {
    if (binding && bounds.length > 0 && isLimit(bounds) && !(binding in NOT_A_LIMIT)) {
      const min = bounds.find(b => b.kind === "min")?.figure;
      const max = bounds.find(b => b.kind === "max")?.figure;
      add(binding, min && max ? `${min}..${max}` : max ? `max ${max}` : `min ${min}`);
    }
    bounds = [];
  };

  for (const line of text.split("\n")) {
    const constant = CONSTANT.exec(line);
    if (constant?.[1] && constant[2]) {
      flush();
      binding = undefined;
      if (constant[1] in NOT_A_LIMIT) continue;
      const figure = figureFrom(constant[2]);
      if (figure) add(constant[1], figure);
      continue;
    }

    const opened = BINDING.exec(line);
    if (opened) {
      flush();
      binding = opened[1] ?? opened[2];
    } else if (!CONTINUATION.test(line)) {
      flush();
      binding = undefined;
    }

    for (const [, kind, figure] of line.matchAll(BOUND)) {
      if (kind && figure) bounds.push({ kind, figure });
    }
  }
  flush();
  return found;
}

/** Every figure in the swept packages, by the two categories #538 names. */
export function limits(): Limit[] {
  const found: Limit[] = [];
  for (const pkg of workspacePackages()) {
    if (!(SWEPT as readonly string[]).includes(pkg.name)) continue;
    for (const file of sources(join(pkg.directory, "src"))) {
      if (file.endsWith(".test.ts")) continue;
      if (file.includes(`${join("src", "vendor")}`)) continue;
      found.push(...limitsIn(relative(ROOT, file), readFileSync(file, "utf8")));
    }
  }
  return found;
}
