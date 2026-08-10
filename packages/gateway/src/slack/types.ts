// The Slack adapter's whole public surface.
//
// Everything here is ids, text the handler asked for, and codes. No token value
// appears in any field of any type in this file, including the error — errors
// are one of the paths a secret leaks, and this is the process that holds the
// app and bot tokens.
//
// The adapter answers a mention, reports a click, surfaces an ordinary message,
// and says who a user id is, and nothing else. Sessions, the per-session mutex,
// the transcript that attribution is rendered into, the live checklist, and the
// message store itself are above this package and are not modelled here — what
// a `SlackMessage` is *for* does not appear in this file, which is why it
// carries the wire's own fields and none of the store's.
//
// The directory is the one read here, and it is here for the same reason the
// posters are: it is a call on the bot token, and this is the package that
// holds one. What a name is *used for* — a cache, a transcript, an `@alice:`
// prefix — is #67's, above.
//
// The one import from the workspace is `@getlibero/schema`, and it is **type
// only**: `ApprovalVerdict` is the exact wire vocabulary of the thing being
// decoded, and two definitions of one enum drift silently. Type only because
// zod must not reach this package at runtime — the gateway validates nothing
// and must not start. The proxy parses at the boundary that enforces; a second
// parse here would be a second authority with no power to act on the result.

import type { ApprovalVerdict } from "@getlibero/schema";

/**
 * A mention the gateway will answer, normalized off the wire.
 *
 * Everything the router keys on is present, but nothing here is routing: the
 * adapter hands this to one handler and posts what comes back. What the router
 * takes is its own type, and the handler the composing process builds is the
 * mapping between the two.
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

/**
 * An ordinary channel message, normalized off the wire.
 *
 * Its own type rather than a `SlackMention`, and the difference is one field.
 * `SlackMention.threadTs` is a *reply target* — `toMention` coalesces it to the
 * mentioning message's own ts so a top-level mention starts a thread — which
 * makes a top-level message and a self-threaded one indistinguishable. What is
 * stored needs the raw value: `null` here means the message was top-level, and
 * a store cannot recover that from a coalesced one.
 *
 * `null` rather than optional. `exactOptionalPropertyTypes` would make the
 * absent case something a reader has to check for rather than something the
 * type states, and "top-level" is a fact about the message rather than a field
 * Slack forgot to send.
 */
