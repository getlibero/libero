// The inbound adapter: @slack/socket-mode behind a SocketSource.
//
// One of only three files in the package allowed to import a Slack SDK, and the
// only one that holds the app token. Everything it does is translate: SDK events
// to two callbacks, SDK errors to a GatewayError with a code.

import { SocketModeClient } from "@slack/socket-mode";
import type { SocketModeOptions } from "@slack/socket-mode";
import { WebAPIPlatformError } from "@slack/web-api";
import type { Logger } from "../log.js";
import { createSdkLogger } from "./sdk-logger.js";
import { GatewayError } from "./types.js";
import type { SlackEnvelope, SocketSource } from "./types.js";

/**
 * The client's state events. The SDK's `State` enum is module-private and not
 * exported from its barrel, so these are string literals — verified against
 * @slack/socket-mode 3.0.0, and the one place to re-check on a version bump.
 */
const DISCONNECTED_EVENT = "disconnected";

/**
 * How long `close()` waits for the socket to shut down politely.
 *
 * `disconnect()` sends a close frame and resolves only once Slack sends one
 * back. Measured against a live workspace that round trip took five seconds,
 * and the SDK's own comment puts the underlying library's ceiling near thirty —
 * longer than the grace period a container gets between SIGTERM and SIGKILL. A
 * process being told to stop should not be held up by the far end's manners:
 * the socket is going away either way, and Slack drops a half-closed Socket
 * Mode connection on its own.
 */
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * Errors from `apps.connections.open` that mean Slack will never accept this
 * app token. Mirrors the SDK's own `UnrecoverableSocketModeStartError`, which it
 * uses for the same decision internally but does not surface on the error.
 */
const UNRECOVERABLE_START_ERRORS: ReadonlySet<string> = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "user_removed_from_team",
  "team_disabled"
]);

/**
 * The slice of SocketModeClient this adapter uses.
 *
 * Method syntax, not properties holding function types: `strictFunctionTypes`
 * makes property function types contravariant in their parameters, and the real
 * client would stop being assignable to this.
 */
export interface SocketModeClientLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SocketSourceOptions {
  /** The app-level token, `xapp-…`. Never logged, never in an error. */
  appToken: string;
  logger: Logger;
  /** Injected for tests. Omitted in production, where the SDK is constructed here. */
  createClient?: (appToken: string, logger: Logger) => SocketModeClientLike;
  /** Defaults to CLOSE_TIMEOUT_MS. Injected for tests. */
  closeTimeoutMs?: number;
}

/**
 * How the client is configured. Exported because the two settings below are
 * decisions rather than defaults, and a test asserting on them is cheaper than
 * a reviewer remembering why they are there.
 */
export function socketModeOptions(appToken: string, logger: Logger): SocketModeOptions {
  return {
    appToken,
    // The gateway owns reconnection. Left on, the SDK runs a second loop with a
    // linear unjittered delay derived from a ping timeout, and — verified in
    // 3.0.0 — its `delayReconnectAttempt` calls back without a rejection
    // handler, so an auth failure during a reconnect becomes an unhandled
    // rejection thrown from a timer, which no caller can catch.
    autoReconnectEnabled: false,
    logger: createSdkLogger(logger),
    clientOptions: {
      // The SDK defaults this to `{ retries: 100, factor: 1.3 }`, which suits an
      // internal reconnect loop and not ours: a transient failure would be
      // absorbed for many minutes before `start()` ever rejects, and our backoff
      // would never see it. Two retries keeps one blip from becoming a
      // reconnect, and hands anything worse straight up.
      retryConfig: { retries: 2, factor: 2 }
    }
  };
}

function defaultCreateClient(appToken: string, logger: Logger): SocketModeClientLike {
  return new SocketModeClient(socketModeOptions(appToken, logger));
}

/** Maps a failed connect to a code, and to whether waiting could fix it. */
function connectError(cause: unknown): GatewayError {
  if (cause instanceof WebAPIPlatformError && UNRECOVERABLE_START_ERRORS.has(cause.data.error)) {
    return new GatewayError("auth_rejected", false, { cause });
  }
  return new GatewayError("connect_failed", true, { cause });
}

export function createSocketModeSource(options: SocketSourceOptions): SocketSource {
  const create = options.createClient ?? defaultCreateClient;
  const client = create(options.appToken, options.logger);
  const closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;

  let onMention: ((envelope: SlackEnvelope) => Promise<void>) | undefined;
  let onDrop: (() => void) | undefined;
  /** Set by `close()`, so an intentional disconnect is not read as a drop. */
  let closing = false;

  // `app_mention` is what the SDK emits for an events_api envelope whose inner
  // event type is app_mention. Subscribing to it rather than to `slack_event`
  // means interactive and slash-command envelopes never reach the dispatch path
  // at all — the approval broker will want them, and will register its own.
  client.on("app_mention", (...args: unknown[]) => {
    const payload = args[0];
    if (typeof payload !== "object" || payload === null) return;
    const { ack, event, body } = payload as {
      ack?: unknown;
      event?: unknown;
      body?: unknown;
    };
    if (typeof ack !== "function") return;
    const envelope: SlackEnvelope = {
      ack: () => (ack as () => Promise<void>)(),
      event,
      body
    };
    // The SDK does not await this listener, so a rejection here would be
    // unhandled. The dispatcher handles its own failures; this is the backstop.
    void onMention?.(envelope).catch(() => {});
  });

  client.on(DISCONNECTED_EVENT, () => {
    if (closing) return;
    onDrop?.();
  });

  return {
    async connect(): Promise<void> {
      closing = false;
      try {
        await client.start();
      } catch (cause) {
        throw connectError(cause);
      }
    },

    async close(): Promise<void> {
      closing = true;
      // Bounded on purpose — see CLOSE_TIMEOUT_MS. The abandoned promise gets a
      // catch because nothing awaits it after the race, and an unhandled
      // rejection on the way out would take the process down with a stack
      // trace instead of an exit code.
      const disconnected = client.disconnect().catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>(resolve => {
        timer = setTimeout(resolve, closeTimeoutMs);
      });
      try {
        await Promise.race([disconnected, expired]);
      } finally {
        clearTimeout(timer);
      }
    },

    onMention(listener: (envelope: SlackEnvelope) => Promise<void>): void {
      onMention = listener;
    },

    onDrop(listener: () => void): void {
      onDrop = listener;
    }
  };
}
