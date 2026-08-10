// The gateway + agent process.
//
// The environment and the lifecycle, and nothing else: read the variables,
// build the adapters, hand them to `createServer`, connect, stop cleanly. The
// wiring those dependencies get plugged into is compose.ts, which holds no
// environment and starts nothing — so the same graph this process runs is the
// one the tests run. Everything it does lives in @getlibero/gateway and
// @getlibero/agent — and the environment rules in env.ts, the Slack mapping in
// handler.ts, the sessions and the loop under session/ — where they are
// testable without a socket, a provider, or a process.
//
// Sessions are in memory and nothing here is durable. A restart drops every
// session, which costs nothing today: a session holds a queue and a timestamp,
// and the team sheet is read from disk per task rather than cached into one.
//
// This process holds the Slack app and bot tokens and the model provider key.
// It holds no tool credential and has no way to reach a tool except one: a
// mutual-TLS call to the tool proxy service, which owns every credential and
// decides every call from the channel's team sheet.

import { createCompletionClient, createProxyTransport } from "@getlibero/agent";
import { GatewayError, createJsonLogger, createSlackSurface } from "@getlibero/gateway";
import { createServer } from "./compose.js";
import {
  channelsRootFromEnv,
  completionConfigFromEnv,
  modelFromEnv,
  proxyConfigFromEnv,
  slackTokensFromEnv
} from "./env.js";
import { createSheetResolver } from "./session/sheet.js";

const logger = createJsonLogger();

// All of it, before anything connects. A process that came up on half its
// configuration would open a socket and then fail every task at the far end of
// a thread, which is the slowest possible way to learn a variable is missing.
const { appToken, botToken } = slackTokensFromEnv(process.env);
const model = modelFromEnv(process.env);
const channelsRoot = channelsRootFromEnv(process.env);
const completion = createCompletionClient(completionConfigFromEnv(process.env));
// Reads the CA and rejects a non-https PROXY_URL here, before the socket opens.
// A per-channel client certificate is resolved on first use — one channel with
// no certificate is that channel's problem, not the process's.
const transport = createProxyTransport(proxyConfigFromEnv(process.env));

// Aborts every task in flight when the process is asked to stop. The loop
// reports `cancelled` rather than throwing, and a cancelled task posts nothing
// — and a task holding an approval settles its wait and repaints its card on
// the way out, because the prompter listens on this same signal.
const tasks = new AbortController();

const { gateway } = createServer({
  // The one thing this process supplies that a test does not: the real socket
  // and the real Web API client, built from the two tokens. `onFatal` stays
  // here with them, because what it does is exit.
  slack: ({ handler, onDecision }) =>
    createSlackSurface({
      appToken,
      botToken,
      handler,
      onDecision,
      logger,
      // The socket died for a reason retrying cannot fix — a revoked or rotated
      // token. Exiting is the honest outcome: the alternative is a process that
      // is up, healthy to every probe, and will never answer another mention.
      // Under compose, `restart: unless-stopped` picks it back up, which is what
      // makes a rotated token recover on its own once the environment is fixed.
      onFatal: error => {
        logger.log("error", { event: "gateway_dead", reason: error.reason });
        process.exit(1);
      }
    }),
  completion,
  transport,
  sheets: createSheetResolver({ root: channelsRoot, model, logger }),
  signal: tasks.signal,
  logger
});

// Rejects on credentials Slack will never accept — which is a startup failure,
// not something to retry.
//
// Caught rather than left to Node, and this is the reason: an uncaught
// rejection prints the error *and its whole cause chain*, and a GatewayError
// carries the SDK error that produced it as `cause`. That is precisely what
// `GatewayError` keeps out of its own fields — a `WebAPIHTTPError` holds
// response headers, and the Socket Mode client's requests carry a bearer
// token. The reason code is what an operator needs; the chain is what leaks.
try {
  await gateway.start();
} catch (error) {
  logger.log("error", {
    event: "startup_failed",
    reason: error instanceof GatewayError ? error.reason : "connect_failed"
  });
  process.exit(1);
}

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) {
      // A second signal is an operator done waiting. Nothing here is durable —
      // no file is open — so exiting costs at most one in-flight answer that
      // was already cancelled, and one spend report per task in flight. The
      // meter under-reports in that case rather than over-reports: the budget
      // fails open, bounded by the tasks running at that moment, and the loop's
      // own token cap and the proxy's tool-call meter are what still bite.
      // Draining in-flight work before exit is a shutdown change, not a
      // sender one — #118, which also has to decide whether a task finishing
      // during the drain gets to post.
      process.exit(1);
    }
    closing = true;
    logger.log("info", { event: "shutting_down", reason: signal });
    // Cancel first, then close the socket. The other order leaves tasks running
    // against the provider with nowhere to post: `stop()` already refuses to
    // post a reply that arrives after it, so those tokens would be spent on
    // answers nobody ever sees.
    //
    // Neither call waits for a task already in flight, so the first signal has
    // the same caveat as the second: a spend report that had not landed when
    // the process exits is lost, and the meter hears less than was spent.
    tasks.abort();
    void gateway.stop().then(() => {
      process.exit(0);
    });
  });
}
