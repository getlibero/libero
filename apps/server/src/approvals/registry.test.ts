// A map with names. The behaviour worth pinning is the lifecycle the names
// promise — an entry is reachable exactly between register and remove — and
// the shape: a lookup is scoped by channel, so another channel's entry is not
// reachable at all, rather than reachable and then rejected.

import { describe, it } from "node:test";
import { expect } from "expect";
import { createApprovalRegistry } from "./registry.js";

const CHANNEL = "C024BE91L";

const entry = () => ({ settle: () => {} });

describe("the approval registry", () => {
  it("finds what was registered, under its channel and ticket id", () => {
    const registry = createApprovalRegistry();
    const pending = entry();

    registry.register(CHANNEL, "tk-1", pending);

    expect(registry.get(CHANNEL, "tk-1")).toBe(pending);
  });

  it("answers undefined for a ticket nobody is waiting on", () => {
    const registry = createApprovalRegistry();

    expect(registry.get(CHANNEL, "tk-never")).toBeUndefined();
  });

  // The proxy's argument, held here too: a foreign ticket and a nonexistent
  // one are one answer, because the lookup cannot reach across channels.
  it("answers undefined for another channel's ticket", () => {
    const registry = createApprovalRegistry();
    registry.register(CHANNEL, "tk-1", entry());

    expect(registry.get("C99OTHER1", "tk-1")).toBeUndefined();
  });

  it("forgets a removed entry", () => {
    const registry = createApprovalRegistry();
    registry.register(CHANNEL, "tk-1", entry());

    registry.remove(CHANNEL, "tk-1");

    expect(registry.get(CHANNEL, "tk-1")).toBeUndefined();
  });

  it("removes an absent id without complaint", () => {
    const registry = createApprovalRegistry();

    expect(() => {
      registry.remove(CHANNEL, "tk-never");
    }).not.toThrow();
  });

  it("keeps a channel's other waits when one is removed", () => {
    const registry = createApprovalRegistry();
    const kept = entry();
    registry.register(CHANNEL, "tk-1", entry());
    registry.register(CHANNEL, "tk-2", kept);

    registry.remove(CHANNEL, "tk-1");

    expect(registry.get(CHANNEL, "tk-2")).toBe(kept);
  });
});

// The boolean exists for one log line: channel_mismatch instead of
// unknown_ticket when a click names a real wait in the wrong channel. It never
// hands back an entry, so nothing found through it can be settled.
describe("heldElsewhere", () => {
  it("is true for a ticket held under a different channel", () => {
    const registry = createApprovalRegistry();
    registry.register(CHANNEL, "tk-1", entry());

    expect(registry.heldElsewhere("C99OTHER1", "tk-1")).toBe(true);
  });

  it("is false for a ticket held under the asking channel itself", () => {
    const registry = createApprovalRegistry();
    registry.register(CHANNEL, "tk-1", entry());

    expect(registry.heldElsewhere(CHANNEL, "tk-1")).toBe(false);
  });

  it("is false for a ticket held nowhere", () => {
    const registry = createApprovalRegistry();

    expect(registry.heldElsewhere(CHANNEL, "tk-never")).toBe(false);
  });

  it("goes false again once the wait settles", () => {
    const registry = createApprovalRegistry();
    registry.register(CHANNEL, "tk-1", entry());
    registry.remove(CHANNEL, "tk-1");

    expect(registry.heldElsewhere("C99OTHER1", "tk-1")).toBe(false);
  });
});
