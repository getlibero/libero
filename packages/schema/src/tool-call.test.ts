import { describe, expect, it } from "vitest";
import { ToolCall, ToolCallResponse, resolveToolCall } from "./tool-call.js";

const wire = { id: "toolu_01", server: "github", tool: "list_prs", arguments: { state: "open" } };

describe("the wire tool call", () => {
  it("parses what the agent sends", () => {
    expect(ToolCall.parse(wire)).toEqual(wire);
  });

  it("defaults absent arguments to an empty object", () => {
    const call = ToolCall.parse({ id: "toolu_01", server: "github", tool: "list_prs" });
    expect(call.arguments).toEqual({});
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

  it("rejects a missing id, server, or tool", () => {
    expect(ToolCall.safeParse({ server: "github", tool: "list_prs" }).success).toBe(false);
    expect(ToolCall.safeParse({ id: "toolu_01", tool: "list_prs" }).success).toBe(false);
    expect(ToolCall.safeParse({ id: "toolu_01", server: "github" }).success).toBe(false);
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

  it("parses each of the three outcomes", () => {
    expect(
      ToolCallResponse.parse({ outcome: "ran", id: "toolu_01", result: { content: "ok" } })
    ).toEqual({ outcome: "ran", id: "toolu_01", result: { content: "ok", isError: false } });

    for (const outcome of ["held", "refused"] as const) {
      expect(ToolCallResponse.parse({ outcome, id: "toolu_01", refusal })).toEqual({
        outcome,
        id: "toolu_01",
        refusal
      });
    }
  });

  // Held and refused both mean the call did not run, and they are still two
  // answers: a hold is a question put to a human, and the approval broker has
  // to tell them apart without re-deriving it from the refusal reason.
  it("keeps held and refused distinct", () => {
    const held = ToolCallResponse.parse({ outcome: "held", id: "toolu_01", refusal });
    const refused = ToolCallResponse.parse({ outcome: "refused", id: "toolu_01", refusal });
    expect(held.outcome).not.toBe(refused.outcome);
  });

  it("rejects a variant carrying the other's payload", () => {
    expect(
      ToolCallResponse.safeParse({ outcome: "ran", id: "toolu_01", refusal }).success
    ).toBe(false);
    expect(
      ToolCallResponse.safeParse({ outcome: "refused", id: "toolu_01", result: { content: "" } })
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
