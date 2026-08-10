// The Web API adapter: @slack/web-api behind a MessagePoster, a CardPoster, and
// a UserDirectory.
//
// Separate from the inbound adapter because it holds the other token. The bot
// token (`xoxb-`) posts and reads history and the directory; the app token
// (`xapp-`) opens the socket and can do none of it. Keeping them on two objects
// means neither adapter is a place both are reachable from.
//
// **One `WebClient` for all three verbs.** The client handles rate limits per
// instance, so a second one built on the same bot token would give the process
// two independent queues over Slack's API and neither would know what the other
// had spent. That argument already governed `chat.postMessage` and
// `chat.update`; `users.info` joins them for the same reason, and it is why the
// directory is built here rather than in a module of its own — which would also
// have needed a fourth entry in eslint.config.mjs's deliberately enumerated
// list of files allowed to import a Slack SDK.

import type { MessageAttachment } from "@slack/types";
import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import type { Logger } from "../log.js";
import { createSdkLogger } from "./sdk-logger.js";
import { GatewayError } from "./types.js";
import type { AppIdentity, PostedCard, SlackCard, SlackPoster, UserDirectory } from "./types.js";

/**
 * The three call shapes this adapter makes, spelled out separately.
 *
 * Not one shape with optional `text` and `attachments`:
 * `ChatPostMessageArguments` is a union requiring exactly one of
 * text/blocks/attachments, and a shape where both are optional satisfies no
 * member of it. The same reason the calls below are written as literals rather
 * than spreads — this is that constraint moved up into the type.
 */
interface TextMessage {
  channel: string;
  thread_ts: string;
  text: string;
}

interface CardMessage extends TextMessage {
  attachments: MessageAttachment[];
}

interface CardUpdate {
  channel: string;
  ts: string;
  text: string;
  attachments: MessageAttachment[];
}

/** The slice of WebClient this adapter uses. Method syntax — see socket-mode.ts. */
export interface WebClientLike {
  chat: {
    postMessage(args: TextMessage | CardMessage): Promise<unknown>;
    update(args: CardUpdate): Promise<unknown>;
  };
  users: {
    info(args: { user: string }): Promise<unknown>;
  };
  auth: {
    test(): Promise<unknown>;
  };
}

/**
 * The one place a rendered card becomes an SDK type.
 *
 * `SlackCard.blocks` is structural on purpose — the renderer may not import
 * `@slack/types`, so it emits plain objects rather than `AnyBlock`s, and the
 * two are not assignable. The cast is that translation, and it lives here
 * because this is the adapter: an SDK type change is then a compile error in
 * one file, which is the entire point of confining the SDK to three of them.
 *
 * Nothing is validated on the way through. Slack rejects a malformed block with
 * an error code, and `slackError` already carries it.
 */
function attachmentOf(card: SlackCard): MessageAttachment {
  return {
    color: card.color,
    fallback: card.fallback,
    blocks: card.blocks as unknown as NonNullable<MessageAttachment["blocks"]>
  };
}

/**
 * The Slack errors that mean these credentials will never work.
 *
 * Separated from everything else `auth.test` can fail with, because the two
 * deserve opposite treatment: a revoked token is not something retrying fixes
 * and should stop the process, and a rate limit or a network blip is exactly
 * what the reconnect ladder exists for.
 */
const FATAL_AUTH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired"
]);

/** The `ts` of the message Slack says it posted, if it said. */
function readTs(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const ts = (response as { ts?: unknown }).ts;
  return typeof ts === "string" && ts.length > 0 ? ts : undefined;
}

/** The app's own user id from an `auth.test` response, if it said. */
function readUserId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  // `user_id` and not `bot_id`. What appears inside a `<@…>` token in a message
  // is the bot's *user* id; `bot_id` is a different identifier that never does.
  const userId = (response as { user_id?: unknown }).user_id;
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

/**
 * The name to show for a `users.info` response, read defensively.
 *
 * Three fields, in the order a person would pick them. `display_name` is what
 * the user chose to be called and is empty for anyone who never set one, which
 * is why it cannot be read alone; `real_name` is the fallback Slack's own
 * clients use; `name` is the legacy handle and is always present. The first
 * non-empty one wins.
 *
 * `profile.display_name` and not `user.name` first, because a channel calls
 * people what they call themselves — a transcript reading `@jsmith` where the
 * thread says `@Jamie` is a transcript the model cannot match to the
 * conversation.
 */
