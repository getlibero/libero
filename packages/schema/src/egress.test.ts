import { describe, expect, it } from "vitest";
import { EgressPattern, isEgressAllowed, normalizeHost } from "./egress.js";

// The matcher is the whole security value of the egress list, so these are
// written as near-misses rather than as a happy path: a matcher that passes
// exact-match and obvious-wildcard cases and nothing else is not done.

const ALLOW = ["api.github.com", "*.internal.example.com"];

describe("exact entries", () => {
  it("admits the host it names", () => {
    expect(isEgressAllowed("api.github.com", ALLOW)).toBe(true);
  });

  it("does not admit a subdomain of it", () => {
    expect(isEgressAllowed("evil.api.github.com", ALLOW)).toBe(false);
  });

  it("does not admit a parent of it", () => {
    expect(isEgressAllowed("github.com", ALLOW)).toBe(false);
  });

  it("does not admit a host that merely contains it", () => {
    for (const host of ["api.github.com.attacker.com", "notapi.github.com", "api.github.computer"]) {
      expect(isEgressAllowed(host, ALLOW), host).toBe(false);
    }
  });
});

describe("the wildcard label", () => {
  it("admits one subdomain label and several", () => {
    expect(isEgressAllowed("build.internal.example.com", ALLOW)).toBe(true);
    expect(isEgressAllowed("a.b.c.internal.example.com", ALLOW)).toBe(true);
  });

  // The one a plain endsWith() gets wrong: no dot boundary, so the pattern is
  // matching the tail of a longer label rather than a label of its own.
  it("does not admit a host whose label merely ends with the suffix", () => {
    for (const host of [
      "evil-internal.example.com",
      "notinternal.example.com",
      "xinternal.example.com"
    ]) {
      expect(isEgressAllowed(host, ALLOW), host).toBe(false);
    }
  });

  // The one an unanchored match gets wrong.
  it("does not admit a host that continues past the suffix", () => {
    for (const host of [
      "internal.example.com.attacker.com",
      "build.internal.example.com.attacker.com",
      "internal.example.command.example.org"
    ]) {
      expect(isEgressAllowed(host, ALLOW), host).toBe(false);
    }
  });

  // Granting a subtree does not grant its root.
  it("does not admit the bare suffix", () => {
    expect(isEgressAllowed("internal.example.com", ALLOW)).toBe(false);
  });

  it("does not admit an empty leading label", () => {
    expect(isEgressAllowed(".internal.example.com", ALLOW)).toBe(false);
  });

  it("never admits an ip literal", () => {
    expect(isEgressAllowed("127.0.0.1", ["*.0.1"])).toBe(false);
    expect(isEgressAllowed("10.0.0.1", ["*.0.1", "*.1"])).toBe(false);
    // Exact remains the only way to name one.
    expect(isEgressAllowed("127.0.0.1", ["127.0.0.1"])).toBe(true);
  });
});

describe("normalization", () => {
  it("folds case on both sides", () => {
    expect(isEgressAllowed("API.GitHub.COM", ALLOW)).toBe(true);
    expect(isEgressAllowed("api.github.com", ["API.GITHUB.COM"])).toBe(true);
    expect(isEgressAllowed("BUILD.Internal.Example.Com", ALLOW)).toBe(true);
  });

  it("treats a single trailing dot as the same host on either side", () => {
    expect(isEgressAllowed("api.github.com.", ALLOW)).toBe(true);
    expect(isEgressAllowed("api.github.com", ["api.github.com."])).toBe(true);
    expect(isEgressAllowed("build.internal.example.com.", ALLOW)).toBe(true);
  });

  // The trailing-dot rule strips one dot, not a run of them: `example.com..`
  // is not a host, and normalizing it into one would invent a match.
  it("does not admit a host with a doubled trailing dot", () => {
    expect(isEgressAllowed("api.github.com..", ALLOW)).toBe(false);
  });

  // Destinations arrive punycoded from `new URL().hostname`, so a unicode
  // lookalike is a different string and stays one. Nothing here maps it onto
  // the ASCII host it imitates.
  it("does not admit a unicode lookalike of an allowed host", () => {
    // Cyrillic а (U+0430) in place of the ASCII one.
    expect(isEgressAllowed("аpi.github.com", ALLOW)).toBe(false);
    expect(isEgressAllowed("xn--pi-8md.github.com", ALLOW)).toBe(false);
    // And the reverse: a pattern typed in unicode does not admit ASCII.
    expect(isEgressAllowed("api.github.com", ["аpi.github.com"])).toBe(false);
  });

  it("returns null for a host that is nothing but a dot", () => {
    expect(normalizeHost(".")).toBeNull();
    expect(normalizeHost("")).toBeNull();
  });
});

describe("default deny", () => {
  it("admits nothing when the list is empty", () => {
    expect(isEgressAllowed("api.github.com", [])).toBe(false);
  });

  it("admits nothing for an empty destination", () => {
    expect(isEgressAllowed("", ALLOW)).toBe(false);
    expect(isEgressAllowed(".", ALLOW)).toBe(false);
  });

  // The schema rejects these, but the matcher is reachable without it and
  // decides for itself rather than assuming its input was parsed.
  it("treats a malformed entry as matching nothing rather than as a wildcard", () => {
    for (const entry of ["*", "*.", "**.example.com", "api*.example.com", "*.*.com", ""]) {
      expect(isEgressAllowed("api.example.com", [entry]), entry).toBe(false);
      expect(isEgressAllowed("anything.example.com", [entry]), entry).toBe(false);
    }
  });

  it("still reads the rest of a list containing a malformed entry", () => {
    expect(isEgressAllowed("api.github.com", ["*", "api.github.com"])).toBe(true);
  });
});

describe("EgressPattern", () => {
  it("accepts a host and a leftmost wildcard", () => {
    for (const entry of ["api.github.com", "*.internal.example.com", "mcp-github", "127.0.0.1"]) {
      expect(EgressPattern.safeParse(entry).success, entry).toBe(true);
    }
  });

  // A bare `*` would be an allow-all, which default deny does not have.
  it("rejects a bare wildcard", () => {
    expect(EgressPattern.safeParse("*").success).toBe(false);
    expect(EgressPattern.safeParse("*.").success).toBe(false);
  });

  it("rejects a wildcard that is not the whole leftmost label", () => {
    for (const entry of ["api*.example.com", "*.*.com", "ex*ample.com", "example.*"]) {
      expect(EgressPattern.safeParse(entry).success, entry).toBe(false);
    }
  });

  it("rejects a scheme, a path, or a query", () => {
    for (const entry of ["https://api.github.com", "api.github.com/v3", "api.github.com?a=b", ""]) {
      expect(EgressPattern.safeParse(entry).success, entry).toBe(false);
    }
  });
});
