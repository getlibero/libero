// A @slack/logger implementation that throws every message away.
//
// This is not laziness. Left to its own logger the Socket Mode client
// interpolates the entire raw WebSocket frame into a debug line — every message
// in every channel the app is in — and the WebClient it builds carries
// `Authorization: Bearer <app token>`, so an SDK error string is a place a token
// can appear. Both would land on our stdout as free-form text, which is exactly
// what `../log.ts` exists to make impossible.
//
// So the vendor logger is a sink. What survives is the fact that the SDK said
// something at warn or error, as a single `slack_sdk` event with a level and no
// payload. That is enough to correlate with the gateway's own lines and no more.
// Diagnosing an SDK-internal problem means reproducing it with the SDK's own
// ConsoleLogger, deliberately, outside a process holding real tokens.

import type { Logger as SlackSdkLogger } from "@slack/logger";
import { LogLevel as SlackLogLevel } from "@slack/logger";
import type { Logger } from "../log.js";

/**
 * Every method takes no parameters. The interface declares `...msg: any[]`, and
 * a function of fewer parameters is assignable to one of more — so this both
 * satisfies the SDK and makes it structurally impossible for a later edit to
 * start reading what it was handed.
 */
export function createSdkLogger(logger: Logger): SlackSdkLogger {
  return {
    debug(): void {},
    info(): void {},
    warn(): void {
      logger.log("warn", { event: "slack_sdk" });
    },
    error(): void {
      logger.log("error", { event: "slack_sdk" });
    },
    setLevel(): void {},
    // INFO, not DEBUG: the level gates whether the SDK builds those payload
    // strings at all, and there is no reason to pay for strings we discard.
    getLevel(): SlackLogLevel {
      return SlackLogLevel.INFO;
    },
    setName(): void {}
  };
}
