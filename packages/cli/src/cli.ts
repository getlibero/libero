// `libero` — the host-authored half of a deployment.
//
// The dispatch rules are the proxy entrypoints': no arguments prints usage on
// stdout and exits 2, an explicit --help prints it on stdout and exits 0, and
// an unknown command goes to stderr with the usage and exits 2. Nothing here
// emits colour, ever.
//
// **What is not a command here is as deliberate as what is.** The vault, the
// budget meter and the audit log are read and written by the proxy's own
// entrypoints, because their files live in named volumes that the host cannot
// open and, for the vault, because the master key is in the proxy's environment
// and not in this process. That boundary is the one #98 settled: this CLI owns
// what an operator authors on the host — the environment file, the channels
// directory, the team sheets, the certificates, all bind-mounted read-only into
// the services — and the services' own entrypoints own what lives in their
// volumes.

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./io.js";
import type { CliIo } from "./io.js";
import { nodeTooOld } from "./node-version.js";
import { runInitCommand, USAGE as INIT_USAGE } from "./init-cli.js";
import { runChannelCommand, USAGE as CHANNEL_USAGE } from "./channel-cli.js";
import { runDoctorCommand, USAGE as DOCTOR_USAGE } from "./doctor-cli.js";

/**
 * Substituted by ./build.mjs at bundle time.
 *
 * The published artifact is a single file, so it cannot read its own
 * package.json off disk to find out what it is. The fallback keeps the source
 * runnable under `tsc` output and under vitest, where nothing defines it.
 */
declare const __LIBERO_VERSION__: string;
export const VERSION = typeof __LIBERO_VERSION__ === "string" ? __LIBERO_VERSION__ : "0.0.0-dev";

const USAGE = [
  "usage: libero <command>",
  "",
  "  init         write the deployment's environment file and generate the vault master key",
  "  channel add  create a channel's team sheet and the certificate that speaks for it",
  "  doctor       read a deployment's wiring back and report what is wrong with it",
  "",
  "Libero's two services run in containers and own what is inside their own",
  "volumes. This command owns the other half: what an operator authors on the",
  "host — the environment file, the channels directory, the team sheets, the",
  "certificates — all of which are bind-mounted read-only into the services.",
  "",
  "The vault, the budget meter and the audit log are deliberately not commands",
  "here. Their files live in named volumes the host cannot open, and the",
  "vault's master key lives in the proxy's environment rather than in this",
  "process. They are reached where the key already is:",
  "",
  "  docker compose -f deploy/docker-compose.yml run --rm proxy \\",
  "    node dist/vault.js set github_service_account < token.txt",
  "  docker compose -f deploy/docker-compose.yml run --rm proxy \\",
  "    node dist/budget.js reset C024BE91L",
  "  docker compose -f deploy/docker-compose.yml run --rm proxy \\",
  "    node dist/audit.js list --channel C024BE91L",
  "",
  "Reads no environment. Every path is resolved from the working directory."
].join("\n");

const COMMANDS = ["init", "channel", "doctor"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Each command's own usage, so `libero <command> --help` reaches it. */
const HELP: Readonly<Record<Command, string>> = {
  init: INIT_USAGE,
  channel: CHANNEL_USAGE,
  doctor: DOCTOR_USAGE
};

/** The three the proxy's entrypoints own, named so the error can say where. */
const ELSEWHERE: Readonly<Record<string, string>> = {
  vault: "node dist/vault.js",
  budget: "node dist/budget.js",
  audit: "node dist/audit.js"
};

/**
 * Async because `doctor` ends with a mutual-TLS probe, and nothing else here
 * needs to be — `init` and `channel` return a resolved number. The proxy's
 * vault entrypoint has the same shape for the same kind of reason.
 */
export async function runCli(io: CliIo): Promise<number> {
  // Before anything reads a file. `engines` is advisory — npm warns and runs
  // the package regardless — so an unsupported runtime has to be refused here
  // or it is not refused at all.
  const tooOld = io.nodeVersion === undefined ? null : nodeTooOld(io.nodeVersion);
  if (tooOld !== null) {
    io.err(tooOld);
    return EXIT_ERROR;
  }

  const [command, ...rest] = io.argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command === "--version") {
    io.out(`libero ${VERSION}`);
    return EXIT_OK;
  }
  if (!isCommand(command)) {
    io.err(`libero: unknown command: ${command}`);
    const entrypoint = ELSEWHERE[command];
    if (entrypoint !== undefined) {
      io.err(
        `libero: ${command} is the proxy's own entrypoint, because its files are ` +
          "in a container volume this host cannot open:"
      );
      io.err(`libero:   docker compose -f deploy/docker-compose.yml run --rm proxy ${entrypoint}`);
    }
    io.err(USAGE);
    return EXIT_USAGE;
  }

  if (rest[0] === "--help" || rest[0] === "-h") {
    io.out(HELP[command]);
    return EXIT_OK;
  }

  switch (command) {
    case "init":
      return runInitCommand(io, rest);
    case "channel":
      return runChannelCommand(io, rest);
    case "doctor":
      return runDoctorCommand(io, rest);
  }
}
