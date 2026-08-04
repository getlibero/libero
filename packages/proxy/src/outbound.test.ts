import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  UpstreamError,
  callUpstream,
  credentialHeader,
  destinationHost,
  injectCredential
} from "./outbound.js";
import { RedactionError } from "./redact.js";
import type { Secret } from "./vault.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const VALUE = "ghp_live_token_do_not_log";

/** A stand-in with the same discipline as the real one: only `reveal` yields it. */
function secretOf(value: string): Secret {
  const secret = {
    reveal: () => value,
    toJSON: () => "[redacted]",
    toString: () => "[redacted]"
  };
  return Object.freeze(secret) as Secret;
}

/** A `fetch` that records what it was called with and answers 200. */
function recordingFetch(body = "{}", status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

describe("injecting the credential", () => {
  it("puts the value in an Authorization: Bearer header", () => {
    expect(credentialHeader("bearer", VALUE)).toEqual(["authorization", `Bearer ${VALUE}`]);
  });

  it("returns a fresh object rather than mutating the caller's headers", () => {
    const original = Object.freeze({ accept: "application/json" });
    const injected = injectCredential(original, "bearer", VALUE);
    expect(injected).not.toBe(original);
    expect(original).toEqual({ accept: "application/json" });
    expect(injected.authorization).toBe(`Bearer ${VALUE}`);
  });

  // An MCP server on the private network may legitimately need no credential.
  // The branch is ordinary, so it is tested rather than left to the happy path.
  it("adds no header when the upstream needs no credential", () => {
    const injected = injectCredential({ accept: "application/json" }, "bearer", undefined);
    expect(injected).toEqual({ accept: "application/json" });
    expect("authorization" in injected).toBe(false);
  });
});

describe("the outbound call", () => {
  it("sends the real secret to the upstream", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({
      url: "http://mcp-github:3001",
      body: { tool: "list_prs", arguments: {} },
      scheme: "bearer",
      secret: secretOf(VALUE),
      fetch
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${VALUE}`);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("returns the upstream's status and body", async () => {
    const { fetch } = recordingFetch('{"prs":[]}', 200);
    const response = await callUpstream({
      url: "http://mcp-github:3001",
      body: {},
      scheme: "bearer",
      secret: undefined,
      fetch
    });
    expect(response).toEqual({ status: 200, body: '{"prs":[]}' });
  });

  // A 404 from a tool is a result the model should see, not a transport
  // failure. `ToolResult.isError` draws that line; this must not throw.
  it("returns a non-2xx as an ordinary result", async () => {
    const { fetch } = recordingFetch("no such repo", 404);
    await expect(
      callUpstream({ url: "http://u:1", body: {}, scheme: "bearer", secret: undefined, fetch })
    ).resolves.toEqual({ status: 404, body: "no such repo" });
  });

  it("applies a timeout even when the caller names none", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({ url: "http://u:1", body: {}, scheme: "bearer", secret: undefined, fetch });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("reports a timeout as a timeout", async () => {
    const fetch = (async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof globalThis.fetch;
    await expect(
      callUpstream({ url: "http://u:1", body: {}, scheme: "bearer", secret: secretOf(VALUE), fetch })
    ).rejects.toMatchObject({ name: "UpstreamError", failure: "timed_out" });
  });

  it("reports anything else as unreachable", async () => {
    const fetch = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      callUpstream({ url: "http://u:1", body: {}, scheme: "bearer", secret: secretOf(VALUE), fetch })
    ).rejects.toMatchObject({ name: "UpstreamError", failure: "unreachable" });
  });

  // The reason `UpstreamError` carries no `cause`: a fetch/undici error can
  // hold the request, and the request holds the credential. Inspecting the
  // thrown value must not disclose it.
  it("never carries the secret out on a thrown error", async () => {
    const fetch = (async (_url: string, init: RequestInit) => {
      // A realistic hostile case: the transport error quotes the request.
      throw new TypeError(`fetch failed: ${JSON.stringify(init.headers)}`);
    }) as unknown as typeof globalThis.fetch;

    const thrown = await callUpstream({
      url: "http://u:1",
      body: {},
      scheme: "bearer",
      secret: secretOf(VALUE),
      fetch
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UpstreamError);
    const seen = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))} ${(thrown as Error).stack ?? ""}`;
    expect(seen).not.toContain(VALUE);
    expect(seen).not.toContain("ghp_");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("the secret does not come back", () => {
  // The leak class: an upstream that reflects the header it was given. The
  // fixture echoes the whole request, which is what a debug endpoint does.
  it("scrubs a credential the upstream echoed", async () => {
    const fetch = (async (_url: string, init: RequestInit) =>
      new Response(`upstream saw ${JSON.stringify(init.headers)}`)) as unknown as typeof globalThis.fetch;

    const response = await callUpstream({
      url: "http://u:1",
      body: {},
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "github_token",
      fetch
    });

    expect(response.body).not.toContain(VALUE);
    expect(response.body).toContain("[redacted:github_token]");
  });

  it.each([
    ["base64", (s: string) => Buffer.from(s).toString("base64")],
    ["base64url", (s: string) => Buffer.from(s).toString("base64url")],
    ["percent-encoded", (s: string) => encodeURIComponent(s)]
  ])("scrubs it when the upstream re-encoded it as %s", async (_label, encode) => {
    const fetch = (async () => new Response(`echo ${encode(VALUE)}`)) as unknown as typeof globalThis.fetch;

    const response = await callUpstream({
      url: "http://u:1",
      body: {},
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "c",
      fetch
    });

    expect(response.body).not.toContain(encode(VALUE));
    expect(response.body).toContain("[redacted:c]");
  });

  it("leaves a clean response byte-identical", async () => {
    const fetch = (async () => new Response('{"prs":[]}')) as unknown as typeof globalThis.fetch;
    const response = await callUpstream({
      url: "http://u:1",
      body: {},
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "c",
      fetch
    });
    expect(response.body).toBe('{"prs":[]}');
  });

  it("passes the body through untouched when there is no credential", async () => {
    const fetch = (async () => new Response("anything at all")) as unknown as typeof globalThis.fetch;
    const response = await callUpstream({ url: "http://u:1", body: {}, scheme: "bearer", secret: undefined, fetch });
    expect(response.body).toBe("anything at all");
  });

  // Fail-closed: the redactor throws on a value it cannot scan for, and
  // callUpstream must not swallow it into a returned body.
  it("throws rather than returning a body it could not scrub", async () => {
    const fetch = (async () => new Response("body")) as unknown as typeof globalThis.fetch;
    await expect(
      callUpstream({
        url: "http://u:1",
        body: {},
        scheme: "bearer",
        secret: secretOf(""),
        credentialName: "c",
        fetch
      })
    ).rejects.toBeInstanceOf(RedactionError);
  });
});

describe("the destination host", () => {
  it.each([
    ["http://mcp-github:3001/rpc", "mcp-github"],
    ["https://api.github.com/v3?token=leaked", "api.github.com"],
    ["https://USER:PASS@internal.example.com/x", "internal.example.com"]
  ])("takes the host out of %s", (url, host) => {
    expect(destinationHost(url)).toBe(host);
  });

  // The point of returning the host rather than the URL: a log line must not be
  // where a query-string token or a userinfo password ends up.
  it("drops the path, the query, and any userinfo", () => {
    expect(destinationHost("https://u:hunter2@api.example.com/p?token=abc")).toBe("api.example.com");
  });

  it("answers null for a url that does not parse", () => {
    expect(destinationHost("not a url")).toBeNull();
  });
});

// The property ./vault.ts is written to make checkable: "`reveal()` is the
// deliberate act. It is the only way out, and #51 will call it in exactly one
// place." A grep, not a mock, because the claim is about the whole tree.
describe("the single reveal", () => {
  it("has exactly one reveal() call site outside tests and the vault itself", () => {
    const found = execFileSync(
      "sh",
      [
        "-c",
        "grep -rn '\\.reveal()' packages/*/src apps/*/src --include='*.ts' | grep -v '\\.test\\.ts' || true"
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    )
      .split("\n")
      .filter(line => line.length > 0)
      // vault.ts defines `reveal`; it does not call it.
      .filter(line => !line.startsWith("packages/proxy/src/vault.ts"));

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("packages/proxy/src/outbound.ts");
  });

  // The companion property: no module outside outbound.ts and the vault should
  // even be able to reach a value, so nothing else imports `Secret` to unwrap.
  it("keeps the credential value out of every other source file", () => {
    const roots = [join(REPO_ROOT, "packages/proxy/src"), join(REPO_ROOT, "apps/proxy-server/src")];
    for (const root of roots) {
      for (const name of readdirSync(root)) {
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        if (name === "outbound.ts" || name === "vault.ts") continue;
        expect(readFileSync(join(root, name), "utf8")).not.toContain(".reveal()");
      }
    }
  });
});
