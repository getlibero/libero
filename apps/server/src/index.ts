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
// Sessions are in memory, and one thing in them is not: since #176 a live
// session holds an open `store.db` for its channel. A restart drops every
// session and reopens the files on demand, which costs nothing — the store is
// the durable thing and the session is only a handle to it, the team sheet is
// read from disk per task rather than cached into one, and a queue that was
// drained by the abort below has nothing left to lose.
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
  slackTokensFromEnv,
  storeRootFromEnv
} from "./env.js";
import { createMemoryFileOpener } from "./session/memory.js";
import { createSheetResolver } from "./session/sheet.js";
import { createMessageStoreOpener } from "./session/store.js";

const logger = createJsonLogger();

// All of it, before anything connects. A process that came up on half its
// configuration would open a socket and then fail every task at the far end of
// a thread, which is the slowest possible way to learn a variable is missing.
const { appToken, botToken } = slackTokensFromEnv(process.env);
const model = modelFromEnv(process.env);
const channelsRoot = channelsRootFromEnv(process.env);
// A different root from the sheets, on purpose: this one is written to, and the
// sheets directory is the tool proxy's authorization source. See env.ts.
const storeRoot = storeRootFromEnv(process.env);
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
  slack: ({ handler, onDecision, onMessage, onRevision }) =>
    // `createSlackSurface` returns `users` alongside `gateway` and `cards`, and
    // the whole object is what `SlackSurfaceLike` reads — so the directory is
    // wired by returning it rather than by naming it here.
    createSlackSurface({
      appToken,
      botToken,
      handler,
      onDecision,
      onMessage,
      onRevision,
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
  store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
  memory: createMemoryFileOpener({ storeRoot, channelsRoot, logger }),
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

/**
 * How long shutdown waits for cancelled tasks to finish unwinding (#118).
 *
 * A constant rather than a variable, because the number is a property of this
 * shutdown path and not of a deployment: it is sized from the two things a
 * cancelled task still does on its way out, both of which carry their own
 * deadlines. `DEFAULT_SPEND_TIMEOUT_MS` is five seconds, and the checklist's
 * terminal edit is one Slack call. Eight seconds covers both without waiting
 * on a rate-limited retry nobody is reading the answer of.
 *
 * **It is not how long a task can take.** A task's own bound is the channel's
 * `max_task_seconds`, five minutes by default, and no drain worth having is
 * that long — `deploy/docker-compose.yml` sets `stop_grace_period: 20s` and
 * SIGKILL follows it. This waits out the accounting, not the work; what a
 * mid-turn task loses is its answer, which it lost before this too.
 */
const SHUTDOWN_DRAIN_MS = 8_000;

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) {
      // A second signal is an operator done waiting, and it cuts the drain
      // below short. Exiting with a session's `store.db` still open is safe
      // rather than merely tolerable: the store runs in WAL with
      // `synchronous = FULL`, so a committed row survives a hard kill and an
      // uncommitted one was one synchronous statement that either ran or did
      // not. Nothing is buffered waiting for a `close()`.
      //
      // What it costs is what the drain was about to save: the spend report of
      // whatever turn each in-flight task was reporting, and a checklist card
      // left reading `WORKING`. The meter under-reports in that case rather
      // than over-reports — the budget fails open, bounded by the tasks running
      // at that moment, and the loop's own token cap and the proxy's tool-call
      // meter are what still bite.
      process.exit(1);
    }
    closing = true;
    logger.log("info", { event: "shutting_down", reason: signal });
    // Cancel first, then close the socket. The other order leaves tasks running
    // against the provider with nowhere to post: `stop()` already refuses to
    // post a reply that arrives after it, so those tokens would be spent on
    // answers nobody ever sees.
    //
    // Then wait for what the cancel started (#118). A cancelled task still
    // unwinds — the turn it had already completed is reported to the meter, and
    // its checklist card is repainted terminal — and both of those were being
    // killed by the `process.exit` below. The drain is bounded because the
    // alternative is not "wait longer", it is SIGKILL from the orchestrator.
    //
    // **Shutdown is still quiet.** Nothing here lets a task post an answer: the
    // gateway refuses to post once stopped, and a cancelled task has no reply
    // to post anyway. What drains is the accounting, and a task that was
    // mid-turn loses its answer exactly as it did before.
    tasks.abort();
    void gateway.stop({ drainMs: SHUTDOWN_DRAIN_MS }).then(() => {
      process.exit(0);
    });
  });
}
