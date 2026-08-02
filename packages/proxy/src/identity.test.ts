// The identity rule, tested as a pure function of the certificate subject.
// server.test.ts proves the same rule holds over a real TLS connection; this
// file is where the edge cases live, because they are cheap to state here.

import { describe, expect, it } from "vitest";
import { channelFromCommonName } from "./identity.js";

describe("channelFromCommonName", () => {
  it("resolves a channel principal", () => {
    expect(channelFromCommonName("channel:C024BE91L")).toEqual({
      ok: true,
      channel: "C024BE91L"
    });
  });

  it("refuses a subject that is not a channel principal", () => {
    // The shape a single shared service certificate would have. Rejected on
    // purpose: one certificate that can speak for every channel is the thing
    // per-channel identity exists to rule out.
    expect(channelFromCommonName("agent")).toMatchObject({
      ok: false,
      reason: "not_a_channel_principal"
    });
  });

  it("refuses an absent or empty common name", () => {
    expect(channelFromCommonName(undefined)).toMatchObject({ ok: false, reason: "no_common_name" });
    expect(channelFromCommonName("")).toMatchObject({ ok: false, reason: "no_common_name" });
  });

  it("refuses an empty channel id", () => {
    expect(channelFromCommonName("channel:")).toMatchObject({
      ok: false,
      reason: "malformed_channel_id"
    });
  });

  // A resolved channel id is used downstream as a path segment — the team
  // sheet at channels/<id>/channel.toml, the per-channel SQLite file — and the
  // file-per-channel layout is the isolation boundary. Traversal has to die
  // here, not at the first place someone remembers to sanitize.
  it.each([
    "channel:..",
    "channel:.",
    "channel:../../etc",
    "channel:a/b",
    "channel:a\\b",
    "channel:.hidden",
    "channel:with space",
    "channel:-flag",
    "channel:C024BE91L\nchannel:other"
  ])("refuses %j", commonName => {
    expect(channelFromCommonName(commonName)).toMatchObject({
      ok: false,
      reason: "malformed_channel_id"
    });
  });

  it("refuses a channel id past the length ceiling", () => {
    expect(channelFromCommonName(`channel:${"a".repeat(65)}`)).toMatchObject({
      ok: false,
      reason: "malformed_channel_id"
    });
    expect(channelFromCommonName(`channel:${"a".repeat(64)}`)).toMatchObject({ ok: true });
  });

  it("carries the rejected subject for the log line", () => {
    // The proxy logs which subject it turned away — a certificate subject is
    // not a secret, and an operator debugging a refused agent needs it. It
    // does not travel back to the caller; server.test.ts holds that half.
    const rejected = channelFromCommonName("agent");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.commonName).toBe("agent");
  });
});
