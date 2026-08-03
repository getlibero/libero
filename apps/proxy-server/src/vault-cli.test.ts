import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVault, parseVaultKey } from "@getlibero/proxy";
import type { VaultKey } from "@getlibero/proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runVaultCommand } from "./vault-cli.js";

const VALUE = "ghp_leaked_value_16C7e42F292c6912E7710c838347Ae178B4a";
const NAME = "github_service_account";

let dir: string;
let file: string;
let keyText: string;

function key(): VaultKey {
  const parsed = parseVaultKey(keyText);
  if (!parsed.ok) throw new Error("test key did not parse");
  return parsed.key;
}

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

async function run(argv: string[], stdin: string | null = null, env?: Record<string, string>): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runVaultCommand({
    argv,
    env: env ?? { PROXY_VAULT_FILE: file, PROXY_VAULT_KEY: keyText },
    readStdin: async () => (stdin === null ? null : Buffer.from(stdin, "utf8")),
    out: line => void out.push(line),
    err: line => void err.push(line)
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-vault-cli-"));
  file = join(dir, "vault.enc");
  keyText = randomBytes(32).toString("base64");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("set", () => {
  it("stores a value read from stdin", async () => {
    const result = await run(["set", NAME], VALUE);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([`vault: set ${NAME}`]);

    const found = openVault({ file, key: key() }).lookup(NAME);
    expect(found.status).toBe("found");
    if (found.status === "found") expect(found.secret.reveal()).toBe(VALUE);
  });

  it("creates the vault owner-only", async () => {
    await run(["set", NAME], VALUE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("does not echo the value it stored", async () => {
    const result = await run(["set", NAME], VALUE);
    expect(result.text).not.toContain("ghp_");
  });

  // A vault this cannot read must not be read as empty and then replaced —
  // that is every stored credential gone on a permissions mistake. Root reads
  // through mode 000, so the test is meaningless there.
  it.runIf(process.getuid?.() !== 0)(
    "refuses to touch a vault it cannot read",
    async () => {
      await run(["set", NAME], VALUE);
      const before = readFileSync(file);
      chmodSync(file, 0o000);

      const result = await run(["set", "other_credential"], "second-value");

      expect(result.code).toBe(EXIT_ERROR);
      expect(result.err).toEqual(["vault: unreadable"]);
      chmodSync(file, 0o600);
      expect(readFileSync(file).equals(before)).toBe(true);
    }
  );

  // `echo secret |` and `printf secret |` must store the same thing.
  it.each([
    ["a trailing newline", `${VALUE}\n`, VALUE],
    ["a trailing CRLF", `${VALUE}\r\n`, VALUE],
    ["no trailing newline", VALUE, VALUE],
    ["only one of two newlines", `${VALUE}\n\n`, `${VALUE}\n`]
  ])("strips %s", async (_label, stdin, stored) => {
    await run(["set", NAME], stdin);
    const found = openVault({ file, key: key() }).lookup(NAME);
    if (found.status !== "found") throw new Error("unreachable");
    expect(found.secret.reveal()).toBe(stored);
  });

  it("keeps a multi-line value intact", async () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`;
    await run(["set", "deploy_key"], `${pem}\n`);
    const found = openVault({ file, key: key() }).lookup("deploy_key");
    if (found.status !== "found") throw new Error("unreachable");
    expect(found.secret.reveal()).toBe(pem);
  });

  it("replaces an existing entry", async () => {
    await run(["set", NAME], VALUE);
    await run(["set", NAME], "second");
    const found = openVault({ file, key: key() }).lookup(NAME);
    if (found.status !== "found") throw new Error("unreachable");
    expect(found.secret.reveal()).toBe("second");
  });

  it("adds to a vault rather than replacing it", async () => {
    await run(["set", NAME], VALUE);
    await run(["set", "slack_bot"], "xoxb-abc");
    expect(openVault({ file, key: key() }).size).toBe(2);
  });

  // A terminal stdin would otherwise block on a blank line until the operator
  // works out that it is waiting for them.
  it("explains itself rather than blocking on a terminal", async () => {
    const result = await run(["set", NAME], null);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("")).toContain("stdin");
    expect(existsSync(file)).toBe(false);
  });

  it.each([
    ["no name", ["set"]],
    ["two names", ["set", NAME, "other"]]
  ])("refuses %s", async (_label, argv) => {
    expect((await run(argv, VALUE)).code).toBe(EXIT_USAGE);
  });

  it.each([
    ["an invalid name", ["set", "../etc/passwd"], VALUE],
    ["an empty value", ["set", NAME], ""],
    ["a value with a NUL", ["set", NAME], "abc\0def"]
  ])("refuses %s without writing", async (_label, argv, stdin) => {
    const result = await run(argv, stdin);
    expect(result.code).toBe(EXIT_ERROR);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a value over the cap", async () => {
    const result = await run(["set", NAME], "a".repeat(9_000));
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("")).toContain("value_too_large");
    expect(existsSync(file)).toBe(false);
  });
});

describe("list", () => {
  it("prints the names, sorted", async () => {
    await run(["set", "slack_bot"], "xoxb-abc");
    await run(["set", NAME], VALUE);

    const result = await run(["list"]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([NAME, "slack_bot"]);
  });

  // Names, and nothing that narrows what an entry holds — no count, no lengths.
  it("prints no value and no length", async () => {
    await run(["set", NAME], VALUE);
    const result = await run(["list"]);
    expect(result.text).not.toContain("ghp_");
    expect(result.text).not.toContain(String(VALUE.length));
  });

  it("prints nothing for an absent vault", async () => {
    const result = await run(["list"]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([]);
  });

  it("prints nothing for an emptied vault", async () => {
    await run(["set", NAME], VALUE);
    await run(["remove", NAME]);
    expect((await run(["list"])).out).toEqual([]);
  });
});

describe("remove", () => {
  it("deletes a credential", async () => {
    await run(["set", NAME], VALUE);
    const result = await run(["remove", NAME]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toEqual([`vault: removed ${NAME}`]);
    expect(openVault({ file, key: key() }).lookup(NAME)).toEqual({ status: "missing" });
  });

  it("names a credential that was not there", async () => {
    await run(["set", NAME], VALUE);
    const result = await run(["remove", "not_loaded"]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("")).toContain("not_loaded");
  });

  it("leaves the other entries alone", async () => {
    await run(["set", NAME], VALUE);
    await run(["set", "slack_bot"], "xoxb-abc");
    await run(["remove", NAME]);
    expect((await run(["list"])).out).toEqual(["slack_bot"]);
  });
});

describe("the command surface", () => {
  // The one command that must never exist.
  it.each(["get", "show", "cat", "print", "reveal", "export", "dump"])(
    "has no %j command",
    async command => {
      const result = await run([command, NAME]);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.err.join("")).toContain("unknown command");
    }
  );

  it("prints usage with no arguments, and calls that a usage error", async () => {
    const result = await run([]);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.out.join("")).toContain("usage: vault");
  });

  it("prints usage on request, and calls that success", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("")).toContain("usage: vault");
  });

  it("documents no way to read a value back", async () => {
    const usage = (await run(["--help"])).out.join("\n");
    expect(usage).toContain("no command that prints a value");
    expect(usage).not.toMatch(/\bget\b/);
  });
});

describe("the environment", () => {
  it.each([
    ["no vault file", { PROXY_VAULT_KEY: "placeholder" }, /PROXY_VAULT_FILE/],
    ["no key", { PROXY_VAULT_FILE: "/tmp/vault.enc" }, /PROXY_VAULT_KEY/]
  ])("refuses to run with %s", async (_label, env, pattern) => {
    const result = await run(["list"], null, env as Record<string, string>);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("")).toMatch(pattern);
  });

  it("keeps a rejected key out of its own message", async () => {
    const bad = "hunter2!!!!hunter2!!!!";
    const result = await run(["list"], null, { PROXY_VAULT_FILE: file, PROXY_VAULT_KEY: bad });

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.text).not.toContain("hunter2");
  });
});

describe("a vault it cannot read", () => {
  // Overwriting a vault this could not read would silently discard whatever an
  // operator had loaded into it.
  it("refuses to set into a vault under a different key", async () => {
    await run(["set", NAME], VALUE);
    const before = readFileSync(file);

    const other = randomBytes(32).toString("base64");
    const result = await run(["set", "slack_bot"], "xoxb-abc", {
      PROXY_VAULT_FILE: file,
      PROXY_VAULT_KEY: other
    });

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("")).toContain("bad_key_or_tampered");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("reports a file that is not a vault", async () => {
    writeFileSync(file, "not a vault");
    const result = await run(["list"]);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("")).toContain("not_a_vault");
  });

  it("keeps the key out of every failure it reports", async () => {
    writeFileSync(file, randomBytes(200));
    const result = await run(["list"]);
    expect(result.text).not.toContain(keyText);
  });
});
