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
import type { GatewayError, MentionHandler, SlackGateway } from "./types.js";
import { createWebApiPoster } from "./web-api.js";

export interface SlackGatewayConfig {
  /** App-level token, `xapp-…`. Opens the socket; cannot post. */
  appToken: string;
  /** Bot token, `xoxb-…`. Posts and reads history; cannot open the socket. */
  botToken: string;
  handler: MentionHandler;
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

export function createSlackGateway(config: SlackGatewayConfig): SlackGateway {
  const logger = config.logger ?? createJsonLogger();
  return createGateway({
    source: createSocketModeSource({ appToken: config.appToken, logger }),
    poster: createWebApiPoster({ botToken: config.botToken, logger }),
    handler: config.handler,
    logger,
    // Spread conditionally: `exactOptionalPropertyTypes` rejects an explicit
    // `undefined` for an optional property.
    ...(config.backoff !== undefined ? { backoff: config.backoff } : {}),
    ...(config.onFatal !== undefined ? { onFatal: config.onFatal } : {}),
    ...(config.scheduler !== undefined ? { scheduler: config.scheduler } : {})
  });
}
