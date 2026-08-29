import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after as afterAll, before as beforeAll, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./io.js";
import { runChannelCommand } from "./channel-cli.js";
import { runDoctorCommand } from "./doctor-cli.js";

const SCRIPT = fileURLToPath(new URL("../../../scripts/dev-certs.sh", import.meta.url));
const CHANNEL = "C0DOCTOR";

/** An env file that passes every check it can, for tests to break one at a time. */
const HEALTHY: Readonly<Record<string, string>> = {
  SLACK_APP_TOKEN: "xapp-1-A00000000-0000000000000-0000",
  SLACK_BOT_TOKEN: "xoxb-0000000000-0000000000000-000000000000",
  AGENT_PROVIDER: "anthropic",
  AGENT_MODEL: "claude-sonnet-4-6",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_BASE_URL: "",
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  PROXY_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
  PROXY_PRICE_TABLE: ""
};

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

let master: string;
let dir: string;

async function doctor(argv: string[] = []): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  // No `--offline` is forced: the default env file names no PROXY_URL, so the
  // probe skips itself without touching the network. The tests that want it to
  // run supply a file that does.
  const code = await runDoctorCommand(
    { argv: ["doctor", ...argv], cwd: dir, out: line => void out.push(line), err: line => void err.push(line) },
    argv
  );
  return { code, out, err, text: [...out, ...err].join("\n") };
}

/**
 * One check's line, by exact name.
 *
 * The name column is padded and separated from the detail by two spaces, and a
 * name never contains two in a row — so the columns split unambiguously. Doing
 * this by prefix would silently match "proxy cert" when asked for "proxy",
 * which is how the probe's tests first passed while asserting nothing.
 */
function check(run: Run, name: string): { status: string; detail: string } {
  for (const line of run.out) {
    const columns = /^(\S+)\s+(.+?)\s{2,}(.*)$/.exec(line);
    if (columns !== null && columns[2] === name) {
      return { status: columns[1] as string, detail: columns[3] as string };
    }
  }
  throw new Error(`no check named ${name} in:\n${run.out.join("\n")}`);
}

function writeEnv(values: Record<string, string>, name = join("deploy", ".env")): void {
  writeFileSync(
    join(dir, name),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
  );
}

function sheetPath(): string {
  return join(dir, "channels", CHANNEL, "channel.toml");
}

function repin(fingerprint: string): void {
  writeFileSync(sheetPath(), readFileSync(sheetPath(), "utf8").replace(/"[0-9A-F:]{95}"/, `"${fingerprint}"`));
}

/** Adds a [[shared_skill]] entry to the fixture's sheet, as an operator would. */
function nameSharedSkill(name: string, load: "always" | "retrieved" = "retrieved"): void {
  writeFileSync(
    sheetPath(),
    `${readFileSync(sheetPath(), "utf8")}\n[[shared_skill]]\nname = "${name}"\nload = "${load}"\n`
  );
}

/** Publishes one into the host-side shared root, as a vendoring step would. */
function publishSharedSkill(name: string, root = "shared-skills"): void {
  mkdirSync(join(dir, root), { recursive: true });
  writeFileSync(
    join(dir, root, `${name}.md`),
    `---\nname: ${name}\ndescription: How this company writes.\ncreated: 2026-01-01\nstatus: active\n---\n\nSay it plainly.\n`
  );
}

const OTHER_PIN = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

beforeAll(() => {
  // Minted once. Every test works on a copy, so the RSA keygen is paid for by
  // this file rather than by each case.
  master = mkdtempSync(join(tmpdir(), "libero-cli-doctor-master-"));
  mkdirSync(join(master, "deploy"), { recursive: true });
  writeFileSync(join(master, "deploy", "docker-compose.yml"), "services: {}\n");
  const code = runChannelCommand(
    { argv: [], cwd: master, out: () => {}, err: () => {} },
    ["add", CHANNEL],
    { script: SCRIPT }
  );
  expect(code).toBe(EXIT_OK);
});

