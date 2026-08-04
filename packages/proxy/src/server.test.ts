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
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { request } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo } from "node:net";
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
import { resetChannel } from "./budget-admin.js";
import { openBudgetDb } from "./budget-db.js";
import type { BudgetDb } from "./budget-db.js";
import { createSqliteSpendMeter } from "./budget-meter.js";
import {
  type SpendMeter,
  createUnavailableDispatcher,
  markProvisional,
  type ToolDispatcher
} from "./dispatch.js";
import { createHttpDispatcher } from "./http-dispatcher.js";
import { createJsonLogger } from "./log.js";
import { RedactionError } from "./redact.js";
import { MAX_BODY_BYTES, createProxyServer } from "./server.js";
import { SHEET_FILENAME, TeamSheetStore } from "./team-sheet-store.js";
import { loadTlsOptions } from "./tls.js";
import { openVault, parseVaultKey } from "./vault.js";
import type { Vault } from "./vault.js";
import { writeVaultEntries } from "./vault-file.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CHANNEL = "C024BE91L";
const OTHER_CHANNEL = "C7ZZZ9999";
/** Its own channel, so the injection sheet cannot disturb the shared one. */
const INJECT_CHANNEL = "C5INJECT01";

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
 * The real meter over a real file, not a stand-in.
 *
 * The recording dispatcher below really serves calls, so
 * `assertServableComposition` would refuse a provisional meter anyway — but the
 * reason to use the shipped one is that the write path is what these tests are
 * for. A hand-rolled `{ read: () => spent }` would assert that enforcement
 * reads a number, and say nothing about whether serving a call records one.
 *
 * `budgetClock` is the injected clock, so a test can cross a UTC midnight
 * without waiting for one.
 */
let budgetDir: string;
let budgetDb: BudgetDb;
let budgetClock = Date.UTC(2026, 7, 4, 12, 0, 0);
let meter: SpendMeter;
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
    `${CHANNEL},${OTHER_CHANNEL},${INJECT_CHANNEL}`,
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

  budgetDir = mkdtempSync(join(tmpdir(), "libero-proxy-budget-"));
  budgetDb = openBudgetDb({ file: join(budgetDir, "budget.db") });
  meter = createSqliteSpendMeter({ db: budgetDb, now: () => budgetClock });

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
  // Each test starts on a fresh day rather than a cleared counter: rollover is
  // the meter's own reset, so using it here exercises it on every test instead
  // of reaching past the API to truncate a table.
  budgetClock += 24 * 60 * 60 * 1000;
  logLines = [];
});

afterAll(() => {
  server.close();
  sheets.close();
  budgetDb.close();
  rmSync(certs, { recursive: true, force: true });
  rmSync(foreignCerts, { recursive: true, force: true });
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(budgetDir, { recursive: true, force: true });
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
      spend: meter,
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
        // A meter that never exhausts a budget, with a dispatcher that really
        // serves calls. Nothing binds; the process does not start.
        //
        // No such meter ships any more — #96 deleted the stand-in — so this
        // builds one. The check stays because the seams that land next arrive
        // before their implementations, and a stand-in meter is the obvious way
        // to test one of those.
        spend: markProvisional({
          read: () => ({
            toolCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          }),
          recordToolCall: () => {},
          recordTokens: () => ({ outcome: "recorded" as const })
        }),
        dispatcher: recordingDispatcher()
      })
    ).toThrow(/needs a real spend meter/);
  });
});

/** A one-server sheet with whatever `[budget]` lines a test needs. */
function budgetSheet(budget: string): string {
  return `
[channel]
name = "engineering"

[budget]
${budget}

[[mcp_server]]
name = "github"
transport = "http"
url = "https://api.github.com"

  [[mcp_server.tool]]
  name = "list_prs"
`;
}

const listPrs = (id: string) => ({ id, server: "github", tool: "list_prs" });

async function callN(times: number, channel = CHANNEL): Promise<Response[]> {
  const out: Response[] = [];
  for (let i = 0; i < times; i += 1) {
    // Sequentially, because the point of these tests is the counter and not
    // the overshoot window that concurrency opens. See the note on
    // `SpendReader.read` in ./dispatch.ts.
    out.push(await post("/v1/tools/call", listPrs(String(i)), channel));
  }
  return out;
}

