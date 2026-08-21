// `libero init` — the operator's half of a deployment's configuration.
//
// What this writes is the environment file `deploy/docker-compose.yml` reads,
// and nothing else. The compose file sets every path the two services use —
// the channels root, the three database files, the store root, the TLS
// material, the host and the port — because those are paths *inside a
// container* and a value on the host cannot make them true. What is left is
// the operator's: two Slack tokens, a provider and a model, a completion key,
// and the vault master key this command generates.
//
// **Where the file goes is not a constant; it is Compose's own rule.** With no
// --project-directory, Compose's project directory is the directory holding the
// compose file, and the `.env` it loads automatically is the one there. This
// repository's compose file is `deploy/docker-compose.yml`, so the file is
// `deploy/.env` and an `.env` at the repository root is read by nothing. The
// `.env.example` beside that root is a different document and a superset: it is
// the contract for running the two processes directly, with host-relative
// paths, and copying it here would produce a file that looks right and is wrong
// in eleven variables.
//
// **No value is ever written over a non-empty one, and there is no --force.**
// The asymmetry is one line: every value in this file can be retyped from where
// it came from except PROXY_VAULT_KEY, which the vault is encrypted under.
// There is no escrow and no recovery, so a flag that regenerated it would be a
// one-word flag that discards every credential the operator has loaded. If they
// mean it, they delete the line. This is the discipline scripts/dev-certs.sh
// has for the same reason — a fingerprint a sheet pins and a key a vault is
// encrypted under are both correct only for as long as nothing regenerates
// them.
//
// **This command writes no tool credential and has no flag that takes one.**
// Service credentials go into the vault from inside the proxy container, over
// stdin, so the master key and the secrets it encrypts never sit on this host
// together.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ModelId } from "@getlibero/schema";
import { createFileExclusively, replaceFileAtomically } from "@getlibero/atomic-write";
import { NO_COMPOSE_FILE, findCompose } from "./compose.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, UsageError, messageOf } from "./io.js";
import type { CliIo } from "./io.js";
import { mergeEnvFile, renderEnvFile } from "./env-file.js";
import type { EnvBlock } from "./env-file.js";
import { generateVaultKey } from "./vault-key.js";

/** The two providers `AGENT_PROVIDER` takes, as apps/server/src/env.ts parses it. */
const PROVIDERS = ["anthropic", "openai-compatible"] as const;
type Provider = (typeof PROVIDERS)[number];

const DEFAULT_PROVIDER: Provider = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Named because three places have to agree about it, one of them a warning. */
const VAULT_KEY = "PROXY_VAULT_KEY";


export const USAGE = [
  "usage: libero init [--file PATH] [--provider NAME] [--model ID]",
  "",
  "  --file PATH      the environment file to write. Defaults to the .env",
  "                   beside the compose file: deploy/.env when this directory",
  "                   holds deploy/docker-compose.yml, ./.env when the compose",
  "                   file is this directory's own",
  "  --provider NAME  anthropic (the default) or openai-compatible",
  "  --model ID       the model the agent completes against",
  "",
  "Writes the operator's half of a deployment's configuration and generates",
  "PROXY_VAULT_KEY, the 32 random bytes that encrypt the credential vault.",
  "Everything else the two services read — the channels root, the three",
  "database paths, the store root, the TLS material, the host and the port — is",
  "set in the compose file, because those are paths inside a container and a",
  "value on the host cannot make them true.",
  "",
  "The file goes beside the compose file because that is where Docker Compose",
  "looks: with no --project-directory the project directory is the directory",
  "holding the compose file, and the .env loaded automatically is the one",
  "there. An .env at the root of this repository is read by nothing. The",
  ".env.example there is a different document, and a superset — the contract",
  "for running the two processes directly, with host-relative paths.",
  "",
  "No value is written over a non-empty one. A re-run fills assignments that",
  "are empty, appends variables that are absent, and leaves every other byte",
  "alone, comments included. There is no --force, and that is about one line:",
  "every value here can be retyped from where it came from except",
  "PROXY_VAULT_KEY, which the vault is encrypted under. There is no escrow and",
  "no recovery, so a flag that regenerates it discards every credential loaded",
  "so far. Delete the line by hand if you mean it.",
  "",
  "No tool credential belongs in this file and no flag here takes one. Service",
  "credentials go into the vault from inside the proxy container, over stdin.",
  "",
  "Reads no environment. Every path is resolved from the working directory."
].join("\n");

