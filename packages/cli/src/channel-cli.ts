// `libero channel` — registering a channel, and rotating the key that speaks
// for it.
//
// **`add` mints a certificate and pins it in the same act, and that is not the
// rule scripts/dev-certs.sh keeps.** The script's header says it, and it is
// right: "minting material and authorizing it are two acts, and a script that
// did both would hand back the property pinning exists to create". The property
// is that a change to which key may speak for a channel is a reviewable edit to
// a file in git, and a tool that silently rewrote that list would give it away.
//
// Creation is not that change. At `add` there is no sheet, so there is no prior
// list, no diff, and nothing for a reviewer to compare against — the operator
// running the command *is* the authorization, and making them copy a
// fingerprint out of one terminal and into a file they just created proves
// nothing to anybody. The state that rule protects against is the one after
// creation, and `rotate` and `promote` below leave it exactly as it was: mint
// into staging, print the fingerprint, stop. The sheet is edited by a human,
// and `promote` refuses until it has been.
//
// So: one act to create, two to change. `add` is deliberately not able to touch
// a channel that already exists — it refuses rather than merging, which keeps
// "this command only ever writes a sheet nobody had reviewed yet" true by
// construction.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ChannelId, parseTeamSheet } from "@getlibero/schema";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, UsageError, messageOf } from "./io.js";
import type { CliIo } from "./io.js";
import { bundledScript, fingerprintOf, runDevCerts } from "./dev-certs.js";
import type { CertRunner } from "./dev-certs.js";
import { renderStarterSheet } from "./starter-sheet.js";

/** Where team sheets and certificates live, as scripts/dev-certs.sh defaults. */
const DEFAULT_CHANNELS_ROOT = "channels";
const DEFAULT_CERTS_OUT = "deploy/certs";

/** The documented starter sheet, which is not a channel and gets no material. */
const RESERVED = "example";

export const USAGE = [
  "usage: libero channel <command>",
  "",
  "  add <id> [--name NAME]  create a channel's directory, its team sheet, and",
  "                          the client certificate that speaks for it",
  "  rotate <id>             mint a replacement certificate into staging and",
  "                          print the fingerprint to add to the sheet",
  "  promote <id>            put a staged certificate into service, once the",
  "                          sheet pins it",
  "  pins                    print every channel's fingerprint and expiry",
  "",
  "  --channels-root DIR     where team sheets live (default: channels)",
  "  --out DIR               where the mutual-TLS material lives",
  "                          (default: deploy/certs)",
  "",
  "A channel id is what Slack calls the channel, and it becomes a directory",
  "name: letters, digits, dot, dash and underscore, starting with a letter or",
  "a digit. One directory per channel is the isolation boundary, so the id is",
  "checked against the same rule the two services check it against.",
  "",
  "`add` creates a channel that can authenticate and do nothing: no tools, and",
  "the schema's default caps. Granting is editing the sheet it writes —",
  "channels/example/channel.toml documents every field. It refuses to touch a",
  "channel that already has a sheet.",
  "",
  "Rotation is deliberately two commands with a human edit between them.",
  "`rotate` changes nothing in service; it stages a certificate and prints the",
  "fingerprint to add alongside the one already in the sheet. `promote`",
  "refuses until the sheet pins it, then swaps the material — the agent picks",
  "it up on its next request and neither service restarts. Drop the old",
  "fingerprint once a call has succeeded.",
  "",
  "Certificates are minted by scripts/dev-certs.sh, a copy of which ships in",
  "this package. It needs sh and openssl on the host.",
  "",
  "Reads no environment. Every path is resolved from the working directory."
].join("\n");