describe("the budget gate", () => {
  // The headline property, and the reason this issue exists: the proxy counts
  // what it serves, so a loop that ignores its own caps still cannot get a
  // call served past the sheet's limit. Nothing about this depends on the
  // agent behaving.
  it("stops a loop at the sheet's limit however many times it asks", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 3"));

    const responses = await callN(5);

    expect(responses.slice(0, 3).map(r => (r.body as { outcome: string }).outcome)).toEqual([
      "ran",
      "ran",
      "ran"
    ]);
    for (const res of responses.slice(3)) {
      expect(ToolCallResponse.parse(res.body)).toMatchObject({
        outcome: "refused",
        refusal: { reason: "budget_exhausted", limit: "daily_tool_calls" }
      });
    }
    // Enforced before the call is served, like every other refusal: exactly
    // three calls reached the dispatcher and the refusals left no trace.
    expect(dispatcher.seen).toHaveLength(3);
  });

  it("counts a call the upstream never answered, because it was still served", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 2"));

    // The recording dispatcher answers; what matters is that the count was
    // written before it was asked, so a failure downstream cannot uncount it.
    await post("/v1/tools/call", listPrs("1"));
    expect((await meter.read(CHANNEL)).toolCalls).toBe(1);
  });

  it("never counts a refused or held call", async () => {
    await post("/v1/tools/call", { id: "1", server: "stripe", tool: "charge" });
    await post("/v1/tools/call", { id: "2", server: "github", tool: "force_push" });
    await post("/v1/tools/call", { id: "3", server: "github", tool: "merge_pr" });

    expect(await meter.read(CHANNEL)).toMatchObject({ toolCalls: 0 });
    expect(dispatcher.seen).toEqual([]);
  });

  // One file, and the isolation rests on every statement being scoped to a
  // channel. Asserted end to end, over two certificates, not just at the store.
  it("meters two channels at once without either seeing the other", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 2"));
    writeSheet(OTHER_CHANNEL, budgetSheet("daily_tool_calls = 2"));

    await callN(2, CHANNEL);

    const exhausted = await post("/v1/tools/call", listPrs("x"), CHANNEL);
    expect(ToolCallResponse.parse(exhausted.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "budget_exhausted" }
    });

    const other = await post("/v1/tools/call", listPrs("y"), OTHER_CHANNEL);
    expect(ToolCallResponse.parse(other.body)).toMatchObject({ outcome: "ran" });
    expect((await meter.read(OTHER_CHANNEL)).toolCalls).toBe(1);
  });

  // The reset is an operator path on a second handle to the same file, because
  // the proxy has no admin principal and a state-clearing verb must not sit on
  // the listener the agent talks to. The server keeps running throughout.
  it("is restored by an admin reset with no restart", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 1"));
    await callN(1);

    const refused = await post("/v1/tools/call", listPrs("2"));
    expect(ToolCallResponse.parse(refused.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "budget_exhausted" }
    });

    const operator = openBudgetDb({ file: join(budgetDir, "budget.db") });
    resetChannel(operator, CHANNEL, budgetClock);
    operator.close();

    const served = await post("/v1/tools/call", listPrs("3"));
    expect(ToolCallResponse.parse(served.body)).toMatchObject({ outcome: "ran" });
  });

  // Rollover is a key change, not a sweep, and it happens on the clock rather
  // than at process start — the server here has been up the whole time.
  it("rolls over at the day boundary and leaves yesterday's count behind", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 1"));
    await callN(1);
    const yesterday = budgetClock;

    budgetClock += 24 * 60 * 60 * 1000;
    const served = await post("/v1/tools/call", listPrs("2"));
    expect(ToolCallResponse.parse(served.body)).toMatchObject({ outcome: "ran" });

    budgetClock = yesterday;
    expect((await meter.read(CHANNEL)).toolCalls).toBe(1);
  });

  // The token limit, and the weighting that decides it. Same stored counters,
  // two sheets, two answers: the weight is policy read at decision time, not a
  // number the meter baked in when it wrote the row.
  it("charges a cache read at the weight the sheet gives it", async () => {
    await post("/v1/spend", {
      turn: "turn_cache_weight",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 5_000 }
    });

    writeSheet(CHANNEL, budgetSheet("daily_tokens = 1000\ncache_read_weight = 0.1"));
    const discounted = await post("/v1/tools/call", listPrs("1"));
    expect(ToolCallResponse.parse(discounted.body)).toMatchObject({ outcome: "ran" });

    writeSheet(CHANNEL, budgetSheet("daily_tokens = 1000\ncache_read_weight = 1"));
    const charged = await post("/v1/tools/call", listPrs("2"));
    expect(ToolCallResponse.parse(charged.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "budget_exhausted", limit: "daily_tokens" }
    });
  });
});

