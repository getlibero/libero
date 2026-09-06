import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./io.js";
import { assignedNames } from "./env-file.js";
import { IMAGE_TAG } from "./version.js";
import { runCli } from "./cli.js";

/**
 * Every variable `init` writes, grouped by what has to be asked for to get it.
 *
 * The lists are here rather than imported so that adding one to ./init-cli.ts is
 * a test that has to be edited, and the edit is where someone is asked whether
 * a new variable belongs in a file an operator's Slack tokens live in. Since
 * #518 the edit asks a second question — which group — and getting that wrong
 * is what "the compose contract" below catches: the union is still exactly the
 * compose file's set, so a variable in no group fails a test.
 */

/** Written whatever the flags say, and in this order. */
const ALWAYS_BEFORE_KEYS = [
  // Which release this deployment runs (#519). First because it is the one
  // variable that is about the deployment rather than about a service in it,
  // and the only one `init` writes a real value into besides the master key.
  "LIBERO_VERSION",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "AGENT_PROVIDER",
  "AGENT_MODEL"
];

const ANTHROPIC = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];

/** Also written under --profile litellm, which is keyed by OPENAI_API_KEY. */
const OPENAI = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];

// The LiteLLM sidecar (#428, #479). Blank for the runner's first reason: the
// sidecar shape needs a provider key and nobody can guess which. In that shape
// OPENAI_API_KEY above stops being a provider key and becomes the sidecar's, so
// these two are where the provider keys go — on a service the agent's own
// variables never reach.
const LITELLM = ["LITELLM_ANTHROPIC_API_KEY", "LITELLM_OPENAI_API_KEY"];

/** In the order `template()` writes them: the proxy's, then the agent's. */
const TUNABLES = [
  "PROXY_MAX_PENDING_SCHEDULED_TASKS",
  "PROXY_MAX_RESPONSE_BYTES",
  "PROXY_MAX_UPSTREAM_CONCURRENCY",
  "PROXY_MAX_SANDBOX_CONCURRENCY",
  "PROXY_UPSTREAM_TIMEOUT_MS",
  "AGENT_RECALL_LIMIT",
  "AGENT_RECALL_MAX_CHARS",
  "AGENT_SKILLS_MAX_CHARS",
  "AGENT_MAX_OPEN_PROPOSALS",
  "AGENT_SKILL_LIFECYCLE_INTERVAL_MS",
  "AGENT_HEARTBEAT_POST_WINDOW_MS"
];

/** Written whatever the flags say, and after the completion keys. */
const ALWAYS_AFTER_KEYS = [
  "AGENT_EMBEDDING_PROVIDER",
  "AGENT_EMBEDDING_MODEL",
  "AGENT_EMBEDDING_API_KEY",
  "AGENT_EMBEDDING_BASE_URL",
  "PROXY_VAULT_KEY",
  "PROXY_PRICE_TABLE",
  // The limits a deployment may move (#539). Blank, every one — blank means the
  // figure the code already argues for, so an operator who reads past this block
  // and changes nothing has changed nothing. They are scaffolded rather than
  // omitted because a variable nobody can see is a variable nobody knows they
  // have, which is `[memory] enabled`'s argument applied to an env file.
  ...TUNABLES
];

const RUNNER = [
  // The sandbox (#395). Three, and they arrive together: an image nobody chose,
  // a pin nobody can guess, and a group id that differs between hosts. Each is
  // blank in the scaffold on purpose — the runner refuses to start without them,
  // which is the intended failure rather than an oversight.
  "RUNNER_SANDBOX_IMAGE",
  "RUNNER_CLIENT_PIN",
  "DOCKER_GID",
  // The deployment's ceiling over what a sheet may ask a run to have (#405).
  // Blank for a different reason from the three above: those have no usable
  // default and the runner refuses to start, and these have one — compose
  // interpolates `:-`, so an empty line is the shipped number rather than no
  // ceiling. Scaffolded anyway once the profile is asked for, because an
  // operator who never opens the compose file should still find the bound on
  // their host in the file they do edit.
  "RUNNER_MAX_CPUS",
  "RUNNER_MAX_MEMORY_MB",
  "RUNNER_MAX_TIMEOUT_SECONDS"
];

