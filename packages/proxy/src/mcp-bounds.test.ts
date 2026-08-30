import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  MAX_RESULT_MIME_TYPE,
  MAX_TOOL_DESCRIPTION,
  PermittedTool,
  ToolResultBlock,
  resultText
} from "@getlibero/schema";
import {
  boundedToolDescription,
  boundedToolInputSchema,
  boundedToolResult,
  isInputRequired,
  parseToolsList
} from "./mcp-bounds.js";
import { RedactionError, redactionPasses, type SecretScan } from "./redact.js";

/**
 * A scan that finds nothing, which is every case here that is not about
 * redaction. The real one is built from a credential in ./outbound.ts.
 */
const NO_SECRET: SecretScan = () => null;

/** `boundedToolResult` with the scan every case but one wants. */
const bound = (
  result: Record<string, unknown>,
  maxChars: number,
  scan: SecretScan = NO_SECRET
): { content: ToolResultBlock[]; isError: boolean } | null => boundedToolResult(result, maxChars, scan);

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

  // One block in, one block out. They used to be joined into a single string,
  // because a string was all a result had; keeping them apart is what lets a
  // provider that takes several blocks be handed several.
  it("keeps text blocks apart rather than joining them", () => {
    expect(
      bound({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }, ROOMY)
    ).toEqual({
      content: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
      isError: false
    });
    // And the text a text-only provider is handed is unchanged, because
    // `resultText` joins with the newline this function's join always used.
    expect(
      textOf(bound({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }, ROOMY))
    ).toBe("one\ntwo");
  });

  it("carries the tool's own error flag", () => {
    expect(bound({ content: [{ type: "text", text: "nope" }], isError: true }, ROOMY)).toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true
    });
  });

  // #501: the payload crosses as a payload. Inlining it into text was never the
  // alternative — it is not viewable as an image from a text block, and it would
  // spend the channel's tokens to deliver something the model cannot use.
  it("relays a binary block as a block", () => {
    const data = "A".repeat(8000);
    expect(bound({ content: [{ type: "image", data, mimeType: "image/png" }] }, ROOMY)).toEqual({
      content: [{ type: "image", data, mimeType: "image/png" }],
      isError: false
    });
  });

  each([
    [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }, { type: "audio", data: "AAAA", mimeType: "audio/wav" }],
    [
      { type: "resource", resource: { uri: "file:///x", blob: "AAAA", mimeType: "application/zip" } },
      { type: "resource", uri: "file:///x", mimeType: "application/zip", blob: "AAAA" }
    ],
    [
      // No mimeType is a legal embedded resource and an optional field here.
      { type: "resource", resource: { uri: "file:///x", blob: "AAAA" } },
      { type: "resource", uri: "file:///x", blob: "AAAA" }
    ]
  ])("relays %j as a block", (block, expected) => {
    expect(bound({ content: [block] }, ROOMY)?.content).toEqual([expected]);
  });

  // The agent parses `ToolCallResponse` with zod, so a block this module emits
  // that does not satisfy `ToolResultBlock` is not a degraded result over there
  // — it is a `malformed_response` that loses the call. Every one of these
  // degrades to the sentence instead.
  each([
    [
      "a payload that is not base64",
      { type: "image", data: "not base64!!", mimeType: "image/png" },
      "[image omitted: image/png, 9 bytes]"
    ],
    [
      "an image with no mime type",
      { type: "image", data: "AAAA" },
      "[image omitted: unknown, 3 bytes]"
    ],
    [
      "a blob resource with no uri",
      { type: "resource", resource: { blob: "AAAA", mimeType: "application/zip" } },
      "[resource omitted: application/zip, 3 bytes]"
    ],
    [
      "a resource with neither text nor blob",
      { type: "resource", resource: { uri: "file:///x" } },
      "[resource omitted: unknown, unknown size]"
    ]
  ])("degrades %s to the placeholder", (_label, block, expected) => {
    expect(bound({ content: [block] }, ROOMY)?.content).toEqual([{ type: "text", text: expected }]);
  });

  // A label over the schema's bound would fail the agent's parse, so truncating
  // it is what keeps a hostile label cosmetic instead of a lost call.
  it("truncates a label to what the wire shape accepts, and still relays the block", () => {
    const mapped = bound(
      { content: [{ type: "image", data: "AAAA", mimeType: "image/png; ".repeat(500) }] },
      ROOMY
    );
    const block = mapped?.content[0];
    expect(block?.type).toBe("image");
    expect(block?.type === "image" ? block.mimeType.length : 0).toBe(MAX_RESULT_MIME_TYPE);
    // The proof that truncation is load-bearing rather than tidy: what came out
    // is what the other end will parse.
    expect(ToolResultBlock.safeParse(block).success).toBe(true);
  });

  // The three that are text on the way out and stay text. `resource_link` and an
  // unknown type are not members of `ToolResultBlock` and never become one — a
  // block type earns membership when a provider can be handed it, which is what
  // keeps a forward-revision block costing a sentence rather than the call.
  each([
    [{ type: "resource", resource: { uri: "file:///x", text: "inline text" } }, "inline text"],
    [{ type: "resource_link", uri: "https://example.test/a" }, "[resource: https://example.test/a]"],
    [{ type: "hologram" }, "[unsupported content block: hologram]"]
  ])("flattens %j to text", (block, expected) => {
    expect(bound({ content: [block] }, ROOMY)?.content).toEqual([{ type: "text", text: expected }]);
  });

  // The spec tells servers to mirror structured content into a text block, so
  // reading both would hand the model a well-behaved server's answer twice.
  it("uses structuredContent only when there is no text", () => {
    expect(textOf(bound({ content: [], structuredContent: { total: 3 } }, ROOMY))).toBe('{"total":3}');
    expect(
      textOf(bound({ content: [{ type: "text", text: "three" }], structuredContent: { total: 3 } }, ROOMY))
    ).toBe("three");
  });

  // No blocks rather than one empty one, which is what `ToolResult`'s header
  // means by the empty array being what the old `content: ""` becomes. A
  // text-only provider is still handed the empty string, because that is what
  // `resultText` renders no blocks as.
  it("maps an empty result to no blocks rather than to a failure", () => {
    expect(bound({ content: [] }, ROOMY)).toEqual({ content: [], isError: false });
    expect(textOf(bound({ content: [] }, ROOMY))).toBe("");
  });

  each([
    ["content that is not an array", { content: "text" }],
    ["a block that is not an object", { content: ["text"] }],
    ["a text block with no text", { content: [{ type: "text" }] }],
    ["a resource block with no resource", { content: [{ type: "resource" }] }],
    ["no content at all", {}]
  ])("refuses to read %s", (_label, result) => {
    expect(bound(result, ROOMY)).toBeNull();
  });
});