describe("reporting spend", () => {
  const usage = {
    inputTokens: 120,
    outputTokens: 8,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 20
  };

  // A fresh id per test, because a turn id is remembered across days — the
  // dedupe window is time-based, not daily, so reusing one would make every
  // test after the first report a duplicate.
  let turn: string;
  let turnSeq = 0;

  beforeEach(() => {
    turnSeq += 1;
    turn = `turn_${turnSeq}`;
  });

  it("records what a turn cost against the reporting channel", async () => {
    const res = await post("/v1/spend", { turn, usage });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "recorded" });
    expect(await meter.read(CHANNEL)).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 100,
      cacheWriteTokens: 20
    });
  });

  // The channel comes from the certificate here exactly as it does on the
  // call route. That is the one thing the two routes share.
  it("binds the report to the certificate and not to anything in the body", async () => {
    await post("/v1/spend", { turn, usage }, OTHER_CHANNEL);

    expect((await meter.read(OTHER_CHANNEL)).inputTokens).toBe(120);
    expect((await meter.read(CHANNEL)).inputTokens).toBe(0);
  });

  it("rejects a report that asserts a channel", async () => {
    const res = await post("/v1/spend", { turn, usage, channel: OTHER_CHANNEL });

    expect(res.status).toBe(400);
    expect(ProxyError.parse(res.body).error.code).toBe("bad_request");
    expect((await meter.read(CHANNEL)).inputTokens).toBe(0);
  });

  // Retry safety. A report that arrives twice — a failed response, a restart
  // mid-flight — must move the meter once.
  it("is safe to retry: the repeat is a duplicate and spends nothing", async () => {
    await post("/v1/spend", { turn, usage });
    const again = await post("/v1/spend", { turn, usage });

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ outcome: "duplicate" });
    expect((await meter.read(CHANNEL)).inputTokens).toBe(120);
  });

  it("rejects a malformed report without relaying what was wrong with it", async () => {
    const res = await post("/v1/spend", { turn, usage: { inputTokens: -1, outputTokens: 0 } });

    expect(res.status).toBe(400);
    const error = ProxyError.parse(res.body).error;
    expect(error.code).toBe("bad_request");
    expect(error.message).toBe("the request body is not a valid spend report");
  });

  it("takes no other method", async () => {
    const res = await call("/v1/spend", clientCert(certs, CHANNEL), "GET");
    expect(res.status).toBe(405);
  });

  // The sharpest available statement of "this route makes no authorization
  // decision". A channel with no team sheet at all cannot make a tool call —
  // every one is refused `no_team_sheet` — and its report is still recorded,
  // because nothing on this path asked the sheet anything.
  it("records a report for a channel that has no team sheet", async () => {
    rmSync(join(channelsRoot, OTHER_CHANNEL), { recursive: true, force: true });

    const refused = await post("/v1/tools/call", listPrs("1"), OTHER_CHANNEL);
    expect(ToolCallResponse.parse(refused.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "no_team_sheet" }
    });

    const reported = await post("/v1/spend", { turn, usage }, OTHER_CHANNEL);
    expect(reported.status).toBe(200);
    expect(reported.body).toEqual({ outcome: "recorded" });
  });

  // And the mechanical form of the same claim: the sheet store is not touched.
  it("resolves no team sheet at all", async () => {
    const resolve = vi.spyOn(sheets, "resolve");
    try {
      await post("/v1/spend", { turn, usage });
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
    }
  });

  it("logs the report without a verdict, because it made none", async () => {
    await post("/v1/spend", { turn, usage });

    const reported = logLines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.event === "spend_reported");
    expect(reported).toMatchObject({ channel: CHANNEL, report: "recorded", tokens: 248 });
    expect(reported).not.toHaveProperty("outcome");
    expect(reported).not.toHaveProperty("reason");
  });
});

