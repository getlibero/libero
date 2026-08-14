import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTokenStore, parseVaultKey, startFakeTokenIssuer } from "@getlibero/proxy";
import type { FakeTokenIssuer } from "@getlibero/proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runGrantCommand } from "./grant-cli.js";

// The CLI over a real store, real sheets in a temp channels root, and the
// fake issuer over a real socket, with `readLine` playing the operator: fetch
// the URL the CLI printed, paste the redirect's location back. What the tests
// hold is the acceptance criteria — the documented loop completes, nothing
// secret reaches either writer, and a second grant replaces the first.

const NAME = "notion_grant";
const KEY = randomBytes(32).toString("base64");

let dir: string;
let channelsRoot: string;
let vaultFile: string;
let issuer: FakeTokenIssuer | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "libero-grant-cli-"));
  channelsRoot = join(dir, "channels");
  vaultFile = join(dir, "vault", "vault.enc");
  mkdirSync(channelsRoot, { recursive: true });
  mkdirSync(join(dir, "vault"), { recursive: true });
  issuer = await startFakeTokenIssuer();
});

afterEach(async () => {
  await issuer?.close();
  issuer = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function sheet(channel: string, over: { credential?: string; issuer?: string; scopes?: string[]; auth?: boolean }): void {
  const scopes = (over.scopes ?? ["mcp.read"]).map(scope => `"${scope}"`).join(", ");
  const auth =
    (over.auth ?? true)
      ? [
          "  [mcp_server.auth]",
          '  scheme = "oauth"',
          `  issuer = "${over.issuer ?? issuer?.url ?? ""}"`,
          `  scopes = [${scopes}]`
        ].join("\n")
      : "";
  const text = [
    "[channel]",
    `name = "${channel}"`,
    'certificate_sha256 = ["00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"]',
    "",
    "[[mcp_server]]",
    'name = "notion"',
    'transport = "http"',
    'url = "https://mcp.notion.example/mcp"',
    `credential = "${over.credential ?? NAME}"`,
    "",
    auth
  ].join("\n");
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, "channel.toml"), text);
}

interface Run {
  code: number;
  out: string[];
  err: string[];
  text: string;
}

/** `readLine` follows the printed URL as the browser unless scripted otherwise. */
async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    paste?: (shownUrl: string) => Promise<string | null>;
    tamper?: (location: string) => string;
  } = {}
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const paste =
    options.paste ??
    (async (shownUrl: string) => {
      const match = /^ {2}(http\S+)$/m.exec(shownUrl);
      if (match?.[1] === undefined) throw new Error("no URL was shown");
      const response = await fetch(match[1], { redirect: "manual" });
      const location = response.headers.get("location");
      if (location === null) throw new Error("the fake did not redirect");
      return (options.tamper ?? (value => value))(location);
    });
  const code = await runGrantCommand({
    argv,
    env: options.env ?? {
      PROXY_CHANNELS_ROOT: channelsRoot,
      PROXY_VAULT_FILE: vaultFile,
      PROXY_VAULT_KEY: KEY
    },
    readLine: () => paste(out.join("\n")),
    out: line => out.push(line),
    err: line => err.push(line)
  });
  return { code, out, err, text: [...out, ...err].join("\n") };
}

function storedGrant(binding: { issuer: string; scopes: string[] }) {
  const parsed = parseVaultKey(KEY);
  if (!parsed.ok) throw new Error("fixture key failed to parse");
  const store = openTokenStore({ vaultFile, key: parsed.key });
  try {
    return store.read(NAME, binding);
  } finally {
    store.close();
  }
}

describe("usage", () => {
  it("prints usage on help, and on no command with exit 2", async () => {
    expect((await run(["--help"])).code).toBe(EXIT_OK);
    const bare = await run([]);
    expect(bare.code).toBe(EXIT_USAGE);
    expect(bare.out.join("\n")).toContain("usage: grant");
  });

  it("refuses an unknown command, extra names, a bad flag and a bad client id", async () => {
    expect((await run(["remove", NAME])).code).toBe(EXIT_USAGE);
    expect((await run(["add"])).code).toBe(EXIT_USAGE);
    expect((await run(["add", NAME, "second"])).code).toBe(EXIT_USAGE);
    const flag = await run(["add", NAME, "--client"]);
    expect(flag.code).toBe(EXIT_USAGE);
    expect(flag.err[0]).toContain("--client");
    expect((await run(["add", NAME, "--client-id", "not a url"])).code).toBe(EXIT_USAGE);
  });

  it("reads env only after the command parses, and names the missing variable", async () => {
    const bad = await run(["remove"], { env: {} });
    expect(bad.code).toBe(EXIT_USAGE);
    const missing = await run(["add", NAME], { env: {} });
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.err[0]).toContain("PROXY_CHANNELS_ROOT");
  });
});

