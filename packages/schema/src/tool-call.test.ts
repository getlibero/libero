import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  MAX_RESULT_MIME_TYPE,
  ToolCall,
  ToolCallResponse,
  ToolResult,
  ToolResultBlock,
  omittedText,
  resolveToolCall,
  resultBytes,
  resultBytesByType,
  resultCost,
  resultText,
  textBlock
} from "./tool-call.js";

const wire = {
  id: "toolu_01",
  server: "github",
  tool: "list_prs",
  arguments: { state: "open" },
  requestingUser: "U024BE7LH",
  task: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55"
};

/** A well-formed call minus some fields, for the cases about one being absent. */
function without(...keys: (keyof typeof wire)[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(wire).filter(([key]) => !keys.includes(key as never)));
}

describe("the wire tool call", () => {
  it("parses what the agent sends", () => {
    expect(ToolCall.parse(wire)).toEqual(wire);
  });

  it("defaults absent arguments to an empty object", () => {
    expect(ToolCall.parse(without("arguments")).arguments).toEqual({});
  });

  it("passes arguments through without inspecting them", () => {
    const args = { nested: { deep: [1, "two", null] }, count: 3 };
    expect(ToolCall.parse({ ...wire, arguments: args }).arguments).toEqual(args);
  });

  // The one that matters. The channel comes from the client certificate and
  // from nowhere else, so a body asserting one must fail loudly rather than
  // have the field quietly dropped — a dropped field is a trap for whoever
  // wires up the next endpoint, and it hides the attempt from the operator.
  it("rejects a body that asserts a channel", () => {
    const result = ToolCall.safeParse({ ...wire, channel: "C123" });
    expect(result.success).toBe(false);
  });

  it("rejects any unknown field", () => {
    expect(ToolCall.safeParse({ ...wire, credential: "github_service_account" }).success).toBe(false);
    expect(ToolCall.safeParse({ ...wire, authorization: "Bearer sk-live-abc" }).success).toBe(false);
  });

  // A first submission carries no ticket, which is every call there was before
  // the approval broker. Absent rather than null: `exactOptionalPropertyTypes`
  // makes present-and-undefined a different thing, and the proxy branches on it.
  it("accepts a call with no ticket, and leaves the field absent", () => {
    const parsed = ToolCall.parse(wire);
    expect(parsed.ticket).toBeUndefined();
    expect("ticket" in parsed).toBe(false);
  });

  it("carries a ticket on a re-submission", () => {
    expect(ToolCall.parse({ ...wire, ticket: "tk-7f3a" }).ticket).toBe("tk-7f3a");
  });

  // Bounded like every other name here. The value is model-reachable, and it
  // lands in a log line and an audit row.
  it("rejects a ticket that is not a short identifier", () => {
    for (const bad of ["", "a".repeat(65), "../../etc", "has space", null]) {
      expect(ToolCall.safeParse({ ...wire, ticket: bad }).success).toBe(false);
    }
  });

  it("rejects a missing id, server, or tool", () => {
    expect(ToolCall.safeParse(without("id")).success).toBe(false);
    expect(ToolCall.safeParse(without("server")).success).toBe(false);
    expect(ToolCall.safeParse(without("tool")).success).toBe(false);
  });

  // Required, not optional. An audit record that cannot say who asked or which
  // task it belonged to is most of the reason the record exists, and an
  // optional field is one a client forgets on the path that matters.
  it("requires both attribution fields", () => {
    expect(ToolCall.safeParse(without("requestingUser", "task")).success).toBe(false);
    expect(ToolCall.safeParse(without("requestingUser")).success).toBe(false);
    expect(ToolCall.safeParse(without("task")).success).toBe(false);
  });

  // Both land in the audit log and in its CSV export (#98), so what a client
  // can put in them is bounded here rather than at the point a human reads one.
  it("rejects an attribution value that is not a short identifier", () => {
    for (const bad of ["", "has space", "a/b", "x".repeat(65), "-leading", "U1\nU2"]) {
      expect(ToolCall.safeParse({ ...wire, requestingUser: bad }).success).toBe(false);
      expect(ToolCall.safeParse({ ...wire, task: bad }).success).toBe(false);
    }
  });

  it("accepts a Slack user id and a generated task id", () => {
    const parsed = ToolCall.parse(wire);
    expect(parsed.requestingUser).toBe("U024BE7LH");
    expect(parsed.task).toBe("b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55");
    expect(ToolCall.safeParse({ ...wire, requestingUser: "W07WXYZ12" }).success).toBe(true);
    expect(ToolCall.safeParse({ ...wire, requestingUser: "B01BOTID" }).success).toBe(true);
  });

  // Server and tool names are model-authored and come back out in a refusal
  // that reaches a Slack channel and the audit log. Bounded here, not there.
  it("rejects a server or tool name that is not a short identifier", () => {
    for (const name of ["", "has space", "a/b", "x".repeat(65), "-leading-dash"]) {
      expect(ToolCall.safeParse({ ...wire, server: name }).success).toBe(false);
      expect(ToolCall.safeParse({ ...wire, tool: name }).success).toBe(false);
    }
  });

  it("accepts the names a team sheet writes", () => {
    for (const name of ["github", "list_prs", "trigger_workflow", "acme.internal", "v2-api"]) {
      expect(ToolCall.safeParse({ ...wire, server: name }).success).toBe(true);
    }
  });

  // Two layers, and this is where the boundary between them is drawn. A name
  // that reaches the enforcement gate is refused there by an exact scan of the
  // team sheet's array, which is what packages/proxy/src/enforce.test.ts
  // covers for `constructor` and its siblings. These never get that far — the
  // leading underscore is not in the identifier's first character class — so
  // the layer that refuses them is this one, and a reader looking for
  // `__proto__` beside `constructor` should find the answer here.
  each(["__proto__", "_constructor", "__defineGetter__"])(
    "cannot express the prototype name %s, which does not start with a letter",
    name => {
      expect(ToolCall.safeParse({ ...wire, server: name }).success).toBe(false);
      expect(ToolCall.safeParse({ ...wire, tool: name }).success).toBe(false);
    }
  );
});

