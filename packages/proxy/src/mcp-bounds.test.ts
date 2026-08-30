import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { MAX_TOOL_DESCRIPTION, PermittedTool, type ToolResultBlock, resultText } from "@getlibero/schema";
import {
  boundedToolDescription,
  boundedToolInputSchema,
  isInputRequired,
  parseToolsList,
  toolResultText
} from "./mcp-bounds.js";

describe("the multi-round-trip result", () => {
  it("recognises an input_required result", () => {
    expect(isInputRequired({ resultType: "input_required" })).toBe(true);
  });

  // Servers on an earlier revision omit the field, and the spec says to read
  // that as complete.
  it("treats a missing resultType as complete", () => {
    expect(isInputRequired({ content: [] })).toBe(false);
    expect(isInputRequired({ resultType: "complete" })).toBe(false);
  });
});

/**
 * The text a mapped result carries, however many blocks it takes to hold it.
 *
 * Every result this module can currently produce is one text block, so this is
 * `content[0].text` today and these cases are the ones they always were. It is
 * written as a render rather than an index so that #501, which is what makes a
 * result hold more than one block, does not have to rewrite the assertions —
 * only add the ones about the blocks it starts promoting.
 */
const textOf = (mapped: { content: ToolResultBlock[] } | null): string =>
  mapped === null ? "" : resultText(mapped.content);

describe("mapping a tool result to text", () => {
  /** Far above anything these cases produce, so the cap is out of the way. */
  const ROOMY = 100_000;

  it("joins text blocks", () => {
    expect(
      toolResultText({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }, ROOMY)
    ).toEqual({ content: [{ type: "text", text: "one\ntwo" }], isError: false });
  });

  it("carries the tool's own error flag", () => {
    expect(toolResultText({ content: [{ type: "text", text: "nope" }], isError: true }, ROOMY)).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true
    });
  });

  // A base64 blob is not viewable as an image from a text block, and inlining
  // it would spend the channel's tokens and the audit row's byte count to
  // deliver something the model cannot use.
  it("names a binary block rather than inlining it", () => {
    const data = "A".repeat(8000);
    const mapped = toolResultText({ content: [{ type: "image", data, mimeType: "image/png" }] }, ROOMY);
    expect(textOf(mapped)).toBe("[image omitted: image/png, 6 KB]");
    expect(textOf(mapped)).not.toContain("AAAA");
  });

  each([
    [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }, "[audio omitted: audio/wav, 3 bytes]"],
    [{ type: "resource", resource: { uri: "file:///x", text: "inline text" } }, "inline text"],
    [
      { type: "resource", resource: { uri: "file:///x", blob: "AAAA", mimeType: "application/zip" } },
      "[resource omitted: application/zip, 3 bytes]"
    ],
    [{ type: "resource_link", uri: "https://example.test/a" }, "[resource: https://example.test/a]"],
    [{ type: "hologram" }, "[unsupported content block: hologram]"]
  ])("renders %j", (block, expected) => {
    expect(textOf(toolResultText({ content: [block] }, ROOMY))).toBe(expected);
  });

  // Every label is upstream-authored text entering the model's context.
  it("truncates a hostile label rather than relaying a paragraph", () => {
    const mapped = toolResultText(
      { content: [{ type: "image", data: "AAAA", mimeType: "image/png; ".repeat(500) }] },
      ROOMY
    );
    expect(textOf(mapped).length).toBeLessThan(150);
  });

  // The spec tells servers to mirror structured content into a text block, so
  // reading both would hand the model a well-behaved server's answer twice.
  it("uses structuredContent only when there is no text", () => {
    expect(textOf(toolResultText({ content: [], structuredContent: { total: 3 } }, ROOMY))).toBe('{"total":3}');
    expect(
      textOf(toolResultText({ content: [{ type: "text", text: "three" }], structuredContent: { total: 3 } }, ROOMY))
    ).toBe("three");
  });

  it("maps an empty result to empty text rather than to a failure", () => {
    expect(toolResultText({ content: [] }, ROOMY)).toEqual({
      content: [{ type: "text", text: "" }],
      isError: false
    });
  });

  each([
    ["content that is not an array", { content: "text" }],
    ["a block that is not an object", { content: ["text"] }],
    ["a text block with no text", { content: [{ type: "text" }] }],
    ["a resource block with no resource", { content: [{ type: "resource" }] }],
    ["no content at all", {}]
  ])("refuses to read %s", (_label, result) => {
    expect(toolResultText(result, ROOMY)).toBeNull();
  });
});

