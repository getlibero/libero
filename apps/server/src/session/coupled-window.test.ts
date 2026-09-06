// `SESSION_IDLE_MS` and the roof on `[llm] follow_up_window_seconds` are one
// figure, written twice (#545).
//
// `registry.ts` states the coupling and its direction: a session holds the set
// of threads it will answer without a re-mention, so evicting one deactivates
// its threads — and "**moving this down means moving that bound down**, or a
// channel can name a window the process quietly fails to keep". The sheet's own
// comment says the same from the other end. Both note they are kept in step by
// hand, because `packages/schema` cannot import from here.
//
// This file is here because `apps/server` can see both halves, and it is the
// third of the three such tests #545 added — the fourth pair needed none,
// because both of its halves were already in one package and became one figure.
//
// The units differ, and the assertion says so rather than hiding it: this
// number is milliseconds and the sheet's field is seconds.

import { describe, it } from "node:test";
import { parseTeamSheet } from "@getlibero/schema";
import { expect } from "expect";
import { SESSION_IDLE_MS } from "./registry.js";

const sheet = (seconds: number): string => `
[channel]
name = "engineering"
certificate_sha256 = ["${"AB".repeat(32)}"]

[llm]
follow_up_window_seconds = ${seconds}
`;

/** The sheet's field is seconds; this module's constant is milliseconds. */
const ROOF_SECONDS = SESSION_IDLE_MS / 1000;

describe("SESSION_IDLE_MS and [llm] follow_up_window_seconds' roof", () => {
  it("is a whole number of seconds, so the two can express the same instant", () => {
    expect(Number.isInteger(ROOF_SECONDS)).toBe(true);
  });

  it("lets a sheet name exactly as long as a session survives", () => {
    expect(parseTeamSheet(sheet(ROOF_SECONDS)).ok).toBe(true);
  });

  it("refuses one second more, rather than advertising a window eviction would cut", () => {
    expect(parseTeamSheet(sheet(ROOF_SECONDS + 1)).ok).toBe(false);
  });
});