describe("resolving a call to a channel", () => {
  it("binds the channel the proxy authenticated as", () => {
    const resolved = resolveToolCall(ToolCall.parse(wire), "C0ENGINEERING");
    expect(resolved).toEqual({ ...wire, channel: "C0ENGINEERING" });
  });

  it("does not mutate the call it was given", () => {
    const call = ToolCall.parse(wire);
    resolveToolCall(call, "C0ENGINEERING");
    expect(call).not.toHaveProperty("channel");
  });

  // The id becomes a directory name and a SQLite filename downstream, and the
  // one-file-per-channel layout is the isolation boundary. The proxy's identity
  // resolver checks this first; this is the second of two, positioned to catch
  // a caller that got an id from somewhere other than a certificate.
  it("refuses an id that is not a safe path segment", () => {
    const call = ToolCall.parse(wire);
    for (const channel of ["", "..", "../../etc", "a/b", ".hidden", "C 123", "x".repeat(65)]) {
      expect(() => resolveToolCall(call, channel)).toThrow();
    }
  });

  it("does not put the offending id in the thrown message", () => {
    // In this process a thrown value is a thing that gets logged, and the id
    // reaching here from an unexpected place is exactly when it is untrusted.
    expect(() => resolveToolCall(ToolCall.parse(wire), "../../etc")).toThrow(
      /^resolveToolCall: channel is not a valid channel id$/
    );
  });

  it("accepts the ids the dev-certs script mints", () => {
    const call = ToolCall.parse(wire);
    for (const channel of ["C0ENGINEERING", "engineering", "eng-ops", "team.core", "C123_456"]) {
      expect(resolveToolCall(call, channel).channel).toBe(channel);
    }
  });
});

