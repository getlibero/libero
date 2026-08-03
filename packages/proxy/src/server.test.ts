// The proxy over a real TLS connection, with real certificates.
//
// The certificates come from scripts/dev-certs.sh — the same script a
// self-hoster runs, not a test-only fixture path. Two things follow: no
// private keys are checked into this repository, and the documented operator
// command is exercised on every CI run rather than rotting next to the code it
// describes.
//
// Nothing here mocks TLS. "A client without the certificate cannot connect" is
// only worth asserting against the real handshake.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import type { Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProxyError,
  type ResolvedToolCall,
  ToolCallResponse,
  ToolListing
} from "@getlibero/schema";
import {
  type SpendMeter,
  createUnavailableDispatcher,
  createUnmeteredSpend,
  type ToolDispatcher
} from "./dispatch.js";
import type { BudgetSpend } from "./enforce.js";
import { createJsonLogger } from "./log.js";
import { MAX_BODY_BYTES, createProxyServer } from "./server.js";
import { SHEET_FILENAME, TeamSheetStore } from "./team-sheet-store.js";
import { loadTlsOptions } from "./tls.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CHANNEL = "C024BE91L";
const OTHER_CHANNEL = "C7ZZZ9999";

interface Response {
  status: number;
  body: unknown;
}

interface ClientCert {
  cert: Buffer;
  key: Buffer;
}

let certs: string;
/** A second, unrelated CA. Its certificates are well-formed and worthless. */
let foreignCerts: string;
let channelsRoot: string;
let sheets: TeamSheetStore;
let dispatcher: ToolDispatcher & { seen: ResolvedToolCall[] };
/**
 * A real meter, because the recording dispatcher below really serves calls and
 * `assertServableComposition` will not let those two be paired with the
 * provisional one. Mutable so a test can spend a channel's budget.
 */
let spent: BudgetSpend = { tokens: 0, toolCalls: 0 };
const meter: SpendMeter = { read: () => spent };
let server: Server;
let port: number;
let logLines: string[] = [];

function mint(out: string, args: string[]): void {
  execFileSync("sh", ["scripts/dev-certs.sh", "--out", out, ...args], {
    cwd: REPO_ROOT,
    stdio: "pipe"
  });
}

function clientCert(dir: string, label: string): ClientCert {
  return {
    cert: readFileSync(join(dir, "agent", `client-${label}.pem`)),
    key: readFileSync(join(dir, "agent", `client-${label}.key`))
  };
}

/** One request. Resolves on a response; rejects when the connection does not survive. */
function call(
  path: string,
  client?: ClientCert,
  method = "GET",
  targetPort = port,
  body?: string
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: targetPort,
        path,
        method,
        ca: readFileSync(join(certs, "ca.pem")),
        ...(client ?? {})
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw === "" ? undefined : JSON.parse(raw) });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A tool call as the agent would send it, against the shared server. */
function post(path: string, body: unknown, channel = CHANNEL): Promise<Response> {
  return call(path, clientCert(certs, channel), "POST", port, JSON.stringify(body));
}

/**
 * A dispatcher that records what reached it and otherwise does nothing.
 *
 * The instrument for the property this whole issue exists to establish:
 * reaching the dispatcher is what opens a connection and resolves a
 * credential, so "a refused call leaves no trace upstream" is the assertion
 * that `seen` is still empty.
 */
function recordingDispatcher(): ToolDispatcher & { seen: ResolvedToolCall[] } {
  const seen: ResolvedToolCall[] = [];
  return {
    seen,
    dispatch(call: ResolvedToolCall) {
      seen.push(call);
      return { outcome: "ran", result: { content: "upstream said so", isError: false } };
    }
  };
}

function writeSheet(channel: string, toml: string): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, SHEET_FILENAME), toml);
}

