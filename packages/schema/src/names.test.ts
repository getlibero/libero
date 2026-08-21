import { describe, it } from "node:test";
import { expect } from "expect";
import {
  CHANNEL_ID_PATTERN,
  CertificateSha256,
  ChannelId,
  normalizeCertificateSha256,
} from "./names.js";

// The other names in this module are covered where they are used: ResourceName,
// RequestingUser, and TaskId in tool-call.test.ts, CredentialName and
// DestinationHost in refusal.test.ts. ChannelId is the one nothing else
// exercises, and it is the one that decides whether a channel id is safe to use
// as a path segment.
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

// The value a team sheet pins a client certificate by (#79). What has to hold is
// that the two spellings an operator can end up with — openssl's and Node's
// colon-separated pairs, or the same digest with the colons stripped — are one
// value, because a pin that failed to match its own certificate over punctuation
// would be a channel offline for a reason nothing on screen explains.
describe("a certificate fingerprint", () => {
  const digest = "A1B2C3D4E5F60718293A4B5C6D7E8F901122334455667788990AABBCCDDEEFF0";
  const colons = digest.match(/.{2}/g)?.join(":") ?? "";

  it("accepts both written forms, in either case", () => {
    for (const value of [digest, colons, digest.toLowerCase(), colons.toLowerCase()]) {
      expect(CertificateSha256.safeParse(value).success).toBe(true);
    }
  });

  it("rejects anything that is not a whole SHA-256 digest", () => {
    const invalid = [
      "",
      digest.slice(0, 62), // 31 pairs
      `${digest}00`, // 33
      colons.slice(0, -1), // trailing half-pair
      digest.replace("A1", "G1"), // not hex
      colons.replaceAll(":", " "), // spaces for colons
      `sha256:${digest}`, // an algorithm prefix the field name already carries
      "*",
    ];
    for (const value of invalid) expect(CertificateSha256.safeParse(value).success).toBe(false);
  });

  it("folds every accepted spelling of one digest to one string", () => {
    const folded = new Set(
      [digest, colons, digest.toLowerCase(), colons.toLowerCase()].map(normalizeCertificateSha256),
    );
    expect(folded).toEqual(new Set([digest]));
  });
});