describe("the proxy's answer to a call", () => {
  const refusal = { reason: "tool_not_allowed", server: "github", tool: "force_push" } as const;
  const ticket = { id: "tk-7f3a", expiresAt: Date.UTC(2026, 7, 4, 12, 15, 0) } as const;

  it("parses each of the three outcomes", () => {
    expect(
      ToolCallResponse.parse({
        outcome: "ran",
        id: "toolu_01",
        result: { content: [{ type: "text", text: "ok" }] }
      })
    ).toEqual({
      outcome: "ran",
      id: "toolu_01",
      result: { content: [{ type: "text", text: "ok" }], isError: false }
    });

    expect(ToolCallResponse.parse({ outcome: "held", id: "toolu_01", refusal, ticket })).toEqual({
      outcome: "held",
      id: "toolu_01",
      refusal,
      ticket
    });

    expect(ToolCallResponse.parse({ outcome: "refused", id: "toolu_01", refusal })).toEqual({
      outcome: "refused",
      id: "toolu_01",
      refusal
    });
  });

  // Held and refused both mean the call did not run, and they are still two
  // answers: a hold is a question put to a human, and the approval broker has
  // to tell them apart without re-deriving it from the refusal reason.
  it("keeps held and refused distinct", () => {
    const held = ToolCallResponse.parse({ outcome: "held", id: "toolu_01", refusal, ticket });
    const refused = ToolCallResponse.parse({ outcome: "refused", id: "toolu_01", refusal });
    expect(held.outcome).not.toBe(refused.outcome);
  });

  // A hold nobody can act on is not a hold. Every deployment mints a ticket, so
  // the field is required rather than optional and a proxy that forgot one
  // fails here instead of handing the client a case that must not exist.
  it("refuses a hold with no ticket on it", () => {
    expect(ToolCallResponse.safeParse({ outcome: "held", id: "toolu_01", refusal }).success).toBe(false);
  });

  // The deadline is the proxy's, and a refusal is not a place to put one.
  it("keeps the ticket off the refused variant", () => {
    expect(
      ToolCallResponse.safeParse({ outcome: "refused", id: "toolu_01", refusal, ticket }).success
    ).toBe(false);
  });

  it("rejects a variant carrying the other's payload", () => {
    expect(
      ToolCallResponse.safeParse({ outcome: "ran", id: "toolu_01", refusal }).success
    ).toBe(false);
    expect(
      ToolCallResponse.safeParse({ outcome: "refused", id: "toolu_01", result: { content: [] } })
        .success
    ).toBe(false);
  });

  it("rejects any field a credential could ride in", () => {
    for (const extra of [{ detail: "Bearer sk-live-abc" }, { cause: "ghp_x" }, { headers: {} }]) {
      expect(
        ToolCallResponse.safeParse({ outcome: "refused", id: "toolu_01", refusal, ...extra }).success
      ).toBe(false);
    }
  });

  it("requires the id, so an answer can be matched to its call", () => {
    expect(ToolCallResponse.safeParse({ outcome: "refused", refusal }).success).toBe(false);
  });
});

// #160's shape, and the first block of cases this schema has had of its own —
// `ToolResult` was asserted only through the response until it stopped being a
// string.
describe("what a tool produced", () => {
  const pixel = "iVBORw0KGgo=";

  it("round-trips every block type unchanged", () => {
    const content = [
      { type: "text", text: "here is the chart" },
      { type: "image", data: pixel, mimeType: "image/png" },
      { type: "audio", data: pixel, mimeType: "audio/wav" },
      { type: "resource", uri: "file:///report.zip", mimeType: "application/zip", blob: pixel }
    ];
    expect(ToolResult.parse({ content })).toEqual({ content, isError: false });
  });

  // The degenerate case, and the one every producer emits until #501: a result
  // is an array whether or not it holds more than one thing.
  it("takes a single text block, and an empty array", () => {
    expect(ToolResult.parse({ content: [{ type: "text", text: "ok" }] }).content).toHaveLength(1);
    expect(ToolResult.parse({ content: [] })).toEqual({ content: [], isError: false });
  });

  it("defaults isError to false", () => {
    expect(ToolResult.parse({ content: [] }).isError).toBe(false);
  });

  // A bare string was the shape until #500 and is not a shape it still accepts.
  // The union that would have taken both was declined: normalizing on read is
  // the trap this file's header names, and both services ship on one tag.
  it("does not accept the string it used to be", () => {
    expect(ToolResult.safeParse({ content: "ok" }).success).toBe(false);
  });

  // Nothing downstream can decode a payload that is not base64. Refusing it
  // here is refusing it where the tool that produced it is still known.
  it("rejects a payload that is not base64", () => {
    expect(ToolResultBlock.safeParse({ type: "image", data: "not!base64", mimeType: "image/png" }).success).toBe(
      false
    );
    expect(ToolResultBlock.safeParse({ type: "resource", uri: "file:///x", blob: "!!" }).success).toBe(false);
  });

  each([
    ["an image with no mimeType", { type: "image", data: "iVBORw0KGgo=" }],
    ["an audio block with no data", { type: "audio", mimeType: "audio/wav" }],
    ["a resource with no uri", { type: "resource", blob: "iVBORw0KGgo=" }],
    ["a block of no known type", { type: "hologram", data: "iVBORw0KGgo=" }],
    ["a text block carrying a payload", { type: "text", text: "x", data: "iVBORw0KGgo=" }]
  ])("rejects %s", (_label, block) => {
    expect(ToolResultBlock.safeParse(block).success).toBe(false);
  });

  // Every label is text a model reads, so it is bounded on the wire rather than
  // on the way out of whichever module happened to render it.
  it("bounds a mimeType", () => {
    const long = "image/".concat("x".repeat(MAX_RESULT_MIME_TYPE));
    expect(ToolResultBlock.safeParse({ type: "image", data: pixel, mimeType: long }).success).toBe(false);
  });
});

