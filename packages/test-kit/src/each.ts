// `it.each`, which `node:test` does not have.
//
// This is the one piece of vitest the suite genuinely used — 155 call sites —
// and it is reproduced rather than expanded into hand-written loops so that
// #202's migration could keep its promise: the assertions do not change, only
// the harness around them. `each(cases)(name, fn)` is spelled to be a drop-in
// for `it.each(cases)(name, fn)`, which is what made the move a mechanical
// rewrite of one token.
//
// Two behaviours are copied from vitest deliberately, because tests depend on
// them:
//
//   - A case that is an array is spread across the callback's parameters, and
//     a case that is not is passed as the single argument. Both spellings are
//     in use here — `each([["dot-dot", ".."]])` and `each(SkillToolName.options)`.
//   - The name is formatted with only as many arguments as it has
//     placeholders. `node:util`'s `format` would otherwise append the leftovers
//     to the title, and the common shape in this suite is a two-element case
//     whose second element is the input and whose name names only the first.
//
// One thing it cannot do anything about: `node:test` takes a test's file from
// the call site of `it`, so every case registered here is reported as belonging
// to *this* file rather than to the one that asked for it. A failure's stack
// still names the real file, because the callback is declared there — but the
// reporter's file column will say `each.js`, and `ALLOWED_SKIPS` has to spell an
// entry that way.

import { it } from "node:test";
import { format } from "node:util";

/** What the callback receives: a tuple case spread, anything else as one argument. */
type Args<Case> = Case extends readonly unknown[] ? [...Case] : [Case];

/** The `node:test` options a generated case may carry. Timeouts are the only one used. */
export interface EachOptions {
  readonly timeout?: number;
  readonly skip?: boolean | string;
  readonly todo?: boolean | string;
}

/** `%%` is an escape rather than a placeholder, so it does not consume an argument. */
const PLACEHOLDER = /%[sdifjoO%]/g;

/**
 * The generated title. Exported for `each.test.ts` alone — `node:test` gives a
 * test no way to read back the name it was registered under, and the rule that
 * a title consumes only its own placeholders is the part of this module most
 * likely to be got wrong. It is deliberately absent from the package's barrel.
 */
export function title(name: string, args: readonly unknown[]): string {
  const consumed = (name.match(PLACEHOLDER) ?? []).filter(match => match !== "%%").length;
  return format(name, ...args.slice(0, consumed));
}

/**
 * Registers one test per case.
 *
 * ```ts
 * each([
 *   ["a parent traversal", ".."],
 *   ["a separator", "a/b"]
 * ])("refuses %s", (_label, id) => {
 *   expect(() => parse(id)).toThrow();
 * });
 * ```
 */
export function each<const Case>(cases: readonly Case[]) {
  return (
    name: string,
    fn: (...args: Args<Case>) => void | Promise<void>,
    options: EachOptions = {}
  ): void => {
    for (const entry of cases) {
      const args = (Array.isArray(entry) ? entry : [entry]) as unknown as Args<Case>;
      it(title(name, args), options, () => fn(...args));
    }
  };
}
