// Which channel is calling.
//
// The answer comes from the client certificate the connection was established
// with, and from nowhere else. There is deliberately no header and no body
// field the proxy will read a channel id out of: the agent process runs the
// model, so anything the model can influence is not a boundary. A request for
// channel X requires possession of channel X's private key.
//
// Certificates authenticate; team sheets authorize. Resolving an identity here
// says only that the caller is who it claims to be — what that channel may do
// is a separate question the team sheet answers on every call.
//
// Since #79 the sheet has a say in the first question too, and the distinction
// is worth keeping straight: it names the fingerprints of the certificates
// allowed to speak for its channel. That is the sheet narrowing *which key*
// speaks for the channel it belongs to — it still cannot make a key speak for a
// different channel, because the CN below is what selects the sheet in the first
// place. A sheet that pinned another channel's certificate would make its own
// channel unreachable and widen nothing.
//
// Without it there was no revocation for a leaked key: a re-mint carries the
// same `CN=channel:<id>` as the key it replaces, so nothing here could tell them
// apart, and the only remedy was deleting the sheet — which is revoking the
// channel rather than the key.

import type { TLSSocket } from "node:tls";
import { CHANNEL_ID_PATTERN, normalizeCertificateSha256 } from "@getlibero/schema";

/** Client certificate subjects are "channel:<id>". Nothing else is a principal. */
export const CHANNEL_CN_PREFIX = "channel:";

// What a channel id may look like is defined once, in @getlibero/schema, and
// imported here rather than restated — a certificate that minted an id this
// process accepted but the storage layer rejected (or worse, the other way
// round) is a hole, and two copies of a regex is how that happens. The pattern
// rather than the zod schema, because this runs on every request and the
// rejection taxonomy below is this module's own.

/** Why a connection produced no channel. Logged; never returned to the caller. */
export type IdentityRejection =
  | "no_client_certificate"
  | "no_common_name"
  | "ambiguous_common_name"
  | "not_a_channel_principal"
  | "malformed_channel_id"
  | "no_certificate_fingerprint"
  | "certificate_not_pinned";

/**
 * What the common-name rule alone decides, before any certificate digest is
 * read. Separate from `ChannelIdentity` so the rule stays a pure function of a
 * string and can be tested without a socket.
 */
export type CommonNameIdentity =
  | { readonly ok: true; readonly channel: string }
  | { readonly ok: false; readonly reason: IdentityRejection; readonly commonName?: string };

export type ChannelIdentity =
  | {
      readonly ok: true;
      readonly channel: string;
      /**
       * The presented certificate's SHA-256 digest, colon-separated, as
       * `matchesPin` and a team sheet both spell one. Carried on the resolved
       * identity rather than re-read later because this is the only module that
       * touches the socket, and a second reader of peer material is a second
       * place the rule about where a channel comes from could be bent.
       */
      readonly fingerprint: string;
    }
  | {
      readonly ok: false;
      readonly reason: IdentityRejection;
      readonly commonName?: string;
      readonly fingerprint?: string;
    };

/**
 * The whole rule, as a pure function of the certificate's common name, so it
 * can be tested without a socket. `undefined` covers both a connection with no
 * client certificate and one whose certificate carries no CN.
 */
export function channelFromCommonName(commonName: string | undefined): CommonNameIdentity {
  if (commonName === undefined || commonName === "") {
    return { ok: false, reason: "no_common_name" };
  }
  if (!commonName.startsWith(CHANNEL_CN_PREFIX)) {
    return { ok: false, reason: "not_a_channel_principal", commonName };
  }
  const channel = commonName.slice(CHANNEL_CN_PREFIX.length);
  if (!CHANNEL_ID_PATTERN.test(channel)) {
    return { ok: false, reason: "malformed_channel_id", commonName };
  }
  return { ok: true, channel };
}

/**
 * The socket-facing wrapper.
 *
 * A connection normally cannot get this far without a certificate the proxy's
 * CA signed — the TLS layer refuses it first — so the empty case here is the
 * belt to that braces. It is checked anyway rather than assumed, because the
 * cost of being wrong is a request with no channel bound to it.
 */
export function resolveChannel(socket: TLSSocket): ChannelIdentity {
  const peer = socket.getPeerCertificate();
  // Node returns {} rather than null when there is no peer certificate.
  if (peer === null || Object.keys(peer).length === 0) {
    return { ok: false, reason: "no_client_certificate" };
  }
  const commonName = peer.subject?.CN;
  // A subject carrying two CNs is refused rather than resolved. Nothing this
  // CA mints looks like that, and choosing one of them would be picking which
  // channel an ambiguous certificate speaks for.
  if (Array.isArray(commonName)) {
    return { ok: false, reason: "ambiguous_common_name" };
  }
  const named = channelFromCommonName(commonName);
  if (!named.ok) return named;

  // Node computes this from the DER it verified, so it is a fact about the
  // certificate this connection actually presented rather than anything the
  // peer said about itself. Absent is not a case the TLS layer can produce with
  // a verified certificate in hand; it is refused rather than defaulted,
  // because the alternative to a digest here is a request that skipped the pin
  // check.
  const fingerprint = peer.fingerprint256;
  if (typeof fingerprint !== "string" || fingerprint === "") {
    return {
      ok: false,
      reason: "no_certificate_fingerprint",
      ...(commonName !== undefined ? { commonName } : {})
    };
  }
  return { ok: true, channel: named.channel, fingerprint };
}

/**
 * Whether a presented certificate is one the channel's sheet allows.
 *
 * Both sides are folded rather than compared as written. `openssl` and Node
 * both print colon-separated uppercase pairs, but a sheet may carry either that
 * or bare hex in either case — an operator who stripped the punctuation is not
 * making a different claim, and a channel offline over a colon would be a
 * failure with nothing on screen to explain it.
 *
 * Nothing here treats an empty list as permissive: the schema makes an empty
 * list unsayable, and this returns `false` for one, so the two disagree in the
 * safe direction rather than in the interesting one.
 */
export function matchesPin(fingerprint: string, pins: readonly string[]): boolean {
  const presented = normalizeCertificateSha256(fingerprint);
  return pins.some(pin => normalizeCertificateSha256(pin) === presented);
}