afterAll(() => {
  rmSync(master, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-cli-doctor-"));
  cpSync(master, dir, { recursive: true });
  writeEnv(HEALTHY);
});

describe("a deployment with nothing wrong with it", () => {
  it("passes every check it can run, and exits 0", async () => {
    const result = await doctor();

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.filter(line => line.startsWith("fail"))).toEqual([]);
    expect(check(result, CHANNEL).status).toBe("ok");
    expect(check(result, "vault key").status).toBe("ok");
    expect(check(result, "stray certs").status).toBe("ok");
  });

  it("writes nothing", async () => {
    // Read-only is the point: the two things most worth checking here are a
    // master key and the fingerprints a sheet pins, and a doctor that repaired
    // either could destroy a vault or widen a channel's authorization.
    const before = tree(dir);

    await doctor();

    expect(tree(dir)).toEqual(before);
  });

  it("prints no credential", async () => {
    const result = await doctor();

    expect(result.text).not.toContain(HEALTHY["PROXY_VAULT_KEY"] as string);
    expect(result.text).not.toContain(HEALTHY["ANTHROPIC_API_KEY"] as string);
    expect(result.text).not.toContain(HEALTHY["SLACK_BOT_TOKEN"] as string);
  });
});

/**
 * The master key from a file rather than from the environment (#495).
 *
 * `--key-file` names the **host** path — what `init --key-file` writes and what
 * the compose file's `secrets:` block mounts — not the container path
 * `PROXY_VAULT_KEY_FILE` carries, which is unreadable from here.
 */
describe("the master key in a file", () => {
  const KEY_FILE = join("deploy", "secrets", "vault.key");
  const KEY = Buffer.alloc(32, 9).toString("base64");

  /** As `init --key-file` leaves it: trailing newline, owner-only. */
  function writeKeyFile(contents = `${KEY}\n`, mode = 0o600): void {
    mkdirSync(join(dir, "deploy", "secrets"), { recursive: true });
    writeFileSync(join(dir, KEY_FILE), contents, { mode });
    chmodSync(join(dir, KEY_FILE), mode);
  }

  /** The env file a --key-file deployment has: no PROXY_VAULT_KEY line. */
  function envWithoutKey(): void {
    writeEnv(
      Object.fromEntries(Object.entries(HEALTHY).filter(([name]) => name !== "PROXY_VAULT_KEY"))
    );
  }

  it("passes on a key file and no variable", async () => {
    envWithoutKey();
    writeKeyFile();

    const result = await doctor(["--key-file", KEY_FILE]);

    expect(result.code).toBe(EXIT_OK);
    expect(check(result, "vault key").status).toBe("ok");
    expect(check(result, "vault key").detail).toContain("32 bytes, base64");
  });

  it("prints no part of the key", async () => {
    envWithoutKey();
    writeKeyFile();

    const result = await doctor(["--key-file", KEY_FILE]);

    expect(result.text).not.toContain(KEY);
  });

  // The trap a precedence rule would set, and the one the proxy refuses to
  // start on: two keys, one of which opens the vault.
  it("fails on both a variable and a file", async () => {
    writeKeyFile();

    const result = await doctor(["--key-file", KEY_FILE]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "vault key").status).toBe("fail");
    expect(check(result, "vault key").detail).toContain("Exactly one");
  });

  it("fails when neither is there, naming both answers", async () => {
    envWithoutKey();

    const result = await doctor(["--key-file", KEY_FILE]);

    expect(check(result, "vault key").status).toBe("fail");
    expect(check(result, "vault key").detail).toContain("PROXY_VAULT_KEY is empty");
    expect(check(result, "vault key").detail).toContain(KEY_FILE);
  });

  // A `fail` and not a `warn`: the file form buys the key out of `docker
  // inspect` and a mode every account on the host can read gives that back,
  // leaving a deployment worse off than one that never moved the key.
  it("fails on a key file readable beyond its owner", async () => {
    envWithoutKey();
    writeKeyFile(`${KEY}\n`, 0o644);

    const result = await doctor(["--key-file", KEY_FILE]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "vault key").status).toBe("fail");
    expect(check(result, "vault key").detail).toContain("chmod 600");
  });

  each([
    ["empty", "\n", "is empty"],
    ["not base64", "hunter2!!!!hunter2!!!!\n", "not base64"],
    ["the wrong length", `${Buffer.alloc(16).toString("base64")}\n`, "decodes to 16 bytes"]
  ])("fails on a key file that is %s", async (_label, contents, expected) => {
    envWithoutKey();
    writeKeyFile(contents as string);

    const result = await doctor(["--key-file", KEY_FILE]);

    expect(check(result, "vault key").status).toBe("fail");
    expect(check(result, "vault key").detail).toContain(expected as string);
  });

  // What `docker run -v` against a path that did not exist leaves behind.
  it("fails on a directory where the key should be", async () => {
    envWithoutKey();
    mkdirSync(join(dir, KEY_FILE), { recursive: true });

    const result = await doctor(["--key-file", KEY_FILE]);

    expect(check(result, "vault key").status).toBe("fail");
    expect(check(result, "vault key").detail).toContain("not a regular file");
  });

  // The default is the path init writes and the compose file names, so a
  // deployment that took the documented layout needs no flag.
  it("looks under deploy/secrets/vault.key with no flag", async () => {
    envWithoutKey();
    writeKeyFile();

    const result = await doctor();

    expect(check(result, "vault key").status).toBe("ok");
  });

  it("still writes nothing", async () => {
    envWithoutKey();
    writeKeyFile();
    const before = tree(dir);

    await doctor(["--key-file", KEY_FILE]);

    expect(tree(dir)).toEqual(before);
  });
});

