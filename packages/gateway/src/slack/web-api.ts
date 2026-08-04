// The outbound adapter: @slack/web-api behind a MessagePoster.
//
// Separate from the inbound adapter because it holds the other token. The bot
// token (`xoxb-`) posts and reads history; the app token (`xapp-`) opens the
// socket and can do neither. Keeping them on two objects means neither adapter
// is a place both are reachable from.

import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import type { Logger } from "../log.js";
import { createSdkLogger } from "./sdk-logger.js";
import { GatewayError } from "./types.js";
import type { MessagePoster } from "./types.js";

/** The slice of WebClient this adapter uses. Method syntax — see socket-mode.ts. */
export interface WebClientLike {
  chat: {
    postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<unknown>;
  };
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

export function createWebApiPoster(options: MessagePosterOptions): MessagePoster {
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
        throw cause instanceof WebAPIPlatformError
          ? new GatewayError("post_failed", false, { cause, slackError: cause.data.error })
          : new GatewayError("post_failed", false, { cause });
      }
    }
  };
}
