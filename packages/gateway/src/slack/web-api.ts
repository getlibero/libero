// The outbound adapter: @slack/web-api behind a MessagePoster.
//
// Separate from the inbound adapter because it holds the other token. The bot
// token (`xoxb-`) posts and reads history; the app token (`xapp-`) opens the
// socket and can do neither. Keeping them on two objects means neither adapter
// is a place both are reachable from.

import type { MessageAttachment } from "@slack/types";
import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import type { Logger } from "../log.js";
import { createSdkLogger } from "./sdk-logger.js";
import { GatewayError } from "./types.js";
import type { PostedCard, SlackCard, SlackPoster } from "./types.js";

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

/** The `ts` of the message Slack says it posted, if it said. */
function readTs(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const ts = (response as { ts?: unknown }).ts;
  return typeof ts === "string" && ts.length > 0 ? ts : undefined;
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

export interface MessagePosterOptions {
  /** The bot token, `xoxb-…`. Never logged, never in an error. */
  botToken: string;
  logger: Logger;
  /** Injected for tests. Omitted in production. */
  createClient?: (botToken: string, logger: Logger) => WebClientLike;
}

function defaultCreateClient(botToken: string, logger: Logger): WebClientLike {
  return new WebClient(botToken, { logger: createSdkLogger(logger) });
}

export function createWebApiPoster(options: MessagePosterOptions): SlackPoster {
  const create = options.createClient ?? defaultCreateClient;
  const client = create(options.botToken, options.logger);

  return {
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
}
