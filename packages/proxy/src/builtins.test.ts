import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  BuiltinToolName,
  MAX_TOOL_DESCRIPTION,
  PermittedTool,
  ToolInputSchema
} from "@getlibero/schema";
import { READ_MAX_LIMIT } from "@getlibero/memory";
import { BUILTIN_TOOLS, DEFAULT_SEARCH_LIMIT, SearchChannelHistoryArguments } from "./builtins.js";

describe("the built-in definitions", () => {
  // The Record is keyed by the schema's enum, so this cannot drift — but a
  // missing member is a type error at build time and nothing at review time,
  // and a reviewer adding a name wants to be told which half they forgot.
  it("defines every name the schema declares", () => {
    expect(Object.keys(BUILTIN_TOOLS).sort()).toEqual([...BuiltinToolName.options].sort());
  });

  // The bound that matters: `PermittedTool.description` parses against this, so
  // an over-long one makes the whole listing fail on the agent's side, which
  // ends a task with "the tool proxy could not be reached" rather than costing
  // it a sentence. ./builtins.ts throws at module load for the same reason;
  // this is the version that names the tool in a test report.
  each(Object.entries(BUILTIN_TOOLS))("publishes %s within the schema's bounds", (tool, definition) => {
    expect(definition.description.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION);
    expect(ToolInputSchema.safeParse(definition.inputSchema).success).toBe(true);
    expect(
      PermittedTool.safeParse({
        server: "libero",
        tool,
        approval: "none",
        description: definition.description,
        inputSchema: definition.inputSchema
      }).success
    ).toBe(true);
  });
});

// Two spellings of one contract — a JSON Schema the model reads and a zod parser
// the executor enforces — so they are round-tripped against each other rather
// than trusted to stay in step.
describe("search_channel_history's arguments", () => {
  const schema = BUILTIN_TOOLS.search_channel_history.inputSchema as unknown as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };

  it("declares exactly the keys the parser accepts", () => {
    expect(Object.keys(schema.properties)).toEqual(["query", "limit"]);
    expect(schema.required).toEqual(["query"]);
    // Mirrors `.strict()`, so a well-behaved model is told the rule rather than
    // only punished for breaking it.
    expect(schema.additionalProperties).toBe(false);
  });

  // The acceptance criterion, at the layer that makes it structural. There is
  // no channel key to send, and an unknown key is a rejection rather than a
  // silently dropped one.
  it("has no channel argument and refuses one", () => {
    expect(Object.keys(schema.properties)).not.toContain("channel");
    expect(SearchChannelHistoryArguments.safeParse({ query: "vault", channel: "C0OTHER" }).success).toBe(
      false
    );
  });

  it("defaults the limit to the number the description advertises", () => {
    const parsed = SearchChannelHistoryArguments.parse({ query: "vault" });
    expect(parsed.limit).toBe(DEFAULT_SEARCH_LIMIT);
    expect(BUILTIN_TOOLS.search_channel_history.description).not.toContain("undefined");
    expect(JSON.stringify(schema.properties["limit"])).toContain(String(DEFAULT_SEARCH_LIMIT));
  });

  // The store clamps silently, which is right for a model's argument and wrong
  // as the *advertised* ceiling — so the parser refuses past it and the schema
  // says the same number.
  it("bounds the limit at the store's own ceiling, in both spellings", () => {
    expect(SearchChannelHistoryArguments.safeParse({ query: "v", limit: READ_MAX_LIMIT }).success).toBe(true);
    expect(SearchChannelHistoryArguments.safeParse({ query: "v", limit: READ_MAX_LIMIT + 1 }).success).toBe(
      false
    );
    expect(JSON.stringify(schema.properties["limit"])).toContain(String(READ_MAX_LIMIT));
  });

  each([
    ["an empty query", { query: "" }],
    ["a missing query", {}],
    ["a fractional limit", { query: "v", limit: 1.5 }],
    ["a zero limit", { query: "v", limit: 0 }]
  ])("refuses %s", (_label, args) => {
    expect(SearchChannelHistoryArguments.safeParse(args).success).toBe(false);
  });
});