function readDisplayName(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const user = (response as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return undefined;
  const profile = (user as { profile?: unknown }).profile;
  const fromProfile =
    typeof profile === "object" && profile !== null
      ? (profile as { display_name?: unknown; real_name?: unknown })
      : {};

  for (const candidate of [
    fromProfile.display_name,
    fromProfile.real_name,
    (user as { real_name?: unknown }).real_name,
    (user as { name?: unknown }).name
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Slack's own error code from a failed call, when there was one.
 *
 * Never the SDK's message: `WebAPIHTTPError` carries response headers, and this
 * process holds the app and bot tokens.
 */
function slackErrorOf(cause: unknown): string | undefined {
  return cause instanceof WebAPIPlatformError ? cause.data.error : undefined;
}

/** One mapping for every `chat.*` failure. See the note in `postThreadReply`. */
function chatError(
  reason: "post_failed" | "update_failed",
  cause: unknown
): GatewayError {
  return cause instanceof WebAPIPlatformError
    ? new GatewayError(reason, false, { cause, slackError: cause.data.error })
    : new GatewayError(reason, false, { cause });
}

export interface WebApiOptions {
  /** The bot token, `xoxb-…`. Never logged, never in an error. */
  botToken: string;
  logger: Logger;
  /** Injected for tests. Omitted in production. */
  createClient?: (botToken: string, logger: Logger) => WebClientLike;
}

/** The halves this adapter is, kept apart because their consumers are. */
export interface WebApiSurface {
  poster: SlackPoster;
  users: UserDirectory;
  identity: AppIdentity;
}

function defaultCreateClient(botToken: string, logger: Logger): WebClientLike {
  return new WebClient(botToken, { logger: createSdkLogger(logger) }) as WebClientLike;
}

/**
 * Builds both halves over one client.
 *
 * Two named members rather than one object implementing everything, because the
 * consumers are genuinely different: the gateway takes a `MessagePoster` and
 * must not be able to reach a card or a directory, and the composing app takes
 * the other two and must not be able to post a reply out of band. One returned
 * object with every method on it would make each of those a habit rather than a
 * type.
 */
export function createWebApiSurface(options: WebApiOptions): WebApiSurface {
  const create = options.createClient ?? defaultCreateClient;
  const client = create(options.botToken, options.logger);
  const logger = options.logger;

  const poster: SlackPoster = {
    async postThreadReply(target): Promise<void> {
      try {
        // Built as a literal rather than spread: ChatPostMessageArguments is a
        // union requiring exactly one of text/blocks/attachments, and spreading
        // conditionals into it defeats the narrowing.
        await client.chat.postMessage({
          channel: target.channelId,
          thread_ts: target.threadTs,
          text: target.text
        });
      } catch (cause) {
        // Not retryable here, and not by the caller either. The WebClient
        // already retries transport failures and honours rate limits
        // internally, so anything that reaches us is a decision Slack made —
        // `not_in_channel`, `channel_not_found`, `msg_too_long` — and posting
        // again would either fail identically or post twice.
        throw chatError("post_failed", cause);
      }
    },

    async postCard(target): Promise<PostedCard> {
      let response: unknown;
      try {
        response = await client.chat.postMessage({
          channel: target.channelId,
          thread_ts: target.threadTs,
          // The card's own words, again, at the top level. Slack shows this
          // rather than the blocks wherever it cannot render them — a push
          // notification, most of the time — and the attachment's `fallback`
          // does not reach that far.
          text: target.card.fallback,
          attachments: [attachmentOf(target.card)]
        });
      } catch (cause) {
        throw chatError("post_failed", cause);
      }

      // A card whose ts we could not read is a card nothing can ever update: it
      // would sit amber forever, which is the exact lie this feature exists to
      // avoid. Fail here, where the caller still has somewhere to say so,
      // rather than hand back a handle that silently no-ops at the first edit.
      const messageTs = readTs(response);
      if (messageTs === undefined) {
        throw new GatewayError("post_failed", false, { slackError: "no_message_ts" });
      }
      return { channelId: target.channelId, messageTs };
    },

    async updateCard(target): Promise<void> {
      try {
        await client.chat.update({
          channel: target.channelId,
          ts: target.messageTs,
          text: target.card.fallback,
          attachments: [attachmentOf(target.card)]
        });
      } catch (cause) {
        throw chatError("update_failed", cause);
      }
    }
  };

  const users: UserDirectory = {
    async displayName(userId): Promise<string | undefined> {
      let response: unknown;
      try {
        response = await client.users.info({ user: userId });
      } catch (cause) {
        const slackError = slackErrorOf(cause);

        // Not an error, and deliberately not logged. `users.info` answers
        // `user_not_found` for a deleted account and for one this app cannot
        // see, and a channel with a departed member would otherwise emit a line
        // per task forever saying something nobody can act on.
        if (slackError === "user_not_found") return undefined;

        // Everything else is worth a line, because there is something to do
        // about it. `missing_scope` is the first-run one: the app was installed
        // without `users:read`, and the symptom without this line is a
        // transcript full of raw ids and no explanation.
        logger.log("warn", {
          event: "user_lookup_failed",
          user: userId,
          ...(slackError !== undefined ? { slackError } : {})
        });
        return undefined;
      }
      return readDisplayName(response);
    }
  };

  const identity: AppIdentity = {
    async userId(): Promise<string> {
      let response: unknown;
      try {
        response = await client.auth.test();
      } catch (cause) {
        const slackError = slackErrorOf(cause);
        const fatal = slackError !== undefined && FATAL_AUTH_ERRORS.has(slackError);

        // Two different failures wearing one call. A revoked token is
        // `auth_rejected` and stops the process; anything else — a rate limit,
        // a network blip, Slack having a bad minute — is `connect_failed` and
        // goes round the reconnect ladder with everything else that could not
        // come up.
        throw new GatewayError(fatal ? "auth_rejected" : "connect_failed", !fatal, {
          cause,
          ...(slackError !== undefined ? { slackError } : {})
        });
      }

      const userId = readUserId(response);
      if (userId === undefined) {
        // Slack answered without saying who we are. Not retryable: the call
        // succeeded and this is the shape it returned, so asking again gets the
        // same answer. Failing here rather than carrying on unidentified,
        // because the fallback for an unknown id costs a channel its follow-ups
        // and it should not be silent.
        throw new GatewayError("auth_rejected", false, { slackError: "no_user_id" });
      }
      return userId;
    }
  };

  return { poster, users, identity };
}
