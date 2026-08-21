import { describe, it } from "node:test";
import { expect } from "expect";
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

  it("carries what the upstream said about the tool", () => {
    const described = {
      ...entry,
      description: "Lists open pull requests.",
      inputSchema: { type: "object", properties: { repo: { type: "string" } } }
    };
    expect(PermittedTool.parse(described)).toEqual(described);
  });

  it("treats both describing fields as optional, because an upstream may not answer", () => {
    // Absence is a state rather than a gap: a server that is down degrades to
    // the entry the sheet wrote, and the listing is not the enforcement.
    expect(PermittedTool.parse(entry)).toEqual(entry);
    expect(PermittedTool.safeParse({ ...entry, description: "x" }).success).toBe(true);
    expect(PermittedTool.safeParse({ ...entry, inputSchema: { type: "object" } }).success).toBe(true);
  });

  it("bounds the description and refuses a schema no provider would take", () => {
    // The proxy truncates to this number before it publishes one, so a
    // description over it means the two ends have drifted rather than that an
    // upstream is chatty. Same constant, imported by both.
    expect(PermittedTool.safeParse({ ...entry, description: "x".repeat(1024) }).success).toBe(true);
    expect(PermittedTool.safeParse({ ...entry, description: "x".repeat(1025) }).success).toBe(false);
    expect(PermittedTool.safeParse({ ...entry, description: "" }).success).toBe(false);

    for (const inputSchema of [{ type: "string" }, {}, [], "x"]) {
      expect(PermittedTool.safeParse({ ...entry, inputSchema }).success).toBe(false);
    }
  });

  it("rejects any field a credential or a cursor could ride in", () => {
    // A description and a schema are the only two fields an upstream fills.
    // Everything else here is the sheet's, and paging is the proxy's: the wire
    // listing is complete by the time it is sent.
    expect(PermittedTool.safeParse({ ...entry, credential: "gh_token" }).success).toBe(false);
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