// #501's decision, and the one #503 asserts end to end. The wire scan in
// ./outbound.ts has already redacted everything spelled literally in the
// response — a base64 payload included, since it is text on the wire. What it
// cannot see is a credential sitting in the *decoded* bytes, which is what this
// pass is for.
describe("scanning a payload the wire scan could not read", () => {
  const CREDENTIAL = "ghp_0000000000000000000000000000000000";
  const scan = (() => {
    const passes = redactionPasses([{ name: "github", value: CREDENTIAL }]);
    return (text: string) => (passes.some(pass => pass.needles.some(n => text.includes(n))) ? "[redacted:github]" : null);
  })();

  /** A payload whose decoded bytes hold the credential and whose base64 does not. */
  const carrying = Buffer.from(`PNG..${CREDENTIAL}..IEND`, "latin1").toString("base64");

  it("fails the whole result closed rather than degrading one block", () => {
    // Closed, and *whole*: serving a scrubbed-looking subset would be the proxy
    // asserting a boundary it did not hold. There is no edit to make either —
    // replacing bytes inside a PNG yields a corrupt image, not a scrubbed one.
    expect(() =>
      bound({ content: [{ type: "text", text: "here" }, { type: "image", data: carrying, mimeType: "image/png" }] }, 100_000, scan)
    ).toThrow(RedactionError);
  });

  // The positive control: without it the case above also passes on a scan that
  // finds nothing anywhere, which would say nothing about what it caught.
  it("relays a payload that does not carry one", () => {
    const clean = Buffer.from("PNG..nothing to see..IEND", "latin1").toString("base64");
    expect(bound({ content: [{ type: "image", data: clean, mimeType: "image/png" }] }, 100_000, scan)?.content).toEqual([
      { type: "image", data: clean, mimeType: "image/png" }
    ]);
  });

  // Only a block that is actually crossing is decoded and searched. Paying for a
  // decode to prove something about bytes nobody will see is the wrong trade,
  // and the block below is degraded by the cap before the scan would run.
  it("does not scan a block the cap already replaced", () => {
    expect(
      // Room for the sentence and not for the payload, which is the ordinary
      // shape of a channel that has not raised its cap.
      bound({ content: [{ type: "image", data: carrying, mimeType: "image/png" }] }, 40, scan)?.content
    ).toEqual([{ type: "text", text: `[image omitted: image/png, ${String(Buffer.from(carrying, "base64").length)} bytes]` }]);
  });
});