describe("the sheet scan", () => {
  it("refuses a credential no sheet declares, naming the root", async () => {
    sheet("C1", { credential: "other_grant" });
    const result = await run(["add", NAME]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err[0]).toContain(channelsRoot);
    expect(result.err[0]).toContain(NAME);
  });

  it("does not match a bearer block sharing the credential name", async () => {
    sheet("C1", { auth: false });
    const result = await run(["add", NAME]);
    expect(result.code).toBe(EXIT_ERROR);
  });

  it("unions scopes across agreeing sheets", async () => {
    sheet("C1", { scopes: ["mcp.read"] });
    sheet("C2", { scopes: ["mcp.write"] });
    const result = await run(["add", NAME]);
    expect(result.code).toBe(EXIT_OK);
    expect(issuer?.authorizeRequests[0]?.scope).toBe("mcp.read mcp.write");
  });

  it("refuses disagreeing issuers, listing every declaring sheet", async () => {
    sheet("C1", {});
    sheet("C2", { issuer: `${issuer?.url ?? ""}/` });
    const result = await run(["add", NAME]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err.join("\n")).toContain(join(channelsRoot, "C1", "channel.toml"));
    expect(result.err.join("\n")).toContain(join(channelsRoot, "C2", "channel.toml"));
  });

  it("warns about an invalid sheet and continues past it", async () => {
    mkdirSync(join(channelsRoot, "C0"), { recursive: true });
    writeFileSync(join(channelsRoot, "C0", "channel.toml"), "not toml [");
    sheet("C1", {});
    const result = await run(["add", NAME]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.err.join("\n")).toContain(join(channelsRoot, "C0", "channel.toml"));
  });
});

describe("the grant", () => {
  it("completes the documented loop and stores a readable grant", async () => {
    sheet("C1", {});
    const result = await run(["add", NAME]);

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.at(-1)).toBe(`grant: stored ${NAME}`);
    expect(result.out.join("\n")).toContain("http://127.0.0.1/callback");
    const read = storedGrant({ issuer: issuer?.url ?? "", scopes: ["mcp.read"] });
    expect(read.status).toBe("found");
  });

  it("says replaced when a second grant lands on the same name", async () => {
    sheet("C1", {});
    expect((await run(["add", NAME])).out.at(-1)).toBe(`grant: stored ${NAME}`);
    const second = await run(["add", NAME]);
    expect(second.code).toBe(EXIT_OK);
    expect(second.out.at(-1)).toBe(`grant: replaced ${NAME}`);
  });

  it("sends the default client id, and an override when given", async () => {
    sheet("C1", {});
    await run(["add", NAME]);
    expect(issuer?.authorizeRequests[0]?.client_id).toBe("https://getlibero.com/client.json");
    await run(["add", NAME, "--client-id", "https://example.com/me.json"]);
    expect(issuer?.authorizeRequests[1]?.client_id).toBe("https://example.com/me.json");
  });

  it("prints closed words: a wrong key, a tampered state, a closed prompt", async () => {
    sheet("C1", {});
    await run(["add", NAME]); // creates the store under KEY
    const wrongKey = await run(["add", NAME], {
      env: {
        PROXY_CHANNELS_ROOT: channelsRoot,
        PROXY_VAULT_FILE: vaultFile,
        PROXY_VAULT_KEY: randomBytes(32).toString("base64")
      }
    });
    expect(wrongKey.code).toBe(EXIT_ERROR);
    expect(wrongKey.err).toEqual(["grant: bad_key_or_tampered"]);

    const tampered = await run(["add", NAME], { tamper: location => location.replace(/state=[^&]+/, "state=x") });
    expect(tampered.code).toBe(EXIT_ERROR);
    expect(tampered.err[0]).toBe("grant: state_mismatch");
    expect(tampered.err[1]).toContain("run the grant again");

    const closed = await run(["add", NAME], { paste: async () => null });
    expect(closed.code).toBe(EXIT_ERROR);
    expect(closed.err[0]).toBe("grant: input_closed");
  });

  it("fails loudly when the issuer grants no refresh token", async () => {
    await issuer?.close();
    issuer = await startFakeTokenIssuer({ issueRefreshToken: false });
    sheet("C1", {});
    const result = await run(["add", NAME]);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err[0]).toBe("grant: no_refresh_token");
    expect(result.err[1]).toContain("refresh_token grant");
  });

  it("writes no code, verifier or token to either stream, on success or failure", async () => {
    sheet("C1", {});
    const success = await run(["add", NAME]);
    const tampered = await run(["add", NAME], { tamper: location => location.replace(/state=[^&]+/, "state=x") });

    for (const transcript of [success.text, tampered.text]) {
      expect(transcript).not.toMatch(/code_\d/); // the fake's codes are code_<n>
      expect(transcript).not.toContain("rt_granted"); // and its refresh tokens rt_granted_<n>
      expect(transcript).not.toContain("code_verifier=");
    }
    // The authorization URL is meant to be printed — with the challenge, never
    // the verifier that hashes to it.
    expect(success.out.join("\n")).toContain("code_challenge=");
  });
});