/** The sheet the shared server serves for CHANNEL, restored before each test. */
const SHEET = `
[channel]
name = "engineering"

[[mcp_server]]
name = "github"
transport = "http"
url = "https://api.github.com"

  [[mcp_server.tool]]
  name = "list_prs"

  [[mcp_server.tool]]
  name = "delete_branch"

  [[mcp_server.tool]]
  name = "merge_pr"
  approval = "required"

  [[mcp_server.tool]]
  name = "drop_stale_caches"
  approval = "none"
`;

beforeAll(() => {
  certs = mkdtempSync(join(tmpdir(), "libero-proxy-certs-"));
  foreignCerts = mkdtempSync(join(tmpdir(), "libero-proxy-foreign-"));

  mint(certs, [
    "--channels",
    `${CHANNEL},${OTHER_CHANNEL}`,
    // A certificate this CA signed whose subject is not a channel principal —
    // the shape a single shared service certificate would have.
    "--raw-cn",
    "no-prefix=agent",
    // And one whose channel id would escape the per-channel directory.
    "--raw-cn",
    "traversal=channel:../../etc"
  ]);
  mint(foreignCerts, ["--channels", CHANNEL]);

  channelsRoot = mkdtempSync(join(tmpdir(), "libero-proxy-channels-"));
  sheets = new TeamSheetStore({ root: channelsRoot });
  dispatcher = recordingDispatcher();

  server = createProxyServer({
    tls: loadTlsOptions({
      cert: join(certs, "proxy", "server.pem"),
      key: join(certs, "proxy", "server.key"),
      ca: join(certs, "ca.pem")
    }),
    sheets,
    spend: meter,
    dispatcher,
    logger: createJsonLogger(line => {
      logLines.push(line);
    })
  });

  return new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      resolve();
    });
  });
  // Six RSA keypairs. Slower than the tests themselves, and still under the
  // default timeout on CI; raised here so a loaded runner does not flake.
}, 120_000);

beforeEach(() => {
  // Several tests below edit or delete the sheet mid-run — that is the point of
  // them — so each starts from the same one.
  rmSync(channelsRoot, { recursive: true, force: true });
  writeSheet(CHANNEL, SHEET);
  dispatcher.seen.length = 0;
  spent = { tokens: 0, toolCalls: 0 };
  logLines = [];
});

afterAll(() => {
  server.close();
  sheets.close();
  rmSync(certs, { recursive: true, force: true });
  rmSync(foreignCerts, { recursive: true, force: true });
  rmSync(channelsRoot, { recursive: true, force: true });
});

describe("mutual TLS", () => {
  // Which error a refused client sees depends on the Node build and the TLS
  // alert it happens to read before the socket dies, so the assertion is that
  // the connection failed *and* that the server refused it at certificate
  // verification. "Threw something" alone would also pass against a closed
  // port, which would prove nothing.
  async function expectRefusedAtHandshake(client?: ClientCert): Promise<void> {
    logLines = [];
    await expect(call("/health", client)).rejects.toThrow();
    await vi.waitFor(() => {
      expect(logLines.map(line => JSON.parse(line) as { event: string })).toContainEqual(
        expect.objectContaining({ event: "tls_client_rejected" })
      );
    });
  }

  it("refuses a client that presents no certificate", async () => {
    // The headline property. No response, no route reached, nothing to parse:
    // the connection does not survive the handshake.
    await expectRefusedAtHandshake();
  });

  it("refuses a certificate signed by another authority", async () => {
    // Well-formed, correct subject, wrong CA. Minting your own certificate is
    // not a way in.
    await expectRefusedAtHandshake(clientCert(foreignCerts, CHANNEL));
  });

  it("serves a client holding a certificate this CA signed", async () => {
    const res = await call("/health", clientCert(certs, CHANNEL));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });
});

