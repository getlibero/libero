// `DEFAULT_AGENT_LOOP_CAPS` and the four `[llm]` per-task caps are one set of
// figures, written twice (#545).
//
// `loop/types.ts` says so — "mirroring DEFAULT_AGENT_LOOP_CAPS", says the sheet
// side — and both comments say the two are kept in step by hand, because
// `packages/schema` is the base package and cannot import from this one. That
// reason is real and this file does not remove it; what it adds is something
// that notices when the mirror stops being one.
//
// Here rather than in `packages/schema` because this is the side that can see
// both halves: `@getlibero/agent` depends on `@getlibero/schema`.
//
// ## Two of the four are unit-converted, and that is the point of asserting
//
// `max_task_seconds` is seconds and `maxWallTimeMs` is milliseconds. An
// equality assertion over the four would be wrong on that one and would have to
// be written as an equality that is not one — so the conversion is stated here,
// in the one direction the sheet-to-caps mapping goes. A test that quietly
// compared 300 against 300_000 and passed would be worse than no test.
//
// What this asserts is the *defaults*. `DEFAULT_AGENT_LOOP_CAPS` is what a
// caller with no sheet gets, and the `[llm]` defaults are what a sheet that
// mentions nothing gets; the claim the two comments make is that those are the
// same deployment. A sheet that states its own figures is not this file's
// business.

import { describe, it } from "node:test";
import { parseTeamSheet } from "@getlibero/schema";
import { expect } from "expect";
import { DEFAULT_AGENT_LOOP_CAPS } from "./loop/types.js";

/** A sheet whose `[llm]` block is present and says nothing, so every default applies. */
const INHERITS_EVERYTHING = `
[channel]
name = "engineering"
certificate_sha256 = ["${"AB".repeat(32)}"]

[llm]
`;

describe("DEFAULT_AGENT_LOOP_CAPS and the [llm] caps", () => {
  it("agrees with the sheet's own defaults, seconds converted", () => {
    const parsed = parseTeamSheet(INHERITS_EVERYTHING);
    if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.reason}`);
    const llm = parsed.sheet.llm;

    // As a whole object rather than four assertions, so a failure names every
    // figure that drifted at once rather than the first one.
    expect({
      maxToolCalls: llm.max_tool_calls_per_task,
      maxWallTimeMs: llm.max_task_seconds * 1000,
      maxTokens: llm.max_tokens_per_task,
      maxOutputTokensPerTurn: llm.max_tokens_per_turn
    }).toEqual(DEFAULT_AGENT_LOOP_CAPS);
  });

  it("states the conversion rather than assuming the two units are one", () => {
    const parsed = parseTeamSheet(INHERITS_EVERYTHING);
    if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.reason}`);

    // The guard on the assertion above: if `max_task_seconds` were ever
    // milliseconds too, the `* 1000` would be wrong and silently so.
    expect(parsed.sheet.llm.max_task_seconds).toBeLessThan(DEFAULT_AGENT_LOOP_CAPS.maxWallTimeMs);
  });
});
