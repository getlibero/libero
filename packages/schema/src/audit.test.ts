import { describe, it } from "node:test";
import { expect } from "expect";
import { AuditOutcome, auditRefusalMessage } from "./audit.js";
import { RefusalReason, refusalMessage } from "./refusal.js";
import { ToolCallResponse } from "./tool-call.js";

describe("AuditOutcome", () => {
  it("accepts exactly the things that can happen to a call", () => {
    for (const outcome of [
      "ran",
      "held",
      "refused",
      "unavailable",
      "unanswered",
      "approved",
      "denied",
      "expired"
    ]) {
      expect(AuditOutcome.parse(outcome)).toBe(outcome);
    }
    expect(AuditOutcome.options).toHaveLength(8);
  });

  it("rejects anything else, including the tool's own error flag", () => {
    for (const nope of ["error", "failed", "ok", "RAN", ""]) {
      expect(AuditOutcome.safeParse(nope).success).toBe(false);
    }
  });

  // The property that keeps a log line, the answer the agent got, and the row
  // saying the same word — for the outcomes a tool call can be answered with.
  // The rest are named here rather than counted, so adding one is a decision
  // about what it is: `unavailable` is a 501 rather than a served refusal,
  // `unanswered` is a call the proxy decided and then failed to answer at all,
  // and the last three are a human's decision about a call rather than a call.
  it("covers ToolCallResponse's discriminator, and names what it does not", () => {
    const served: string[] = ToolCallResponse.options.map(option => option.shape.outcome.value);

    expect(served.every(outcome => AuditOutcome.safeParse(outcome).success)).toBe(true);
    expect(AuditOutcome.options.filter(outcome => !served.includes(outcome))).toEqual([
      "unavailable",
      "unanswered",
      "approved",
      "denied",
      "expired"
    ]);
  });
});

describe("auditRefusalMessage", () => {
  const SERVER = "github";
  const TOOL = "delete_repo";

  // The ones the row cannot complete, named here so adding another is a
  // decision someone made rather than something that drifted in.
  //
  // `model_not_priced` joined them with #62 and is expected to stay: the audit
  // table's coming `budget_limit` column says which *limit* bound, and this one
  // needs the *model*, which is a different fact and one a row about a tool call
  // never observed. Its sibling `model_unreported` is deliberately not here —
  // it carries no facts at all, so the row is already complete for it, and that
  // asymmetry is the reason the two reasons are two.
  const INCOMPLETE = [
    "budget_exhausted",
    "model_not_priced",
    "egress_denied",
    "credential_unresolved"
  ];

  it("answers every reason in the union, with a sentence or with null", () => {
    for (const reason of RefusalReason.options) {
      const message = auditRefusalMessage(reason, SERVER, TOOL);
      if (INCOMPLETE.includes(reason)) {
        expect(message).toBeNull();
      } else {
        expect(message).toEqual(expect.any(String));
      }
    }
  });

  // The property the whole function exists for: the operator reading the log
  // and the channel that saw the refusal are given the same words. Compared
  // against `refusalMessage` itself rather than against literals, so prose
  // written here instead of delegated fails rather than being reviewed.
  it("delegates to refusalMessage rather than writing its own prose", () => {
    expect(auditRefusalMessage("tool_not_allowed", SERVER, TOOL)).toBe(
      refusalMessage({ reason: "tool_not_allowed", server: SERVER, tool: TOOL })
    );
    expect(auditRefusalMessage("no_team_sheet", SERVER, TOOL)).toBe(
      refusalMessage({ reason: "no_team_sheet" })
    );
    expect(auditRefusalMessage("server_not_allowed", SERVER, TOOL)).toBe(
      refusalMessage({ reason: "server_not_allowed", server: SERVER })
    );
    expect(auditRefusalMessage("approval_mismatch", SERVER, TOOL)).toBe(
      refusalMessage({ reason: "approval_mismatch", server: SERVER, tool: TOOL })
    );
  });

  // Null rather than a sentence with a fact nobody recorded. Asserted as an
  // absence of the specific prose, because the failure this guards against is
  // picking a plausible variant to satisfy the type.
  it("invents nothing for the reasons the row has no column for", () => {
    for (const reason of INCOMPLETE) {
      expect(auditRefusalMessage(RefusalReason.parse(reason), SERVER, TOOL)).toBeNull();
    }
    expect(refusalMessage({ reason: "budget_exhausted", limit: "daily_tokens" })).not.toBe(
      refusalMessage({ reason: "budget_exhausted", limit: "daily_tool_calls" })
    );
  });

  // A refusal naming a credential is the one an operator most wants prose for,
  // and the one where prose would have to be invented. The table holds the
  // name no more than the value, so there is nothing here to leak.
  it("names no credential, because the row holds none", () => {
    expect(auditRefusalMessage("credential_unresolved", SERVER, TOOL)).toBeNull();
  });
});