export function runInitCommand(io: CliIo, argv: readonly string[]): number {
  let options: InitOptions;
  try {
    options = parseInit(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }

  let file: string;
  try {
    file = options.file === undefined ? beside(io.cwd) : resolve(io.cwd, options.file);
  } catch (error) {
    io.err(messageOf(error));
    return EXIT_ERROR;
  }

  try {
    return write(io, file, options);
  } catch (error) {
    io.err(`libero: ${messageOf(error)}`);
    return EXIT_ERROR;
  }
}

interface InitOptions {
  readonly file?: string;
  readonly provider: Provider;
  readonly model: string;
}

function parseInit(argv: readonly string[]): InitOptions {
  let values: Record<string, string | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        file: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" }
      }
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    // Node's message already names the offending flag and often suggests the
    // one that was meant; only the capital needs changing to match house style.
    const text = error instanceof Error ? error.message : "bad arguments";
    throw new UsageError(`libero: ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
  }

  if (positionals.length > 0) {
    throw new UsageError(`libero: init takes no arguments, and got: ${positionals[0] as string}`);
  }

  const provider = values["provider"] ?? DEFAULT_PROVIDER;
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new UsageError(`libero: not a provider: ${provider}. One of ${PROVIDERS.join(", ")}.`);
  }

  const model = values["model"] ?? DEFAULT_MODEL;
  // The same validator a team sheet's [llm] model passes through, so a model id
  // this command accepts is one the rest of the deployment will. It is narrow
  // for a reason the schema states: a leading parenthesis is reserved for the
  // budget meter's `(legacy)` and `(unreported)` sentinels.
  if (!ModelId.safeParse(model).success) {
    throw new UsageError(`libero: not a model id: ${model}`);
  }

  return {
    ...(values["file"] !== undefined ? { file: values["file"] } : {}),
    provider: provider as Provider,
    model
  };
}

/** Compose's rule, applied by hand: the `.env` beside the compose file. */
function beside(cwd: string): string {
  const found = findCompose(cwd);
  if (found === null) throw new Error(`libero: ${NO_COMPOSE_FILE}`);
  return found.envFile;
}

function write(io: CliIo, file: string, options: InitOptions): number {
  const shown = display(io.cwd, file);
  let key: string | undefined;
  const blocks = (): readonly EnvBlock[] => {
    key ??= generateVaultKey();
    return template(options, key);
  };

  if (!existsSync(file)) {
    const text = renderEnvFile(HEADER, blocks());
    // `wx` on the real path, which `createFileExclusively` keeps: two `init`s
    // racing on one path should end with one of them saying the file already
    // exists, not with a key written over a key — a temporary and a rename would
    // hand the second writer a clean win. 0600 because this is the only thing in
    // the repository that puts a master key on an operator's disk, and the two
    // fsyncs because a half-written key is worse than no key: the truncated
    // assignment is non-empty, so a re-run neither fills it nor warns, and the
    // failure surfaces four steps later as a vault that will not open.
    createFileExclusively(file, Buffer.from(text, "utf8"));
    io.out(`libero: wrote ${shown}`);
    io.out(`libero: generated ${VAULT_KEY}`);
    report(io, shown, options);
    return EXIT_OK;
  }

  const existing = readFileSync(file, "utf8");
  const merged = mergeEnvFile(existing, blocks());
  if (merged.appended.length === 0 && merged.filled.length === 0) {
    io.out(`libero: ${shown} already assigns every variable compose reads`);
    io.out("libero: nothing written");
    return EXIT_OK;
  }

  // Written beside and renamed over, so a crash mid-write cannot leave the
  // operator with a truncated file — and at 0600 before the rename rather than
  // after, so the key is never briefly world-readable. This used to be written
  // out here, and it had drifted: it renamed without fsyncing either the file or
  // the directory, so the guarantee this comment claims was not one the code
  // gave. #272 gave the recipe one home, and this is the caller it was unified
  // for.
  replaceFileAtomically(file, Buffer.from(merged.text, "utf8"));

  io.out(`libero: updated ${shown}`);
  for (const name of merged.appended) io.out(`libero:   added ${name}`);
  for (const name of merged.filled) io.out(`libero:   filled ${name}`);
  // Said in its own words rather than left to be read off an "added" line: a
  // new master key means the vault a previous key encrypted is unreadable, and
  // that is worth a sentence of its own on an operator's screen.
  if (merged.appended.includes(VAULT_KEY) || merged.filled.includes(VAULT_KEY)) {
    io.out(`libero: generated ${VAULT_KEY}`);
  }
  report(io, shown, options);
  return EXIT_OK;
}

/** What is left for the operator to do, in the order they have to do it. */
function report(io: CliIo, shown: string, options: InitOptions): void {
  const key = options.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  io.out("");
  io.out(`Fill SLACK_APP_TOKEN, SLACK_BOT_TOKEN and ${key} in ${shown}, then:`);
  io.out("  libero channel add <CHANNEL_ID>");
  io.out("  docker compose -f deploy/docker-compose.yml up");
}

function display(cwd: string, file: string): string {
  const shown = relative(cwd, file);
  return shown === "" || shown.startsWith("..") || isAbsolute(shown) ? file : shown;
}

const HEADER = [
  "Libero — the environment deploy/docker-compose.yml reads.",
  "",
  "Written by `libero init`. It lives beside the compose file because that is",
  "where Docker Compose looks: with no --project-directory, the project",
  "directory is the directory holding the compose file, and the .env loaded",
  "automatically is the one there. An .env at the repository root is read by",
  "nothing, and .env.example there is a different document — the superset",
  "contract for running the two processes directly, with host-relative paths.",
  "",
  "This is the operator's half. Everything else the services need — the",
  "channels root, the three database paths, the store root, the TLS material,",
  "the host and the port — is set in the compose file and is deliberately not",
  "here: those are paths inside a container, and a value on the host cannot",
  "make them true.",
  "",
  "NO TOOL CREDENTIAL BELONGS IN THIS FILE. The keys below are the model",
  "provider's: they buy completions and reach no tool. A GitHub token, a Stripe",
  "key, anything a team sheet names by credential — those go into the vault",
  "from inside the proxy container, over stdin, so that the master key below",
  "and the secrets it encrypts never sit on this host together:",
  "",
  "  docker compose -f deploy/docker-compose.yml run --rm proxy \\",
  "    node dist/vault.js set github_service_account < token.txt"
];

/**
 * Every variable `deploy/docker-compose.yml` interpolates, and no other.
 *
 * The set is asserted against the compose file in ./init-cli.test.ts, so a
 * variable added there and not here fails a test rather than an operator's
 * first `docker compose up`.
 */
function template(options: InitOptions, vaultKey: string): readonly EnvBlock[] {
  return [
    {
      comment: [
        "Socket Mode app-level token (xapp-) and bot token (xoxb-), both from the",
        "app created from deploy/slack-app-manifest.yml. Empty here, and a loud",
        "startup failure in the server rather than a compose error."
      ],
      vars: [
        { name: "SLACK_APP_TOKEN", value: "" },
        { name: "SLACK_BOT_TOKEN", value: "" }
      ]
    },
    {
      comment: [
        "Which provider the agent completes against, and which model. Both are",
        "declared rather than one inferred from the other: inferring the provider",
        "from whichever key is set would quietly bill the other account. AGENT_MODEL",
        "is one of the two variables compose refuses to start without."
      ],
      vars: [
        { name: "AGENT_PROVIDER", value: options.provider },
        { name: "AGENT_MODEL", value: options.model }
      ]
    },
    {
      comment: [
        "Completion keys. Only the one matching AGENT_PROVIDER is read; the other",
        "is ignored. The base URLs are optional and are what reach anything other",
        "than the provider's own endpoint — Together, Fireworks, Groq, Ollama,",
        "Gemini's compatibility endpoint, or the litellm sidecar."
      ],
      vars: [
        { name: "ANTHROPIC_API_KEY", value: "" },
        { name: "ANTHROPIC_BASE_URL", value: "" },
        { name: "OPENAI_API_KEY", value: "" },
        { name: "OPENAI_BASE_URL", value: "" }
      ]
    },
    {
      comment: [
        "Embeddings: a second provider, and the only optional one here. Anthropic",
        "publishes no embeddings endpoint, so this is configured separately from",
        "AGENT_PROVIDER and is usually a different vendor — Voyage, OpenAI, a local",
        "Ollama. Leaving the provider unset turns semantic recall off and leaves",
        "memory's search and MEMORY.md whole; the agent says so once at startup.",
        "The model is required once a provider is named, because it is stamped",
        "against the channel's stored vectors — changing it later is a rebuild.",
        "The key falls back to OPENAI_API_KEY when both are one account."
      ],
      vars: [
        { name: "AGENT_EMBEDDING_PROVIDER", value: "" },
        { name: "AGENT_EMBEDDING_MODEL", value: "" },
        { name: "AGENT_EMBEDDING_API_KEY", value: "" },
        { name: "AGENT_EMBEDDING_BASE_URL", value: "" }
      ]
    },
    {
      comment: [
        "The vault master key: 32 random bytes, base64, generated by `libero",
        "init`. It encrypts every tool credential at rest. Lose it and the vault",
        "is unreadable — there is no recovery path and no escrow — so this is the",
        "one line in this file worth backing up, and the one line init will never",
        "overwrite."
      ],
      vars: [{ name: "PROXY_VAULT_KEY", value: vaultKey }]
    },
    {
      comment: [
        "Optional: what a model's tokens cost, so a channel's [budget] daily_usd",
        "can mean something. A container path under the ../prices mount, e.g.",
        "/data/prices/prices.toml. Absent fails closed — with no table every model",
        "is unpriced, and a channel that caps in dollars is refused rather than",
        "metered at zero."
      ],
      vars: [{ name: "PROXY_PRICE_TABLE", value: "" }]
    },
    {
      comment: [
        "Optional: the code-execution sandbox (#368), which is off unless you",
        "start it — `docker compose --profile runner up -d`. All three are needed",
        "together and none has a usable default, because each names something",
        "only you know.",
        "",
        "RUNNER_SANDBOX_IMAGE must be pinned by digest and the runner refuses to",
        "start otherwise: which language the sandbox has is a property of this",
        "deployment, and a floating tag makes it a property of whenever the daemon",
        "last pulled. Resolve one with:",
        "  docker buildx imagetools inspect python:3.13-alpine",
        "",
        "RUNNER_CLIENT_PIN is the fingerprint of the proxy's client certificate,",
        "printed by `sh scripts/dev-certs.sh`. It is what stops a compromised",
        "agent — which holds certificates the same CA signed — from calling the",
        "runner directly, around the team sheet and the audit log.",
        "",
        "DOCKER_GID is the HOST's docker group id, which differs between",
        "distributions:",
        "  getent group docker | cut -d: -f3"
      ],
      vars: [
        { name: "RUNNER_SANDBOX_IMAGE", value: "" },
        { name: "RUNNER_CLIENT_PIN", value: "" },
        { name: "DOCKER_GID", value: "" }
      ]
    }
  ];
}

export { DEFAULT_MODEL, DEFAULT_PROVIDER };
