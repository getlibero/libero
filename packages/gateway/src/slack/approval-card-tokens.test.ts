// The card's hexes are hand-transcribed from design/tokens.css, because Slack
// cannot read a CSS variable. The transcription is the one place the design
// system crosses into app code, and nothing at build time would notice it
// going stale — unlike the site, whose design-tokens.mjs throws when a token
// it needs is renamed. This test is that throw for the gateway: it parses the
// dark block of the spec's stylesheet and asserts the card wears exactly the
// tokens its doc comment names. Change a token upstream, re-sync tokens.css,
// and this fails until approval-card.ts follows.
//
// Read relative to this file, reaching outside the package on purpose:
// design/ is not a workspace package and has nothing to import, and vendoring
// the values here would recreate the drift this test exists to catch.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalTicket } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import { renderApprovalCard } from "./approval-card.js";

const TOKENS_CSS = join(dirname(fileURLToPath(import.meta.url)), "../../../../design/tokens.css");

/**
 * A token's dark value: the first declaration inside `:root`, which is the
 * dark block — dark is the default and light is the `[data-theme="light"]`
 * override further down, so first match is the right match.
 */
function darkToken(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{3,8})`, "u").exec(css);
  if (match?.[1] === undefined) throw new Error(`design/tokens.css no longer declares ${name}`);
  return match[1];
}

const TICKET: ApprovalTicket = { id: "0f2c9b3e-7a41-4c0d-9d2b-6e1f5a8c3b90", expiresAt: 1_749_998_700_123 };

const colourOf = (status: Parameters<typeof renderApprovalCard>[0]["status"]): string =>
  renderApprovalCard({ toolName: "github.pr.merge", status }).color;

describe("the card's colours against design/tokens.css", () => {
  const css = readFileSync(TOKENS_CSS, "utf8");

  it("draws awaiting in the dark --lb-warn", () => {
    expect(colourOf({ state: "awaiting", ticket: TICKET })).toBe(darkToken(css, "--lb-warn"));
  });

  it("draws approved in the dark --lb-accent", () => {
    expect(colourOf({ state: "approved", approver: "U0HUMAN" })).toBe(darkToken(css, "--lb-accent"));
  });

  it("draws denied and expired in the dark --lb-danger", () => {
    const danger = darkToken(css, "--lb-danger");
    expect(colourOf({ state: "denied", approver: "U0HUMAN" })).toBe(danger);
    expect(colourOf({ state: "expired" })).toBe(danger);
  });
});