// The channel's half of #151. The bytes read off the wire are the deployment's
// bound and live in ./outbound.ts; this is the bound on what a result may spend
// of the channel's context, and it truncates rather than refusing because a
// large answer is usually still a useful one.
describe("bounding a tool result", () => {
  const bounded = (text: string, limit: number): string =>
    textOf(toolResultText({ content: [{ type: "text", text }] }, limit));

  it("leaves a result under the limit untouched", () => {
    expect(bounded("x".repeat(99), 100)).toBe("x".repeat(99));
  });

  it("leaves a result of exactly the limit untouched", () => {
    expect(bounded("x".repeat(100), 100)).toBe("x".repeat(100));
  });

  // The notice names both numbers: the bound, so the model can tell this from a
  // short answer, and the original size, so it can tell how much it is missing.
  // The original is also the only place that number survives — the audit row
  // records what was handed over, which is the truncated length.
  it("truncates past the limit and says so", () => {
    expect(bounded("x".repeat(5000), 100)).toBe(`${"x".repeat(100)}\n[result truncated: 100 of 5000 characters]`);
  });

  it("bounds the join, not each block", () => {
    const mapped = toolResultText(
      { content: [{ type: "text", text: "a".repeat(80) }, { type: "text", text: "b".repeat(80) }] },
      100
    );
    // 80 + newline + 80 = 161 characters of content, cut at 100.
    expect(textOf(mapped)).toContain("[result truncated: 100 of 161 characters]");
  });

  // The branch an upstream would have reached for otherwise: before the two
  // returns were folded into one, the structured fallback was unbounded.
  it("bounds the structuredContent fallback too", () => {
    const mapped = toolResultText({ content: [], structuredContent: { pad: "y".repeat(5000) } }, 100);
    expect(textOf(mapped)).toContain("[result truncated: 100 of ");
    expect(textOf(mapped).startsWith('{"pad":"yyy')).toBe(true);
  });

  it("carries the error flag through a truncation", () => {
    const mapped = toolResultText({ content: [{ type: "text", text: "z".repeat(500) }], isError: true }, 10);
    expect(mapped?.isError).toBe(true);
    expect(textOf(mapped)).toContain("[result truncated:");
  });

  // A cut landing between a surrogate pair would leave a lone high surrogate,
  // which is not a character and is what a provider answers 400 about.
  it("never leaves a lone surrogate at the cut", () => {
    // Each emoji is two code units, so an odd limit always splits one.
    const content = bounded("🚀".repeat(50), 11);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(content)).toBe(false);
    // The dropped unit is reported, so the notice never overstates what was kept.
    expect(content).toContain("[result truncated: 10 of 100 characters]");
  });
});

describe("reading a page of a catalog", () => {
  it("reads the tools and the cursor", () => {
    expect(
      parseToolsList({
        tools: [{ name: "list_prs", description: "Lists PRs.", inputSchema: { type: "object" } }],
        nextCursor: "page-2"
      })
    ).toEqual({
      tools: [{ name: "list_prs", description: "Lists PRs.", inputSchema: { type: "object" } }],
      nextCursor: "page-2"
    });
  });

  it("reports the last page as the last page", () => {
    // No cursor, and an empty one, are the same answer: there is nowhere to go
    // next. An empty string read as a position is a loop.
    expect(parseToolsList({ tools: [] })?.nextCursor).toBeNull();
    expect(parseToolsList({ tools: [], nextCursor: "" })?.nextCursor).toBeNull();
    expect(parseToolsList({ tools: [], nextCursor: 7 })?.nextCursor).toBeNull();
  });

  // The opposite call from `toolResultText`, and deliberately: a partial tool
  // answer misleads, a partial catalog does not. Refusing the page over one bad
  // entry would cost every other tool on it its schema, and each of those falls
  // back to an entry the team sheet already produced.
  it("skips an entry it cannot read and keeps the rest of the page", () => {
    const page = parseToolsList({
      tools: [{ name: "list_prs" }, { description: "no name" }, "not an object", { name: "" }, { name: "merge_pr" }]
    });
    expect(page?.tools.map((tool) => tool.name)).toEqual(["list_prs", "merge_pr"]);
  });

  it("refuses a page that is not a page", () => {
    expect(parseToolsList({ tools: "list_prs" })).toBeNull();
    expect(parseToolsList({})).toBeNull();
  });

  it("vouches for the name and nothing else", () => {
    // `description` and `inputSchema` come back exactly as they arrived, so a
    // caller cannot mistake them for values this module checked.
    const page = parseToolsList({ tools: [{ name: "list_prs", description: 7, inputSchema: "nope" }] });
    expect(page?.tools[0]).toEqual({ name: "list_prs", description: 7, inputSchema: "nope" });
  });
});

