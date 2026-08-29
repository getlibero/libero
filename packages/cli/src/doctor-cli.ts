// `libero doctor` — reading a deployment's wiring back and saying what is wrong
// with it.
//
// **It reads and never writes.** Not a style preference: the two things most
// worth checking here are a master key and the fingerprints a team sheet pins,
// and a command that repaired either would be a command that could destroy a
// vault or widen a channel's authorization while claiming to diagnose it. It
// opens no vault — it cannot, the vault is in a container volume — prints no
// credential, and its only writes are the ones `accessSync` does not do. It
// does read the master key when the key is in a file rather than in the
// environment (#495), because a key it cannot read is a key it cannot say the
// shape of; what it prints of it is the number of bytes.
//
// **What it can see is bounded by where it runs, and it says so rather than
// guessing.** On a compose deployment the two channels roots, the store root
// and the three database paths are set in the compose file to paths *inside a
// container*, and the proxy publishes no port to the host. A checker that
// reported those as healthy because it could not find them would be worse than
// one that did not check them, so an unreachable check is reported `skip` with
// the reason, and `skip` is never a pass. The checks that do run on the host
// are the ones that matter most anyway: the environment file the operator
// authored, and whether every certificate on disk is a certificate some sheet
// pins.
//
// **A pin without a certificate and a certificate without a pin are different
// failures.** The first is a channel that cannot authenticate — every call
// answered 401, which is loud. The second is key material lying around that no
// sheet will accept, which is quiet, and is what a half-finished rotation or a
// retired channel leaves behind. Both are reported, and the second is the one
// nothing else in the system would ever tell an operator about.

import { X509Certificate } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:tls";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ModelId, normalizeCertificateSha256, parseTeamSheet } from "@getlibero/schema";
import { NO_COMPOSE_FILE, findCompose } from "./compose.js";
import { assignedValues } from "./env-file.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, UsageError, messageOf } from "./io.js";
import type { CliIo } from "./io.js";
import { DEFAULT_KEY_FILE, VAULT_KEY_BYTES } from "./vault-key.js";

const DEFAULT_CHANNELS_ROOT = "channels";
const DEFAULT_SHARED_SKILLS_ROOT = "shared-skills";
const DEFAULT_CERTS_OUT = "deploy/certs";

/** The starter sheet, which is documentation and not a channel. */
const RESERVED = "example";

/** Warn this far ahead of a certificate's expiry, as scripts/dev-certs.sh does. */
const EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000;

/** How long the mutual-TLS probe waits before calling the proxy unreachable. */
const PROBE_TIMEOUT_MS = 5000;

export const USAGE = [
  "usage: libero doctor [--file PATH] [--channels-root DIR]",
  "                     [--shared-skills-root DIR] [--out DIR]",
  "                     [--key-file PATH] [--offline]",
  "",
  "  --file PATH          the environment file to read. Defaults to the .env",
  "                       beside the compose file, as init writes it",
  "  --key-file PATH      where the master key lives when it is not in the",
  `                       environment file (default: ${DEFAULT_KEY_FILE})`,
  "  --channels-root DIR  where team sheets live (default: channels)",
  "  --shared-skills-root DIR",
  "                       where the operator's shared skills live",
  "                       (default: shared-skills)",
  "  --out DIR            where the mutual-TLS material lives",
  "                       (default: deploy/certs)",
  "  --offline            skip the one check that needs the deployment running",
  "",
  "Reads a deployment's host-side configuration back and reports what is wrong",
  "with it: the environment file, the vault master key's shape — wherever it",
  "is kept, PROXY_VAULT_KEY or a file, and having both is a failure rather than",
  "a preference — and whether every team sheet parses and pins a certificate",
  "that is actually on disk —",
  "in both directions, because a certificate no sheet pins is key material",
  "nothing else would ever mention. Also whether every shared skill a sheet",
  "names has actually been published into the shared root, which is quiet when",
  "it is wrong: the sheet parses and the channel gets nothing.",
  "",
  "A check that cannot run says skip and why, and skip is not a pass. On a",
  "compose deployment the channels roots, the store root and the database",
  "paths are set in the compose file to paths inside a container, and the",
  "proxy publishes no port to the host — so those are checked when the",
  "environment file supplies them, which is the case when you are running the",
  "two processes directly, and skipped with the reason when it does not.",
  "",
  "Writes nothing, opens no vault, and prints no credential. Exits 1 if any",
  "check failed, 0 otherwise — a warning is not a failure.",
  "",
  "Reads no environment. Every path is resolved from the working directory."
].join("\n");

