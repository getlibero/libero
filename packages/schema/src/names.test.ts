import { describe, expect, it } from "vitest";
import { CHANNEL_ID_PATTERN, ChannelId } from "./names.js";

// The other names in this module are covered where they are used: ResourceName
// in tool-call.test.ts, CredentialName and DestinationHost in refusal.test.ts.
// ChannelId is the one nothing else exercises, and it is the one that decides
// whether a channel id is safe to use as a path segment.
describe("the channel id", () => {
  const valid = ["C0ENGINEERING", "engineering", "eng-ops", "team.core", "C123_456", "a"];
  const invalid = ["", "..", ".", "../../etc", "a/b", "a\\b", ".hidden", "-lead", "C 123", "x".repeat(65)];

  it("accepts the ids an operator writes", () => {
    for (const id of valid) expect(ChannelId.safeParse(id).success).toBe(true);
  });

  it("rejects anything that is not a safe path segment", () => {
    for (const id of invalid) expect(ChannelId.safeParse(id).success).toBe(false);
  });

  // The proxy's identity resolver uses the raw pattern on its hot path while
  // everything that stores or routes on an id uses the schema. They are one
  // rule, and this is the test that says so.
  it("agrees with the pattern the proxy tests against", () => {
    for (const id of [...valid, ...invalid]) {
      expect(CHANNEL_ID_PATTERN.test(id)).toBe(ChannelId.safeParse(id).success);
    }
  });
});
