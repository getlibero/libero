// The Slack adapter's whole public surface.
//
// Everything here is ids, text the handler asked for, and codes. No token value
// appears in any field of any type in this file, including the error — errors
// are one of the paths a secret leaks, and this is the process that holds the
// app and bot tokens.
//
// The adapter answers a mention and nothing else. Sessions keyed on
// `(team_id, channel_id)`, the per-session mutex, attribution, the live
// checklist, and the message store are the channel router's job and are not
// modelled here.

/**
 * A mention the gateway will answer, normalized off the wire.
 *
 * Everything the router will later key on is present, but nothing here is
 * routing: the adapter hands this to one handler and posts what comes back.
 */
export interface SlackMention {
  teamId: string;
  channelId: string;
  /** The Slack user who mentioned the app. Display-name lookup is the router's. */
  userId: string;
  /** The message text, with Slack's `<@U…>` mention token still in it. */
  text: string;
  /** The mentioning message's own ts. */
  ts: string;
  /**
   * Where the reply goes: the parent thread when the mention was in one, else
   * the mentioning message itself, which starts a thread.
   */
  threadTs: string;
  /** Slack's `event_id`. Stable across delivery retries — the dedupe key. */
  eventId: string;
}

/** What the handler wants posted. A reply always lands in `threadTs`. */
export interface SlackReply {
  text: string;
}

/**
 * Event in, reply out — the minimal seam the adapter dispatches through.
 * Returning `undefined` posts nothing, which is how a handler declines a
 * mention without the adapter inventing a message.
 */
export type MentionHandler = (mention: SlackMention) => Promise<SlackReply | undefined>;

/**
 * One inbound event as the socket delivered it, still unparsed.
 *
 * `event` and `body` are `unknown` on purpose: `toMention` is the only code that
 * reads them, so an SDK type change cannot spread past one function.
 */
export interface SlackEnvelope {
  /**
   * Acknowledge receipt. Slack redelivers an unacknowledged event, and its
   * window is about three seconds — far shorter than a model turn — so the
   * gateway acks before dispatching, never after.
   */
  ack(): Promise<void>;
  /** The inner `app_mention` payload. */
  event: unknown;
  /** The outer events_api body. Carries `team_id` and `event_id`. */
  body: unknown;
}

/**
 * The inbound half of the seam. Implemented over Socket Mode in production and
 * by `createStubSlack` in tests, so the whole dispatch path runs with no socket.
 */
export interface SocketSource {
  /**
   * Resolves once connected. Rejects with a `GatewayError` whose `retryable`
   * says whether the reconnect loop should try again — a revoked token is not
   * something waiting fixes.
   */
  connect(): Promise<void>;
  /** Closes the socket. No listener fires after this resolves. */
  close(): Promise<void>;
  /** Registers the mention listener. Called once, before `connect`. */
  onMention(listener: (envelope: SlackEnvelope) => Promise<void>): void;
  /** The socket dropped for a reason other than `close()`. */
  onDrop(listener: () => void): void;
}

/**
 * The outbound half. Separate from `SocketSource` because inbound and outbound
 * are different Slack APIs with different failure modes, and a test that asserts
 * on what got posted should not have to script a socket to do it.
 */
export interface MessagePoster {
  postThreadReply(target: { channelId: string; threadTs: string; text: string }): Promise<void>;
}

/** The adapter's lifecycle, and all of it. */
export interface SlackGateway {
  /**
   * Connects and begins dispatching. Resolves once connected; rejects if Slack
   * refused the credentials, which no amount of retrying changes.
   */
  start(): Promise<void>;
  /** Stops dispatching and closes the socket. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Why a mention was ignored, or a connection or post failed. A closed set of
 * codes rather than prose, so a log line and an error say the same word and
 * neither can grow an SDK message carrying a URL or a token.
 */
export type GatewayErrorReason =
  /** Slack will not accept these credentials. Not retryable. */
  | "auth_rejected"
  /** The socket did not come up. Retryable. */
  | "connect_failed"
  /** `chat.postMessage` failed. */
  | "post_failed"
  /** The envelope was not an answerable mention. See `toMention`. */
  | "malformed_event";

export class GatewayError extends Error {
  readonly reason: GatewayErrorReason;
  /** Whether the reconnect loop should try again. */
  readonly retryable: boolean;
  /**
   * Slack's own error code when there was one — `not_in_channel`,
   * `channel_not_found`, `msg_too_long`. Slack's closed vocabulary, and the
   * first thing an operator needs when a reply does not appear. Never the SDK's
   * message: `WebAPIHTTPError` carries response headers and the Socket Mode
   * client's requests carry a bearer token.
   *
   * Declared `string | undefined` rather than optional because
   * `exactOptionalPropertyTypes` rejects assigning `undefined` to an optional
   * property, and this one is assigned from a lookup that may not find it.
   */
  readonly slackError: string | undefined;

  constructor(
    reason: GatewayErrorReason,
    retryable: boolean,
    options?: { cause?: unknown; slackError?: string }
  ) {
    super(reason, options);
    this.name = "GatewayError";
    this.reason = reason;
    this.retryable = retryable;
    this.slackError = options?.slackError;
  }
}
