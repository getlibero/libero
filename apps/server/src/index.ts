// The gateway + agent process.
//
// Composition only: read the environment, build the completion client and the
// handler, connect, stop cleanly. Everything it does lives in
// @getlibero/gateway and @getlibero/agent — and the environment rules in
// env.ts, the reply mapping in handler.ts — where they are testable without a
// socket, a provider, or a process.
//
// This process holds the Slack app and bot tokens and the model provider key.
// It holds no tool credential and has no way to reach a tool: the only path is
// a network call to the tool proxy service, which is not wired yet — the agent
// runs with a stub tool source that lists nothing.

import { createCompletionClient } from "@getlibero/agent";
import { GatewayError, createJsonLogger, createSlackGateway } from "@getlibero/gateway";
import { completionConfigFromEnv, modelFromEnv, slackTokensFromEnv } from "./env.js";
import { createMentionHandler } from "./handler.js";

const logger = createJsonLogger();

// All of it, before anything connects. A process that came up on half its
// configuration would open a socket and then fail every task at the far end of
// a thread, which is the slowest possible way to learn a variable is missing.
const { appToken, botToken } = slackTokensFromEnv(process.env);
const model = modelFromEnv(process.env);
const completion = createCompletionClient(completionConfigFromEnv(process.env));

// Aborts every task in flight when the process is asked to stop. The loop
// reports `cancelled` rather than throwing, and a cancelled task posts nothing.
const tasks = new AbortController();

const gateway = createSlackGateway({
  appToken,
  botToken,
  handler: createMentionHandler({ completion, model, signal: tasks.signal, logger }),
  logger,
  // The socket died for a reason retrying cannot fix — a revoked or rotated
  // token. Exiting is the honest outcome: the alternative is a process that is
  // up, healthy to every probe, and will never answer another mention. Under
  // compose, `restart: unless-stopped` picks it back up, which is what makes a
  // rotated token recover on its own once the environment is fixed.
  onFatal: error => {
    logger.log("error", { event: "gateway_dead", reason: error.reason });
    process.exit(1);
  }
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
      // A second signal is an operator done waiting. Nothing here is
      // durable — no file is open and no counter is owed a write — so exiting
      // costs at most one in-flight answer that was already cancelled.
      process.exit(1);
    }
    closing = true;
    logger.log("info", { event: "shutting_down", reason: signal });
    // Cancel first, then close the socket. The other order leaves tasks running
    // against the provider with nowhere to post: `stop()` already refuses to
    // post a reply that arrives after it, so those tokens would be spent on
    // answers nobody ever sees.
    tasks.abort();
    void gateway.stop().then(() => {
      process.exit(0);
    });
  });
}
