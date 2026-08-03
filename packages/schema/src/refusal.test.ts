import { describe, expect, it } from "vitest";
import { RefusalReason, ToolRefusal, refusalMessage } from "./refusal.js";

/** One well-formed refusal per reason, keyed so the totality test can check
 *  that the union covers every reason the enum declares. */
const samples: Record<RefusalReason, ToolRefusal> = {
  no_team_sheet: { reason: "no_team_sheet" },
  team_sheet_unreadable: { reason: "team_sheet_unreadable" },
  server_not_allowed: { reason: "server_not_allowed", server: "stripe" },
  tool_not_allowed: { reason: "tool_not_allowed", server: "github", tool: "delete_repo" },
  approval_required: { reason: "approval_required", server: "github", tool: "trigger_workflow" },
  budget_exhausted: { reason: "budget_exhausted", limit: "daily_tool_calls" },
  egress_denied: { reason: "egress_denied", destination: "api.example.net" },
  credential_unresolved: { reason: "credential_unresolved", credential: "github_service_account" }
};

describe("coverage", () => {
  it("has a variant and a sentence for every declared reason", () => {
    for (const reason of RefusalReason.options) {
      const sample = samples[reason];
      expect(ToolRefusal.safeParse(sample).success).toBe(true);
      expect(refusalMessage(sample).length).toBeGreaterThan(0);
    }
  });

  it("gives each reason its own sentence", () => {
    const sentences = RefusalReason.options.map(r => refusalMessage(samples[r]));
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  // Terse and technical, per the house voice. Cheap to assert, and the thing
  // that drifts first when someone adds a reason in a hurry.
  it("names the call and says whether it ran", () => {
    expect(refusalMessage(samples.tool_not_allowed)).toContain("`delete_repo`");
    expect(refusalMessage(samples.approval_required)).toContain("`github.trigger_workflow`");
    for (const reason of RefusalReason.options) {
      expect(refusalMessage(samples[reason])).not.toMatch(/[!😀-🿿]/u);
    }
  });
});

describe("the round trip", () => {
  // Constructed in the proxy, serialized, parsed by the agent, relayed as text.
  // The reason has to survive that, or a refusal is just a string.
  it("survives JSON without losing its reason", () => {
    for (const reason of RefusalReason.options) {
      const overWire: unknown = JSON.parse(JSON.stringify(samples[reason]));
      const parsed = ToolRefusal.parse(overWire);
      expect(parsed.reason).toBe(reason);
      expect(refusalMessage(parsed)).toBe(refusalMessage(samples[reason]));
    }
  });

  it("keeps the facts the sentence is built from", () => {
    const parsed = ToolRefusal.parse(JSON.parse(JSON.stringify(samples.egress_denied)));
    expect(parsed).toEqual({ reason: "egress_denied", destination: "api.example.net" });
  });
});

describe("rejections", () => {
  it("rejects an unknown reason", () => {
    expect(ToolRefusal.safeParse({ reason: "rate_limited" }).success).toBe(false);
    expect(ToolRefusal.safeParse({ server: "github" }).success).toBe(false);
  });

  it("requires each variant's own facts", () => {
    expect(ToolRefusal.safeParse({ reason: "tool_not_allowed", server: "github" }).success).toBe(false);
    expect(ToolRefusal.safeParse({ reason: "budget_exhausted" }).success).toBe(false);
    expect(ToolRefusal.safeParse({ reason: "budget_exhausted", limit: "monthly" }).success).toBe(false);
  });

  // No open bag: not a detail, not a cause, not a free-text message. The
  // relayable sentence is derived, so there is no prose field to slip a value
  // into and nothing for a careless call site to widen.
  it("rejects any field a variant does not declare", () => {
    for (const extra of [
      { detail: "token was sk-live-abc" },
      { message: "denied: Bearer sk-live-abc" },
      { cause: { headers: { authorization: "Bearer sk-live-abc" } } },
      { credential: "github_service_account" }
    ]) {
      expect(ToolRefusal.safeParse({ ...samples.server_not_allowed, ...extra }).success).toBe(false);
    }
  });

  // The name bound rejects the shapes a name never has: punctuation outside the
  // identifier alphabet, and anything long.
  it("rejects bulk secret material where a credential name belongs", () => {
    for (const value of [
      "sk-live-51H8xY/9aB+cD=",
      "-----BEGIN PRIVATE KEY-----",
      "A".repeat(200),
      "https://user:pw@api.example.net"
    ]) {
      expect(
        ToolRefusal.safeParse({ reason: "credential_unresolved", credential: value }).success
      ).toBe(false);
    }
  });

  // The gap, asserted so nobody reads the bound above as a filter. A GitHub PAT
  // and a Slack bot token are short and use the identifier alphabet, so they
  // parse. What keeps values out of this field is that only names from a team
  // sheet are ever put in it — not the shape. See ./names.ts.
  it("does not detect a token that is shaped like a name", () => {
    for (const value of ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", "xoxb-2401-3982-Zk9qW"]) {
      expect(
        ToolRefusal.safeParse({ reason: "credential_unresolved", credential: value }).success
      ).toBe(true);
    }
  });

  // A URL carries a query string, and a credential in a query string is how a
  // secret reaches a log line. An egress refusal names a host.
  it("rejects a URL where an egress destination belongs", () => {
    for (const destination of [
      "https://api.example.net/hook?token=sk-live-abc",
      "api.example.net/path",
      "https://api.example.net"
    ]) {
      expect(ToolRefusal.safeParse({ reason: "egress_denied", destination }).success).toBe(false);
    }
  });

  it("accepts a bare host, with a port", () => {
    for (const destination of ["api.github.com", "mcp-github:3001", "10.0.0.7"]) {
      expect(ToolRefusal.safeParse({ reason: "egress_denied", destination }).success).toBe(true);
    }
  });
});
