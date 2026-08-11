// The identity rule, tested as a pure function of the certificate subject.
// server.test.ts proves the same rule holds over a real TLS connection; this
// file is where the edge cases live, because they are cheap to state here.

import type { TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import { channelFromCommonName, matchesPin, resolveChannel } from "./identity.js";

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

// The socket-facing branches that a real handshake cannot easily produce: the
// TLS layer normally refuses a connection before either shape reaches
// resolveChannel, which is exactly why they are checked rather than assumed.
describe("resolveChannel", () => {
  function socketWithPeer(peer: object): TLSSocket {
    return { getPeerCertificate: () => peer } as unknown as TLSSocket;
  }

  const FINGERPRINT = "AB".repeat(32).replace(/(.{2})(?=.)/g, "$1:");

  it("resolves the channel and the presented fingerprint from the peer certificate", () => {
    expect(
      resolveChannel(
        socketWithPeer({ subject: { CN: "channel:C024BE91L" }, fingerprint256: FINGERPRINT })
      )
    ).toEqual({ ok: true, channel: "C024BE91L", fingerprint: FINGERPRINT });
  });

  // The digest is what the pin check compares, so resolving an identity without
  // one would be resolving a request that skips the check. Node cannot produce
  // this with a verified certificate in hand; it is refused rather than
  // defaulted for the reason the empty-certificate case above is checked.
  it("refuses a certificate it can read a CN from but no fingerprint", () => {
    expect(resolveChannel(socketWithPeer({ subject: { CN: "channel:C024BE91L" } }))).toMatchObject({
      ok: false,
      reason: "no_certificate_fingerprint",
      commonName: "channel:C024BE91L"
    });
  });

  it("refuses a connection with no peer certificate", () => {
    // Node hands back {} rather than null when there is no certificate.
    expect(resolveChannel(socketWithPeer({}))).toMatchObject({
      ok: false,
      reason: "no_client_certificate"
    });
  });

  it("refuses a subject carrying more than one CN", () => {
    // Refused rather than resolved: picking either CN would be choosing which
    // channel an ambiguous certificate speaks for.
    expect(
      resolveChannel(socketWithPeer({ subject: { CN: ["channel:C024BE91L", "channel:C7ZZZ9999"] } }))
    ).toMatchObject({ ok: false, reason: "ambiguous_common_name" });
  });
});

// #79. The certificate says which channel; this says which key may say it.
describe("matchesPin", () => {
  const a = "3A:79:E2:94:17:53:18:E7:7A:78:F3:44:38:42:A7:3D:F7:8D:05:E6:E9:FD:E0:BD:3B:B8:52:13:DA:68:16:B9";
  const b = "FE:BB:80:F9:EC:20:F1:9A:C4:96:77:8C:6D:C6:19:B3:19:F0:BF:77:3A:51:91:D5:05:69:6B:0A:22:16:80:63";
  const bare = (fp: string) => fp.replaceAll(":", "");

  it("accepts the certificate the sheet pins", () => {
    expect(matchesPin(a, [a])).toBe(true);
  });

  // The whole point of the list: during a rotation both are live, so neither
  // step of a rotation is a moment when the channel cannot call.
  it("accepts either of two, which is what a rotation in progress looks like", () => {
    expect(matchesPin(a, [a, b])).toBe(true);
    expect(matchesPin(b, [a, b])).toBe(true);
  });

  // The leak, modelled: a second certificate for the same channel, minted from
  // the same CA, differing only in its key. The CN cannot tell them apart.
  it("refuses a certificate the sheet does not pin", () => {
    expect(matchesPin(b, [a])).toBe(false);
  });

  // An operator who stripped the colons out is not making a different claim, and
  // a channel offline over punctuation would be a failure with nothing on screen
  // to explain it.
  it("reads both written forms and either case as one value", () => {
    for (const pin of [a, bare(a), a.toLowerCase(), bare(a).toLowerCase()]) {
      expect(matchesPin(a, [pin])).toBe(true);
    }
  });

  // Guarding a state the schema makes unsayable: `certificate_sha256` is
  // required and `min(1)`. If that ever stopped being true, an empty list must
  // mean "nothing may speak for this channel" and never "anything may".
  it("refuses everything when the list is empty", () => {
    expect(matchesPin(a, [])).toBe(false);
  });
});