export interface SlackMessage {
  teamId: string;
  channelId: string;
  /** The Slack user who posted. Display-name lookup is not done here. */
  userId: string;
  /** The message text, with Slack's `<@U…>` tokens still in it. */
  text: string;
  /** The message's own ts. Slack's identity for it, and the store's. */
  ts: string;
  /** The parent thread's ts, or null when the message was top-level. */
  threadTs: string | null;
  /** Slack's `event_id`. Stable across delivery retries. */
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
 * A message in, and nothing out.
 *
 * No reply, deliberately. A message is recorded, never answered — answering one
 * without a mention is #66's, and a handler that could return a `SlackReply`
 * would make the adapter capable of posting into a channel nobody addressed it
 * in. The seam is narrow because the capability should be.
 */
export type MessageHandler = (message: SlackMessage) => Promise<void>;

/**
 * A human's click on an approval card, normalized off the wire.
 *
 * The second thing this adapter surfaces, and the one the security property
 * cares about: the click is read out of a Socket Mode envelope by this code
 * rather than produced by a model, which is what makes `approverId` hold
 * against a prompt-injected model. It does not hold against a compromised agent
 * process, which relays it — see `ApproverId` in `@getlibero/schema`, where the
 * narrower claim is argued in full. Say *tool credentials* survive process
 * compromise; approvals survive prompt injection.
 */
export interface SlackDecision {
  teamId: string;
  channelId: string;
  /**
   * The Slack user who clicked. Attribution, never authorization — nothing
   * downstream gates on it. Display-name lookup is not done here, and does not
   * need to be: `<@U…>` on the card lets Slack resolve it client-side.
   */
  approverId: string;
  /**
   * The ticket the card's button carried. Opaque here and deliberately
   * unvalidated — the gateway decides nothing, and the proxy answers `unknown`
   * for an id that matches nothing in this channel.
   */
  ticketId: string;
  verdict: ApprovalVerdict;
  /** The card message's own ts. What `updateCard` edits, and not the thread's. */
  messageTs: string;
  /** The thread the card sits in, so anything else can land beside it. */
  threadTs: string;
}

/**
 * A click in, nothing out.
 *
 * `Promise<void>` rather than a reply, because a click's visible answer is the
 * card changing colour — an edit to the message that is already there. A
 * handler that could return a reply would invite a second message per click,
 * which is the thing "edit, don't spam" exists to forbid.
 */
export type DecisionHandler = (decision: SlackDecision) => Promise<void>;

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
 * One interactive envelope as the socket delivered it, still unparsed.
 *
 * Its own type rather than a `SlackEnvelope`, because the SDK genuinely hands
 * down a different shape: it splits out an inner `event` only for `events_api`
 * envelopes, and emits everything else as `{ack, body}` — verified against
 * @slack/socket-mode 3.0.0, `SocketModeClient.js:341`. Everything a click
 * carries is in `body`.
 */
export interface SlackInteractionEnvelope {
  /** Acknowledge receipt. Same three-second window a mention has. */
  ack(): Promise<void>;
  /** The interactivity payload — a `block_actions` body, or something dropped. */
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
  /**
   * Registers the ordinary-message listener. Called once, before `connect`.
   *
   * A `message` is an events_api envelope like a mention, so it arrives as a
   * `SlackEnvelope` and not as a shape of its own. A separate listener rather
   * than a widened mention one because the two subscriptions are separate on
   * the wire and the two dispatch paths share nothing: one is answered, the
   * other is recorded.
   */
  onMessage(listener: (envelope: SlackEnvelope) => Promise<void>): void;
  /**
   * Registers the interactivity listener. Called once, before `connect`.
   *
   * On this interface rather than its own, because there is one socket and one
   * `connect`/`close` lifecycle: an interaction source that could exist without
   * the mention source's connection does not exist.
   */
  onInteraction(listener: (envelope: SlackInteractionEnvelope) => Promise<void>): void;
  /** The socket dropped for a reason other than `close()`. */
  onDrop(listener: () => void): void;
}

/**
 * The outbound half. Separate from `SocketSource` because inbound and outbound
 * are different Slack APIs with different failure modes, and a test that asserts
 * on what got posted should not have to script a socket to do it.
 */
export interface MessagePoster {
  /**
   * Posts and returns nothing, and the nothing is load-bearing. A reply is
   * fire-and-forget text: no `ts` comes back, so nothing above this can hold
   * one, which is the mechanical reason the channel router never learns what a
   * Slack timestamp is. A card is the other case — see `CardPoster`.
   */
  postThreadReply(target: { channelId: string; threadTs: string; text: string }): Promise<void>;
}

/**
 * One block of a rendered card, as plain JSON.
 *
 * Structural rather than `@slack/types`' `AnyBlock`, because the renderer may
 * not import a Slack SDK — an ESLint rule keeps `@slack/*` to the three adapter
 * files. The translation to an SDK type happens once, in `web-api.ts`, which is
 * the file the rule exempts.
 */
export type SlackBlock = { type: string } & Record<string, unknown>;

/** A rendered card: everything one attachment carries. */
export interface SlackCard {
  /**
   * The attachment's left-border colour, as a design-system hex. Status, never
   * decoration — the renderer is the only thing that picks one.
   */
  color: string;
  /**
   * The state in words. The only string a client that cannot render blocks
   * shows, which on a phone is the push notification, so it has to say what
   * happened rather than name the feature.
   */
  fallback: string;
  blocks: readonly SlackBlock[];
}

/** Where a posted card is. Two ids, and nothing with a lifetime. */
export interface PostedCard {
  channelId: string;
  /** The card message's own ts. Not the thread's. */
  messageTs: string;
}

/**
 * The card half of the outbound seam.
 *
 * Separate from `MessagePoster` because a different consumer holds it: the
 * gateway posts replies and never a card, since a card's lifetime belongs to
 * whatever holds the ticket. Both are implemented by one adapter over one
 * `WebClient`, so the process keeps one rate-limit queue over `chat.*`.
 */
export interface CardPoster {
  /**
   * Posts a card into a thread and says where it landed.
   *
   * Rejects rather than returning a handle it cannot edit: a card whose `ts` is
   * unreadable can never be updated, and would sit amber forever — the exact
   * lie the feature exists to avoid.
   */
  postCard(target: { channelId: string; threadTs: string; card: SlackCard }): Promise<PostedCard>;
  /**
   * Replaces a posted card in place. Takes a whole card rather than a patch,
   * because `chat.update` replaces the message anyway — so nothing here holds
   * mutable card state between calls, and a caller cannot render a partial one.
   */
  updateCard(target: { channelId: string; messageTs: string; card: SlackCard }): Promise<void>;
}

/** What the Web API adapter and the stub both post with. Consumers take a narrower view. */
export type SlackPoster = MessagePoster & CardPoster;

/**
 * Who a Slack user id belongs to, as a name a person would recognize.
 *
 * The only read in this package — everything else here answers an event or
 * sends a message. It is here rather than above because it is a Slack API call
 * on the bot token, and this package is where that token's calls live.
 *
 * **Attribution, never authorization.** Nothing decides anything from a name:
 * the channel comes from a certificate and a ticket is spent on a channel and an
 * argument hash. A name is what makes a transcript readable, and a wrong one
 * costs a reader nothing that matters.
 */
export interface UserDirectory {
  /**
   * This user's display name, or `undefined` when there is not one to have.
   *
   * `undefined` rather than a rejection, and rather than the id, for both of the
   * ways this fails. A user who has left the workspace has no name and never
   * will, and that is an answer rather than an error. And a lookup that failed
   * — rate limited, offline, a missing `users:read` scope — must not cost a
   * caller its task: attribution is worth a round trip and not an answer, so the
   * caller substitutes what it likes and carries on.
   *
   * The caller decides what to render for `undefined`, because only it knows
   * what an unnamed author should look like in the thing it is building.
   */
  displayName(userId: string): Promise<string | undefined>;
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
  /**
   * `chat.update` failed, so a card on screen is stale.
   *
   * Its own code rather than `post_failed`, because the symptom differs: a
   * failed post means nothing appeared, and a failed update means something
   * wrong is still showing — an amber card offering buttons for a call that has
   * already been decided.
   */
  | "update_failed";

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
