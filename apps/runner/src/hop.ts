// The hop process (#219): `node dist/hop.js`.
//
// A second entrypoint on the runner's image, the way apps/proxy-server carries
// `vault`, `audit`, `grant` and `tasks` — so the deployment has three images
// rather than four and this one inherits the image assertions the other
// entrypoint already passes. Named to match that convention: the entrypoint is
// `hop.ts` and the thing it composes is `hop-server.ts`, exactly as `vault.ts`
// composes `vault-cli.ts`.
//
// Composition only. One container of these exists per sandbox run, started and
// destroyed by the runner, on a network whose only other member is the sandbox
// it serves. It holds no credential and never had one to hold: its whole
// configuration is a port and a list of host patterns.

import { createHop, DENIED_EVENT, HOP_LISTENING_EVENT } from "./hop-server.js";
import { hopAllowFromEnv, hopPortFromEnv } from "./env.js";

const allow = hopAllowFromEnv(process.env);
const port = hopPortFromEnv(process.env);

const server = createHop({
  allow,
  onDenied: host => {
    // The one line the runner is watching for on this container's log stream.
    // Written before anything else happens so the kill is as prompt as the
    // daemon's log pipe allows.
    process.stdout.write(`${JSON.stringify({ event: DENIED_EVENT, host })}\n`);
  }
});

// 0.0.0.0 rather than a named interface: the network this sits on has no route
// anywhere except the sandbox that shares it, so there is nothing else that
// could reach the port.
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ event: HOP_LISTENING_EVENT, port, allow: allow.length })}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