describe("the environment file", () => {
  it("fails, naming init, when there is none", async () => {
    rmSync(join(dir, "deploy", ".env"));

    const result = await doctor();

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "env file").status).toBe("fail");
    expect(check(result, "env file").detail).toContain("libero init");
  });

  each([
    [{ AGENT_MODEL: "" }, "AGENT_MODEL", "empty"],
    [{ AGENT_MODEL: "(unreported)" }, "AGENT_MODEL", "not a model id"],
    [{ AGENT_PROVIDER: "gemini" }, "AGENT_PROVIDER", "not a provider"],
    [{ AGENT_PROVIDER: "" }, "AGENT_PROVIDER", "empty"],
    [{ SLACK_APP_TOKEN: "" }, "SLACK_APP_TOKEN", "empty"],
    [{ PROXY_VAULT_KEY: "" }, "vault key", "empty"],
    [{ PROXY_VAULT_KEY: "not base64!!" }, "vault key", "not base64"],
    [{ PROXY_VAULT_KEY: Buffer.alloc(16).toString("base64") }, "vault key", "decodes to 16 bytes"]
  ])("fails on %o", async (override, name, expected) => {
    writeEnv({ ...HEALTHY, ...(override as Record<string, string>) });

    const result = await doctor();

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, name as string).status).toBe("fail");
    expect(check(result, name as string).detail).toContain(expected as string);
  });

  it("fails when the key set is not the provider chosen", async () => {
    writeEnv({ ...HEALTHY, AGENT_PROVIDER: "openai-compatible" });

    const result = await doctor();

    expect(check(result, "provider key").status).toBe("fail");
    expect(check(result, "provider key").detail).toContain("OPENAI_API_KEY is empty");
  });

  it("warns, without failing, on a token in the wrong variable", async () => {
    writeEnv({ ...HEALTHY, SLACK_APP_TOKEN: HEALTHY["SLACK_BOT_TOKEN"] as string });

    const result = await doctor();

    expect(check(result, "SLACK_APP_TOKEN").status).toBe("warn");
    expect(check(result, "SLACK_APP_TOKEN").detail).toContain("xapp-");
    expect(result.code).toBe(EXIT_OK);
  });
});