type Status = "ok" | "warn" | "fail" | "skip";

interface Check {
  readonly status: Status;
  /** Two words at most; this column is scanned, not read. */
  readonly name: string;
  readonly detail: string;
}

export async function runDoctorCommand(io: CliIo, argv: readonly string[]): Promise<number> {
  let options: DoctorOptions;
  try {
    options = parseDoctor(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }

  let checks: Check[];
  try {
    checks = await inspect(io.cwd, options);
  } catch (error) {
    io.err(`libero: ${messageOf(error)}`);
    return EXIT_ERROR;
  }

  const width = Math.max(...checks.map(check => check.name.length));
  for (const check of checks) {
    io.out(`${check.status.padEnd(5)} ${check.name.padEnd(width)}  ${check.detail}`);
  }

  const failed = checks.filter(check => check.status === "fail").length;
  const skipped = checks.filter(check => check.status === "skip").length;
  io.out("");
  io.out(
    failed === 0
      ? `libero: ${checks.length - skipped} checked, nothing failed${skipped > 0 ? `, ${skipped} skipped` : ""}`
      : `libero: ${failed} of ${checks.length} failed`
  );
  return failed === 0 ? EXIT_OK : EXIT_ERROR;
}

interface DoctorOptions {
  readonly file?: string;
  readonly channelsRoot: string;
  readonly sharedSkillsRoot: string;
  readonly out: string;
  /**
   * The host path `init --key-file` writes and the compose `secrets:` block
   * mounts (#495) — not the container path `PROXY_VAULT_KEY_FILE` names, which
   * is the compose file's business and unreadable from here. Defaulted like
   * `--out`, because a deployment that took the file form took the layout the
   * docs and the compose file name; one that put the key elsewhere says where.
   */
  readonly keyFile: string;
  readonly offline: boolean;
}

function parseDoctor(argv: readonly string[]): DoctorOptions {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        file: { type: "string" },
        "channels-root": { type: "string" },
        "shared-skills-root": { type: "string" },
        out: { type: "string" },
        "key-file": { type: "string" },
        offline: { type: "boolean" }
      }
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const text = error instanceof Error ? error.message : "bad arguments";
    throw new UsageError(`libero: ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
  }

  if (positionals.length > 0) {
    throw new UsageError(`libero: doctor takes no arguments, and got: ${positionals[0] as string}`);
  }

  return {
    ...(typeof values["file"] === "string" ? { file: values["file"] } : {}),
    channelsRoot: typeof values["channels-root"] === "string" ? values["channels-root"] : DEFAULT_CHANNELS_ROOT,
    sharedSkillsRoot:
      typeof values["shared-skills-root"] === "string"
        ? values["shared-skills-root"]
        : DEFAULT_SHARED_SKILLS_ROOT,
    out: typeof values["out"] === "string" ? values["out"] : DEFAULT_CERTS_OUT,
    keyFile: typeof values["key-file"] === "string" ? values["key-file"] : DEFAULT_KEY_FILE,
    offline: values["offline"] === true
  };
}

async function inspect(cwd: string, options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];

  const envFile =
    options.file !== undefined ? resolve(cwd, options.file) : findCompose(cwd)?.envFile;
  if (envFile === undefined) throw new Error(NO_COMPOSE_FILE);

  const env = readEnv(envFile, checks, cwd);
  checkModel(env, checks);
  checkProvider(env, checks);
  checkSlack(env, checks);
  checkVaultKey(env, resolve(cwd, options.keyFile), checks);
  checkRoots(env, checks, cwd);

  const certs = resolve(cwd, options.out);
  checkCertMaterial(certs, checks);
  const namedSkills = checkChannels(resolve(cwd, options.channelsRoot), certs, checks);
  checkSharedSkills(resolve(cwd, options.sharedSkillsRoot), namedSkills, checks);

  checks.push(await probe(env, cwd, options));
  return checks;
}

function readEnv(file: string, checks: Check[], cwd: string): Map<string, string> {
  const shown = show(cwd, file);
  if (!existsSync(file)) {
    checks.push({
      status: "fail",
      name: "env file",
      detail: `${shown} does not exist. Write it with: libero init`
    });
    return new Map();
  }
  const values = assignedValues(readFileSync(file, "utf8"));
  checks.push({ status: "ok", name: "env file", detail: `${shown}, ${values.size} assignments` });
  return values;
}

function checkModel(env: Map<string, string>, checks: Check[]): void {
  const model = env.get("AGENT_MODEL") ?? "";
  if (model === "") {
    checks.push({
      status: "fail",
      name: "AGENT_MODEL",
      detail: "empty. Compose refuses to start without it"
    });
    return;
  }
  if (!ModelId.safeParse(model).success) {
    checks.push({ status: "fail", name: "AGENT_MODEL", detail: `not a model id: ${model}` });
    return;
  }
  checks.push({ status: "ok", name: "AGENT_MODEL", detail: model });
}

function checkProvider(env: Map<string, string>, checks: Check[]): void {
  const provider = env.get("AGENT_PROVIDER") ?? "";
  if (provider !== "anthropic" && provider !== "openai-compatible") {
    checks.push({
      status: "fail",
      name: "AGENT_PROVIDER",
      detail: `${provider === "" ? "empty" : `not a provider: ${provider}`}. One of anthropic, openai-compatible`
    });
    return;
  }
  checks.push({ status: "ok", name: "AGENT_PROVIDER", detail: provider });

  // Only the key matching the provider is read; the other is ignored, and
  // saying so is the point — an operator who filled the wrong one has a
  // deployment that fails at the first completion with a key sitting right
  // there in the file.
  const name = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const set = (env.get(name) ?? "") !== "";
  checks.push(
    set
      ? { status: "ok", name: "provider key", detail: `${name} is set` }
      : { status: "fail", name: "provider key", detail: `${name} is empty, and AGENT_PROVIDER is ${provider}` }
  );
}

function checkSlack(env: Map<string, string>, checks: Check[]): void {
  // The prefixes are Slack's and are worth checking because the two are easy to
  // swap, and a swap fails at connect time with a message about neither.
  for (const [name, prefix] of [
    ["SLACK_APP_TOKEN", "xapp-"],
    ["SLACK_BOT_TOKEN", "xoxb-"]
  ] as const) {
    const value = env.get(name) ?? "";
    if (value === "") {
      checks.push({ status: "fail", name, detail: "empty" });
    } else if (!value.startsWith(prefix)) {
      checks.push({ status: "warn", name, detail: `does not start with ${prefix}` });
    } else {
      checks.push({ status: "ok", name, detail: `set, ${prefix}…` });
    }
  }
}

/**
 * The master key, from whichever of its two places this deployment keeps it
 * (#495): `PROXY_VAULT_KEY` in the environment file, or the file `--key-file`
 * names.
 *
 * **Both is a failure and not a preference**, because that is what
 * `vaultKeyFromEnv` does with it: exactly one source, and a proxy that finds
 * two refuses to start. Saying so here is the point of saying it at all — the
 * alternative is an operator who moved the key to a file, left the old line in
 * place, and learns at `docker compose up` that they now have two keys and no
 * way to tell which one the vault was loaded under.
 *
 * Neither is the failure it already was, worded to name both answers.
 */
function checkVaultKey(env: Map<string, string>, keyFile: string, checks: Check[]): void {
  const value = env.get("PROXY_VAULT_KEY") ?? "";
  const onDisk = existsSync(keyFile);

  if (value !== "" && onDisk) {
    checks.push({
      status: "fail",
      name: "vault key",
      detail:
        `PROXY_VAULT_KEY is set and ${keyFile} exists. Exactly one may be, and the proxy ` +
        "refuses to start on both — the vault opens under whichever one it was loaded with"
    });
    return;
  }

  if (value === "") {
    if (!onDisk) {
      checks.push({
        status: "fail",
        name: "vault key",
        detail: `PROXY_VAULT_KEY is empty and there is no key at ${keyFile}. Write one with: libero init`
      });
      return;
    }
    checkKeyFile(keyFile, checks);
    return;
  }

  checks.push(shapeOf("PROXY_VAULT_KEY", value));
}

/**
 * A key file's presence, mode and shape — and none of its content.
 *
 * The mode is a `fail` rather than a `warn`, and that is the whole reason the
 * file form exists: it buys nothing against a host root, and what it does buy —
 * the key out of `docker inspect`, crash dumps and anything that scrapes a
 * container's environment — is undone by a file every account on the host can
 * read. A deployment with a group- or world-readable master key is worse off
 * than one that left it in the environment, because it believes otherwise.
 *
 * A directory at the path is its own sentence: it is what a `docker run -v`
 * against a path that did not exist leaves behind, and "not base64" would be a
 * true and useless thing to say about it.
 */
function checkKeyFile(keyFile: string, checks: Check[]): void {
  const stats = statSync(keyFile);
  if (!stats.isFile()) {
    checks.push({
      status: "fail",
      name: "vault key",
      detail: `${keyFile} is not a regular file. A bind mount against a path that did not exist leaves a directory`
    });
    return;
  }
  const open = stats.mode & 0o077;
  if (open !== 0) {
    checks.push({
      status: "fail",
      name: "vault key",
      detail: `${keyFile} is mode ${(stats.mode & 0o777).toString(8).padStart(3, "0")}, readable beyond its owner. chmod 600 it`
    });
    return;
  }

  let text: string;
  try {
    text = readFileSync(keyFile, "utf8");
  } catch (error) {
    checks.push({ status: "fail", name: "vault key", detail: `${keyFile}: ${messageOf(error)}` });
    return;
  }
  if (text.trim() === "") {
    checks.push({ status: "fail", name: "vault key", detail: `${keyFile} is empty` });
    return;
  }

  const shape = shapeOf(keyFile, text.trim());
  checks.push(
    shape.status === "ok"
      ? { status: "ok", name: "vault key", detail: `${keyFile}, ${shape.detail}, mode 600` }
      : shape
  );
}

/**
 * The proxy's own rule, applied here so the failure lands on an operator's
 * screen instead of in a container's first two seconds.
 *
 * `source` is the variable's name or the file's path, never the value — a
 * master key is the one thing in a deployment that cannot be retyped from
 * anywhere, so it is also the one that must not reach a terminal, a scrollback
 * or an issue.
 */
function shapeOf(source: string, value: string): Check {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    return { status: "fail", name: "vault key", detail: `${source} is not base64` };
  }
  if (decoded.length !== VAULT_KEY_BYTES) {
    return {
      status: "fail",
      name: "vault key",
      detail: `${source} decodes to ${decoded.length} bytes, not ${VAULT_KEY_BYTES}`
    };
  }
  return { status: "ok", name: "vault key", detail: `${VAULT_KEY_BYTES} bytes, base64` };
}

/**
 * The #176 separation, when the environment names the paths at all.
 *
 * The agent must not be able to write where the proxy reads authorization from:
 * the proxy re-reads a team sheet on every call, so an agent that could write
 * to the channels root would be an agent that can widen its own permissions.
 * Under compose those paths are container paths the compose file sets, and this
 * says so rather than passing.
 */
function checkRoots(env: Map<string, string>, checks: Check[], cwd: string): void {
  const names = ["AGENT_CHANNELS_ROOT", "PROXY_CHANNELS_ROOT", "AGENT_STORE_ROOT", "PROXY_STORE_ROOT"] as const;
  const set = names.filter(name => (env.get(name) ?? "") !== "");
  if (set.length === 0) {
    checks.push({
      status: "skip",
      name: "roots",
      detail: "not in this file; compose sets them to /data/channels and /data/store inside the containers"
    });
    return;
  }
  if (set.length !== names.length) {
    checks.push({
      status: "fail",
      name: "roots",
      detail: `${set.length} of 4 set; missing ${names.filter(name => !set.includes(name)).join(", ")}`
    });
    return;
  }

  const at = (name: (typeof names)[number]): string => resolve(cwd, env.get(name) as string);
  const agentChannels = at("AGENT_CHANNELS_ROOT");
  const proxyChannels = at("PROXY_CHANNELS_ROOT");
  const agentStore = at("AGENT_STORE_ROOT");
  const proxyStore = at("PROXY_STORE_ROOT");

  if (agentChannels !== proxyChannels) {
    checks.push({
      status: "fail",
      name: "channels root",
      detail: `the two services read different directories: ${agentChannels} and ${proxyChannels}`
    });
  } else {
    checks.push({ status: "ok", name: "channels root", detail: agentChannels });
  }

  if (agentStore !== proxyStore) {
    checks.push({
      status: "fail",
      name: "store root",
      detail: `two names for one path, and they differ: ${agentStore} and ${proxyStore}`
    });
  } else if (agentStore === agentChannels || agentStore === proxyChannels) {
    checks.push({
      status: "fail",
      name: "store root",
      detail:
        `AGENT_STORE_ROOT is the channels root. The agent writes there, and the ` +
        "proxy reads its authorization there — give the store its own directory"
    });
  } else {
    checks.push({ status: "ok", name: "store root", detail: agentStore });
  }

  // The third root, and optional — absent is a deployment that publishes no
  // shared skills, which is supported (#433). What is refused is the
  // configuration where it is one of the other two.
  //
  // Being the channels root is the channels root's own hazard. Being the *store*
  // root is the one this check exists for: the store root is the directory the
  // agent writes, so a shared skill under it is a file a compromised agent can
  // rewrite — and a poisoned shared skill is read by every channel whose sheet
  // names it, where a poisoned channel-authored one costs the one channel.
  const shared = env.get("AGENT_SHARED_SKILLS_ROOT") ?? "";
  if (shared !== "") {
    const sharedRoot = resolve(cwd, shared);
    if (sharedRoot === agentStore || sharedRoot === proxyStore) {
      checks.push({
        status: "fail",
        name: "shared root",
        detail:
          "AGENT_SHARED_SKILLS_ROOT is the store root. The agent writes there, and a shared " +
          "skill is read by every channel that names it — give it its own read-only directory"
      });
    } else if (sharedRoot === agentChannels || sharedRoot === proxyChannels) {
      checks.push({
        status: "fail",
        name: "shared root",
        detail:
          "AGENT_SHARED_SKILLS_ROOT is the channels root, where the proxy reads its " +
          "authorization — give it its own directory"
      });
    } else {
      checks.push({ status: "ok", name: "shared root", detail: sharedRoot });
    }
  }

  // Writable rather than merely present: SQLite puts a -wal and a -shm beside
  // every database, so a read-only store root fails at the first message rather
  // than at startup.
  if (!existsSync(agentStore)) {
    checks.push({ status: "fail", name: "store writable", detail: `${agentStore} does not exist` });
    return;
  }
  try {
    accessSync(agentStore, constants.W_OK);
    checks.push({ status: "ok", name: "store writable", detail: agentStore });
  } catch {
    checks.push({
      status: "fail",
      name: "store writable",
      detail: `${agentStore} is not writable, and SQLite needs to put -wal and -shm beside each file`
    });
  }
}

function checkCertMaterial(certs: string, checks: Check[]): void {
  for (const [label, path] of [
    ["ca", join(certs, "ca.pem")],
    ["proxy cert", join(certs, "proxy", "server.pem")]
  ] as const) {
    if (!existsSync(path)) {
      checks.push({
        status: "fail",
        name: label,
        detail: `${path} is missing. Mint it with: libero channel add <CHANNEL_ID>`
      });
      continue;
    }
    checks.push(expiry(label, path));
  }

  // The CA key signs certificates, and a process that can mint one can name
  // itself any channel — so it is mounted into neither container. Its being
  // *inside* a directory that is mounted is the mistake worth catching, and the
  // layout scripts/dev-certs.sh writes keeps it out of both.
  for (const mounted of ["agent", "proxy"]) {
    const stray = join(certs, mounted, "ca.key");
    if (existsSync(stray)) {
      checks.push({
        status: "fail",
        name: "ca key",
        detail: `${stray} is inside a directory mounted into a container. A process that can mint certificates can name itself any channel`
      });
      return;
    }
  }
  checks.push({
    status: "ok",
    name: "ca key",
    detail: "outside both mounted directories"
  });
}

function checkChannels(root: string, certs: string, checks: Check[]): Set<string> {
  const named = new Set<string>();
  if (!existsSync(root)) {
    checks.push({
      status: "fail",
      name: "channels",
      detail: `${root} does not exist. Create one with: libero channel add <CHANNEL_ID>`
    });
    return named;
  }

  const ids = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== RESERVED)
    .map(entry => entry.name)
    .sort();

  if (ids.length === 0) {
    checks.push({ status: "fail", name: "channels", detail: `no channel under ${root}` });
    return named;
  }

  const pinned = new Set<string>();
  for (const id of ids) {
    const sheet = join(root, id, "channel.toml");
    if (!existsSync(sheet)) {
      checks.push({ status: "fail", name: id, detail: `no channel.toml in ${join(root, id)}` });
      continue;
    }
    const parsed = parseTeamSheet(readFileSync(sheet, "utf8"));
    if (!parsed.ok) {
      checks.push({
        status: "fail",
        name: id,
        detail:
          parsed.reason === "toml_syntax"
            ? `channel.toml is not valid TOML at line ${parsed.line}, column ${parsed.column}`
            : `channel.toml is not a team sheet: ${parsed.issues.map(issue => `${issue.path} ${issue.code}`).join(", ")}`
      });
      continue;
    }

    const pins = parsed.sheet.channel.certificate_sha256.map(normalizeCertificateSha256);
    for (const pin of pins) pinned.add(pin);
    // Every shared skill any sheet names, in one set: what the shared root has
    // to hold is a property of the deployment rather than of one channel, and
    // two channels naming the same skill need it published once.
    for (const entry of parsed.sheet.shared_skill) named.add(entry.name);

    const pem = join(certs, "agent", `client-${id}.pem`);
    if (!existsSync(pem)) {
      checks.push({
        status: "fail",
        name: id,
        detail: `sheet pins ${pins.length} fingerprint(s) and there is no certificate at ${pem}`
      });
      continue;
    }

    const onDisk = normalizeCertificateSha256(new X509Certificate(readFileSync(pem)).fingerprint256);
    if (!pins.includes(onDisk)) {
      checks.push({
        status: "fail",
        name: id,
        detail: `the certificate on disk is not pinned by its sheet — every call is answered 401. Add it, or rotate: libero channel rotate ${id}`
      });
      continue;
    }
    const expires = expiry(id, pem);
    checks.push(
      expires.status === "ok"
        ? { status: "ok", name: id, detail: `sheet parses, certificate pinned, ${expires.detail}` }
        : expires
    );
  }

  checkStrayCertificates(certs, pinned, checks);
  return named;
}

/**
 * What the sheets ask the shared root for, against what it holds (#433).
 *
 * The **host** directory, resolved from the working directory like every other
 * path this command takes, and not the container path
 * `AGENT_SHARED_SKILLS_ROOT` names under compose. That split is #98's line: the
 * CLI owns what the operator authors on the host, and a shared skill is authored
 * — it arrives by a copy into a git repository, reviewed as a diff. Whether the
 * compose file mounts that directory at the path the variable names is the
 * compose file's business, and `checkRoots` above says the one thing about the
 * variable that can be wrong on the host: which other root it collides with.
 *
 * **A named skill nobody published is the live failure**, and it is quiet: the
 * sheet parses, the deployment starts, and the channel gets a prompt with
 * nothing in it where its brand voice should have been. Nothing at runtime can
 * do better than log it, because by then the file simply is not there.
 *
 * What this does **not** check is whether a published file parses as a skill.
 * That is `packages/schema`'s grammar and the runtime's to apply, and a second
 * opinion here would be a second parser to keep in step with the first.
 */
function checkSharedSkills(root: string, named: Set<string>, checks: Check[]): void {
  if (named.size === 0) {
    checks.push({
      status: "ok",
      name: "shared skills",
      detail: "no sheet names one"
    });
    return;
  }

  const wanted = [...named].sort();
  if (!existsSync(root)) {
    checks.push({
      status: "fail",
      name: "shared skills",
      detail: `${root} does not exist, and ${wanted.length} skill(s) are named by a sheet: ${wanted.join(", ")}`
    });
    return;
  }

  const missing = wanted.filter(name => !existsSync(join(root, `${name}.md`)));
  if (missing.length > 0) {
    checks.push({
      status: "fail",
      name: "shared skills",
      detail: `${root} does not hold ${missing.join(", ")} — a sheet names ${missing.length === 1 ? "it" : "them"} and the channel gets nothing`
    });
    return;
  }

  checks.push({
    status: "ok",
    name: "shared skills",
    detail: `${root}, ${wanted.length} named and published`
  });
}

/**
 * Key material no sheet will accept.
 *
 * The quiet failure: a retired channel or a half-finished rotation leaves a
 * private key on disk that nothing in the running system will ever mention,
 * because the proxy only ever answers questions about certificates that arrive.
 */
function checkStrayCertificates(certs: string, pinned: Set<string>, checks: Check[]): void {
  const agent = join(certs, "agent");
  if (!existsSync(agent)) return;

  const stray: string[] = [];
  for (const entry of readdirSync(agent)) {
    if (!entry.startsWith("client-") || !entry.endsWith(".pem")) continue;
    const path = join(agent, entry);
    const fingerprint = normalizeCertificateSha256(new X509Certificate(readFileSync(path)).fingerprint256);
    if (!pinned.has(fingerprint)) stray.push(basename(path));
  }

  checks.push(
    stray.length === 0
      ? { status: "ok", name: "stray certs", detail: "every certificate on disk is pinned by a sheet" }
      : {
          status: "fail",
          name: "stray certs",
          detail: `no sheet pins ${stray.join(", ")}. Key material nothing will accept — delete it, or pin it`
        }
  );
}

function expiry(name: string, pem: string): Check {
  const validTo = Date.parse(new X509Certificate(readFileSync(pem)).validTo);
  const remaining = validTo - Date.now();
  if (remaining <= 0) return { status: "fail", name, detail: `certificate expired on ${new Date(validTo).toISOString().slice(0, 10)}` };
  const days = Math.floor(remaining / 86_400_000);
  if (remaining < EXPIRY_WARN_MS) {
    return { status: "warn", name, detail: `certificate expires in ${days} day(s). Replace it: libero channel rotate ${name}` };
  }
  return { status: "ok", name, detail: `expires in ${days} days` };
}

/**
 * The one check that needs the deployment running.
 *
 * `/v1/whoami` is the probe the self-hosting page documents, and it proves the
 * whole chain at once: the connection authenticated, the certificate's CN
 * resolved to a channel, and the sheet pins the fingerprint that arrived. It is
 * last because everything above tells you why it failed.
 *
 * Under compose it cannot run from the host at all — the proxy publishes no
 * port, on purpose — so this reports skip with the command that does work.
 */
async function probe(env: Map<string, string>, cwd: string, options: DoctorOptions): Promise<Check> {
  if (options.offline) {
    return { status: "skip", name: "proxy", detail: "--offline" };
  }
  const url = env.get("PROXY_URL") ?? "";
  const certDir = env.get("PROXY_CLIENT_CERT_DIR") ?? "";
  if (url === "" || certDir === "") {
    return {
      status: "skip",
      name: "proxy",
      detail:
        "PROXY_URL is not in this file, and compose publishes no port to the host. Probe it from the network: " +
        "docker compose -f deploy/docker-compose.yml run --rm --entrypoint curl proxy --cacert /etc/libero/certs/ca.pem --cert … https://proxy:8443/v1/whoami"
    };
  }

  const dir = resolve(cwd, certDir);
  const client = existsSync(dir)
    ? readdirSync(dir).find(entry => entry.startsWith("client-") && entry.endsWith(".pem"))
    : undefined;
  if (client === undefined) {
    return { status: "skip", name: "proxy", detail: `no client certificate under ${dir} to present` };
  }
  const channel = client.slice("client-".length, -".pem".length);

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { status: "fail", name: "proxy", detail: `PROXY_URL is not a URL: ${url}` };
  }
  if (target.protocol !== "https:") {
    // The client certificate is the only thing that says which channel is
    // calling, so a plaintext transport would be an unauthenticated one. The
    // proxy checks this at startup; checking it here says so earlier.
    return { status: "fail", name: "proxy", detail: `PROXY_URL must be https, and is ${target.protocol}//` };
  }

  const ca = env.get("PROXY_TLS_CA");
  try {
    const answered = await whoami(target, {
      cert: readFileSync(join(dir, client)),
      key: readFileSync(join(dir, `client-${channel}.key`)),
      ...(ca !== undefined && ca !== "" ? { ca: readFileSync(resolve(cwd, ca)) } : {})
    });
    return answered === channel
      ? { status: "ok", name: "proxy", detail: `${target.origin} answered whoami as ${channel}` }
      : {
          status: "fail",
          name: "proxy",
          detail: `presented ${channel} and the proxy answered ${answered}`
        };
  } catch (error) {
    return { status: "fail", name: "proxy", detail: `${target.origin}: ${messageOf(error)}` };
  }
}

/** GET /v1/whoami, and the channel it answered with. */
function whoami(
  target: URL,
  credentials: { cert: Buffer; key: Buffer; ca?: Buffer }
): Promise<string> {
  return new Promise((fulfil, fail) => {
    const socket = connect(
      {
        host: target.hostname,
        port: Number(target.port === "" ? 443 : target.port),
        servername: target.hostname,
        ...credentials
      },
      () => {
        socket.write(`GET /v1/whoami HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
      }
    );
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      fail(new Error(`no answer in ${PROBE_TIMEOUT_MS}ms`));
    });

    const chunks: Buffer[] = [];
    socket.on("data", chunk => void chunks.push(chunk as Buffer));
    socket.on("error", fail);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1];
      if (status !== "200") {
        fail(new Error(`answered ${status ?? "nothing"}. 401 means the certificate is not pinned by its sheet`));
        return;
      }
      const channel = /"channel"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (channel === undefined) {
        fail(new Error("answered 200 without a channel"));
        return;
      }
      fulfil(channel);
    });
  });
}

function show(cwd: string, file: string): string {
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}