describe("channel identity", () => {
  it("binds the request to the channel named in the certificate", async () => {
    const res = await call("/v1/whoami", clientCert(certs, CHANNEL));
    expect(res).toEqual({ status: 200, body: { channel: CHANNEL } });
  });

  it("resolves each certificate independently on one listener", async () => {
    // Two channels, one server, no identity cached across connections.
    const [first, second] = await Promise.all([
      call("/v1/whoami", clientCert(certs, CHANNEL)),
      call("/v1/whoami", clientCert(certs, OTHER_CHANNEL))
    ]);
    expect(first.body).toEqual({ channel: CHANNEL });
    expect(second.body).toEqual({ channel: OTHER_CHANNEL });
  });

  it("refuses a valid certificate whose subject is not a channel principal", async () => {
    const res = await call("/v1/whoami", clientCert(certs, "no-prefix"));
    expect(res.status).toBe(401);
    expect(ProxyError.parse(res.body).error.code).toBe("unauthenticated");
  });

  it("refuses a channel id that would escape the channel directory", async () => {
    const res = await call("/v1/whoami", clientCert(certs, "traversal"));
    expect(res.status).toBe(401);
    expect(ProxyError.parse(res.body).error).toMatchObject({ code: "unauthenticated" });
  });

  it("keeps the rejection reason and the subject out of the response", async () => {
    logLines = [];
    const res = await call("/v1/whoami", clientCert(certs, "no-prefix"));
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("not_a_channel_principal");
    expect(serialized).not.toContain("agent");
    // The response carries no channel either — there was none to name.
    expect(ProxyError.parse(res.body).error.channel).toBeUndefined();

    // Both belong in the log, where an operator debugging a refused agent
    // needs them.
    const rejection = logLines.find(line => line.includes("identity_rejected"));
    expect(rejection).toBeDefined();
    expect(JSON.parse(rejection ?? "{}")).toMatchObject({
      event: "identity_rejected",
      reason: "not_a_channel_principal",
      commonName: "agent"
    });
  });
});