describe("the roots", () => {
  it("skips them, saying where compose sets them, when the file does not", async () => {
    const result = await doctor();

    expect(check(result, "roots").status).toBe("skip");
    expect(check(result, "roots").detail).toContain("/data/channels");
    expect(result.code).toBe(EXIT_OK);
  });

  it("fails when the store root is the channels root", async () => {
    // #176: the proxy re-reads a team sheet on every call, so an agent that
    // can write to the channels root can widen its own permissions.
    writeEnv(
      {
        AGENT_CHANNELS_ROOT: "channels",
        PROXY_CHANNELS_ROOT: "channels",
        AGENT_STORE_ROOT: "channels",
        PROXY_STORE_ROOT: "channels"
      },
      "direct.env"
    );

    const result = await doctor(["--file", "direct.env"]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "store root").status).toBe("fail");
    expect(check(result, "store root").detail).toContain("AGENT_STORE_ROOT is the channels root");
  });

  it("fails when the two services read different channels roots", async () => {
    writeEnv(
      {
        AGENT_CHANNELS_ROOT: "channels",
        PROXY_CHANNELS_ROOT: "elsewhere",
        AGENT_STORE_ROOT: "store",
        PROXY_STORE_ROOT: "store"
      },
      "direct.env"
    );

    const result = await doctor(["--file", "direct.env"]);

    expect(check(result, "channels root").status).toBe("fail");
    expect(check(result, "channels root").detail).toContain("different directories");
  });

  it("fails when only some are set, naming the ones that are not", async () => {
    writeEnv({ AGENT_CHANNELS_ROOT: "channels" }, "direct.env");

    const result = await doctor(["--file", "direct.env"]);

    expect(check(result, "roots").status).toBe("fail");
    expect(check(result, "roots").detail).toContain("PROXY_STORE_ROOT");
  });

  it("fails when the store root does not exist or cannot be written", async () => {
    writeEnv(
      {
        AGENT_CHANNELS_ROOT: "channels",
        PROXY_CHANNELS_ROOT: "channels",
        AGENT_STORE_ROOT: "store",
        PROXY_STORE_ROOT: "store"
      },
      "direct.env"
    );

    const missing = await doctor(["--file", "direct.env"]);
    expect(check(missing, "store writable").detail).toContain("does not exist");

    mkdirSync(join(dir, "store"), { mode: 0o500 });
    const unwritable = await doctor(["--file", "direct.env"]);

    expect(unwritable.code).toBe(EXIT_ERROR);
    expect(check(unwritable, "store writable").status).toBe("fail");
    expect(check(unwritable, "store writable").detail).toContain("-wal");
  });
});

describe("the shared-skills root", () => {
  // Optional, and its absence is a deployment that publishes none — so an
  // unset variable is not a finding and there is no line for it here.
  it("passes when it has its own directory", async () => {
    writeEnv(
      {
        AGENT_CHANNELS_ROOT: "channels",
        PROXY_CHANNELS_ROOT: "channels",
        AGENT_STORE_ROOT: "store",
        PROXY_STORE_ROOT: "store",
        AGENT_SHARED_SKILLS_ROOT: "shared-skills"
      },
      "direct.env"
    );

    const result = await doctor(["--file", "direct.env"]);

    expect(check(result, "shared root").status).toBe("ok");
  });

  // The check this exists for: the store root is the one directory the agent
  // writes, and a shared skill is read by every channel that names it.
  it("fails when it is the store root", async () => {
    writeEnv(
      {
        AGENT_CHANNELS_ROOT: "channels",
        PROXY_CHANNELS_ROOT: "channels",
        AGENT_STORE_ROOT: "store",
        PROXY_STORE_ROOT: "store",
        AGENT_SHARED_SKILLS_ROOT: "store"
      },
      "direct.env"
    );

    const result = await doctor(["--file", "direct.env"]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "shared root").status).toBe("fail");
    expect(check(result, "shared root").detail).toContain("is the store root");
    expect(check(result, "shared root").detail).toContain("every channel that names it");
  });

  it("fails when it is the channels root", async () => {
    writeEnv(
      {
        AGENT_CHANNELS_ROOT: "channels",
        PROXY_CHANNELS_ROOT: "channels",
        AGENT_STORE_ROOT: "store",
        PROXY_STORE_ROOT: "store",
        AGENT_SHARED_SKILLS_ROOT: "channels"
      },
      "direct.env"
    );

    const result = await doctor(["--file", "direct.env"]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "shared root").detail).toContain("is the channels root");
  });
});

