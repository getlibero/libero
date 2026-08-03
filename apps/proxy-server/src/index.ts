// The tool proxy process.
//
// Composition only: read the environment, build the server, listen, stop
// cleanly. Everything it does lives in @getlibero/proxy — and the environment
// rules in env.ts — where they can be tested without a process.

import {
  TeamSheetStore,
  createJsonLogger,
  createProxyServer,
  createUnavailableDispatcher,
  createUnmeteredSpend,
  loadTlsOptions
} from "@getlibero/proxy";
import { channelsRootFromEnv, hostFromEnv, portFromEnv, requiredEnv } from "./env.js";

const logger = createJsonLogger();
const host = hostFromEnv(process.env);
const listenPort = portFromEnv(process.env);
const sheets = new TeamSheetStore({ root: channelsRootFromEnv(process.env), logger });

const server = createProxyServer({
  tls: loadTlsOptions({
    cert: requiredEnv(process.env, "PROXY_TLS_CERT"),
    key: requiredEnv(process.env, "PROXY_TLS_KEY"),
    ca: requiredEnv(process.env, "PROXY_TLS_CA")
  }),
  sheets,
  // Both provisional, and both named so they read that way. Enforcement is
  // real; what happens after an `allow` is not built. Replacing the dispatcher
  // without also replacing the meter is a startup error rather than a silently
  // unmetered proxy — see `assertServableComposition` in @getlibero/proxy.
  spend: createUnmeteredSpend(),
  dispatcher: createUnavailableDispatcher(),
  logger
});

server.listen(listenPort, host, () => {
  logger.log("info", { event: "listening", host, port: listenPort });
});

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) {
      // A second signal is an operator done waiting. Without this, one hung
      // keep-alive socket holds the process open until something sends
      // SIGKILL.
      process.exit(1);
    }
    closing = true;
    logger.log("info", { event: "shutting_down", reason: signal });
    // Releases the per-channel file watchers; without it the process can stay
    // alive on them after the listener has closed.
    sheets.close();
    // Stops accepting connections and waits for in-flight requests. Nothing
    // here is long-running yet; when tool calls land, this is what gives them
    // a chance to finish rather than being cut mid-call.
    server.close(() => process.exit(0));
  });
}