// The channel's half of #151. The bytes read off the wire are the deployment's
// bound and live in ./outbound.ts; this is the bound on what a result may spend
// of the channel's context, and it truncates rather than refusing because a
// large answer is usually still a useful one.
describe("bounding a tool result", () => {
  const bounded = (text: string, limit: number): string =>
    textOf(bound({ content: [{ type: "text", text }] }, limit));

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

  // One budget over the whole result, walked in order: the first block is paid
  // for in full and the second gets what is left. The notice names that block's
  // numbers rather than the result's, which is the only honest reading once "the
  // result" is not one string.
  it("spends one budget across the blocks, in order", () => {
    const mapped = bound(
      { content: [{ type: "text", text: "a".repeat(80) }, { type: "text", text: "b".repeat(80) }] },
      100
    );
    expect(mapped?.content).toEqual([
      { type: "text", text: "a".repeat(80) },
      { type: "text", text: `${"b".repeat(20)}\n[result truncated: 20 of 80 characters]` }
    ]);
  });

  // The branch an upstream would have reached for otherwise: before the two
  // returns were folded into one, the structured fallback was unbounded.
  it("bounds the structuredContent fallback too", () => {
    const mapped = bound({ content: [], structuredContent: { pad: "y".repeat(5000) } }, 100);
    expect(textOf(mapped)).toContain("[result truncated: 100 of ");
    expect(textOf(mapped).startsWith('{"pad":"yyy')).toBe(true);
  });

  it("carries the error flag through a truncation", () => {
    const mapped = bound({ content: [{ type: "text", text: "z".repeat(500) }], isError: true }, 10);
    expect(mapped?.isError).toBe(true);
    expect(textOf(mapped)).toContain("[result truncated:");
  });

  // The asymmetry #500 decided and this function carries out: text is cut and
  // says where, a payload is replaced. Half a base64 payload is a corrupt image
  // rather than a short one, and there is no notice to append that would make it
  // decode.
  it("degrades a binary block past the budget rather than slicing it", () => {
    const data = "A".repeat(8000); // 6000 decoded bytes.
    const mapped = bound({ content: [{ type: "image", data, mimeType: "image/png" }] }, 1000);
    expect(mapped?.content).toEqual([{ type: "text", text: "[image omitted: image/png, 6 KB]" }]);
    expect(textOf(mapped)).not.toContain("AAAA");
  });

  // The default is 32768 and a screenshot is bigger, which is the shape every
  // other capability here takes: nothing binary reaches a model until an
  // operator raises a number they already tune.
  it("does not relay a binary block a channel has not paid for", () => {
    const screenshot = "A".repeat(200_000);
    const at = (limit: number) =>
      bound({ content: [{ type: "image", data: screenshot, mimeType: "image/png" }] }, limit)?.content[0]?.type;
    expect(at(32_768)).toBe("text");
    expect(at(200_000)).toBe("image");
  });

  it("charges a binary block its decoded bytes, not its base64", () => {
    // 5000 base64 characters is 3750 decoded bytes: over a 4000 cap if it were
    // charged encoded, under it decoded.
    const data = "A".repeat(5000);
    expect(bound({ content: [{ type: "image", data, mimeType: "image/png" }] }, 4000)?.content[0]?.type).toBe("image");
  });

  // How many blocks an upstream sends is the upstream's choice, so a sentence
  // per block would be a way to spend a budget the cap would not otherwise
  // permit.
  it("stops rather than emitting a placeholder for every remaining block", () => {
    const image = { type: "image", data: "A".repeat(8000), mimeType: "image/png" };
    const mapped = bound({ content: [image, image, image, image] }, 60);
    expect(mapped?.content).toEqual([
      { type: "text", text: "[image omitted: image/png, 6 KB]" },
      { type: "text", text: "[result truncated: 1 of 4 content blocks]" }
    ]);
  });

  it("says nothing about block counts on a result it relayed whole", () => {
    const mapped = bound({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }, 100_000);
    expect(textOf(mapped)).not.toContain("content blocks");
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

  // The opposite call from `boundedToolResult`, and deliberately: a partial tool
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