describe("no route returns a credential", () => {
  // The vault holds a value in this same process while every route is walked.
  //
  // Nothing here consumes a credential yet — that is #51 — so this is not
  // testing injection. It is the honest form of "no route, response, log line,
  // or error can be made to emit a stored secret" while the vault is loaded and
  // the surface it must not reach is fully built. It survives #51 unchanged, as
  // the regression harness for the moment a credential really does reach a
  // tool call.
  const VAULT_VALUE = "ghp_leaked_value_16C7e42F292c6912E7710c838347Ae178B4a";

  let vaultDir: string;
  let vault: Vault;

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "libero-proxy-vault-"));
    const parsed = parseVaultKey(randomBytes(32).toString("base64"));
    if (!parsed.ok) throw new Error("test key did not parse");
    const file = join(vaultDir, "vault.enc");
    writeVaultEntries(file, parsed.key, new Map([["github_service_account", VAULT_VALUE]]));
    vault = openVault({ file, key: parsed.key });
  });

  afterAll(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("holds the value, so the assertions below are not vacuous", () => {
    const found = vault.lookup("github_service_account");
    expect(found.status).toBe("found");
    if (found.status === "found") expect(found.secret.reveal()).toBe(VAULT_VALUE);
  });

  it("emits it from no route, on any outcome", async () => {
    logLines = [];
    const cert = clientCert(certs, CHANNEL);
    const bodyOf = (call: unknown): string => JSON.stringify(call);

    const responses = [
      // Every route, every method the table answers.
      await call("/health", cert),
      await call("/v1/whoami", cert),
      await call("/v1/tools", cert),
      // Ran, refused, held — the three ways a call is answered.
      await post("/v1/tools/call", { id: "toolu_01", server: "github", tool: "list_prs" }),
      await post("/v1/tools/call", { id: "toolu_02", server: "github", tool: "not_listed" }),
      await post("/v1/tools/call", { id: "toolu_03", server: "not_listed", tool: "list_prs" }),
      await post("/v1/tools/call", { id: "toolu_04", server: "github", tool: "merge_pr" }),
      // A body the model wrote that does not parse, and one asserting a channel.
      await post("/v1/tools/call", { id: "toolu_05", server: "github" }),
      await post("/v1/tools/call", {
        id: "toolu_06",
        server: "github",
        tool: "list_prs",
        channel: OTHER_CHANNEL
      }),
      // Arguments carrying something secret-shaped, which must not echo either.
      await post("/v1/tools/call", {
        id: "toolu_07",
        server: "github",
        tool: "list_prs",
        arguments: { token: VAULT_VALUE }
      }),
      // The error paths: unknown route, wrong method, oversized body.
      await call("/v1/nope", cert),
      await call("/v1/tools", cert, "POST"),
      await call(
        "/v1/tools/call",
        cert,
        "POST",
        port,
        bodyOf({ id: "toolu_08", server: "github", tool: "list_prs", arguments: { pad: "x".repeat(MAX_BODY_BYTES) } })
      )
    ];

    // Every request was answered — a walk that silently failed to reach a route
    // would assert nothing.
    expect(responses).toHaveLength(13);
    for (const response of responses) {
      expect(response.status).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain("ghp_");
    }
    expect(logLines.join("")).not.toContain("ghp_");
  });

  // The moment the harness above was written for: a credential really does
  // reach a tool call. Same vault, same value, but now a real dispatcher and a
  // real upstream at the far end of a real socket, behind the real mTLS proxy.
  describe("with credential injection wired end to end", () => {
    let upstream: HttpServer;
    let upstreamSaw: (string | undefined)[] = [];
    let injected: Server;
    let injectedPort: number;
    let injectedLog: string[] = [];
    /** Built in beforeAll once the mock upstream's port is known. */
    let injectSheet = "";
    const injectLogger = createJsonLogger(line => injectedLog.push(line));

    beforeAll(async () => {
      upstream = createHttpServer((req, res) => {
        upstreamSaw.push(req.headers.authorization);
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          // Echoes its own Authorization header back, which is the leak class
          // the redaction pass closes and the worst realistic upstream.
          res.end(JSON.stringify({ prs: [], sawAuth: req.headers.authorization }));
        });
      });
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
      const upstreamPort = (upstream.address() as AddressInfo).port;
      injectSheet = `
[channel]
name = "injected"

[[mcp_server]]
name = "github"
transport = "http"
url = "http://127.0.0.1:${upstreamPort}"
credential = "github_service_account"

  [[mcp_server.tool]]
  name = "list_prs"
`;

      injected = createProxyServer({
        tls: loadTlsOptions({
          cert: join(certs, "proxy", "server.pem"),
          key: join(certs, "proxy", "server.key"),
          ca: join(certs, "ca.pem")
        }),
        sheets,
        // A real meter, because `createHttpDispatcher` is a real dispatcher and
        // `assertServableComposition` will not pair one with the stand-in.
        spend: meter,
        // The same logger to both, as a deployment would: the dispatcher's
        // outbound line and the server's request line land in one stream, which
        // is what makes "no log line holds the value" worth asserting.
        dispatcher: createHttpDispatcher({ vault, logger: injectLogger }),
        logger: injectLogger
      });

      await new Promise<void>(resolve => {
        injected.listen(0, "127.0.0.1", () => {
          injectedPort = (injected.address() as AddressInfo).port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      injected.closeAllConnections();
      await new Promise<void>(resolve => injected.close(() => resolve()));
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    });

    beforeEach(() => {
      // After the outer beforeEach, which wipes the channels root to restore
      // the shared sheet — so this channel's has to be rewritten each time.
      writeSheet(INJECT_CHANNEL, injectSheet);
      upstreamSaw = [];
      injectedLog = [];
    });

    it("hands the upstream the real secret", async () => {
      const response = await call(
        "/v1/tools/call",
        clientCert(certs, INJECT_CHANNEL),
        "POST",
        injectedPort,
        JSON.stringify({ id: "toolu_01", server: "github", tool: "list_prs" })
      );

      expect(ToolCallResponse.parse(response.body)).toMatchObject({ outcome: "ran" });
      expect(upstreamSaw).toEqual([`Bearer ${VAULT_VALUE}`]);
    });

    // The composition `apps/proxy-server` now ships: a real meter, a real
    // dispatcher, a real vault, a real upstream. It is what ends the 501 —
    // and the call it serves is metered, which is what makes serving it legal.
    it("serves a permitted call instead of 501, and meters it", async () => {
      const before = (await meter.read(INJECT_CHANNEL)).toolCalls;

      const response = await call(
        "/v1/tools/call",
        clientCert(certs, INJECT_CHANNEL),
        "POST",
        injectedPort,
        JSON.stringify({ id: "toolu_02", server: "github", tool: "list_prs" })
      );

      expect(response.status).toBe(200);
      expect(ToolCallResponse.parse(response.body)).toMatchObject({ outcome: "ran" });
      expect((await meter.read(INJECT_CHANNEL)).toolCalls).toBe(before + 1);
    });

    // The acceptance criterion for the redaction pass, and the reason it is
    // asserted here rather than only as a unit: this is the real proxy, the
    // real vault, a real socket, and an upstream that genuinely reflects the
    // header it was given. The value provably crossed outward on the request
    // above and provably does not cross back on this one.
    it("scrubs the credential out of a result the upstream echoed", async () => {
      const response = await call(
        "/v1/tools/call",
        clientCert(certs, INJECT_CHANNEL),
        "POST",
        injectedPort,
        JSON.stringify({ id: "toolu_04", server: "github", tool: "list_prs" })
      );

      const parsed = ToolCallResponse.parse(response.body);
      expect(parsed.outcome).toBe("ran");
      const content = parsed.outcome === "ran" ? parsed.result.content : "";
      // The upstream really did receive it, so the assertion below is not vacuous.
      expect(upstreamSaw).toEqual([`Bearer ${VAULT_VALUE}`]);
      expect(content).toContain("[redacted:github_service_account]");
      expect(content).not.toContain(VAULT_VALUE);
      expect(JSON.stringify(response.body)).not.toContain("ghp_");
    });

    // The other half of the acceptance criterion, and the reason the two are
    // asserted in one place: the value provably crossed to the upstream on the
    // request above, and provably did not cross back on this one.
    it("returns a response and writes logs that hold no trace of it", async () => {
      const response = await call(
        "/v1/tools/call",
        clientCert(certs, INJECT_CHANNEL),
        "POST",
        injectedPort,
        JSON.stringify({ id: "toolu_02", server: "github", tool: "list_prs" })
      );

      expect(JSON.stringify(response.body)).not.toContain("ghp_");
      expect(injectedLog.join("")).not.toContain("ghp_");
      expect(injectedLog.join("")).not.toContain("Bearer");
      // The name is expected in the log; that is what makes it useful.
      expect(injectedLog.join("")).toContain("github_service_account");
    });

    it("refuses by name when the sheet names a credential the vault lacks", async () => {
      writeSheet(
        INJECT_CHANNEL,
        `
[channel]
name = "injected"

[[mcp_server]]
name = "github"
transport = "http"
url = "http://127.0.0.1:1"
credential = "absent_credential"

  [[mcp_server.tool]]
  name = "list_prs"
`
      );

      const response = await call(
        "/v1/tools/call",
        clientCert(certs, INJECT_CHANNEL),
        "POST",
        injectedPort,
        JSON.stringify({ id: "toolu_03", server: "github", tool: "list_prs" })
      );

      // A served request, not an error: 200 with the structured refusal.
      expect(response.status).toBe(200);
      expect(ToolCallResponse.parse(response.body)).toMatchObject({
        outcome: "refused",
        refusal: { reason: "credential_unresolved", credential: "absent_credential" }
      });
      expect(upstreamSaw).toEqual([]);
    });
  });
});

// Nothing covered this end to end: `unavailable` was only a unit assertion in
// dispatch.test.ts. It is the behaviour every deployment currently has, so it
// is worth pinning at the wire — a permitted call gets 501 and not a refusal,
// because nothing was denied.
describe("a permitted call with no upstream", () => {
  let bare: Server;
  let barePort: number;

  beforeAll(async () => {
    bare = createProxyServer({
      tls: loadTlsOptions({
        cert: join(certs, "proxy", "server.pem"),
        key: join(certs, "proxy", "server.key"),
        ca: join(certs, "ca.pem")
      }),
      sheets,
      // A real meter with the unavailable dispatcher: a deployment ahead of
      // its upstream, which `assertServableComposition` permits.
      spend: meter,
      dispatcher: createUnavailableDispatcher(),
      logger: createJsonLogger(() => {})
    });
    await new Promise<void>(resolve => {
      bare.listen(0, "127.0.0.1", () => {
        barePort = (bare.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    bare.closeAllConnections();
    await new Promise<void>(resolve => bare.close(() => resolve()));
  });

  it("answers 501, not a refusal", async () => {
    const response = await call(
      "/v1/tools/call",
      clientCert(certs, CHANNEL),
      "POST",
      barePort,
      JSON.stringify({ id: "toolu_01", server: "github", tool: "list_prs" })
    );

    expect(response.status).toBe(501);
    expect(ProxyError.parse(response.body).error.code).toBe("not_implemented");
  });

  // The fail-closed criterion, over the whole chain rather than link by link:
  // a redaction that could not be performed must produce no response at all,
  // not a served one carrying bytes nobody could scrub.
  it("answers 500 and no upstream bytes when redaction fails", async () => {
    const lines: string[] = [];
    const throwing = createProxyServer({
      tls: loadTlsOptions({
        cert: join(certs, "proxy", "server.pem"),
        key: join(certs, "proxy", "server.key"),
        ca: join(certs, "ca.pem")
      }),
      sheets,
      spend: meter,
      dispatcher: {
        dispatch: () => {
          throw new RedactionError("empty_value");
        }
      },
      logger: createJsonLogger(line => lines.push(line))
    });
    const throwingPort = await new Promise<number>(resolve => {
      throwing.listen(0, "127.0.0.1", () => resolve((throwing.address() as AddressInfo).port));
    });

    try {
      const response = await call(
        "/v1/tools/call",
        clientCert(certs, CHANNEL),
        "POST",
        throwingPort,
        JSON.stringify({ id: "toolu_09", server: "github", tool: "list_prs" })
      );

      expect(response.status).toBe(500);
      expect(ProxyError.parse(response.body).error.code).toBe("internal");
      // Not a 200 with a result, and not a refusal — nothing was denied and
      // nothing was served.
      expect(JSON.stringify(response.body)).not.toContain("outcome");
      expect(lines.map(line => JSON.parse(line) as { event: string })).toContainEqual(
        expect.objectContaining({ event: "handler_failed" })
      );
    } finally {
      throwing.closeAllConnections();
      await new Promise<void>(resolve => throwing.close(() => resolve()));
    }
  });

  it("still refuses an unlisted tool, so 501 is not a blanket answer", async () => {
    const response = await call(
      "/v1/tools/call",
      clientCert(certs, CHANNEL),
      "POST",
      barePort,
      JSON.stringify({ id: "toolu_02", server: "github", tool: "not_listed" })
    );

    expect(response.status).toBe(200);
    expect(ToolCallResponse.parse(response.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "tool_not_allowed" }
    });
  });
});
