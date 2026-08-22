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
import { runCli } from "./cli.js";

/**
 * Every variable `init` writes, in the order it writes them.
 *
 * The list is here rather than imported so that adding one to ./init-cli.ts is
 * a test that has to be edited, and the edit is where someone is asked whether
 * a new variable belongs in a file an operator's Slack tokens live in.
 */
const VARIABLES = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AGENT_EMBEDDING_PROVIDER",
  "AGENT_EMBEDDING_MODEL",
  "AGENT_EMBEDDING_API_KEY",
  "AGENT_EMBEDDING_BASE_URL",
  "PROXY_VAULT_KEY",
  "PROXY_PRICE_TABLE",
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
  // ceiling. Scaffolded anyway, because an operator who never opens the compose
  // file should still find the bound on their host in the file they do edit.
  "RUNNER_MAX_CPUS",
  "RUNNER_MAX_MEMORY_MB",
  "RUNNER_MAX_TIMEOUT_SECONDS"
];

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

  it("assigns exactly the variables compose interpolates, and no others", async () => {
    await run(["init"]);

    const text = readFileSync(join(dir, "deploy", ".env"), "utf8");

    expect([...assignedNames(text).keys()]).toEqual(VARIABLES);
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
      "libero: deploy/.env already assigns every variable compose reads",
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
      readFileSync(file, "utf8").split("\n").filter(line => !line.startsWith("OPENAI_API_KEY=")).join("\n")
    );

    const result = await run(["init"]);

    expect(result.out).toContain("libero:   added OPENAI_API_KEY");
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
  it("scaffolds every variable deploy/docker-compose.yml interpolates", async () => {
    // Reaching out of the package is fine: tests never ship, and this is the
    // assertion that catches the compose file growing an eleventh variable
    // that `init` then silently does not write.
    const text = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    const referenced = new Set([...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map(match => match[1] as string));

    expect([...referenced].sort()).toEqual([...VARIABLES].sort());
  });
});