const COMMANDS = ["add", "rotate", "promote", "pins"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * The certificate script, injected so a test can run the real one out of the
 * repository rather than the copy that only exists after a build.
 */
export interface ChannelDeps {
  readonly script: string;
  readonly run: CertRunner;
}

export function runChannelCommand(io: CliIo, argv: readonly string[], deps?: Partial<ChannelDeps>): number {
  const [command, ...rest] = argv;
  const script = deps?.script ?? bundledScript();
  const run = deps?.run ?? runDevCerts;

  if (command === undefined) {
    io.err("libero: channel needs a command");
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (!isCommand(command)) {
    io.err(`libero: unknown channel command: ${command}`);
    io.err(USAGE);
    return EXIT_USAGE;
  }

  let options: Options;
  try {
    options = parseChannel(command, rest);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }

  try {
    return dispatch(io, command, options, { script, run });
  } catch (error) {
    io.err(`libero: ${messageOf(error)}`);
    return EXIT_ERROR;
  }
}

interface Options {
  readonly channel?: string;
  readonly name?: string;
  readonly channelsRoot: string;
  readonly out: string;
}

function parseChannel(command: Command, rest: readonly string[]): Options {
  let values: Record<string, string | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: {
        name: { type: "string" },
        "channels-root": { type: "string" },
        out: { type: "string" }
      }
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const text = error instanceof Error ? error.message : "bad arguments";
    throw new UsageError(`libero: ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
  }

  if (command === "pins") {
    if (positionals.length > 0) {
      throw new UsageError(`libero: channel pins takes no arguments, and got: ${positionals[0] as string}`);
    }
  } else if (positionals.length !== 1) {
    throw new UsageError(`libero: channel ${command} takes one channel id`);
  }

  if (values["name"] !== undefined && command !== "add") {
    throw new UsageError(`libero: --name is only for channel add`);
  }

  const channel = positionals[0];
  if (channel !== undefined) {
    if (!ChannelId.safeParse(channel).success) {
      throw new UsageError(
        `libero: not a channel id: ${channel}. Letters, digits, dot, dash and ` +
          "underscore, starting with a letter or a digit, up to 64 characters."
      );
    }
    if (channel === RESERVED) {
      throw new UsageError(
        `libero: ${RESERVED} is the documented starter sheet, not a channel. ` +
          "Use the id Slack gives the channel."
      );
    }
  }

  return {
    ...(channel !== undefined ? { channel } : {}),
    ...(values["name"] !== undefined ? { name: values["name"] } : {}),
    channelsRoot: values["channels-root"] ?? DEFAULT_CHANNELS_ROOT,
    out: values["out"] ?? DEFAULT_CERTS_OUT
  };
}

function dispatch(io: CliIo, command: Command, options: Options, deps: ChannelDeps): number {
  const roots = ["--out", options.out, "--channels-root", options.channelsRoot];

  switch (command) {
    case "add":
      return add(io, options, deps, roots);
    case "rotate":
      return forward(io, deps, ["--rotate", options.channel as string, ...roots]);
    case "promote":
      return forward(io, deps, ["--promote", options.channel as string, ...roots]);
    case "pins":
      return forward(io, deps, ["--print-pins", ...roots]);
  }
}

function add(io: CliIo, options: Options, deps: ChannelDeps, roots: readonly string[]): number {
  const channel = options.channel as string;
  const sheet = resolve(io.cwd, options.channelsRoot, channel, "channel.toml");

  // Before anything is minted. A channel that already has a sheet has been
  // reviewed by somebody, and this command has nothing to say about it — so it
  // refuses without having first written key material for a channel it is
  // about to decline to register.
  if (existsSync(sheet)) {
    io.err(`libero: ${channel} already has a team sheet at ${sheet}`);
    io.err("libero: edit it, or rotate its certificate with: libero channel rotate " + channel);
    return EXIT_ERROR;
  }

  const minted = forward(io, deps, ["--channels", channel, ...roots]);
  if (minted !== EXIT_OK) return minted;

  const pem = resolve(io.cwd, options.out, "agent", `client-${channel}.pem`);
  if (!existsSync(pem)) {
    io.err(`libero: no certificate at ${pem} after minting one`);
    return EXIT_ERROR;
  }

  const text = renderStarterSheet({
    channel,
    name: options.name ?? channel,
    fingerprint: fingerprintOf(pem)
  });

  // The sheet is validated with the same parser the proxy resolves one with, so
  // this command cannot write a file the deployment would then reject. A
  // failure here is a bug in ./starter-sheet.ts rather than operator error, and
  // the message says which.
  const parsed = parseTeamSheet(text);
  if (!parsed.ok) {
    io.err(`libero: generated a team sheet the schema rejects (${parsed.reason}). This is a bug.`);
    return EXIT_ERROR;
  }

  mkdirSync(dirname(sheet), { recursive: true });
  writeFileSync(sheet, text, { flag: "wx" });

  io.out("");
  io.out(`libero: wrote ${join(options.channelsRoot, channel, "channel.toml")}`);
  io.out(`libero: ${channel} can authenticate and call nothing until you grant it something`);
  io.out("");
  io.out("Grant a tool by adding an [[mcp_server]] block to that file; every");
  io.out("field is documented in channels/example/channel.toml. No restart is");
  io.out("needed — the proxy re-reads the sheet on the next call.");
  return EXIT_OK;
}

/** Runs the script and relays what it said, verbatim. */
function forward(io: CliIo, deps: ChannelDeps, args: readonly string[]): number {
  const result = deps.run(deps.script, [...args], io.cwd);
  for (const line of result.out) io.out(line);
  for (const line of result.err) io.err(line);
  return result.code === 0 ? EXIT_OK : EXIT_ERROR;
}
