import { describe, it } from "node:test";
import { expect } from "expect";
import { renderChecklistCard } from "./checklist-card.js";
import type { ChecklistCardInput, ChecklistStep } from "./checklist-card.js";
import type { SlackBlock, SlackCard } from "./types.js";

const STEPS: ChecklistStep[] = [
  { name: "github.list_pull_requests", state: "ok" },
  { name: "github.merge_pr", state: "running" }
];

function card(input: Partial<ChecklistCardInput> = {}): SlackCard {
  return renderChecklistCard({
    steps: input.steps ?? STEPS,
    status: input.status ?? { state: "working" }
  });
}

/** Everything a reader would see, as one string. */
function text(rendered: SlackCard): string {
  return JSON.stringify(rendered.blocks);
}

/** The first section's rendered text — the label and every row. */
function rows(rendered: SlackCard): string {
  const block = rendered.blocks[0] as SlackBlock;
  return (block["text"] as { text: string }).text;
}

describe("renderChecklistCard", () => {
  it("lists each call once, in order, with its own word", () => {
    const body = rows(card());

    expect(body).toContain("`github.list_pull_requests` — done");
    expect(body).toContain("`github.merge_pr` — running");
    expect(body.indexOf("list_pull_requests")).toBeLessThan(body.indexOf("merge_pr"));
  });

  // A working task is not executed, is not waiting on a human, and is not
  // blocked — none of the three colours the design system has. See
  // `SlackCard.color`.
  it("wears no colour while the task is working", () => {
    expect(card().color).toBeUndefined();
    expect(Object.hasOwn(card(), "color")).toBe(false);
  });

  it("wears no colour when shutdown cancelled the task, which concluded nothing", () => {
    expect(card({ status: { state: "cancelled" } }).color).toBeUndefined();
  });

  it("goes green for a task that reached its own end, and red for one that was stopped", () => {
    expect(card({ status: { state: "done" } }).color).toBe("#1BA85A");
    expect(card({ status: { state: "stopped" } }).color).toBe("#FF6B5B");
  });

  // The acceptance criterion: a task stopped by a cap shows which cap.
  it("names the cap that stopped the task, in its own block", () => {
    const rendered = card({
      status: { state: "stopped", note: "Stopped: per-task tool call cap reached." }
    });

    expect(text(rendered)).toContain("per-task tool call cap reached");
    // Its own block, not another row: it is a fact about the task rather than
    // about any one call.
    expect(rows(rendered)).not.toContain("per-task tool call cap");
    expect(rendered.blocks).toHaveLength(2);
  });

  it("says the state in words as well as in colour", () => {
    // Two of the four states have no colour at all, so the label is not
    // reinforcement here — it is the whole signal.
    const expected: Array<[ChecklistCardInput["status"], string]> = [
      [{ state: "working" }, "WORKING"],
      [{ state: "done" }, "DONE"],
      [{ state: "stopped" }, "STOPPED"],
      [{ state: "cancelled" }, "CANCELLED"]
    ];

    for (const [status, label] of expected) {
      expect(rows(card({ status }))).toContain(`\`${label}\``);
    }
  });

  it("summarizes rather than lists in the fallback, which is one line on a lock screen", () => {
    expect(card().fallback).toBe("Working: 1 of 2 tool calls done.");
    // Singular for one call, because a notification is a sentence a person reads.
    expect(
      card({ steps: [STEPS[0] as ChecklistStep], status: { state: "done" } }).fallback
    ).toBe("Done: 1 of 1 tool call done.");
    expect(
      card({ status: { state: "stopped", note: "Stopped: per-task time limit reached." } }).fallback
    ).toContain("per-task time limit reached");
    expect(card({ status: { state: "cancelled" } }).fallback).toContain("shutting down");
  });

  it("distinguishes a call that failed from one that never ran", () => {
    const body = rows(
      card({
        steps: [
          { name: "github.merge_pr", state: "error" },
          { name: "github.delete_branch", state: "skipped" }
        ]
      })
    );

    expect(body).toContain("`github.merge_pr` — failed");
    expect(body).toContain("`github.delete_branch` — not run");
  });

  it("carries no emoji, and colours no individual row", () => {
    // `design/README.md`: no exclamation marks, no emoji. And the three colours
    // are the card's status — a green tick beside a red cross would be a fourth
    // and fifth thing coloured on a surface whose rule is that only status is.
    const emoji = /[☀-➿]|[\u{1F000}-\u{1FAFF}]/u;
    const rendered = card({ status: { state: "done" } });

    expect(emoji.test(`${text(rendered)}${rendered.fallback}`)).toBe(false);
    // One colour on the card, and it is the attachment's.
    expect(text(rendered)).not.toContain("#1BA85A");
  });

  // `name` is the flat name the model emitted — it may not even decode to a
  // (server, tool) pair — so it is model-authored text on a surface a human
  // reads while deciding whether the agent is behaving.
  it("neutralizes markup in the tool name, which the model wrote", () => {
    const rendered = card({
      steps: [{ name: "<!channel> <@U0BOSS> <https://evil|ok>", state: "ok" }]
    });
    const rendered_text = `${text(rendered)}${rendered.fallback}`;

    expect(rendered_text).not.toContain("<!channel>");
    expect(rendered_text).not.toContain("<@U0BOSS>");
    expect(rendered_text).toContain("&lt;!channel&gt;");
    expect(rendered_text.match(/</gu)).toBeNull();
  });

  it("neutralizes markup in a caller-supplied stop note too", () => {
    const rendered = card({ status: { state: "stopped", note: "<!here> stopped" } });
    expect(text(rendered)).toContain("&lt;!here&gt;");
  });

  // Every row carries a model-authored name at up to 80 characters, and
  // `max_tool_calls_per_task` is an operator's number.
  it("caps the rows and says how many it left out, rather than cutting silently", () => {
    const many: ChecklistStep[] = Array.from({ length: 24 }, (_, index) => ({
      name: `github.tool_${String(index)}`,
      state: "ok"
    }));

    const body = rows(card({ steps: many }));

    expect(body).toContain("and 4 more");
    expect(body).toContain("github.tool_19");
    expect(body).not.toContain("github.tool_20");
    // The count is still the truth about the whole task.
    expect(card({ steps: many }).fallback).toContain("24 of 24");
  });

  it("truncates a name that would blow Slack's section limit", () => {
    const rendered = card({ steps: [{ name: "x".repeat(5000), state: "ok" }] });

    expect(rows(rendered).length).toBeLessThan(3000);
    expect(rows(rendered)).toContain("…");
  });

  it("holds a task with no calls yet, which is what a card posted at the first one is", () => {
    const rendered = card({ steps: [] });

    expect(rendered.blocks).toHaveLength(1);
    expect(rendered.fallback).toBe("Working: 0 of 0 tool calls done.");
  });

  it("emits plain JSON and nothing an SDK type would have smuggled in", () => {
    const rendered = card({ status: { state: "done" } });
    expect(JSON.parse(JSON.stringify(rendered))).toEqual(rendered);
  });
});
