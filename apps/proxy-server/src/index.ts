// The tool proxy process.
//
// Composition only: read the environment, build the server, listen, stop
// cleanly. Everything it does lives in @getlibero/proxy, where it can be
// tested without a process.

import { createJsonLogger, createProxyServer, loadTlsOptions } from "@getlibero/proxy";

/**
 * Localhost by default.
 *
 * The proxy holds every credential in the deployment and has no business on a
 * routable interface. Under compose it is set to 0.0.0.0 so the agent
 * container can reach it over the private bridge network, which publishes no
 * ports; anywhere else, binding it wider is a decision an operator has to make
 * deliberately.
 */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8443;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    // Loud, and at startup. A proxy that came up without mutual TLS would be
    // the worst available outcome: reachable, unauthenticated, and holding
    // every secret. Refusing to start is the only safe failure.
    throw new Error(`proxy: ${name} is required and was not set`);
  }
  return value;
}

function port(): number {
  const raw = process.env.PROXY_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`proxy: PROXY_PORT is not a port number: ${raw}`);
  }
  return parsed;
}

const logger = createJsonLogger();
const host = process.env.PROXY_HOST ?? DEFAULT_HOST;
const listenPort = port();

const server = createProxyServer({
  tls: loadTlsOptions({
    cert: required("PROXY_TLS_CERT"),
    key: required("PROXY_TLS_KEY"),
    ca: required("PROXY_TLS_CA")
  }),
  logger
});

server.listen(listenPort, host, () => {
  logger.log("info", { event: "listening", host, port: listenPort });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.log("info", { event: "shutting_down", reason: signal });
    // Stops accepting connections and waits for in-flight requests. Nothing
    // here is long-running yet; when tool calls land, this is what gives them
    // a chance to finish rather than being cut mid-call.
    server.close(() => process.exit(0));
  });
}
