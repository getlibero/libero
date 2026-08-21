// `approval-card-tokens.test.ts`'s job for the second card, and the same
// argument: the hexes are hand-transcribed from design/tokens.css because Slack
// cannot read a CSS variable, and nothing at build time would notice one going
// stale. Two files rather than one parameterised over both renderers, because
// each asserts which token *its* states wear, and that mapping is the thing
// under test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "expect";
import { renderChecklistCard } from "./checklist-card.js";
import type { ChecklistCardStatus } from "./checklist-card.js";

const TOKENS_CSS = join(dirname(fileURLToPath(import.meta.url)), "../../../../design/tokens.css");

/** A token's dark value: the first declaration inside `:root`, the dark block. */
function darkToken(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{3,8})`, "u").exec(css);
  if (match?.[1] === undefined) throw new Error(`design/tokens.css no longer declares ${name}`);
  return match[1];
}

const colourOf = (status: ChecklistCardStatus): string | undefined =>
  renderChecklistCard({ steps: [{ name: "github.merge_pr", state: "ok" }], status }).color;

describe("the checklist's colours against design/tokens.css", () => {
  const css = readFileSync(TOKENS_CSS, "utf8");

  it("draws a finished task in the dark --lb-accent", () => {
    expect(colourOf({ state: "done" })).toBe(darkToken(css, "--lb-accent"));
  });

  it("draws a stopped task in the dark --lb-danger", () => {
    expect(colourOf({ state: "stopped" })).toBe(darkToken(css, "--lb-danger"));
  });

  // Amber is never used here: nothing on a checklist is waiting for a human.
  // The approval card is where that state lives, and it has its own message.
  it("never wears --lb-warn, which means a human still has to click", () => {
    const warn = darkToken(css, "--lb-warn");
    const every: ChecklistCardStatus[] = [
      { state: "working" },
      { state: "done" },
      { state: "stopped" },
      { state: "cancelled" }
    ];
    expect(every.map(colourOf)).not.toContain(warn);
  });

  it("spends no token on a task that has not concluded", () => {
    expect(colourOf({ state: "working" })).toBeUndefined();
    expect(colourOf({ state: "cancelled" })).toBeUndefined();
  });
});