describe("what a result costs and what it weighed", () => {
  const pixel = "iVBORw0KGgo=";
  /** Eight base64 characters of payload, which is six bytes decoded. */
  const six = { type: "image", data: "AAAAAAAA", mimeType: "image/png" } as const;

  it("costs a text block its characters and a binary block its decoded bytes", () => {
    expect(resultCost([{ type: "text", text: "abcd" }])).toBe(4);
    expect(resultCost([six])).toBe(6);
    expect(resultCost([{ type: "text", text: "abcd" }, six])).toBe(10);
  });

  it("costs the decoded payload, not the four-thirds base64 spells it in", () => {
    expect(resultCost([six])).toBeLessThan(six.data.length);
  });

  // The one case that makes the two numbers different, and the reason they are
  // two functions: the cap counts what the string costs a context window, and
  // the audit row counts what crossed.
  it("weighs multi-byte text in bytes where the cap counted characters", () => {
    const content = [{ type: "text", text: "café" }] as const;
    expect(resultCost([...content])).toBe(4);
    expect(resultBytes([...content])).toBe(5);
  });

  it("agrees with the cap on a binary block", () => {
    expect(resultBytes([six])).toBe(resultCost([six]));
  });

  it("weighs an empty result as nothing", () => {
    expect(resultCost([])).toBe(0);
    expect(resultBytes([])).toBe(0);
  });

  // These sentences are what a model is handed in place of a payload, so their
  // wording is a compatibility surface. They are the ones the proxy has always
  // written.
  it("names what it cannot hand over, in the words the proxy used", () => {
    expect(resultText([{ type: "image", data: "AAAA", mimeType: "image/png" }])).toBe(
      "[image omitted: image/png, 3 bytes]"
    );
    expect(resultText([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }])).toBe(
      "[audio omitted: audio/wav, 3 bytes]"
    );
    expect(resultText([{ type: "resource", uri: "file:///x", mimeType: "application/zip", blob: "AAAA" }])).toBe(
      "[resource omitted: application/zip, 3 bytes]"
    );
  });

  it("says unknown for a resource that named no type", () => {
    expect(resultText([{ type: "resource", uri: "file:///x", blob: "AAAA" }])).toBe(
      "[resource omitted: unknown, 3 bytes]"
    );
  });

  it("joins blocks with a newline, as the proxy always has", () => {
    expect(resultText([{ type: "text", text: "one" }, { type: "text", text: "two" }])).toBe("one\ntwo");
    expect(resultText([])).toBe("");
  });

  it("scales a large payload the way the placeholder always did", () => {
    expect(resultText([{ type: "image", data: "A".repeat(8000), mimeType: "image/png" }])).toBe(
      "[image omitted: image/png, 6 KB]"
    );
  });

  it("does not inline the payload it is naming", () => {
    expect(resultText([{ type: "image", data: pixel, mimeType: "image/png" }])).not.toContain(pixel);
  });

  // `textBlock` is `resultText`'s inverse for the one case both can express,
  // which is what makes the pair worth having in one file: a producer builds
  // with the first and a text-only provider reads with the second.
  it("round-trips a string through the block that holds one", () => {
    expect(resultText([textBlock("one")])).toBe("one");
    expect(textBlock("one")).toEqual({ type: "text", text: "one" });
  });

  // The degraded path the proxy needs and `resultText` cannot serve: there is no
  // `ToolResultBlock` to render when the payload is what failed to parse.
  it("names a payload it could not measure", () => {
    expect(omittedText("image", "image/png", "unknown size")).toBe("[image omitted: image/png, unknown size]");
    expect(omittedText("resource", undefined, "3 bytes")).toBe("[resource omitted: unknown, 3 bytes]");
    expect(omittedText("audio", "", "3 bytes")).toBe("[audio omitted: unknown, 3 bytes]");
  });
});

describe("what crossed, by kind", () => {
  const six = { type: "image", data: "AAAAAAAA", mimeType: "image/png" } as const;

  // The audit row's second number is the first one grouped, not a third measure,
  // so a reader can check the two against each other.
  it("sums to the total it splits", () => {
    const content = [{ type: "text", text: "café" }, six] as const;
    const byType = resultBytesByType([...content]);
    expect(byType).toEqual({ text: 5, image: 6 });
    expect(Object.values(byType).reduce((a, b) => a + b, 0)).toBe(resultBytes([...content]));
  });

  it("adds up blocks of one kind rather than keeping the last", () => {
    expect(resultBytesByType([six, six])).toEqual({ image: 12 });
  });

  // Absent rather than zero: the row records what crossed, and a zero would be a
  // claim that an empty image crossed.
  it("leaves out a kind that carried nothing", () => {
    expect(resultBytesByType([{ type: "text", text: "abcd" }])).toEqual({ text: 4 });
    expect(resultBytesByType([])).toEqual({});
  });
});
