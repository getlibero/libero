import { describe, expect, it } from "vitest";
import { PermittedTool, ToolInputSchema, ToolListing } from "./tool-listing.js";

const entry = { server: "github", tool: "list_prs", approval: "none" };

describe("the tool listing", () => {
  it("parses a manifest of permitted tools", () => {
    expect(ToolListing.parse({ tools: [entry] })).toEqual({ tools: [entry] });
  });

  // A channel with no sheet permits nothing, and that is an answer rather than
  // a failure. Making it parse is what lets the proxy return it as a 200.
  it("accepts an empty list as a real answer", () => {
    expect(ToolListing.parse({ tools: [] })).toEqual({ tools: [] });
  });

  it("requires approval to be resolved, not omitted", () => {
    // The sheet's own field is optional; this one is not. A client must never
    // be left to re-derive the default, because it would derive it separately
    // from the proxy that enforces it.
    expect(PermittedTool.safeParse({ server: "github", tool: "list_prs" }).success).toBe(false);
    expect(PermittedTool.safeParse({ ...entry, approval: "maybe" }).success).toBe(false);
  });

  it("holds names to the same shape a team sheet and a call use", () => {
    expect(PermittedTool.safeParse({ ...entry, server: "git hub" }).success).toBe(false);
    expect(PermittedTool.safeParse({ ...entry, tool: "" }).success).toBe(false);
  });

  it("rejects any field a description or a credential could ride in", () => {
    // There is no description or input schema here on purpose: a team sheet
    // does not carry either, so a field for one would only ever be filled by
    // something that is not the sheet. See the note in tool-listing.ts.
    for (const extra of [{ description: "..." }, { inputSchema: {} }, { credential: "gh_token" }]) {
      expect(PermittedTool.safeParse({ ...entry, ...extra }).success).toBe(false);
    }
    expect(ToolListing.safeParse({ tools: [], nextCursor: "x" }).success).toBe(false);
  });
});

describe("the shape an input schema must have", () => {
  it("passes everything past `type` through untouched", () => {
    // The rule is about shape, never about content. A schema that says
    // `type: "object"` is accepted whole — the proxy publishes what the
    // upstream wrote, and the agent hands it to the provider unmodified.
    const schema = {
      type: "object",
      properties: { number: { type: "integer" } },
      required: ["number"],
      $schema: "https://json-schema.org/draft/2020-12/schema"
    };
    expect(ToolInputSchema.parse(schema)).toEqual(schema);
  });

  it("rejects everything a provider would answer 400 to", () => {
    // The one class worth ruling out: a value that fails the whole turn rather
    // than one tool. `{}` is in the list because a schema with no `type` is
    // exactly as unusable as one that names the wrong one.
    for (const value of [{ type: "string" }, {}, [], "x", null, 7]) {
      expect(ToolInputSchema.safeParse(value).success).toBe(false);
    }
  });
});
