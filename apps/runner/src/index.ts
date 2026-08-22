// The sandbox runner process (#395).
//
// Composition only: read the environment, prove the daemon is reachable, build
// the server, listen, stop cleanly. Everything it does lives in the modules
// beside it, where it can be tested without a process.
//
// It holds no credential. There is no vault here, no token store, no team sheet,
// and no channel store — and the list of what this process does not mount is in
// deploy/README.md, because that is where an operator can check it.

import { randomUUID } from "node:crypto";
import { createDockerClient } from "./docker.js";
import { createRunnerServer } from "./server.js";
import { runInSandbox } from "./run.js";
import {
  clientPinFromEnv,
  dockerSocketFromEnv,
  hostFromEnv,
  portFromEnv,
  requiredEnv,
  sandboxCommandFromEnv,
  sandboxImageFromEnv,
  sandboxCeilingFromEnv,
  ceilingIsEmpty,
  egressNetworkFromEnv,
  runnerImageFromEnv,
  DEFAULT_HOP_PORT
} from "./env.js";
import { loadRunnerTls } from "./tls.js";

const logger = {
  log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
    process.stdout.write(`${JSON.stringify({ level, service: "runner", ...fields })}\n`);
  }
};

const env = process.env;
const host = hostFromEnv(env);
const listenPort = portFromEnv(env);

// The hop's image is this process's own (#219). There is no second image to pin
// because it is the same code with a different entrypoint — if it were
// substituted, the runner would already be substituted.
const egressNetwork = egressNetworkFromEnv(env);
const ceiling = sandboxCeilingFromEnv(env);
const config = {
  image: sandboxImageFromEnv(env),
  command: sandboxCommandFromEnv(env),
  ceiling,
  ...(egressNetwork === undefined
    ? {}
    : {
        egress: {
          image: runnerImageFromEnv(env),
          command: ["node", "dist/hop.js"],
          network: egressNetwork,
          port: DEFAULT_HOP_PORT
        }
      })
};
const docker = createDockerClient({ socketPath: dockerSocketFromEnv(env) });

const server = createRunnerServer({
  tls: loadRunnerTls({
    cert: requiredEnv(env, "RUNNER_TLS_CERT"),
    key: requiredEnv(env, "RUNNER_TLS_KEY"),
    ca: requiredEnv(env, "RUNNER_TLS_CA")
  }),
  clientPin: clientPinFromEnv(env),
  logger,
  run: request =>
    runInSandbox(request, {
      docker,
      config,
      // A container that outlived its run is holding a tmpfs. Nothing here can
      // fix it, and an operator who can needs to be told.
      onRemoveFailed: reason => logger.log("error", { event: "container_remove_failed", reason }),
      // A sheet granted hosts and this deployment cannot enforce the grant, so
      // the run got no network. Loud, because the operator's channel is asking
      // for something their deployment has not turned on.
      onEgressUnavailable: () => logger.log("warn", { event: "egress_unavailable" }),
      // A sheet asked for more machine than this deployment allows, so the run
      // was sized down (#405). Both numbers, because "clamped" without them
      // tells an operator that something happened and not what to change.
      onCapsClamped: (asked, applied) =>
        logger.log("warn", { event: "caps_clamped", asked, applied }),
      newRunId: () => randomUUID()
    })
});

// Said at boot rather than left to be inferred from a run that came back small.
// An absent ceiling is the supported deployment and is today's behaviour, so
// this is the only place an operator can see that nothing bounds what their
// sheets ask for — which is the thing that makes "absent means no ceiling" a
// decision rather than a silence.
logger.log(ceilingIsEmpty(ceiling) ? "warn" : "info", {
  event: "sandbox_ceiling",
  ...(ceilingIsEmpty(ceiling) ? { ceiling: "none" } : { ceiling })
});

// Before anything binds. A socket that is not there, or a group this process is
// not in, is the single most likely deployment mistake — `group_add` with the
// host's docker gid differs between distributions — and it should be a failure
// at `docker compose up` rather than at the far end of a Slack thread.
await docker.ping().catch((error: Error) => {
  logger.log("error", { event: "docker_unreachable", reason: error.message });
  process.exit(1);
});

server.listen(listenPort, host, () => {
  const address = server.address();
  logger.log("info", {
    event: "listening",
    host,
    // The bound port, not the requested one: with RUNNER_PORT=0 they differ, and
    // a harness reads this line to learn where to connect.
    port: typeof address === "object" && address !== null ? address.port : listenPort,
    image: config.image
  });
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    logger.log("info", { event: "shutting_down", signal });
    // In-flight runs are not waited for. A run holds a container with a
    // wall-time cap on it, and the cap is what bounds shutdown; `server.close`
    // stops accepting new work and lets the started ones finish or be killed.
    server.close(() => process.exit(0));
  });
}
