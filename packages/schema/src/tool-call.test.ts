import { describe, expect, it } from "vitest";
import { ToolCall, ToolCallResponse, resolveToolCall } from "./tool-call.js";

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
      ToolCallResponse.parse({ outcome: "ran", id: "toolu_01", result: { content: "ok" } })
    ).toEqual({ outcome: "ran", id: "toolu_01", result: { content: "ok", isError: false } });

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