describe("bounding what an upstream says about a tool", () => {
  it("keeps a description and truncates an overlong one to the shared bound", () => {
    expect(boundedToolDescription("  Lists open pull requests.  ")).toBe("Lists open pull requests.");
    const long = boundedToolDescription("x".repeat(2000));
    // MAX_TOOL_DESCRIPTION exactly, marker included. An earlier version of this
    // test asserted 1025 and so encoded the bug it was meant to catch: the same
    // constant is `PermittedTool.description`'s `.max()`, so one character over
    // is a listing the agent's own parse rejects as `malformed_response`, which
    // ends the task rather than shortening a sentence.
    expect(long).toHaveLength(MAX_TOOL_DESCRIPTION);
    expect(long?.endsWith("…")).toBe(true);
    expect(PermittedTool.safeParse({
      server: "github",
      tool: "pull_request_read",
      approval: "none",
      description: long
    }).success).toBe(true);
  });

  // The property the case above pins by example, at the boundary and just past
  // it. Nothing an upstream can write may produce a description the agent's
  // schema will not take.
  it("never publishes a description the listing schema would reject", () => {
    for (const length of [MAX_TOOL_DESCRIPTION - 1, MAX_TOOL_DESCRIPTION, MAX_TOOL_DESCRIPTION + 1, 50_000]) {
      const bounded = boundedToolDescription("x".repeat(length));
      expect(bounded?.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION);
    }
  });

  it("reports an absent description as absent, however it was absent", () => {
    for (const value of [undefined, "", "   ", 7, null, {}]) {
      expect(boundedToolDescription(value)).toBeUndefined();
    }
  });

  it("passes an accepted schema through as the bytes the upstream wrote", () => {
    const schema = { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] };
    const bounded = boundedToolInputSchema(schema);
    expect(bounded.ok).toBe(true);
    // Identity, not equality. The gate does not rewrite, so what reaches a
    // provider is what arrived.
    expect(bounded.ok && bounded.schema).toBe(schema);
  });

  each([
    ["a schema that is not an object", "nope", "not_an_object"],
    ["an array", [], "not_an_object"],
    ["nothing at all", undefined, "not_an_object"],
    ["a schema naming the wrong type", { type: "string" }, "not_type_object"],
    ["a schema naming no type", { properties: {} }, "not_type_object"]
  ])("rejects %s", (_label, value, reason) => {
    expect(boundedToolInputSchema(value)).toEqual({ ok: false, reason });
  });

  it("rejects a schema too large to publish", () => {
    const under = { type: "object", description: "x".repeat(8000) };
    expect(boundedToolInputSchema(under).ok).toBe(true);
    const over = { type: "object", description: "x".repeat(9000) };
    expect(boundedToolInputSchema(over)).toEqual({ ok: false, reason: "too_large" });
  });

  it("treats a schema it cannot even measure as one too large to publish", () => {
    // A cycle and a BigInt both throw out of `JSON.stringify`. The caller does
    // nothing different for either, so a fourth reason would be a distinction
    // with no consequence.
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["self"] = cyclic;
    expect(boundedToolInputSchema(cyclic)).toEqual({ ok: false, reason: "too_large" });
    expect(boundedToolInputSchema({ type: "object", n: 1n })).toEqual({ ok: false, reason: "too_large" });
  });
});