describe("shared skills a sheet names", () => {
  it("says so when no sheet names one", async () => {
    const result = await doctor();

    expect(check(result, "shared skills").status).toBe("ok");
    expect(check(result, "shared skills").detail).toBe("no sheet names one");
  });

  // The quiet failure this check exists for: the sheet parses, the deployment
  // starts, and the channel gets a prompt with nothing in it where its brand
  // voice should have been.
  it("fails when a named skill was never published", async () => {
    nameSharedSkill("brand-voice");
    publishSharedSkill("code-review-standards");

    const result = await doctor();

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "shared skills").status).toBe("fail");
    expect(check(result, "shared skills").detail).toContain("brand-voice");
    expect(check(result, "shared skills").detail).not.toContain("code-review-standards");
  });

  it("fails when the root itself is not there", async () => {
    nameSharedSkill("brand-voice");

    const result = await doctor();

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, "shared skills").detail).toContain("does not exist");
    expect(check(result, "shared skills").detail).toContain("brand-voice");
  });

  it("passes when every named skill is published", async () => {
    nameSharedSkill("brand-voice", "always");
    nameSharedSkill("code-review-standards");
    publishSharedSkill("brand-voice");
    publishSharedSkill("code-review-standards");

    const result = await doctor();

    expect(check(result, "shared skills").status).toBe("ok");
    expect(check(result, "shared skills").detail).toContain("2 named and published");
  });

  // A published file no sheet names is not a finding: an operator may publish
  // ahead of the sheets that will name it, and there is no key material lying
  // around the way a stray certificate is.
  it("says nothing about a published skill no sheet names", async () => {
    publishSharedSkill("brand-voice");

    const result = await doctor();

    expect(check(result, "shared skills").status).toBe("ok");
    expect(result.out.filter(line => line.startsWith("fail"))).toEqual([]);
  });

  it("takes the root as a flag, since the compose path is a container path", async () => {
    nameSharedSkill("brand-voice");
    publishSharedSkill("brand-voice", "vendored");

    const result = await doctor(["--shared-skills-root", "vendored"]);

    expect(check(result, "shared skills").status).toBe("ok");
    expect(check(result, "shared skills").detail).toContain("vendored");
  });
});

