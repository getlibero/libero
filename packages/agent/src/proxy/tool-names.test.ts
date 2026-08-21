import type { PermittedTool } from "@getlibero/schema";
import { describe, it } from "node:test";
import { expect } from "expect";
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
    const tools = [
      { ...listed("github", "search"), description: "Searches code.", inputSchema: { type: "object" as const } },
      listed("zendesk", "search")
    ];
    expect(mapPermittedTools(tools).definitions).toEqual(mapPermittedTools(tools).definitions);
  });

  it("returns nothing for a channel that permits nothing", () => {
    const { definitions, byModelName } = mapPermittedTools([]);
    expect(definitions).toEqual([]);
    expect(byModelName.size).toBe(0);
  });
});

describe("what the model is told a tool is", () => {
  it("says the arguments are not described when nothing described them", () => {
    const [definition] = mapPermittedTools([listed("github", "list_prs")]).definitions;
    expect(definition?.description).toContain("`github.list_prs`");
    expect(definition?.description).toContain("not described");
  });

  it("relays an upstream description verbatim, and still says where the call goes", () => {
    const [definition] = mapPermittedTools([
      { ...listed("github", "list_prs"), description: "Lists open pull requests." }
    ]).definitions;

    expect(definition?.description).toContain("Lists open pull requests.");
    expect(definition?.description).toContain("`github.list_prs`");
    // The server is what knows; this process no longer claims the arguments
    // are unknown when they are not.
    expect(definition?.description).not.toContain("not described");
  });

  it("says when a call is held for a human", () => {
    const [held] = mapPermittedTools([listed("github", "merge_pr", "required")]).definitions;
    const [free] = mapPermittedTools([listed("github", "list_prs")]).definitions;
    expect(held?.description).toContain("held for approval");
    expect(free?.description).not.toContain("held for approval");
  });

  // The one thing about a tool an upstream cannot tell a model: a server has no
  // idea which of its tools this channel holds for a human. So it comes from
  // the manifest and is never displaced by what the upstream wrote.
  it("keeps the approval sentence alongside an upstream description", () => {
    const [definition] = mapPermittedTools([
      { ...listed("github", "merge_pr", "required"), description: "Merges a pull request." }
    ]).definitions;

    expect(definition?.description).toContain("Merges a pull request.");
    expect(definition?.description).toContain("held for approval");
  });

  // The fallback, for a tool the proxy could not ask about. It says what is
  // true when the arguments are unknown: they go to the tool unmodified, and
  // the tool validates them.
  it("publishes an open object schema when the listing carried none", () => {
    const [definition] = mapPermittedTools([listed("github", "list_prs")]).definitions;
    expect(definition?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true
    });
  });

  it("passes a real schema through unmodified", () => {
    const inputSchema = {
      type: "object" as const,
      properties: { repo: { type: "string" } },
      required: ["repo"]
    };
    const [definition] = mapPermittedTools([{ ...listed("github", "list_prs"), inputSchema }]).definitions;

    expect(definition?.inputSchema).toEqual(inputSchema);
  });

  // Names are chosen from `server` and `tool` alone, so an upstream that
  // reorders its catalog, adds a tool, or goes down cannot move one. That is
  // what keeps the determinism contract true now that a listing carries more
  // than the sheet.
  it("does not let a description or a schema move a model-facing name", () => {
    const bare = [listed("github", "search"), listed("zendesk", "search")];
    const rich = [
      { ...listed("github", "search"), description: "Searches code.", inputSchema: { type: "object" as const } },
      { ...listed("zendesk", "search"), description: "Searches tickets." }
    ];

    expect(mapPermittedTools(rich).definitions.map(definition => definition.name)).toEqual(
      mapPermittedTools(bare).definitions.map(definition => definition.name)
    );
  });
});
