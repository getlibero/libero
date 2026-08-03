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

import type { TLSSocket } from "node:tls";
import { CHANNEL_ID_PATTERN } from "@getlibero/schema";

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
  | "malformed_channel_id";

export type ChannelIdentity =
  | { readonly ok: true; readonly channel: string }
  | { readonly ok: false; readonly reason: IdentityRejection; readonly commonName?: string };

/**
 * The whole rule, as a pure function of the certificate's common name, so it
 * can be tested without a socket. `undefined` covers both a connection with no
 * client certificate and one whose certificate carries no CN.
 */
export function channelFromCommonName(commonName: string | undefined): ChannelIdentity {
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
  return channelFromCommonName(commonName);
}