describe("sheets and the certificates they pin", () => {
  it("fails when the certificate on disk is not pinned", async () => {
    repin(OTHER_PIN);

    const result = await doctor();

    expect(result.code).toBe(EXIT_ERROR);
    expect(check(result, CHANNEL).status).toBe("fail");
    expect(check(result, CHANNEL).detail).toContain("401");
  });

  it("fails when a sheet pins a certificate that is not there", async () => {
    rmSync(join(dir, "deploy", "certs", "agent", `client-${CHANNEL}.pem`));

    const result = await doctor();

    expect(check(result, CHANNEL).status).toBe("fail");
    expect(check(result, CHANNEL).detail).toContain("no certificate at");
  });

  it("fails on key material no sheet pins", async () => {
    // The quiet one. A retired channel or a half-finished rotation leaves a
    // private key that nothing in the running system would ever mention.
    cpSync(
      join(dir, "deploy", "certs", "agent", `client-${CHANNEL}.pem`),
      join(dir, "deploy", "certs", "agent", "client-C0GHOST.pem")
    );
    repin(OTHER_PIN);

    const result = await doctor();

    expect(check(result, "stray certs").status).toBe("fail");
    expect(check(result, "stray certs").detail).toContain("client-C0GHOST.pem");
  });

  it("fails on a sheet that is not valid TOML", async () => {
    writeFileSync(sheetPath(), "[channel\nname = ");

    const result = await doctor();

    expect(check(result, CHANNEL).status).toBe("fail");
    expect(check(result, CHANNEL).detail).toContain("not valid TOML");
  });

  it("fails on a sheet that parses but is not a team sheet", async () => {
    writeFileSync(sheetPath(), '[channel]\nname = "no pins"\n');

    const result = await doctor();

    expect(check(result, CHANNEL).status).toBe("fail");
    expect(check(result, CHANNEL).detail).toContain("certificate_sha256");
  });

  it("fails when the CA key is inside a directory a container mounts", async () => {
    // A process that can mint certificates can name itself any channel, so the
    // CA key is mounted into neither container.
    cpSync(join(dir, "deploy", "certs", "ca.key"), join(dir, "deploy", "certs", "agent", "ca.key"));

    const result = await doctor();

    expect(check(result, "ca key").status).toBe("fail");
    expect(check(result, "ca key").detail).toContain("any channel");
  });

  it("fails when there is no channel at all", async () => {
    rmSync(join(dir, "channels"), { recursive: true });

    const result = await doctor();

    expect(check(result, "channels").status).toBe("fail");
    expect(check(result, "channels").detail).toContain("libero channel add");
  });
});

describe("the probe", () => {
  it("skips with the command that does work, when compose owns the address", async () => {
    const result = await doctor([]);

    expect(check(result, "proxy").status).toBe("skip");
  });

  it("says --offline when that is why", async () => {
    const result = await doctor(["--offline"]);

    expect(check(result, "proxy").detail).toBe("--offline");
  });

  it("fails on a PROXY_URL that is not https", async () => {
    // The client certificate is the only thing that says which channel is
    // calling, so a plaintext transport would be an unauthenticated one.
    writeEnv({ PROXY_URL: "http://localhost:8443", PROXY_CLIENT_CERT_DIR: "deploy/certs/agent" }, "direct.env");

    const result = await doctor(["--file", "direct.env"]);

    expect(check(result, "proxy").status).toBe("fail");
    expect(check(result, "proxy").detail).toContain("must be https");
  });

  it("fails when nothing is listening", async () => {
    writeEnv(
      { PROXY_URL: "https://127.0.0.1:1", PROXY_CLIENT_CERT_DIR: "deploy/certs/agent" },
      "direct.env"
    );

    const result = await doctor(["--file", "direct.env"]);

    expect(check(result, "proxy").status).toBe("fail");
  });
});

describe("arguments", () => {
  each([
    [["nonsense"], "takes no arguments"],
    [["--fil", "x"], "unknown option"]
  ])("%s exits 2", async (argv, expected) => {
    const result = await doctor([...argv]);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain(expected as string);
  });

  it("fails when there is no compose file and no --file", async () => {
    rmSync(join(dir, "deploy", "docker-compose.yml"));

    const result = await doctor();

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("\n")).toContain("no compose file");
  });

  it("counts what it checked and what it skipped", async () => {
    const result = await doctor();

    expect(result.out.at(-1)).toMatch(/^libero: \d+ checked, nothing failed(, \d+ skipped)?$/);
  });
});

describe("the fixture itself", () => {
  it("pins the certificate that was minted", async () => {
    // Guards the tests above: if `channel add` stopped pinning correctly, every
    // "fails when …" case here would still pass while the healthy case did not.
    const pem = join(dir, "deploy", "certs", "agent", `client-${CHANNEL}.pem`);
    const fingerprint = new X509Certificate(readFileSync(pem)).fingerprint256;

    expect(readFileSync(sheetPath(), "utf8")).toContain(fingerprint);
  });
});

function tree(root: string): string[] {
  const found: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(at, entry.name), `${path}/`);
      else found.push(path);
    }
  };
  walk(root, "");
  return found;
}
