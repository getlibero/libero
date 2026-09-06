// `READ_MAX_LIMIT` and the roof on `[llm] max_history_messages` are one figure,
// written twice (#545).
//
// The duplication has a reason and it is not going away: `packages/schema` is
// the base package and cannot import this one, so the two numbers cannot be
// made one the way `SandboxCaps` and `sandboxLimits` were. What was missing is
// anything that notices when they stop agreeing, which is what this file is.
//
// It lives here rather than in `packages/schema` because this is the side that
// can see both: `@getlibero/memory` depends on `@getlibero/schema`, and the
// reverse edge is the one the leaf rule forbids.
//
// ## What breaks if they drift
//
// `max_history_messages` is how an operator asks for more history, and every
// read here is clamped to `READ_MAX_LIMIT`. A sheet permitted to name a number
// above it would be silently clamped — "the one place a silent clamp here would
// be surprising rather than benign, because it is an operator's stated intent
// rather than a model's argument", as `store-db.ts` puts it. Raising
// `READ_MAX_LIMIT` alone is the quieter half of the same failure: the sheet goes
// on refusing a number the store would now honour.
//
// Asserted through `parseTeamSheet` rather than by reading the bound off the
// zod schema. What matters is which sheets parse, and a schema introspected for
// its `.max()` is a test of zod's internals rather than of the contract.

import { describe, it } from "node:test";
import { parseTeamSheet } from "@getlibero/schema";
import { expect } from "expect";
import { READ_MAX_LIMIT } from "./store-db.js";

const sheet = (messages: number): string => `
[channel]
name = "engineering"
certificate_sha256 = ["${"AB".repeat(32)}"]

[llm]
max_history_messages = ${messages}
`;

describe("READ_MAX_LIMIT and [llm] max_history_messages' roof", () => {
  it("lets a sheet name exactly the number this store will return", () => {
    const parsed = parseTeamSheet(sheet(READ_MAX_LIMIT));
    expect(parsed.ok).toBe(true);
  });

  it("refuses a sheet naming one more, rather than clamping it silently", () => {
    const parsed = parseTeamSheet(sheet(READ_MAX_LIMIT + 1));
    expect(parsed.ok).toBe(false);
  });
});
