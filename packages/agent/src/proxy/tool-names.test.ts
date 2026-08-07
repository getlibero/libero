import type { PermittedTool } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import { mapPermittedTools } from "./tool-names.js";

const listed = (server: string, tool: string, approval: "none" | "required" = "none"): PermittedTool => ({
  server,
  tool,
  approval
});

describe("naming a permitted tool for a model", () => {
  it("uses the bare tool name when nothing else claims it", () => {
    const { definitions } = mapPermittedTools([listed("github", "list_prs")]);
    expect(definitions.map(d => d.name)).toEqual(["list_prs"]);
  });

  it("qualifies with the server when two servers offer the same tool", () => {
    const { definitions } = mapPermittedTools([
      listed("github", "search"),
      listed("zendesk", "search")
    ]);
    // The first keeps the short name; the second cannot, so it says which
    // server it is. Both remain callable, which is the point — dropping one
    // would be the agent deciding what the channel may reach.
    expect(definitions.map(d => d.name)).toEqual(["search", "zendesk__search"]);
  });

  // Provider tool names are `[A-Za-z0-9_-]`. `ResourceName` differs in exactly
  // one character, so exactly one is rewritten.
  it("replaces the dot a provider will not accept, and nothing else", () => {
    const { definitions, byModelName } = mapPermittedTools([listed("acme.internal", "get.issue")]);
    expect(definitions[0]?.name).toBe("get_issue");
    // The rewrite is one-way and never parsed back: the map still holds the
    // real names, dots and all.
    expect(byModelName.get("get_issue")).toMatchObject({
      server: "acme.internal",
      tool: "get.issue"
    });
  });

  it("keeps every name inside the 64 characters every provider allows", () => {
    const long = "x".repeat(64);
    const { definitions } = mapPermittedTools([
      listed(long, long),
      listed(`${long.slice(0, 63)}y`, long),
      listed("short", long)
    ]);
    for (const definition of definitions) {
      expect(definition.name.length).toBeLessThanOrEqual(64);
      expect(definition.name).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  // The property the whole module exists for: whatever names come out, each one
  // decodes to exactly the pair it was built from. A collision would send a
  // call to the wrong server, which is the bug worth ruling out by test rather
  // than by reading the fallback logic.
  it("gives every pair its own name, however the names collide", () => {
    const tools = [
      listed("github", "search"),
      listed("zendesk", "search"),
      listed("github", "zendesk__search"),
      listed("acme.internal", "search"),
      listed("acme", "internal.search"),
      listed("x".repeat(64), "y".repeat(64)),
      listed("x".repeat(64), "z".repeat(64))
    ];
    const { definitions, byModelName } = mapPermittedTools(tools);

    expect(new Set(definitions.map(d => d.name)).size).toBe(tools.length);
    expect(byModelName.size).toBe(tools.length);
    for (const entry of tools) {
      const mapped = [...byModelName.values()].filter(
        m => m.server === entry.server && m.tool === entry.tool
      );
      expect(mapped).toHaveLength(1);
    }
  });

  it("names the same listing the same way every time", () => {
    const tools = [listed("github", "search"), listed("zendesk", "search")];
    expect(mapPermittedTools(tools).definitions).toEqual(mapPermittedTools(tools).definitions);
  });

  it("returns nothing for a channel that permits nothing", () => {
    const { definitions, byModelName } = mapPermittedTools([]);
    expect(definitions).toEqual([]);
    expect(byModelName.size).toBe(0);
  });
});

describe("what the model is told a tool is", () => {
  it("names the call and says the arguments are not described", () => {
    const [definition] = mapPermittedTools([listed("github", "list_prs")]).definitions;
    expect(definition?.description).toContain("`github.list_prs`");
    expect(definition?.description).toContain("not described");
  });

  it("says when a call is held for a human", () => {
    const [held] = mapPermittedTools([listed("github", "merge_pr", "required")]).definitions;
    const [free] = mapPermittedTools([listed("github", "list_prs")]).definitions;
    expect(held?.description).toContain("held for approval");
    expect(free?.description).not.toContain("held for approval");
  });

  // A team sheet knows names and approval. Publishing an input schema would be
  // this process inventing a contract with a server it has never spoken to —
  // real schemas arrive with #129.
  it("publishes an open object schema, because the sheet describes no arguments", () => {
    const [definition] = mapPermittedTools([listed("github", "list_prs")]).definitions;
    expect(definition?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true
    });
  });
});
