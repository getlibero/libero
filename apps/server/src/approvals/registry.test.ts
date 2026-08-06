// A map with names. The behaviour worth pinning is the lifecycle the names
// promise: an entry is reachable exactly between register and remove, and
// nothing here decides anything — settle is the registrant's verb.

import { describe, expect, it } from "vitest";
import { createApprovalRegistry } from "./registry.js";

const entry = (channel = "C024BE91L") => ({ channel, settle: () => {} });

describe("the approval registry", () => {
  it("finds what was registered, under its ticket id", () => {
    const registry = createApprovalRegistry();
    const pending = entry();

    registry.register("tk-1", pending);

    expect(registry.get("tk-1")).toBe(pending);
  });

  it("answers undefined for a ticket nobody is waiting on", () => {
    const registry = createApprovalRegistry();

    expect(registry.get("tk-never")).toBeUndefined();
  });

  it("forgets a removed entry", () => {
    const registry = createApprovalRegistry();
    registry.register("tk-1", entry());

    registry.remove("tk-1");

    expect(registry.get("tk-1")).toBeUndefined();
  });

  it("removes an absent id without complaint", () => {
    const registry = createApprovalRegistry();

    expect(() => {
      registry.remove("tk-never");
    }).not.toThrow();
  });
});
