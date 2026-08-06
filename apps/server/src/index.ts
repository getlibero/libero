// The gateway + agent process.
//
// Composition only: read the environment, build the completion client and the
// handler, connect, stop cleanly. Everything it does lives in
// @getlibero/gateway and @getlibero/agent — and the environment rules in
// env.ts, the Slack mapping in handler.ts, the sessions and the loop under
// session/ — where they are testable without a socket, a provider, or a
// process.
//
// Sessions are in memory and nothing here is durable. A restart drops every
// session, which costs nothing today: a session holds a queue and a timestamp,
// and the team sheet is read from disk per task rather than cached into one.
//
// This process holds the Slack app and bot tokens and the model provider key.
// It holds no tool credential and has no way to reach a tool except one: a
// mutual-TLS call to the tool proxy service, which owns every credential and
// decides every call from the channel's team sheet.

import {
  createCompletionClient,
  createProxyApprovalsClient,
  createProxyTransport
} from "@getlibero/agent";
import { GatewayError, createJsonLogger, createSlackSurface } from "@getlibero/gateway";
import { createDecisionHandler } from "./approvals/decisions.js";
import { createHeldCallPrompter } from "./approvals/prompter.js";
import { createApprovalRegistry } from "./approvals/registry.js";
import {
  channelsRootFromEnv,
  completionConfigFromEnv,
  modelFromEnv,
  proxyConfigFromEnv,
  slackTokensFromEnv
} from "./env.js";
import { createMentionHandler } from "./handler.js";
import { createChannelRouter } from "./session/router.js";
import { createSheetResolver } from "./session/sheet.js";
import { createTaskRunner } from "./session/task.js";

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

// The approval broker's client side: one registry of waits at process scope,
// one decisions client over the same transport every tool call takes. The
// channel a decision is relayed on comes from the waiting entry, which got it
// from the mention's certificate-backed session — never from the click.
const registry = createApprovalRegistry();
const approvals = createProxyApprovalsClient({ transport });

const surface = createSlackSurface({
  appToken,
  botToken,
  // The prompter needs the surface's card poster and the surface needs the
  // handler, so the handler closes over a binding assigned just below. Safe:
  // nothing dispatches a mention before `start()`, and `handleMention` exists
  // the moment this module finishes evaluating.
  handler: mention => handleMention(mention),
  // A click becomes a settled wait by way of the proxy — see
  // approvals/decisions.ts for the ordering and what each answer means.
  onDecision: createDecisionHandler({ registry, approvals, logger }),
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
const gateway = surface.gateway;

// Slack in, request out, and everything below that mapping is transport
// neutral: the router serializes per channel, the resolver reads that
// channel's sheet, the runner runs one task on what the sheet said. The
// prompter factory rides the same seam the reply does — the mention's channel
// and thread are captured in handler.ts, and the router sees a closure.
const handleMention = createMentionHandler(
  createChannelRouter({
    sheets: createSheetResolver({ root: channelsRoot, model, logger }),
    task: createTaskRunner({ completion, transport, signal: tasks.signal, logger }),
    logger
  }),
  createHeldCallPrompter({ cards: surface.cards, registry, logger })
);

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