describe("routing", () => {
  it("answers an unknown path with a structured error", async () => {
    const res = await call("/v1/nope", clientCert(certs, CHANNEL));
    expect(res.status).toBe(404);
    expect(ProxyError.parse(res.body).error).toMatchObject({
      code: "not_found",
      channel: CHANNEL
    });
  });

  it("answers a disallowed method with a structured error", async () => {
    const res = await call("/health", clientCert(certs, CHANNEL), "POST");
    expect(res.status).toBe(405);
    expect(ProxyError.parse(res.body).error.code).toBe("method_not_allowed");
  });

  it("gives every error the shape @getlibero/schema fixes", async () => {
    // Strict parse: an extra field anywhere on this shape fails here. That is
    // what keeps a credential value from ever acquiring somewhere to ride,
    // while there is still nothing in the proxy to leak.
    for (const path of ["/v1/nope", "/health/nested", "/"]) {
      const res = await call(path, clientCert(certs, CHANNEL));
      expect(() => ProxyError.parse(res.body)).not.toThrow();
      expect(ProxyError.parse(res.body).error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("answers a failed handler with 500 and keeps the thrown value out of everything", async () => {
    // A server whose /health handler throws: the injected clock's first call
    // is the start timestamp, every later one fails with a message shaped
    // like the thing this process must never emit.
    const lines: string[] = [];
    let calls = 0;
    const failing = createProxyServer({
      tls: loadTlsOptions({
        cert: join(certs, "proxy", "server.pem"),
        key: join(certs, "proxy", "server.key"),
        ca: join(certs, "ca.pem")
      }),
      sheets,
      spend: createUnmeteredSpend(),
      dispatcher: createUnavailableDispatcher(),
      logger: createJsonLogger(line => {
        lines.push(line);
      }),
      now: () => {
        calls += 1;
        if (calls > 1) throw new Error("ghp_credential_shaped_value");
        return 0;
      }
    });
    const failingPort = await new Promise<number>(resolve => {
      failing.listen(0, "127.0.0.1", () => {
        const address = failing.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    try {
      const res = await call("/health", clientCert(certs, CHANNEL), "GET", failingPort);
      expect(res.status).toBe(500);
      expect(ProxyError.parse(res.body).error.code).toBe("internal");
      // The exception's message reaches neither the response nor the log.
      expect(JSON.stringify(res.body)).not.toContain("ghp_");
      expect(lines.join("")).not.toContain("ghp_");
      expect(lines.map(line => JSON.parse(line) as { event: string })).toContainEqual(
        expect.objectContaining({ event: "handler_failed", channel: CHANNEL, path: "/health" })
      );
    } finally {
      failing.close();
    }
  });

  it("correlates a refusal with its log line by request id", async () => {
    // The error message stays generic on purpose, so the request id is the
    // only thing tying a user's complaint to what the proxy actually saw.
    logLines = [];
    const res = await call("/v1/nope", clientCert(certs, CHANNEL));
    const { requestId } = ProxyError.parse(res.body).error;

    expect(JSON.parse(logLines[0] ?? "{}")).toMatchObject({
      event: "request",
      requestId,
      channel: CHANNEL,
      method: "GET",
      path: "/v1/nope",
      status: 404
    });
  });
});

describe("the tool listing", () => {
  it("returns only what the channel's team sheet permits", async () => {
    const res = await call("/v1/tools", clientCert(certs, CHANNEL));
    expect(res.status).toBe(200);
    const { tools } = ToolListing.parse(res.body);

    expect(tools.map(tool => tool.tool).sort()).toEqual([
      "delete_branch",
      "drop_stale_caches",
      "list_prs",
      "merge_pr"
    ]);
    expect(tools.every(tool => tool.server === "github")).toBe(true);
  });

  it("resolves approval rather than copying the sheet's optional field", () => {
    // The listing has to answer the question the sheet only sometimes answers,
    // and it has to answer it the way the call-time gate will.
    const approval = async (tool: string): Promise<string> => {
      const res = await call("/v1/tools", clientCert(certs, CHANNEL));
      const found = ToolListing.parse(res.body).tools.find(entry => entry.tool === tool);
      return found?.approval ?? "missing";
    };

    return Promise.all([
      expect(approval("list_prs")).resolves.toBe("none"),
      // Explicit in the sheet.
      expect(approval("merge_pr")).resolves.toBe("required"),
      // Nothing in the sheet; the destructive-name default applies.
      expect(approval("delete_branch")).resolves.toBe("required"),
      // Destructive-looking, and the sheet has answered. Explicit wins.
      expect(approval("drop_stale_caches")).resolves.toBe("none")
    ]);
  });

  it("gives a channel with no sheet an empty list, not an error", async () => {
    const res = await call("/v1/tools", clientCert(certs, OTHER_CHANNEL));
    // Empty is a permission state: this channel may call nothing. A 4xx here
    // would make "not provisioned" indistinguishable from "the proxy is broken".
    expect(res.status).toBe(200);
    expect(ToolListing.parse(res.body).tools).toEqual([]);
  });

  it("reflects a sheet edited under a running proxy", async () => {
    const before = await call("/v1/tools", clientCert(certs, CHANNEL));
    expect(ToolListing.parse(before.body).tools).not.toHaveLength(0);

    writeSheet(
      CHANNEL,
      `
[channel]
name = "engineering"
`
    );

    const after = await call("/v1/tools", clientCert(certs, CHANNEL));
    expect(ToolListing.parse(after.body).tools).toEqual([]);
  });

  it("lists per channel, not per process", async () => {
    writeSheet(
      OTHER_CHANNEL,
      `
[channel]
name = "support"

[[mcp_server]]
name = "zendesk"
transport = "http"
url = "https://example.zendesk.com"

  [[mcp_server.tool]]
  name = "list_tickets"
`
    );

    const mine = await call("/v1/tools", clientCert(certs, CHANNEL));
    const theirs = await call("/v1/tools", clientCert(certs, OTHER_CHANNEL));

    expect(ToolListing.parse(mine.body).tools.map(tool => tool.server)).not.toContain("zendesk");
    expect(ToolListing.parse(theirs.body).tools).toEqual([
      { server: "zendesk", tool: "list_tickets", approval: "none" }
    ]);
  });
});

describe("the call-time gate", () => {
  const CALL = { id: "toolu_01", server: "github", tool: "list_prs", arguments: { state: "open" } };

  it("serves an allowed call to the dispatcher", async () => {
    const res = await post("/v1/tools/call", CALL);
    expect(res.status).toBe(200);
    const answer = ToolCallResponse.parse(res.body);
    expect(answer).toMatchObject({ outcome: "ran", id: "toolu_01" });
    // And the dispatcher was handed a call bound to the certificate's channel.
    expect(dispatcher.seen).toHaveLength(1);
    expect(dispatcher.seen[0]).toMatchObject({ channel: CHANNEL, tool: "list_prs" });
  });

  it("refuses an unlisted server and an unlisted tool, structurally", async () => {
    const unlistedServer = await post("/v1/tools/call", { ...CALL, server: "gitlab" });
    expect(unlistedServer.status).toBe(200);
    expect(ToolCallResponse.parse(unlistedServer.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "server_not_allowed", server: "gitlab" }
    });

    const unlistedTool = await post("/v1/tools/call", { ...CALL, tool: "force_push" });
    expect(ToolCallResponse.parse(unlistedTool.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "tool_not_allowed", server: "github", tool: "force_push" }
    });
  });

  it("holds a tool the sheet marks as needing approval", async () => {
    const res = await post("/v1/tools/call", { ...CALL, tool: "merge_pr" });
    expect(ToolCallResponse.parse(res.body)).toMatchObject({
      outcome: "held",
      refusal: { reason: "approval_required", server: "github", tool: "merge_pr" }
    });
  });

  // The criterion this issue exists for. Reaching the dispatcher is what opens
  // a connection and resolves a credential, so every not-allowed outcome has to
  // leave it untouched — including a hold, which is not a denial but is also
  // not permission to go and do the thing.
  it("leaves no trace upstream for any call that was not allowed", async () => {
    await post("/v1/tools/call", { ...CALL, server: "gitlab" });
    await post("/v1/tools/call", { ...CALL, tool: "force_push" });
    await post("/v1/tools/call", { ...CALL, tool: "merge_pr" });
    await post("/v1/tools/call", { ...CALL, tool: "delete_branch" });
    await post("/v1/tools/call", CALL, OTHER_CHANNEL);
    await post("/v1/tools/call", { id: "x" });

    expect(dispatcher.seen).toEqual([]);
  });

  it("refuses a body that asserts a channel, and does not honour it", async () => {
    const res = await post("/v1/tools/call", { ...CALL, channel: OTHER_CHANNEL });
    // The strict schema rejects the field rather than dropping it, so the
    // attempt is a 400 an operator can see rather than a silently ignored one.
    expect(res.status).toBe(400);
    expect(ProxyError.parse(res.body).error.code).toBe("bad_request");
    expect(ProxyError.parse(res.body).error.channel).toBe(CHANNEL);
    expect(dispatcher.seen).toEqual([]);
  });

  it("refuses every call from a channel with no team sheet", async () => {
    const res = await post("/v1/tools/call", CALL, OTHER_CHANNEL);
    expect(ToolCallResponse.parse(res.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "no_team_sheet" }
    });
  });

  it("refuses the next call for a tool removed from a live sheet, with no restart", async () => {
    const before = await post("/v1/tools/call", CALL);
    expect(ToolCallResponse.parse(before.body).outcome).toBe("ran");

    writeSheet(
      CHANNEL,
      `
[channel]
name = "engineering"

[[mcp_server]]
name = "github"
transport = "http"
url = "https://api.github.com"

  [[mcp_server.tool]]
  name = "merge_pr"
  approval = "required"
`
    );

    const after = await post("/v1/tools/call", CALL);
    expect(ToolCallResponse.parse(after.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "tool_not_allowed", tool: "list_prs" }
    });
  });

  it("refuses every call once the sheet is deleted — revocation is removing it", async () => {
    rmSync(join(channelsRoot, CHANNEL), { recursive: true, force: true });

    const res = await post("/v1/tools/call", CALL);
    expect(ToolCallResponse.parse(res.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "no_team_sheet" }
    });
    expect(dispatcher.seen).toEqual([]);
  });

  it("audits the call with names, an outcome, and no arguments", async () => {
    await post("/v1/tools/call", { ...CALL, tool: "force_push", arguments: { token: "ghp_secret" } });

    const audit = logLines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(entry => entry.event === "tool_call");

    expect(audit).toMatchObject({
      channel: CHANNEL,
      server: "github",
      tool: "force_push",
      outcome: "refused",
      reason: "tool_not_allowed"
    });
    // The model wrote the arguments, so they are not a thing this process logs.
    expect(logLines.join("")).not.toContain("ghp_secret");
  });
});

describe("request bodies", () => {
  it("rejects a body past the cap without buffering it", async () => {
    const res = await post("/v1/tools/call", {
      id: "toolu_01",
      server: "github",
      tool: "list_prs",
      arguments: { blob: "x".repeat(MAX_BODY_BYTES) }
    });

    expect(res.status).toBe(413);
    expect(ProxyError.parse(res.body).error.code).toBe("payload_too_large");
    expect(dispatcher.seen).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await call("/v1/tools/call", clientCert(certs, CHANNEL), "POST", port, "not json");
    expect(res.status).toBe(400);
    expect(ProxyError.parse(res.body).error.code).toBe("bad_request");
  });

  // The drain path. A route that does not read a body still has to answer a
  // client that sent one, rather than leaving it waiting for the body to be
  // consumed. Both early returns that a POST can reach are exercised.
  it("still answers a route that reads no body when one is sent anyway", async () => {
    const body = JSON.stringify({ ignored: true });

    const wrongMethod = await call("/v1/tools", clientCert(certs, CHANNEL), "POST", port, body);
    expect(wrongMethod.status).toBe(405);

    const noRoute = await call("/v1/nope", clientCert(certs, CHANNEL), "POST", port, body);
    expect(noRoute.status).toBe(404);
  });
});

describe("composing the proxy", () => {
  it("refuses to build one that would serve calls without metering them", () => {
    expect(() =>
      createProxyServer({
        tls: loadTlsOptions({
          cert: join(certs, "proxy", "server.pem"),
          key: join(certs, "proxy", "server.key"),
          ca: join(certs, "ca.pem")
        }),
        sheets,
        // The stand-in that never exhausts a budget, with a dispatcher that
        // really serves calls. Nothing binds; the process does not start.
        spend: createUnmeteredSpend(),
        dispatcher: recordingDispatcher()
      })
    ).toThrow(/needs a real spend meter/);
  });
});

describe("the budget gate", () => {
  it("refuses a call once the channel's daily tool calls are spent", async () => {
    writeSheet(
      CHANNEL,
      `
[channel]
name = "engineering"

[budget]
daily_tool_calls = 5

[[mcp_server]]
name = "github"
transport = "http"
url = "https://api.github.com"

  [[mcp_server.tool]]
  name = "list_prs"
`
    );
    spent = { tokens: 0, toolCalls: 5 };

    const res = await post("/v1/tools/call", { id: "1", server: "github", tool: "list_prs" });
    expect(ToolCallResponse.parse(res.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "budget_exhausted", limit: "daily_tool_calls" }
    });
    // Budget is enforced before the call is served, like every other refusal.
    expect(dispatcher.seen).toEqual([]);
  });
});