/** What the default run writes: anthropic, and neither optional service. */
const VARIABLES = [...ALWAYS_BEFORE_KEYS, ...ANTHROPIC, ...ALWAYS_AFTER_KEYS];

let dir: string;

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

/** The working directory is a field, so no test ever has to `process.chdir`. */
async function run(argv: string[], cwd: string = dir): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv,
    cwd,
    out: line => void out.push(line),
    err: line => void err.push(line)
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

function compose(at: string): string {
  mkdirSync(join(dir, at), { recursive: true });
  const file = join(dir, at, "docker-compose.yml");
  writeFileSync(file, "services: {}\n");
  return file;
}

function valueOf(text: string, name: string): string | undefined {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(text);
  return match?.[1];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-cli-init-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("where the file goes", () => {
  it("writes deploy/.env when the compose file is under deploy/", async () => {
    compose("deploy");

    const result = await run(["init"]);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(join(dir, "deploy", ".env"))).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("writes ./.env when the compose file is the working directory's own", async () => {
    compose(".");

    const result = await run(["init"]);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(join(dir, ".env"))).toBe(true);
  });

  it("prefers deploy/ when both exist, because that is this repository's shape", async () => {
    compose(".");
    compose("deploy");

    await run(["init"]);

    expect(existsSync(join(dir, "deploy", ".env"))).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  it("fails, writing nothing, when there is no compose file to sit beside", async () => {
    const result = await run(["init"]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("\n")).toContain("no compose file under deploy/");
    expect(result.err.join("\n")).toContain("--file");
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(existsSync(join(dir, "deploy", ".env"))).toBe(false);
  });

  it("--file overrides the search entirely", async () => {
    const result = await run(["init", "--file", "elsewhere.env"]);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(join(dir, "elsewhere.env"))).toBe(true);
  });
});

describe("what it writes", () => {
  beforeEach(() => {
    compose("deploy");
  });

  it("reports the file, the key, and what is left to do", async () => {
    const result = await run(["init"]);

    expect(result.out).toEqual([
      "libero: wrote deploy/.env",
      "libero: generated PROXY_VAULT_KEY",
      "",
      "Fill SLACK_APP_TOKEN, SLACK_BOT_TOKEN and ANTHROPIC_API_KEY in deploy/.env, then:",
      "  libero channel add <CHANNEL_ID>",
      "  docker compose -f deploy/docker-compose.yml up"
    ]);
  });

  it("assigns exactly the variables this shape reads, and no others", async () => {
    await run(["init"]);

    const text = readFileSync(join(dir, "deploy", ".env"), "utf8");

    expect([...assignedNames(text).keys()]).toEqual(VARIABLES);
  });

  // #519. The compose file interpolates this into all three `image:` lines, so
  // a deployment scaffolded by one release does not silently start running
  // another one the next time its daemon pulls.
  it("pins the three images to the release that wrote the file", async () => {
    await run(["init"]);

    const text = readFileSync(join(dir, "deploy", ".env"), "utf8");

    expect(valueOf(text, "LIBERO_VERSION")).toBe(IMAGE_TAG);
  });

  // The rule the whole file is written to, applied to the one line an upgrade
  // moves: a re-run with a newer CLI must not decide on its own that this
  // deployment now runs a different release.
  it("does not move a pin that is already there", async () => {
    await run(["init"]);
    const before = readFileSync(join(dir, "deploy", ".env"), "utf8").replace(
      `LIBERO_VERSION=${IMAGE_TAG}`,
      "LIBERO_VERSION=v0.1.0"
    );
    writeFileSync(join(dir, "deploy", ".env"), before);

    await run(["init"]);

    expect(valueOf(readFileSync(join(dir, "deploy", ".env"), "utf8"), "LIBERO_VERSION")).toBe("v0.1.0");
  });

  it("leaves the file readable only by its owner", async () => {
    await run(["init"]);

    expect(statSync(join(dir, "deploy", ".env")).mode & 0o777).toBe(0o600);
  });

  it("fills the two variables compose refuses to start without", async () => {
    await run(["init"]);

    const text = readFileSync(join(dir, "deploy", ".env"), "utf8");

    expect(valueOf(text, "AGENT_MODEL")).not.toBe("");
    expect(valueOf(text, "PROXY_VAULT_KEY")).not.toBe("");
  });

  it("generates a key that decodes to 32 bytes, and a different one each run", async () => {
    await run(["init"]);
    const first = valueOf(readFileSync(join(dir, "deploy", ".env"), "utf8"), "PROXY_VAULT_KEY") as string;

    rmSync(join(dir, "deploy", ".env"));
    await run(["init"]);
    const second = valueOf(readFileSync(join(dir, "deploy", ".env"), "utf8"), "PROXY_VAULT_KEY") as string;

    expect(Buffer.from(first, "base64")).toHaveLength(32);
    expect(second).not.toBe(first);
  });

  it("never prints the master key", async () => {
    // A key on stdout is a key in scrollback, in a CI log, and in the terminal
    // dump someone pastes into an issue. It goes to a 0600 file and nowhere
    // else.
    const result = await run(["init"]);
    const key = valueOf(readFileSync(join(dir, "deploy", ".env"), "utf8"), "PROXY_VAULT_KEY") as string;

    expect(result.text).not.toContain(key);
  });

  it("writes no credential-shaped value", async () => {
    await run(["init"]);

    const text = readFileSync(join(dir, "deploy", ".env"), "utf8");
    const assignments = text.split("\n").filter(line => /^[A-Z_]+=/.test(line));

    expect(assignments.join("\n")).not.toMatch(/xoxb-|xapp-|ghp_|sk-ant-/);
  });

  it("takes the provider and the model from the flags", async () => {
    await run(["init", "--provider", "openai-compatible", "--model", "llama-3.3-70b"]);

    const text = readFileSync(join(dir, "deploy", ".env"), "utf8");

    expect(valueOf(text, "AGENT_PROVIDER")).toBe("openai-compatible");
    expect(valueOf(text, "AGENT_MODEL")).toBe("llama-3.3-70b");
  });

  it("names the key for the provider that was chosen", async () => {
    const result = await run(["init", "--provider", "openai-compatible"]);

    expect(result.text).toContain("OPENAI_API_KEY");
    expect(result.text).not.toContain("ANTHROPIC_API_KEY in");
  });
});

describe("what the shape asked for decides", () => {
  beforeEach(() => {
    compose("deploy");
  });

  it("writes one provider's pair and not the other's", async () => {
    await run(["init", "--provider", "openai-compatible"]);

    const written = [...assignedNames(readFileSync(join(dir, "deploy", ".env"), "utf8")).keys()];

    expect(written).toEqual([...ALWAYS_BEFORE_KEYS, ...OPENAI, ...ALWAYS_AFTER_KEYS]);
  });

  it("leaves both optional services out unless they are asked for", async () => {
    // The complaint in #518: about fifteen assignments an operator has to learn
    // not to fill, for two services they are not running.
    await run(["init"]);

    const written = new Set(assignedNames(readFileSync(join(dir, "deploy", ".env"), "utf8")).keys());

    for (const name of [...LITELLM, ...RUNNER]) expect(written.has(name)).toBe(false);
  });

  each([
    ["litellm", LITELLM, RUNNER],
    ["runner", RUNNER, LITELLM]
  ])("writes %s's block under its own --profile and not the other's", async (profile, wanted, other) => {
    await run(["init", "--profile", profile as string]);

    const written = new Set(assignedNames(readFileSync(join(dir, "deploy", ".env"), "utf8")).keys());

    for (const name of wanted as string[]) expect(written.has(name)).toBe(true);
    for (const name of other as string[]) expect(written.has(name)).toBe(false);
  });

  it("writes the OPENAI pair for the sidecar under either provider", async () => {
    // The sidecar is reached over OPENAI_BASE_URL and keyed by OPENAI_API_KEY,
    // so scaffolding it without them would stand a gateway up with no way to
    // point the agent at it.
    await run(["init", "--provider", "anthropic", "--profile", "litellm"]);

    const written = new Set(assignedNames(readFileSync(join(dir, "deploy", ".env"), "utf8")).keys());

    for (const name of OPENAI) expect(written.has(name)).toBe(true);
  });

  it("writes a profile's block on a re-run that asks for it, and touches nothing else", async () => {
    await run(["init"]);
    const before = readFileSync(join(dir, "deploy", ".env"), "utf8");

    const result = await run(["init", "--profile", "runner"]);
    const after = readFileSync(join(dir, "deploy", ".env"), "utf8");

    expect(after.startsWith(before.trimEnd())).toBe(true);
    for (const name of RUNNER) expect(result.out.join("\n")).toContain(`added ${name}`);
  });

  it("renders a repeated or reordered profile once, in one order", async () => {
    await run(["init", "--profile", "runner", "--profile", "litellm", "--profile", "runner"]);
    const both = readFileSync(join(dir, "deploy", ".env"), "utf8");

    rmSync(join(dir, "deploy", ".env"));
    await run(["init", "--profile", "litellm", "--profile", "runner"]);
    const once = readFileSync(join(dir, "deploy", ".env"), "utf8");

    const names = (text: string): string[] => [...assignedNames(text).keys()];
    expect(names(both)).toEqual(names(once));
    expect(names(both)).toHaveLength(new Set(names(both)).size);
  });

  it("puts every profile it scaffolded on the compose line it prints", async () => {
    const result = await run(["init", "--profile", "litellm", "--profile", "runner"]);

    expect(result.out.at(-1)).toBe(
      "  docker compose -f deploy/docker-compose.yml --profile litellm --profile runner up"
    );
  });

  it("refuses a profile it does not have, writing nothing", async () => {
    const result = await run(["init", "--profile", "temporal"]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain("libero: not a profile: temporal");
    expect(existsSync(join(dir, "deploy", ".env"))).toBe(false);
  });
});

describe("the compose file it names", () => {
  // #516: `findCompose` accepts deploy/ or this directory and four filenames,
  // and everything init printed said deploy/docker-compose.yml regardless — so
  // the operator with their own compose.yaml was told to run a file that is
  // not there.
  it("drops the -f when the compose file is this directory's own", async () => {
    writeFileSync(join(dir, "compose.yaml"), "services: {}\n");

    const result = await run(["init"]);

    expect(result.out.at(-1)).toBe("  docker compose up");
    expect(result.text).not.toContain("deploy/docker-compose.yml");
  });

  it("names the file it found in the header it writes", async () => {
    writeFileSync(join(dir, "compose.yaml"), "services: {}\n");

    await run(["init"]);
    const text = readFileSync(join(dir, ".env"), "utf8");

    expect(text).toContain("the environment compose.yaml reads");
    expect(text).not.toContain("deploy/docker-compose.yml");
  });

  it("names it in the --key-file step too", async () => {
    writeFileSync(join(dir, "compose.yaml"), "services: {}\n");

    const result = await run(["init", "--key-file", "secrets/vault.key"]);

    expect(result.text).toContain("In compose.yaml,");
  });

  it("names no file at all when --file was given and there is none to find", async () => {
    const result = await run(["init", "--file", "custom.env"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.at(-1)).toBe("  docker compose up");
    expect(readFileSync(join(dir, "custom.env"), "utf8")).toContain("the environment the compose file reads");
  });
});

describe("re-running", () => {
  beforeEach(() => {
    compose("deploy");
  });

  it("changes nothing, and says so, on a file it already wrote", async () => {
    await run(["init"]);
    const before = readFileSync(join(dir, "deploy", ".env"), "utf8");

    const result = await run(["init"]);

    expect(result.code).toBe(EXIT_OK);
    expect(readFileSync(join(dir, "deploy", ".env"), "utf8")).toBe(before);
    expect(result.out).toEqual([
      "libero: deploy/.env already assigns every variable this deployment reads",
      "libero: nothing written"
    ]);
  });

  it("keeps an operator's comments and every value they set", async () => {
    const file = join(dir, "deploy", ".env");
    writeFileSync(file, "# my own note\nSLACK_APP_TOKEN=xapp-mine\nPROXY_VAULT_KEY=mine\n");

    const result = await run(["init"]);
    const text = readFileSync(file, "utf8");

    expect(result.code).toBe(EXIT_OK);
    expect(text).toContain("# my own note");
    expect(valueOf(text, "SLACK_APP_TOKEN")).toBe("xapp-mine");
    expect(valueOf(text, "PROXY_VAULT_KEY")).toBe("mine");
  });

  it("appends every absent name exactly once", async () => {
    const file = join(dir, "deploy", ".env");
    writeFileSync(file, "SLACK_APP_TOKEN=xapp-mine\n");

    await run(["init"]);
    const text = readFileSync(file, "utf8");

    for (const name of VARIABLES) {
      expect([...text.matchAll(new RegExp(`^${name}=`, "gm"))]).toHaveLength(1);
    }
  });

  it("fills an empty vault key and leaves an empty token empty", async () => {
    const file = join(dir, "deploy", ".env");
    writeFileSync(file, "PROXY_VAULT_KEY=\nSLACK_APP_TOKEN=\n");

    const result = await run(["init"]);
    const text = readFileSync(file, "utf8");

    expect(valueOf(text, "PROXY_VAULT_KEY")).not.toBe("");
    expect(valueOf(text, "SLACK_APP_TOKEN")).toBe("");
    expect(result.out).toContain("libero: generated PROXY_VAULT_KEY");
  });

  it("does not regenerate a key on a run that does write", async () => {
    // The merge path, not the no-op one: a variable is missing, so the file is
    // rewritten — and the key still has to come through untouched.
    const file = join(dir, "deploy", ".env");
    await run(["init"]);
    const key = valueOf(readFileSync(file, "utf8"), "PROXY_VAULT_KEY") as string;
    writeFileSync(
      file,
      readFileSync(file, "utf8").split("\n").filter(line => !line.startsWith("ANTHROPIC_API_KEY=")).join("\n")
    );

    const result = await run(["init"]);

    expect(result.out).toContain("libero:   added ANTHROPIC_API_KEY");
    expect(result.out).not.toContain("libero: generated PROXY_VAULT_KEY");
    expect(valueOf(readFileSync(file, "utf8"), "PROXY_VAULT_KEY")).toBe(key);
  });

  it("leaves no temporary file behind", async () => {
    writeFileSync(join(dir, "deploy", ".env"), "SLACK_APP_TOKEN=xapp-mine\n");

    await run(["init"]);

    expect(readdirSync(join(dir, "deploy")).sort()).toEqual([".env", "docker-compose.yml"]);
  });

  // The rewrite goes through `replaceFileAtomically`, and these are the two
  // things that would still be true if it went back to a bare write. The mode
  // matters because the merged file carries the key an operator cannot retype;
  // the inode is the observable signature of write-temp-then-rename, and #272 is
  // here because the version this replaced renamed without fsyncing anything.
  it("leaves a rewritten file readable only by its owner", async () => {
    const file = join(dir, "deploy", ".env");
    writeFileSync(file, "SLACK_APP_TOKEN=xapp-mine\n", { mode: 0o644 });

    await run(["init"]);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("lands the rewrite by rename, so the inode changes", async () => {
    const file = join(dir, "deploy", ".env");
    writeFileSync(file, "SLACK_APP_TOKEN=xapp-mine\n");
    const before = statSync(file).ino;

    await run(["init"]);

    expect(statSync(file).ino).not.toBe(before);
  });
});

/**
 * `--key-file`: the master key one directory over instead of in the env file
 * (#495).
 *
 * The property under test is that there is never more than one master key. The
 * proxy refuses to start on two sources, and every case here is about this
 * command not being the thing that creates the second one.
 */
describe("--key-file", () => {
  const KEY_FILE = "deploy/secrets/vault.key";

  beforeEach(() => {
    compose("deploy");
  });

  it("writes the key to the file and no PROXY_VAULT_KEY line at all", async () => {
    const result = await run(["init", "--key-file", KEY_FILE]);

    expect(result.code).toBe(EXIT_OK);
    const env = readFileSync(join(dir, "deploy", ".env"), "utf8");
    expect(assignedNames(env).has("PROXY_VAULT_KEY")).toBe(false);
    const key = readFileSync(join(dir, KEY_FILE), "utf8").trim();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(Buffer.from(key, "base64").toString("base64")).toBe(key);
  });

  it("writes it owner-only", async () => {
    await run(["init", "--key-file", KEY_FILE]);

    expect(statSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  it("says where the key went and what compose still needs", async () => {
    const result = await run(["init", "--key-file", KEY_FILE]);

    expect(result.out).toContain(`libero: generated PROXY_VAULT_KEY in ${KEY_FILE}, mode 0600`);
    expect(result.out.join("\n")).toContain("PROXY_VAULT_KEY_FILE");
    expect(result.out.join("\n")).toContain("comment out PROXY_VAULT_KEY");
  });

  it("never prints the key", async () => {
    const result = await run(["init", "--key-file", KEY_FILE]);

    expect(result.text).not.toContain(readFileSync(join(dir, KEY_FILE), "utf8").trim());
  });

  // The same rule the env file has, for the same reason: there is no escrow, so
  // a second key at a path that already holds one discards a vault.
  it("refuses a path that already holds a key, and leaves it alone", async () => {
    await run(["init", "--key-file", KEY_FILE]);
    const first = readFileSync(join(dir, KEY_FILE), "utf8");

    const result = await run(["init", "--key-file", KEY_FILE]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("\n")).toContain("already exists");
    expect(readFileSync(join(dir, KEY_FILE), "utf8")).toBe(first);
  });

  // The two-sources case, refused here rather than left for the proxy to refuse
  // at `docker compose up` with two keys already on disk.
  it("refuses when the env file already assigns PROXY_VAULT_KEY", async () => {
    await run(["init"]);

    const result = await run(["init", "--key-file", KEY_FILE]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("\n")).toContain("already assigns PROXY_VAULT_KEY");
    expect(existsSync(join(dir, KEY_FILE))).toBe(false);
  });

  // An empty assignment is a deployment that has not chosen yet, which is what
  // `.env.example` ships and what a half-filled file looks like.
  it("allows an env file whose PROXY_VAULT_KEY line is empty", async () => {
    writeFileSync(join(dir, "deploy", ".env"), "PROXY_VAULT_KEY=\n");

    const result = await run(["init", "--key-file", KEY_FILE]);

    expect(result.code).toBe(EXIT_OK);
    expect(existsSync(join(dir, KEY_FILE))).toBe(true);
    expect(valueOf(readFileSync(join(dir, "deploy", ".env"), "utf8"), "PROXY_VAULT_KEY")).toBe("");
  });

  it("creates the directory it was pointed at", async () => {
    await run(["init", "--key-file", "somewhere/deeper/vault.key"]);

    expect(existsSync(join(dir, "somewhere/deeper/vault.key"))).toBe(true);
  });
});

describe("bad arguments", () => {
  beforeEach(() => {
    compose("deploy");
  });

  each([
    [["init", "--provider", "gemini"], "not a provider"],
    [["init", "--model", "(unreported)"], "not a model id"],
    [["init", "extra"], "takes no arguments"],
    [["init", "--fil", "x"], "unknown option"]
  ])("%s exits 2 and writes nothing", async (argv, expected) => {
    const result = await run([...argv]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain(expected as string);
    expect(existsSync(join(dir, "deploy", ".env"))).toBe(false);
  });

  it("prints init's own usage for --help, and exits 0", async () => {
    const result = await run(["init", "--help"]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("\n")).toContain("usage: libero init");
    expect(existsSync(join(dir, "deploy", ".env"))).toBe(false);
  });
});

describe("the compose contract", () => {
  it("can scaffold every variable deploy/docker-compose.yml interpolates, and no other", async () => {
    // Reaching out of the package is fine: tests never ship, and this is the
    // assertion that catches the compose file growing a variable that `init`
    // then silently does not write. Since #518 what it holds is the UNION over
    // the flags rather than what any one run produces — a variable put in no
    // group is one no combination of flags can scaffold, which fails here.
    const text = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    const referenced = new Set([...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map(match => match[1] as string));
    const union = [...ALWAYS_BEFORE_KEYS, ...ANTHROPIC, ...OPENAI, ...LITELLM, ...ALWAYS_AFTER_KEYS, ...RUNNER];

    expect([...referenced].sort()).toEqual([...union].sort());
  });

  it("scaffolds them all when every flag is given", async () => {
    // The union is a claim about the flags, not only about the lists above, so
    // it is also run through the command.
    compose("deploy");
    await run(["init", "--provider", "openai-compatible", "--profile", "litellm", "--profile", "runner"]);

    const text = readFileSync(join(dir, "deploy", ".env"), "utf8");
    const written = new Set(assignedNames(text).keys());
    const composeText = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    const referenced = [...composeText.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map(match => match[1] as string);

    // Every one but the Anthropic pair, which no openai-compatible deployment
    // reads and which --provider anthropic is how you ask for.
    expect([...referenced].filter(name => !written.has(name)).sort()).toEqual(ANTHROPIC);
  });
});
