// Building the real thing: two tokens, two adapters, one gateway.
//
// The tokens arrive as arguments. This package reads no `process.env` — the
// composing app parses and validates the environment, the way
// `apps/proxy-server/src/env.ts` does, so the rules are unit-testable without a
// process and the library has no opinion about where a token came from.

import { createJsonLogger } from "../log.js";
import type { Logger } from "../log.js";
import type { BackoffPolicy } from "./backoff.js";
import { createGateway } from "./gateway.js";
import type { Scheduler } from "./gateway.js";
import { createSocketModeSource } from "./socket-mode.js";
import type {
  CardPoster,
  DecisionHandler,
  GatewayError,
  MentionHandler,
  MessageHandler,
  SlackGateway,
  UserDirectory
} from "./types.js";
import { createWebApiSurface } from "./web-api.js";

export interface SlackGatewayConfig {
  /** App-level token, `xapp-…`. Opens the socket; cannot post. */
  appToken: string;
  /** Bot token, `xoxb-…`. Posts and reads history; cannot open the socket. */
  botToken: string;
  handler: MentionHandler;
  /** A human clicked an approval card. See `GatewayOptions.onDecision`. */
  onDecision?: DecisionHandler;
  /** An ordinary message arrived. See `GatewayOptions.onMessage`. */
  onMessage?: MessageHandler;
  /** Defaults to JSON lines on stdout. */
  logger?: Logger;
  backoff?: BackoffPolicy;
  /**
   * The socket died after `start()` resolved and retrying will not bring it
   * back. See `GatewayOptions.onFatal` — the composing app decides what a dead
   * gateway does to the process.
   */
  onFatal?: (error: GatewayError) => void;
  /** Injected for tests. Omitted in production. */
  scheduler?: Scheduler;
}

/**
 * Everything a composing app needs from Slack: the lifecycle, and the cards.
 *
 * The two come from one call because they must share one `WebClient`. The
 * client handles rate limits per instance, so a second one built on the same
 * bot token would give the process two independent queues over `chat.*` and
 * neither would know what the other had spent.
 */
export interface SlackSurface {
  gateway: SlackGateway;
  /**
   * Narrowed to the card verbs, deliberately: not `SlackPoster`.
   *
   * A composing app that could reach `postThreadReply` here could post a reply
   * out of band, and then "a handler still running when the gateway stopped
   * does not get to post" would stop being a property of the dispatcher and
   * become a habit of every caller. Cards are the exception because a card's
   * lifetime genuinely outlives the handler that raised it.
   */
  cards: CardPoster;
  /**
   * Who a user id is, on the same client as the two posters.
   *
   * Here rather than reachable from the gateway because nothing in the dispatch
   * path needs a name — the adapter answers a mention and posts a reply, and
   * resolving an author is what the layer assembling a transcript does. Sharing
   * the client is the whole reason it comes out of this one call: a second
   * `WebClient` on the same bot token would give the process two rate-limit
   * queues over one API.
   */
  users: UserDirectory;
}

export function createSlackSurface(config: SlackGatewayConfig): SlackSurface {
  const logger = config.logger ?? createJsonLogger();
  const { poster, users, identity } = createWebApiSurface({ botToken: config.botToken, logger });
  const gateway = createGateway({
    source: createSocketModeSource({ appToken: config.appToken, logger }),
    poster,
    handler: config.handler,
    // Not optional in the real thing. Without it every message carrying a
    // mention token is treated as addressing the app, which turns a channel's
    // follow-ups off — see `mentionsApp` in message.ts.
    identity,
    logger,
    // Spread conditionally: `exactOptionalPropertyTypes` rejects an explicit
    // `undefined` for an optional property.
    ...(config.onDecision !== undefined ? { onDecision: config.onDecision } : {}),
    ...(config.onMessage !== undefined ? { onMessage: config.onMessage } : {}),
    ...(config.backoff !== undefined ? { backoff: config.backoff } : {}),
    ...(config.onFatal !== undefined ? { onFatal: config.onFatal } : {}),
    ...(config.scheduler !== undefined ? { scheduler: config.scheduler } : {})
  });
  return { gateway, cards: poster, users };
}

/** The gateway alone, for a process that renders no cards. */
export function createSlackGateway(config: SlackGatewayConfig): SlackGateway {
  return createSlackSurface(config).gateway;
}
