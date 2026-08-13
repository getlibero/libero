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
import { X509Certificate, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProxyError,
  type ResolvedToolCall,
  ToolCallResponse,
  ToolListing
} from "@getlibero/schema";
import { openAuditDb } from "./audit-db.js";
import type { AuditDb } from "./audit-db.js";
import { createSqliteAuditWriter } from "./audit-log.js";
import type { AuditWriter } from "./audit-log.js";
import { resetChannel } from "./budget-admin.js";
import { openBudgetDb } from "./budget-db.js";
import type { BudgetDb } from "./budget-db.js";
import { createSqliteSpendMeter } from "./budget-meter.js";
import {
  type SpendMeter,
  createToolDispatcher,
  createUnavailableCatalog,
  createUnavailableDispatcher,
  markProvisional,
  type ToolDispatcher
} from "./dispatch.js";
import { type HttpDispatcher, createHttpDispatcher } from "./http-dispatcher.js";
import { ANNOTATION_UNDER_ITEMS, type FakeMcpServer, startFakeMcpServer } from "./mcp-fake-server.js";
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
/** And one for the listing suite, which rewrites its sheet in every test. */
const DESCRIBED_CHANNEL = "C7DESCRIBE";

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
/**
 * Sheet reads the shared server has caused, counted at the boundary it holds.
 *
 * Not a spy on the store, and that is the whole point. `TeamSheetStore`'s
 * watcher refreshes a channel by calling `this.resolve` — so a spy on the
 * instance counts the store keeping itself current as though a request had
 * asked it something. `beforeEach` deletes the channels root and rewrites the
 * sheet before every test in this file, which means those refreshes are always
 * in flight and land whenever the OS delivers the event. That is what made
 * "adds no team-sheet read of its own" fail about one run in five (#243).
 *
 * Counting here counts what a request caused, because this is the view the
 * server was handed and the watcher does not go through it.
 */
let serverSheetReads = 0;
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

/**
 * The audit log, real and on a real file, as the meter above is.
 *
 * `auditCursor` is the wrinkle the table's own property forces: `beforeEach`
 * cannot truncate it, because nothing can. Each test records where the log had
 * got to and reads only what came after — which is itself a demonstration of
 * what is being tested.
 */
let auditDir: string;
let auditDb: AuditDb;
let auditFile: string;
let auditCursor = 0;

/** Rows since the cursor, read the way the audit CLI will: a separate handle. */
function auditRows(file: string = auditFile, since: number = auditCursor): Record<string, unknown>[] {
  const raw = new DatabaseSync(file);
  try {
    return raw
      .prepare("SELECT * FROM tool_call_audit WHERE id > ? ORDER BY id")
      .all(since) as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

/**
 * For a server whose test is about something else entirely. The option is
 * required, so every composition has to say something; this says "not the
 * subject of this test" rather than quietly dropping rows in one that is.
 */
function discardingAuditWriter(): AuditWriter {
  return { append: () => {} };
}

function lastAuditId(file: string = auditFile): number {
  const raw = new DatabaseSync(file);
  try {
    const row = raw.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM tool_call_audit").get() as { id: number };
    return row.id;
  } finally {
    raw.close();
  }
}

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
 * A call body carrying the attribution the agent asserts (#95).
 *
 * Required by `ToolCall`, so every body here needs it, and a helper rather than
 * a literal per site keeps the fields out of the way of what each test is
 * actually about. That they change no decision is asserted in enforce.test.ts,
 * which is where the rule lives; here they are only along for the ride.
 */
function asked(fields: Record<string, unknown>): Record<string, unknown> {
  return { requestingUser: "U0ASKER", task: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55", ...fields };
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

/** The SHA-256 digest of a minted client certificate, as a sheet pins one. */
function pinOf(dir: string, label: string): string {
  return new X509Certificate(readFileSync(join(dir, "agent", `client-${label}.pem`))).fingerprint256;
}

/**
 * Every sheet this suite writes pins the certificate minted for its own
 * channel (#79).
 *
 * Injected here rather than written into each fixture. None of the cases below
 * is about pinning — the ones that are write their own `certificate_sha256`
 * line, which this leaves alone — and the identity gate answers 401 to a
 * request whose sheet does not name the certificate it arrived on, so without
 * this every case in the file would be testing that instead of itself.
 */
function pinned(channel: string, toml: string): string {
  if (toml.includes("certificate_sha256")) return toml;
  return toml.replace(
    "[channel]\n",
    `[channel]\ncertificate_sha256 = ["${pinOf(certs, channel)}"]\n`
  );
}

function writeSheet(channel: string, toml: string): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, SHEET_FILENAME), pinned(channel, toml));
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
    `${CHANNEL},${OTHER_CHANNEL},${INJECT_CHANNEL},${DESCRIBED_CHANNEL}`,
    // A certificate this CA signed whose subject is not a channel principal —
    // the shape a single shared service certificate would have.
    "--raw-cn",
    "no-prefix=agent",
    // And one whose channel id would escape the per-channel directory.
    "--raw-cn",
    "traversal=channel:../../etc",
    // The leak #79 is about, modelled exactly: a second certificate for a
    // channel that is still in use, signed by the same CA, carrying the same
    // subject, differing only in the private key behind it. Nothing about the
    // CN can tell it from the real one — the sheet's pin is the whole
    // difference.
    "--raw-cn",
    `leaked=channel:${CHANNEL}`
  ]);
  mint(foreignCerts, ["--channels", CHANNEL]);

  channelsRoot = mkdtempSync(join(tmpdir(), "libero-proxy-channels-"));
  sheets = new TeamSheetStore({ root: channelsRoot });
  dispatcher = recordingDispatcher();

  budgetDir = mkdtempSync(join(tmpdir(), "libero-proxy-budget-"));
  budgetDb = openBudgetDb({ file: join(budgetDir, "budget.db") });
  meter = createSqliteSpendMeter({ db: budgetDb, now: () => budgetClock });

  auditDir = mkdtempSync(join(tmpdir(), "libero-proxy-audit-"));
  auditFile = join(auditDir, "audit.db");
  auditDb = openAuditDb({ file: auditFile });

  server = createProxyServer({
    tls: loadTlsOptions({
      cert: join(certs, "proxy", "server.pem"),
      key: join(certs, "proxy", "server.key"),
      ca: join(certs, "ca.pem")
    }),
    sheets: {
      resolve: channel => {
        serverSheetReads += 1;
        return sheets.resolve(channel);
      }
    },
    spend: meter,
    dispatcher,
    catalog: createUnavailableCatalog(),
    audit: createSqliteAuditWriter({ db: auditDb }),
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
  // Not a truncate. Nothing can truncate this table — see `auditCursor`.
  auditCursor = lastAuditId();
});

afterAll(() => {
  server.close();
  sheets.close();
  budgetDb.close();
  auditDb.close();
  rmSync(certs, { recursive: true, force: true });
  rmSync(foreignCerts, { recursive: true, force: true });
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(budgetDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
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

// #79. A certificate proves which channel is calling; the sheet says which key
// is allowed to say it. What these cases are about is the leak the CN alone
// cannot answer: `client-leaked.pem` carries `CN=channel:<CHANNEL>` exactly as
// the real one does and was signed by the same CA, so every gate before this
// one lets it through.
describe("certificate pinning", () => {
  const real = () => clientCert(certs, CHANNEL);
  const leaked = () => clientCert(certs, "leaked");

  /** A sheet for CHANNEL pinning exactly the certificates named. */
  function pinning(...labels: string[]): string {
    const pins = labels.map(label => `"${pinOf(certs, label)}"`).join(", ");
    return `${SHEET.replace("[channel]\n", `[channel]\ncertificate_sha256 = [${pins}]\n`)}`;
  }

  // The positive control. Every assertion below is "the leaked certificate got
  // nothing", and each of them passes just as well against a proxy that is
  // refusing everyone — so first, the real certificate works.
  it("serves the certificate the sheet pins", async () => {
    writeSheet(CHANNEL, pinning(CHANNEL));
    expect(await call("/v1/whoami", real())).toEqual({ status: 200, body: { channel: CHANNEL } });
  });

  // The acceptance criterion, in one test: the leaked key is dead and the
  // channel is not. No sheet was deleted, so legitimate use never stopped.
  it("refuses a certificate the sheet does not pin, without taking the channel offline", async () => {
    writeSheet(CHANNEL, pinning(CHANNEL));

    const refused = await call("/v1/whoami", leaked());
    expect(refused.status).toBe(401);
    expect(ProxyError.parse(refused.body).error.code).toBe("unauthenticated");

    expect(await call("/v1/whoami", real())).toEqual({ status: 200, body: { channel: CHANNEL } });
  });

  // The reason the check is in the identity gate rather than in the tool-call
  // handler. A key that could still enumerate the channel's tools, read its
  // spend, or answer its held calls would be revoked in name only.
  it("refuses it on every route on the listener", async () => {
    writeSheet(CHANNEL, pinning(CHANNEL));

    const responses = await Promise.all([
      call("/health", leaked()),
      call("/v1/whoami", leaked()),
      call("/v1/tools", leaked()),
      call("/v1/tools/call", leaked(), "POST", port, JSON.stringify(listPrs("pin-1"))),
      call(
        "/v1/spend",
        leaked(),
        "POST",
        port,
        JSON.stringify({
          turn: "9f2a1b6c-4d3e-4f5a-8b7c-0d1e2f3a4b5c",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
        })
      ),
      call("/v1/approvals", leaked(), "POST", port, JSON.stringify({ ticket: "t", decision: "approve" })),
      // Not even which paths exist: the pin check runs ahead of the route table.
      call("/v1/nope", leaked())
    ]);
    expect(responses.map(r => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
  });

  it("leaves no audit row and reaches no upstream", async () => {
    writeSheet(CHANNEL, pinning(CHANNEL));
    const before = lastAuditId();

    await call("/v1/tools/call", leaked(), "POST", port, JSON.stringify(listPrs("pin-2")));

    expect(lastAuditId()).toBe(before);
    expect(dispatcher.seen).toEqual([]);
  });

  // The overlap that makes rotation gapless: mint the replacement, pin it
  // beside the one in service, and there is no moment when neither works.
  it("accepts either of two pinned certificates", async () => {
    writeSheet(CHANNEL, pinning(CHANNEL, "leaked"));

    expect((await call("/v1/whoami", real())).status).toBe(200);
    expect((await call("/v1/whoami", leaked())).status).toBe(200);
  });

  // And the other end of the rotation. No restart of anything: the sheet store
  // re-reads on change and the gate resolves per request, so dropping a
  // fingerprint takes effect on the next call.
  it("stops accepting a certificate the moment its pin is dropped", async () => {
    writeSheet(CHANNEL, pinning(CHANNEL, "leaked"));
    expect((await call("/v1/whoami", leaked())).status).toBe(200);

    writeSheet(CHANNEL, pinning(CHANNEL));
    expect((await call("/v1/whoami", leaked())).status).toBe(401);
    expect((await call("/v1/whoami", real())).status).toBe(200);
  });

  it("keeps the fingerprint out of the response and puts it in the log", async () => {
    writeSheet(CHANNEL, pinning(CHANNEL));
    logLines = [];

    const res = await call("/v1/whoami", leaked());
    const presented = pinOf(certs, "leaked");
    expect(JSON.stringify(res.body)).not.toContain(presented);
    // As with every rejection from this gate, the body names no channel.
    expect(ProxyError.parse(res.body).error.channel).toBeUndefined();

    const rejection = logLines.find(line => line.includes("certificate_not_pinned"));
    expect(JSON.parse(rejection ?? "{}")).toMatchObject({
      event: "identity_rejected",
      reason: "certificate_not_pinned",
      channel: CHANNEL,
      fingerprint: presented,
      pins: 1
    });
  });

  // The two sheet states the gate passes through untouched. Both already have
  // answers further in that name what is wrong, and a bare 401 in their place
  // would be a worse answer to a question about provisioning.
  it("leaves a channel with no sheet, and one with a broken sheet, to their own refusals", async () => {
    rmSync(join(channelsRoot, CHANNEL), { recursive: true, force: true });
    const unprovisioned = await post("/v1/tools/call", listPrs("pin-3"));
    expect(unprovisioned.status).toBe(200);
    expect(ToolCallResponse.parse(unprovisioned.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "no_team_sheet" }
    });

    writeSheet(CHANNEL, "[channel\nname = broken\n");
    const unreadable = await post("/v1/tools/call", listPrs("pin-4"));
    expect(ToolCallResponse.parse(unreadable.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "team_sheet_unreadable" }
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
      dispatcher: createToolDispatcher({ mcp: createUnavailableDispatcher() }),
      catalog: createUnavailableCatalog(),
      audit: discardingAuditWriter(),
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

  // A built-in is described from this build's own constants rather than from an
  // upstream answer, so it is the one row that cannot degrade to a thin one —
  // there is nobody to ask and nothing that can fail (#64).
  it("carries a built-in with its description and schema", async () => {
    writeSheet(
      CHANNEL,
      `
[channel]
name = "engineering"

[[builtin]]
name = "search_channel_history"
`
    );

    const { tools } = ToolListing.parse((await call("/v1/tools", clientCert(certs, CHANNEL))).body);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      server: "libero",
      tool: "search_channel_history",
      approval: "none",
      description: expect.stringContaining("Search this Slack channel's own message history"),
      inputSchema: expect.objectContaining({ type: "object" })
    });
    // No channel argument, which is what makes the scope structural rather than
    // checked. The executor's `.strict()` parse is the other half.
    const properties = (tools[0]?.inputSchema as unknown as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).toEqual(["query", "limit"]);
    expect(properties).not.toHaveProperty("channel");
  });

  it("resolves a built-in's approval the way the call-time gate will", async () => {
    writeSheet(
      CHANNEL,
      `
[channel]
name = "engineering"

[[builtin]]
name = "search_channel_history"
approval = "required"
`
    );

    const { tools } = ToolListing.parse((await call("/v1/tools", clientCert(certs, CHANNEL))).body);
    expect(tools[0]?.approval).toBe("required");
  });

  it("lists a built-in after the sheet's upstream tools", async () => {
    writeSheet(CHANNEL, `${SHEET}\n[[builtin]]\nname = "search_channel_history"\n`);

    const { tools } = ToolListing.parse((await call("/v1/tools", clientCert(certs, CHANNEL))).body);

    expect(tools.at(-1)?.server).toBe("libero");
    expect(tools.slice(0, -1).every(tool => tool.server === "github")).toBe(true);
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
  const CALL = asked({ id: "toolu_01", server: "github", tool: "list_prs", arguments: { state: "open" } });

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

  // The two fields exist to be read back by a human (#95), so the end-to-end
  // claim is that they survive the wire into what an operator greps — not
  // merely that the route parses them.
  it("audits who a call said asked, and which task it claimed", async () => {
    await post(
      "/v1/tools/call",
      asked({ id: "toolu_01", server: "github", tool: "list_prs", requestingUser: "U024BE7LH" })
    );

    const audit = logLines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(entry => entry.event === "tool_call");

    expect(audit).toMatchObject({
      outcome: "ran",
      requestingUser: "U024BE7LH",
      task: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55"
    });
  });

  // Bounded at the edge, so nothing downstream — a log line today, an audit
  // row and a CSV export tomorrow (#97, #98) — has to cope with an agent that
  // decided its user id was a kilobyte of text.
  it("rejects a call whose attribution is not a short identifier", async () => {
    for (const bad of ["x".repeat(65), "has space", "U1\nU2", ""]) {
      const asUser = await post(
        "/v1/tools/call",
        asked({ id: "toolu_01", server: "github", tool: "list_prs", requestingUser: bad })
      );
      const asTask = await post(
        "/v1/tools/call",
        asked({ id: "toolu_01", server: "github", tool: "list_prs", task: bad })
      );

      expect(asUser.status).toBe(400);
      expect(asTask.status).toBe(400);
      expect(ProxyError.parse(asUser.body).error.code).toBe("bad_request");
    }
    // Refused before anything upstream was touched, exactly as a malformed
    // body has always been.
    expect(dispatcher.seen).toEqual([]);
  });

  it("rejects a call carrying no attribution at all", async () => {
    const res = await post("/v1/tools/call", {
      id: "toolu_01",
      server: "github",
      tool: "list_prs"
    });

    expect(res.status).toBe(400);
    expect(dispatcher.seen).toEqual([]);
  });
});

// The log line above is what an operator tails. This is what survives the
// process — and #97's criteria are about the row, not the line.
describe("the durable audit record", () => {
  const CALL = asked({ id: "toolu_01", server: "github", tool: "list_prs", arguments: { state: "open" } });

  it("writes one row for a served call, with what the proxy observed", async () => {
    await post(
      "/v1/tools/call",
      asked({
        id: "toolu_served",
        server: "github",
        tool: "list_prs",
        requestingUser: "U024BE7LH",
        arguments: { state: "open" }
      })
    );

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: CHANNEL,
      requesting_user: "U024BE7LH",
      task: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55",
      call_id: "toolu_served",
      server: "github",
      tool: "list_prs",
      outcome: "ran",
      refusal_reason: null,
      // `recordingDispatcher` answers "upstream said so": 16 bytes, measured
      // rather than asserted by anything the model wrote.
      result_bytes: 16,
      result_is_error: 0,
      approver: null
    });
    expect(String(rows[0]?.arguments_sha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes one row for a refusal, carrying the reason", async () => {
    await post("/v1/tools/call", { ...CALL, tool: "force_push" });

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "refused",
      refusal_reason: "tool_not_allowed",
      tool: "force_push",
      // Never dispatched, so there is no result to size.
      result_bytes: null,
      result_is_error: null
    });
  });

  it("writes one row for a hold, and tells it from a refusal", async () => {
    await post("/v1/tools/call", { ...CALL, tool: "merge_pr" });

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "held",
      refusal_reason: "approval_required",
      tool: "merge_pr",
      // Not on this row. It cannot be back-filled — the table refuses UPDATE —
      // so the approver is written on the decision's own row and again on the
      // row of the call that ran. This row carries the ticket that joins them.
      approver: null
    });
    expect(auditRows().at(-1)?.ticket).toEqual(expect.any(String));
  });

  // A call that ran and a call that was refused must not collapse into one row
  // or three: "exactly one row per decided call" is what makes any count of
  // this table mean anything.
  it("writes exactly one row per call, in order", async () => {
    await post("/v1/tools/call", { ...CALL, id: "toolu_a" });
    await post("/v1/tools/call", { ...CALL, id: "toolu_b", tool: "force_push" });
    await post("/v1/tools/call", { ...CALL, id: "toolu_c" });

    expect(auditRows().map(row => [row.call_id, row.outcome])).toEqual([
      ["toolu_a", "ran"],
      ["toolu_b", "refused"],
      ["toolu_c", "ran"]
    ]);
  });

  // Arguments are model-authored, so nothing on the write path could redact
  // them and nothing on it stores them. The hash is what stands in.
  it("stores a hash of the arguments and not the arguments", async () => {
    await post("/v1/tools/call", {
      ...CALL,
      id: "toolu_args",
      arguments: { token: "ghp_secret", note: "sensitive text" }
    });

    const written = JSON.stringify(auditRows());
    expect(written).not.toContain("ghp_secret");
    expect(written).not.toContain("sensitive text");
    expect(written).not.toContain("token");
  });

  // The same call twice hashes the same; a different one does not. That is the
  // whole of what the column is for.
  it("hashes the same arguments alike and different arguments apart", async () => {
    await post("/v1/tools/call", { ...CALL, id: "toolu_1", arguments: { a: 1, b: 2 } });
    await post("/v1/tools/call", { ...CALL, id: "toolu_2", arguments: { b: 2, a: 1 } });
    await post("/v1/tools/call", { ...CALL, id: "toolu_3", arguments: { a: 9, b: 2 } });

    const [first, second, third] = auditRows().map(row => row.arguments_sha256);
    expect(first).toBe(second);
    expect(first).not.toBe(third);
  });

  it("keeps two channels' rows apart", async () => {
    writeSheet(OTHER_CHANNEL, SHEET);

    await post("/v1/tools/call", { ...CALL, id: "toolu_mine" });
    await call(
      "/v1/tools/call",
      clientCert(certs, OTHER_CHANNEL),
      "POST",
      port,
      JSON.stringify(asked({ id: "toolu_theirs", server: "github", tool: "list_prs" }))
    );

    const rows = auditRows();
    expect(rows.map(row => [row.channel, row.call_id])).toEqual([
      [CHANNEL, "toolu_mine"],
      [OTHER_CHANNEL, "toolu_theirs"]
    ]);
    // The channel came off the certificate on both, so filtering on it is the
    // only thing that separates them and it is not something either could assert.
    expect(rows.filter(row => row.channel === OTHER_CHANNEL)).toHaveLength(1);
  });

  // A body that never became a call has nothing to attribute a row to, and a
  // row of nulls would be worse than the log line it already gets: it would be
  // counted. Stated as a test so the gap is a decision rather than a surprise.
  it("writes no row for a body that is not a tool call", async () => {
    await post("/v1/tools/call", { id: "toolu_01", server: "github", tool: "list_prs" });

    expect(auditRows()).toEqual([]);
    expect(logLines.join("")).toContain("tool_call_malformed");
  });

  // The rule the route is built on: a proxy that cannot record what it did must
  // not answer. Refusing one call is the right trade against serving a stream
  // of them with no record.
  it("answers 500 and no tool-call response when the row cannot be written", async () => {
    const lines: string[] = [];
    let appends = 0;
    const failing = createProxyServer({
      tls: loadTlsOptions({
        cert: join(certs, "proxy", "server.pem"),
        key: join(certs, "proxy", "server.key"),
        ca: join(certs, "ca.pem")
      }),
      sheets,
      spend: meter,
      dispatcher: recordingDispatcher(),
      catalog: createUnavailableCatalog(),
      audit: {
        append: () => {
          appends += 1;
          throw new Error("ghp_credential_shaped_value");
        }
      },
      logger: createJsonLogger(line => lines.push(line))
    });
    const failingPort = await new Promise<number>(resolve => {
      failing.listen(0, "127.0.0.1", () => resolve((failing.address() as AddressInfo).port));
    });

    try {
      const response = await call(
        "/v1/tools/call",
        clientCert(certs, CHANNEL),
        "POST",
        failingPort,
        JSON.stringify(CALL)
      );

      expect(response.status).toBe(500);
      expect(ProxyError.parse(response.body).error.code).toBe("internal");
      // Not a served refusal, and not a result. The agent gets no answer.
      expect(ToolCallResponse.safeParse(response.body).success).toBe(false);
      // Named, so an operator debugging the 500 is not left with handler_failed
      // alone — and without the thrown value, which in this process can carry a
      // credential.
      expect(lines.join("")).toContain("audit_write_failed");
      expect(lines.join("")).not.toContain("ghp_");

      // The direct test of the flag the #124 catch reads, and the reason it is
      // set on *entry* rather than on success. The `ran` write threw, so the
      // catch runs — and it must recognise that the failure it is handling *is*
      // the audit write and not try a second one. One attempt, one log line.
      expect(appends).toBe(1);
      expect(lines.filter(line => line.includes("audit_write_failed"))).toHaveLength(1);
    } finally {
      failing.closeAllConnections();
      await new Promise<void>(resolve => failing.close(() => resolve()));
    }
  });
});

describe("request bodies", () => {
  it("rejects a body past the cap without buffering it", async () => {
    const res = await post("/v1/tools/call", asked({
      id: "toolu_01",
      server: "github",
      tool: "list_prs",
      arguments: { blob: "x".repeat(MAX_BODY_BYTES) }
    }));

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
            cacheWriteTokens: 0,
            byModel: []
          }),
          recordToolCall: () => {},
          recordTokens: () => ({ outcome: "recorded" as const }),
          claimWarning: () => false
        }),
        catalog: createUnavailableCatalog(),
        dispatcher: recordingDispatcher(),
        audit: discardingAuditWriter()
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

const listPrs = (id: string) => asked({ id, server: "github", tool: "list_prs" });

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
    await post("/v1/tools/call", asked({ id: "1", server: "stripe", tool: "charge" }));
    await post("/v1/tools/call", asked({ id: "2", server: "github", tool: "force_push" }));
    await post("/v1/tools/call", asked({ id: "3", server: "github", tool: "merge_pr" }));

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

// The soft limit, end to end (#99). The warning rides a served call, once a
// day, and the call it rides still runs — the whole difference from the gate
// above.
describe("the soft budget warning", () => {
  // `warn_at = 0.8` of five calls is four, so the fifth call is the one that
  // finds the count at the threshold — and it is still under the limit, which
  // is the whole difference between this and the gate above.
  const fiveCalls = budgetSheet("daily_tool_calls = 5\nwarn_at = 0.8");

  it("carries the warning on the call that crosses, and the call runs", async () => {
    writeSheet(CHANNEL, fiveCalls);
    const responses = await callN(5);

    expect(ToolCallResponse.parse(responses[0]?.body)).toMatchObject({ outcome: "ran" });
    expect(ToolCallResponse.parse(responses[0]?.body)).not.toHaveProperty("warning");
    expect(ToolCallResponse.parse(responses[4]?.body)).toMatchObject({
      outcome: "ran",
      warning: { limit: "daily_tool_calls", spent: 4, cap: 5 }
    });
    // It is a notice on a call that happened, not a refusal wearing a result.
    expect(dispatcher.seen).toHaveLength(5);
  });

  // The acceptance bullet the once-a-day rule is: a warning repeated on every
  // call after the threshold is a warning nobody reads.
  it("warns once and then stops, while the calls go on running", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 50\nwarn_at = 0.02"));
    const responses = await callN(4);

    const warned = responses.filter(res => "warning" in (res.body as object));
    expect(warned).toHaveLength(1);
    expect(responses.every(res => (res.body as { outcome: string }).outcome === "ran")).toBe(true);
  });

  // A new day is a new budget, so it is also a new warning. Same clock, same
  // rollover the counters have.
  it("warns again after the day rolls over", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 50\nwarn_at = 0.02"));
    await callN(2);

    budgetClock += 24 * 60 * 60 * 1000;
    // The count rolled over too, so it takes another call to re-cross.
    const [, second] = await callN(2);
    expect(ToolCallResponse.parse(second?.body)).toMatchObject({
      outcome: "ran",
      warning: { limit: "daily_tool_calls" }
    });
  });

  // The third acceptance bullet, over the wire: a channel that goes from below
  // the threshold to past the hard limit is refused, and a refusal has no room
  // for a warning — so it is never told only about the soft one.
  it("refuses rather than warning once the hard limit is reached", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 1\nwarn_at = 0.8"));
    const [served, refused] = await callN(2);

    expect(ToolCallResponse.parse(served?.body)).toMatchObject({ outcome: "ran" });
    const answer = ToolCallResponse.parse(refused?.body);
    expect(answer).toMatchObject({ outcome: "refused", refusal: { reason: "budget_exhausted" } });
    expect(answer).not.toHaveProperty("warning");
  });

  // `0` is the sheet's way of saying a channel does not want the notice, and it
  // must not warn on the first call of the day through a `>= 0` comparison.
  it("says nothing when the sheet turns it off", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 3\nwarn_at = 0"));
    const responses = await callN(3);
    expect(responses.some(res => "warning" in (res.body as object))).toBe(false);
  });

  // One claim per channel, from statements scoped to a channel: one channel
  // crossing its threshold must not spend another's notice.
  it("keeps one channel's warning out of another's", async () => {
    writeSheet(CHANNEL, fiveCalls);
    writeSheet(OTHER_CHANNEL, fiveCalls);

    await callN(5, CHANNEL);
    const fifth = (await callN(5, OTHER_CHANNEL))[4];
    expect(ToolCallResponse.parse(fifth?.body)).toMatchObject({
      outcome: "ran",
      warning: { limit: "daily_tool_calls" }
    });
  });

  // A reset starts the day over, which means the notice comes back too — the
  // operator did not clear the counters in order to silence the warning.
  it("is re-armed by the operator's reset", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 50\nwarn_at = 0.02"));
    await callN(2);

    const operator = openBudgetDb({ file: join(budgetDir, "budget.db") });
    resetChannel(operator, CHANNEL, budgetClock);
    operator.close();

    const [, second] = await callN(2);
    expect(ToolCallResponse.parse(second?.body)).toMatchObject({
      outcome: "ran",
      warning: { limit: "daily_tool_calls" }
    });
  });
});

// The property the shared budget file rests on. Channels share one table
// because spend is operator-facing data and cross-channel aggregation is what
// it is for — so what has to hold instead is that the people who live in a
// channel cannot manipulate its numbers. A prompt-injected member drives the
// agent, and the agent reaches only these routes.
describe("no route can lower a counter", () => {
  it("leaves every counter at or above where it started, whatever is called", async () => {
    writeSheet(CHANNEL, budgetSheet("daily_tool_calls = 50"));
    await callN(2);
    await post("/v1/spend", {
      turn: "turn_floor",
      usage: { inputTokens: 100, outputTokens: 10 }
    });
    const before = await meter.read(CHANNEL);

    // Everything an agent can reach, including the shapes an attacker would
    // reach for: a negative report, a zeroing one, a replayed turn, and a
    // body trying to name someone else's channel or a past day.
    await call("/health", clientCert(certs, CHANNEL));
    await call("/v1/whoami", clientCert(certs, CHANNEL));
    await call("/v1/tools", clientCert(certs, CHANNEL));
    await post("/v1/tools/call", asked({ id: "1", server: "github", tool: "nope" }));
    await post("/v1/spend", { turn: "t", usage: { inputTokens: -500, outputTokens: 0 } });
    await post("/v1/spend", { turn: "t", usage: { inputTokens: 0, outputTokens: 0 } });
    await post("/v1/spend", { turn: "turn_floor", usage: { inputTokens: 0, outputTokens: 0 } });
    await post("/v1/spend", { turn: "t2", usage: { inputTokens: 1, outputTokens: 0 }, reset: true });
    await post("/v1/spend", { turn: "t3", usage: { inputTokens: 1, outputTokens: 0 }, day: "1999-01-01" });

    const after = await meter.read(CHANNEL);
    expect(after.toolCalls).toBeGreaterThanOrEqual(before.toolCalls);
    expect(after.inputTokens).toBeGreaterThanOrEqual(before.inputTokens);
    expect(after.outputTokens).toBeGreaterThanOrEqual(before.outputTokens);
    expect(after.cacheReadTokens).toBeGreaterThanOrEqual(before.cacheReadTokens);
    expect(after.cacheWriteTokens).toBeGreaterThanOrEqual(before.cacheWriteTokens);
  });

  // The other half: one channel's agent cannot reach across to another's row,
  // because the only channel it can name is the one its certificate proves.
  it("cannot touch another channel's counters", async () => {
    writeSheet(OTHER_CHANNEL, budgetSheet("daily_tool_calls = 50"));
    await callN(2, OTHER_CHANNEL);
    const before = await meter.read(OTHER_CHANNEL);

    await post("/v1/spend", { turn: "x", usage: { inputTokens: 9_999, outputTokens: 0 } }, CHANNEL);
    await post(
      "/v1/spend",
      { turn: "y", usage: { inputTokens: 1, outputTokens: 0 }, channel: OTHER_CHANNEL },
      CHANNEL
    );
    await callN(3, CHANNEL);

    expect(await meter.read(OTHER_CHANNEL)).toEqual(before);
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

  // And the mechanical form of the same claim: this route adds no read of the
  // sheet to the one every request already makes.
  //
  // It used to read "resolves no team sheet at all", and that assertion was
  // describing the design correctly until #79 put a sheet-sourced check in the
  // identity gate — which every route on this listener passes through, this one
  // included. The claim worth keeping is the one that was always the point: the
  // route itself asks the sheet nothing. So it is measured against a route that
  // demonstrably reads no sheet of its own rather than against zero, which
  // keeps it from pinning how many reads the gate happens to make.
  //
  // It counts `serverSheetReads` rather than spying on the store, and #243 is
  // why: a spy on the instance also catches the watcher refreshing itself, and
  // `beforeEach` rewrites the sheet before every test in this file, so those
  // refreshes are always in flight. The assertion was measuring the weather
  // about one run in five. See the counter's own comment for the boundary.
  it("adds no team-sheet read of its own", async () => {
    const before = serverSheetReads;
    await call("/v1/whoami", clientCert(certs, CHANNEL));
    const gateOnly = serverSheetReads - before;
    expect(gateOnly).toBeGreaterThan(0);

    const beforeSpend = serverSheetReads;
    await post("/v1/spend", { turn, usage });

    expect(serverSheetReads - beforeSpend).toBe(gateOnly);
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
      await post("/v1/tools/call", asked({ id: "toolu_01", server: "github", tool: "list_prs" })),
      await post("/v1/tools/call", asked({ id: "toolu_02", server: "github", tool: "not_listed" })),
      await post("/v1/tools/call", asked({ id: "toolu_03", server: "not_listed", tool: "list_prs" })),
      await post("/v1/tools/call", asked({ id: "toolu_04", server: "github", tool: "merge_pr" })),
      // A body the model wrote that does not parse, and one asserting a channel.
      await post("/v1/tools/call", asked({ id: "toolu_05", server: "github" })),
      await post("/v1/tools/call", asked({
        id: "toolu_06",
        server: "github",
        tool: "list_prs",
        channel: OTHER_CHANNEL
      })),
      // Arguments carrying something secret-shaped, which must not echo either.
      await post("/v1/tools/call", asked({
        id: "toolu_07",
        server: "github",
        tool: "list_prs",
        arguments: { token: VAULT_VALUE }
      })),
      // The error paths: unknown route, wrong method, oversized body.
      await call("/v1/nope", cert),
      await call("/v1/tools", cert, "POST"),
      await call(
        "/v1/tools/call",
        cert,
        "POST",
        port,
        bodyOf(asked({ id: "toolu_08", server: "github", tool: "list_prs", arguments: { pad: "x".repeat(MAX_BODY_BYTES) } }))
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
    let upstream: FakeMcpServer;
    /**
     * The Authorization header of every request the upstream received.
     *
     * Read off the fake rather than accumulated separately, because one tool
     * call is no longer one request: the first call on an upstream discovers
     * before it calls. What has to hold is that *every* request carried the
     * credential, which is a stronger claim than the old "exactly one did".
     */
    const authsSeen = (): (string | undefined)[] => upstream.received.map(seen => seen.authorization);
    let injected: Server;
    let injectDispatcher: HttpDispatcher;
    let injectedPort: number;
    let injectedLog: string[] = [];
    let injectAuditDir: string;
    let injectAuditFile: string;
    let injectAuditDb: AuditDb;
    /** Built in beforeAll once the mock upstream's port is known. */
    let injectSheet = "";
    const injectLogger = createJsonLogger(line => injectedLog.push(line));

    beforeAll(async () => {
      injectAuditDir = mkdtempSync(join(tmpdir(), "libero-proxy-inject-audit-"));
      injectAuditFile = join(injectAuditDir, "audit.db");
      injectAuditDb = openAuditDb({ file: injectAuditFile });

      // A real MCP server, echoing its own Authorization header into the tool
      // result — the leak class the redaction pass closes, and the worst
      // realistic upstream.
      upstream = await startFakeMcpServer({ echoHeaders: "text" });
      injectSheet = `
[channel]
name = "injected"

[[mcp_server]]
name = "github"
transport = "http"
url = "${upstream.url}"
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
        dispatcher: createToolDispatcher({
          mcp: (injectDispatcher = createHttpDispatcher({ vault, logger: injectLogger }))
        }),
        // The same object twice, as apps/proxy-server does: one thing holds the
        // vault and the pool, and the two seams are what each route sees of it.
        catalog: injectDispatcher,
        // A real audit log for the same reason the logger is shared: this is
        // the one composition where a credential genuinely transits a call, so
        // it is the only place "no audit row holds the value" can be asserted
        // against a real one rather than a fixture.
        audit: createSqliteAuditWriter({ db: injectAuditDb }),
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
      injectDispatcher.close();
      await upstream.close();
      injectAuditDb.close();
      rmSync(injectAuditDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      // After the outer beforeEach, which wipes the channels root to restore
      // the shared sheet — so this channel's has to be rewritten each time.
      writeSheet(INJECT_CHANNEL, injectSheet);
      upstream.received.length = 0;
      injectedLog = [];
    });

    it("hands the upstream the real secret", async () => {
      const response = await call(
        "/v1/tools/call",
        clientCert(certs, INJECT_CHANNEL),
        "POST",
        injectedPort,
        JSON.stringify(asked({ id: "toolu_01", server: "github", tool: "list_prs" }))
      );

      expect(ToolCallResponse.parse(response.body)).toMatchObject({ outcome: "ran" });
      expect(authsSeen()).not.toHaveLength(0);
      for (const seen of authsSeen()) expect(seen).toBe(`Bearer ${VAULT_VALUE}`);
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
        JSON.stringify(asked({ id: "toolu_02", server: "github", tool: "list_prs" }))
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
        JSON.stringify(asked({ id: "toolu_04", server: "github", tool: "list_prs" }))
      );

      const parsed = ToolCallResponse.parse(response.body);
      expect(parsed.outcome).toBe("ran");
      const content = parsed.outcome === "ran" ? parsed.result.content : "";
      // The upstream really did receive it, so the assertion below is not vacuous.
      expect(authsSeen()).not.toHaveLength(0);
      for (const seen of authsSeen()) expect(seen).toBe(`Bearer ${VAULT_VALUE}`);
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
        JSON.stringify(asked({ id: "toolu_02", server: "github", tool: "list_prs" }))
      );

      expect(JSON.stringify(response.body)).not.toContain("ghp_");
      expect(injectedLog.join("")).not.toContain("ghp_");
      expect(injectedLog.join("")).not.toContain("Bearer");
      // The name is expected in the log; that is what makes it useful.
      expect(injectedLog.join("")).toContain("github_service_account");
    });

    // The same criterion carried onto the durable record, which is the one that
    // outlives the process. Arguments here carry the vault value, so the row's
    // `arguments_sha256` is what is actually under test: a hash may not be the
    // value, and the whole-object preimage is why it is not a fingerprint of it.
    it("writes audit rows that hold no trace of it either", async () => {
      const before = lastAuditId(injectAuditFile);

      await call(
        "/v1/tools/call",
        clientCert(certs, INJECT_CHANNEL),
        "POST",
        injectedPort,
        JSON.stringify(
          asked({
            id: "toolu_07",
            server: "github",
            tool: "list_prs",
            arguments: { note: `the token is ${VAULT_VALUE}` }
          })
        )
      );

      const rows = auditRows(injectAuditFile, before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "ran", channel: INJECT_CHANNEL });

      const written = JSON.stringify(rows);
      expect(written).not.toContain(VAULT_VALUE);
      expect(written).not.toContain("ghp_");
      // Not vacuous: the row exists and carries the hash of those arguments.
      expect(String(rows[0]?.arguments_sha256)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses by name when the sheet names a credential the vault lacks", async () => {
      const before = lastAuditId(injectAuditFile);
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
        JSON.stringify(asked({ id: "toolu_03", server: "github", tool: "list_prs" }))
      );

      // A served request, not an error: 200 with the structured refusal.
      expect(response.status).toBe(200);
      expect(ToolCallResponse.parse(response.body)).toMatchObject({
        outcome: "refused",
        refusal: { reason: "credential_unresolved", credential: "absent_credential" }
      });
      expect(authsSeen()).toEqual([]);

      // The dispatch-time refusal (#51) is decided while serving rather than
      // by `decideFromState`, and it reaches the log through the `refused`
      // branch of the dispatch switch — the one branch no other test pins to
      // a row. One row, the enumerated reason, and no result to size.
      const rows = auditRows(injectAuditFile, before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel: INJECT_CHANNEL,
        tool: "list_prs",
        outcome: "refused",
        refusal_reason: "credential_unresolved",
        result_bytes: null,
        result_is_error: null
      });
    });
  });
});

// The acceptance suite for #129: what a listing says once an upstream has been
// asked, and what it still says when one cannot be.
//
// A fresh proxy and a fresh dispatcher per test, because the catalog caches for
// five minutes on a real clock — a shared composition would have one test's
// walk answer the next test's question, which is the assertion these are here
// to make rather than to assume.
describe("a listing described by its upstream", () => {
  let vaultDir: string;
  let described: Server | undefined;
  let describedDispatcher: HttpDispatcher | undefined;
  let describedPort = 0;
  let describedLog: string[] = [];

  /** Stand a proxy up against this sheet, with a real dispatcher and catalog. */
  async function serving(sheet: string): Promise<void> {
    writeSheet(DESCRIBED_CHANNEL, sheet);
    describedLog = [];
    const logger = createJsonLogger(line => describedLog.push(line));
    const dispatch = createHttpDispatcher({ vault: describedVault, logger });
    describedDispatcher = dispatch;
    const built = createProxyServer({
      tls: loadTlsOptions({
        cert: join(certs, "proxy", "server.pem"),
        key: join(certs, "proxy", "server.key"),
        ca: join(certs, "ca.pem")
      }),
      sheets,
      spend: meter,
      dispatcher: createToolDispatcher({ mcp: dispatch }),
      // One object, two seams — the composition root's own shape.
      catalog: dispatch,
      audit: discardingAuditWriter(),
      logger
    });
    described = built;
    describedPort = await new Promise<number>(resolve => {
      built.listen(0, "127.0.0.1", () => resolve((built.address() as AddressInfo).port));
    });
  }

  const listing = async (): Promise<ToolListing> => {
    const res = await call("/v1/tools", clientCert(certs, DESCRIBED_CHANNEL), "GET", describedPort);
    expect(res.status).toBe(200);
    return ToolListing.parse(res.body);
  };

  let describedVault: Vault;
  let upstream: FakeMcpServer | undefined;

  beforeAll(() => {
    vaultDir = mkdtempSync(join(tmpdir(), "libero-proxy-described-"));
    const parsed = parseVaultKey(randomBytes(32).toString("base64"));
    if (!parsed.ok) throw new Error("test key did not parse");
    const file = join(vaultDir, "vault.enc");
    writeVaultEntries(file, parsed.key, new Map([["github_service_account", "ghp_described"]]));
    describedVault = openVault({ file, key: parsed.key });
  });

  afterAll(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    described?.closeAllConnections();
    if (described !== undefined) await new Promise<void>(resolve => described?.close(() => resolve()));
    described = undefined;
    await describedDispatcher?.close();
    describedDispatcher = undefined;
    await upstream?.close();
    upstream = undefined;
  });

  const sheetFor = (url: string, tools = "  [[mcp_server.tool]]\n  name = \"list_prs\"\n"): string => `
[channel]
name = "described"

[[mcp_server]]
name = "github"
transport = "http"
url = "${url}"
credential = "github_service_account"

${tools}`;

  // Both halves of the issue's first acceptance criterion, in one test: the
  // sheet's tool arrives with its schema, and the upstream's other tool is
  // neither listed nor callable. The upstream describes; it does not decide.
  it("carries the sheet's tool with its schema, and cannot add one of its own", async () => {
    upstream = await startFakeMcpServer();
    await serving(sheetFor(upstream.url));

    const { tools } = await listing();

    expect(tools).toEqual([
      {
        server: "github",
        tool: "list_prs",
        approval: "none",
        description: "Lists open pull requests.",
        inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] }
      }
    ]);

    // `merge_pr` is on the upstream and not on the sheet. Absent from the
    // listing, and refused at the gate by the sheet that omitted it.
    const refused = await call(
      "/v1/tools/call",
      clientCert(certs, DESCRIBED_CHANNEL),
      "POST",
      describedPort,
      JSON.stringify(asked({ id: "toolu_01", server: "github", tool: "merge_pr" }))
    );
    expect(ToolCallResponse.parse(refused.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "tool_not_allowed" }
    });
  });

  // The issue's second acceptance criterion. An upstream that cannot answer
  // costs the model a schema and costs the channel nothing.
  it("degrades to the sheet's own entry when the upstream will not answer", async () => {
    upstream = await startFakeMcpServer();
    upstream.respond = request => (request.rpc?.method === "tools/list" ? { status: 503, raw: "down" } : null);
    await serving(sheetFor(upstream.url));

    expect((await listing()).tools).toEqual([{ server: "github", tool: "list_prs", approval: "none" }]);

    // And the gate decides exactly as it would have. The listing is not the
    // enforcement, so a thin one changes no answer.
    const ran = await call(
      "/v1/tools/call",
      clientCert(certs, DESCRIBED_CHANNEL),
      "POST",
      describedPort,
      JSON.stringify(asked({ id: "toolu_01", server: "github", tool: "list_prs" }))
    );
    expect(ToolCallResponse.parse(ran.body)).toMatchObject({ outcome: "ran" });
  });

  // #200, at the wire. The one place the degrade-to-thin contract narrows: a
  // tool whose `x-mcp-header` annotations do not validate gets no row at all,
  // because the proxy cannot derive its headers and a server requiring them
  // refuses every call to it `-32020` — a tool the model can see, will call,
  // and can never use.
  it("leaves out a tool whose annotations are invalid, rather than thinning it", async () => {
    upstream = await startFakeMcpServer({
      catalog: [
        { name: "list_prs", description: "Lists PRs.", inputSchema: ANNOTATION_UNDER_ITEMS },
        { name: "merge_pr", description: "Merges a PR.", inputSchema: { type: "object" } }
      ]
    });
    await serving(
      sheetFor(upstream.url, '  [[mcp_server.tool]]\n  name = "list_prs"\n\n  [[mcp_server.tool]]\n  name = "merge_pr"\n')
    );

    // Not `{ server: "github", tool: "list_prs", approval: "none" }` — absent.
    // Thin is what every other listing failure yields and what this one no
    // longer does.
    expect((await listing()).tools).toEqual([
      { server: "github", tool: "merge_pr", approval: "none", description: "Merges a PR.", inputSchema: { type: "object" } }
    ]);

    const listed = describedLog.filter(line => line.includes('"tools_listed"'));
    expect(listed).toHaveLength(1);
    // `count + excluded` is the sheet's own size, so an operator reading the
    // line that reports the listing can see it shrank without going hunting.
    expect(listed[0]).toContain('"count":1');
    expect(listed[0]).toContain('"excluded":1');

    // **And the channel lost no permission.** This is the load-bearing half:
    // the sheet still names `list_prs`, so the gate decides it exactly as it
    // would have. Excluding narrows what the model is shown, never what it is
    // allowed — if this came back `tool_not_allowed`, the listing would have
    // become the enforcement.
    const ran = await call(
      "/v1/tools/call",
      clientCert(certs, DESCRIBED_CHANNEL),
      "POST",
      describedPort,
      JSON.stringify(asked({ id: "toolu_01", server: "github", tool: "list_prs" }))
    );
    expect(ToolCallResponse.parse(ran.body)).toMatchObject({ outcome: "ran" });
  });

  it("asks a server split across blocks by approval exactly once", async () => {
    upstream = await startFakeMcpServer();
    await serving(
      sheetFor(
        upstream.url,
        '  [[mcp_server.tool]]\n  name = "list_prs"\n'
      ) +
        `
[[mcp_server]]
name = "github"
transport = "http"
url = "${upstream.url}"
credential = "github_service_account"

  [[mcp_server.tool]]
  name = "merge_pr"
  approval = "required"
`
    );

    const { tools } = await listing();

    expect(tools.map(tool => [tool.tool, tool.approval, tool.inputSchema !== undefined])).toEqual([
      ["list_prs", "none", true],
      ["merge_pr", "required", true]
    ]);
    // One upstream, one question. `upstreamKey` groups the blocks, so the
    // documented way to split a server by approval does not double the traffic.
    expect(upstream.callsTo("tools/list")).toHaveLength(1);
  });

  it("lists an ambiguous tool thin, and refuses it at the gate", async () => {
    upstream = await startFakeMcpServer();
    await serving(`
[channel]
name = "described"

[[mcp_server]]
name = "github"
transport = "http"
url = "${upstream.url}"

  [[mcp_server.tool]]
  name = "list_prs"

[[mcp_server]]
name = "github"
transport = "http"
url = "http://elsewhere.invalid:9"

  [[mcp_server.tool]]
  name = "list_prs"
`);

    expect((await listing()).tools).toEqual([{ server: "github", tool: "list_prs", approval: "none" }]);
    expect(upstream.received).toHaveLength(0);
    expect(describedLog.join("")).toContain('"reason":"server_ambiguous"');
  });

  it("lists a stdio server's tools thin, since there is no client to ask", async () => {
    await serving(`
[channel]
name = "described"

[[mcp_server]]
name = "local"
transport = "stdio"

  [[mcp_server.tool]]
  name = "read_file"
`);

    expect((await listing()).tools).toEqual([{ server: "local", tool: "read_file", approval: "none" }]);
    expect(describedLog.join("")).toContain('"reason":"unsupported_transport"');
  });

  it("counts what it described, and writes no upstream byte to the log", async () => {
    upstream = await startFakeMcpServer({
      catalog: [{ name: "list_prs", description: "Lists PRs ghp_described.", inputSchema: { type: "object" } }]
    });
    await serving(sheetFor(upstream.url));

    await listing();

    const listed = describedLog.filter(line => line.includes('"tools_listed"'));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('"count":1');
    expect(listed[0]).toContain('"described":1');
    // The description reached the wire, and no line of the log carries a byte
    // of it — a listing's log is counts, not content.
    expect(describedLog.join("")).not.toContain("Lists PRs");
    expect(describedLog.join("")).not.toContain("ghp_described");
  });

  it("asks nothing at all for a channel with no sheet", async () => {
    upstream = await startFakeMcpServer();
    await serving(sheetFor(upstream.url));
    rmSync(join(channelsRoot, DESCRIBED_CHANNEL), { recursive: true, force: true });

    expect((await listing()).tools).toEqual([]);
    expect(upstream.received).toHaveLength(0);
  });
});

// Nothing covered this end to end: `unavailable` was only a unit assertion in
// dispatch.test.ts. It is the behaviour every deployment currently has, so it
// is worth pinning at the wire — a permitted call gets 501 and not a refusal,
// because nothing was denied.
describe("a permitted call with no upstream", () => {
  let bare: Server;
  let barePort: number;
  let bareAuditDir: string;
  let bareAuditFile: string;
  let bareAuditDb: AuditDb;

  beforeAll(async () => {
    // A real audit log here, not a discarding one: `unavailable` is the fourth
    // outcome and this is the only place it happens at the wire, so it is the
    // only place its row can be asserted.
    bareAuditDir = mkdtempSync(join(tmpdir(), "libero-proxy-bare-audit-"));
    bareAuditFile = join(bareAuditDir, "audit.db");
    bareAuditDb = openAuditDb({ file: bareAuditFile });

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
      dispatcher: createToolDispatcher({ mcp: createUnavailableDispatcher() }),
      catalog: createUnavailableCatalog(),
      audit: createSqliteAuditWriter({ db: bareAuditDb }),
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
    bareAuditDb.close();
    rmSync(bareAuditDir, { recursive: true, force: true });
  });

  it("records the call it could not serve", async () => {
    await call(
      "/v1/tools/call",
      clientCert(certs, CHANNEL),
      "POST",
      barePort,
      JSON.stringify(asked({ id: "toolu_unavailable", server: "github", tool: "list_prs" }))
    );

    const rows = auditRows(bareAuditFile, 0).filter(row => row.call_id === "toolu_unavailable");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: CHANNEL,
      server: "github",
      tool: "list_prs",
      outcome: "unavailable",
      // Permitted, so nothing refused it; and never served, so no result.
      refusal_reason: null,
      result_bytes: null,
      result_is_error: null
    });
  });

  it("answers 501, not a refusal", async () => {
    const response = await call(
      "/v1/tools/call",
      clientCert(certs, CHANNEL),
      "POST",
      barePort,
      JSON.stringify(asked({ id: "toolu_01", server: "github", tool: "list_prs" }))
    );

    expect(response.status).toBe(501);
    expect(ProxyError.parse(response.body).error.code).toBe("not_implemented");
  });

  // Two claims in one case, because they are in tension and the fix for #124 is
  // the resolution. The fail-closed criterion, over the whole chain rather than
  // link by link: a redaction that could not be performed must produce no
  // response at all, not a served one carrying bytes nobody could scrub. And the
  // accountability one: a call that got that far was metered and reached the
  // dispatcher, so it must leave a row saying the proxy never answered it —
  // this is the live path that used to leave none.
  it("answers 500 with no upstream bytes when redaction fails, and records the call it never answered", async () => {
    const lines: string[] = [];
    const before = lastAuditId(bareAuditFile);
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
      catalog: createUnavailableCatalog(),
      audit: createSqliteAuditWriter({ db: bareAuditDb }),
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
        JSON.stringify(asked({ id: "toolu_09", server: "github", tool: "list_prs" }))
      );

      expect(response.status).toBe(500);
      expect(ProxyError.parse(response.body).error.code).toBe("internal");
      // Not a 200 with a result, and not a refusal — nothing was denied and
      // nothing was served. The outcome exists in the log, not in the answer.
      expect(JSON.stringify(response.body)).not.toContain("outcome");
      expect(lines.map(line => JSON.parse(line) as { event: string })).toContainEqual(
        expect.objectContaining({ event: "handler_failed" })
      );

      // Exactly one, asserted by length rather than by shape: the whole point of
      // the flag the catch reads is that a call cannot come out of here with two.
      const written = auditRows(bareAuditFile, before);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        call_id: "toolu_09",
        outcome: "unanswered",
        refusal_reason: null,
        // Null because the result could not be measured, not because there was
        // none: these are the bytes the redaction failed on.
        result_bytes: null,
        result_is_error: null
      });
    } finally {
      throwing.closeAllConnections();
      await new Promise<void>(resolve => throwing.close(() => resolve()));
    }
  });

  // Criterion 2 of #124. The meter is the one write that must precede serving,
  // so a meter that throws must both refuse the call and leave the row — and
  // nothing may reach the upstream.
  it("records a call whose meter write failed, and dispatches nothing", async () => {
    const before = lastAuditId(bareAuditFile);
    const dispatcher = recordingDispatcher();
    const throwing = createProxyServer({
      tls: loadTlsOptions({
        cert: join(certs, "proxy", "server.pem"),
        key: join(certs, "proxy", "server.key"),
        ca: join(certs, "ca.pem")
      }),
      sheets,
      spend: {
        read: channel => meter.read(channel),
        recordToolCall: () => {
          throw new Error("disk full");
        },
        recordTokens: () => ({ outcome: "recorded" }),
        claimWarning: () => false
      },
      dispatcher,
      catalog: createUnavailableCatalog(),
      audit: createSqliteAuditWriter({ db: bareAuditDb }),
      logger: createJsonLogger(() => {})
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
        JSON.stringify(asked({ id: "toolu_10", server: "github", tool: "list_prs" }))
      );

      expect(response.status).toBe(500);
      expect(dispatcher.seen).toEqual([]);

      const written = auditRows(bareAuditFile, before);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ call_id: "toolu_10", outcome: "unanswered" });
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
      JSON.stringify(asked({ id: "toolu_02", server: "github", tool: "not_listed" }))
    );

    expect(response.status).toBe(200);
    expect(ToolCallResponse.parse(response.body)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "tool_not_allowed" }
    });
  });
});

/**
 * The approval broker, end to end over real mutual TLS.
 *
 * Its own server, because expiry is the one thing here that needs a clock and
 * the shared server above injects none. Everything else is shared — the same
 * certificates, the same sheets, the same recording dispatcher — so a call that
 * reaches the dispatcher here is a call that really got past enforcement.
 *
 * `SHEET` already carries `merge_pr` at `approval = "required"`, which is what
 * every test below holds on.
 */
describe("the approval broker", () => {
  let broker: Server;
  let brokerPort: number;
  let brokerAuditDir: string;
  let brokerAuditFile: string;
  let brokerAuditDb: AuditDb;
  let brokerClock: number;

  const HELD_CALL = asked({ id: "toolu_hold", server: "github", tool: "merge_pr", arguments: { pr: 42 } });

  beforeAll(async () => {
    brokerAuditDir = mkdtempSync(join(tmpdir(), "libero-proxy-approval-audit-"));
    brokerAuditFile = join(brokerAuditDir, "audit.db");
    brokerAuditDb = openAuditDb({ file: brokerAuditFile });

    broker = createProxyServer({
      tls: loadTlsOptions({
        cert: join(certs, "proxy", "server.pem"),
        key: join(certs, "proxy", "server.key"),
        ca: join(certs, "ca.pem")
      }),
      sheets,
      spend: meter,
      dispatcher,
      catalog: createUnavailableCatalog(),
      audit: createSqliteAuditWriter({ db: brokerAuditDb }),
      logger: createJsonLogger(() => {}),
      // The whole reason this block has its own server: a test crosses a
      // fifteen-minute deadline without waiting fifteen minutes.
      now: () => brokerClock
    });
    await new Promise<void>(resolve => {
      broker.listen(0, "127.0.0.1", () => {
        brokerPort = (broker.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    broker.closeAllConnections();
    await new Promise<void>(resolve => broker.close(() => resolve()));
    brokerAuditDb.close();
    rmSync(brokerAuditDir, { recursive: true, force: true });
  });

  let cursor = 0;

  beforeEach(() => {
    brokerClock = Date.UTC(2026, 7, 4, 12, 0, 0);
    cursor = lastAuditId(brokerAuditFile);
    dispatcher.seen.length = 0;
  });

  const send = (path: string, body: unknown, channel = CHANNEL): Promise<Response> =>
    call(path, clientCert(certs, channel), "POST", brokerPort, JSON.stringify(body));

  const rows = (): Record<string, unknown>[] => auditRows(brokerAuditFile, cursor);

  /** Hold a call and hand back the ticket the proxy minted for it. */
  async function hold(body: unknown = HELD_CALL): Promise<{ id: string; expiresAt: number }> {
    const response = await send("/v1/tools/call", body);
    expect(response.status).toBe(200);
    return (response.body as { ticket: { id: string; expiresAt: number } }).ticket;
  }

  const decide = (
    id: string,
    decision: "approve" | "deny",
    channel = CHANNEL,
    approver = "U0BOSS"
  ): Promise<Response> => send("/v1/approvals", { ticket: id, decision, approver }, channel);

  describe("holding", () => {
    it("hands back a ticket and a deadline, and records the hold against it", async () => {
      const ticket = await hold();

      expect(ticket.id).toEqual(expect.any(String));
      expect(ticket.expiresAt).toBe(brokerClock + 900_000);
      expect(rows().at(-1)).toMatchObject({
        outcome: "held",
        refusal_reason: "approval_required",
        ticket: ticket.id,
        approver: null
      });
      expect(dispatcher.seen).toHaveLength(0);
    });

    // A call arriving with no ticket is a first submission whatever else is
    // true of it, so it holds again rather than running. Two holds, two
    // tickets: the second does not inherit the first's decision.
    it("holds a second time rather than running, when the call comes back bare", async () => {
      const first = await hold();
      await decide(first.id, "approve");

      const second = await hold();

      expect(second.id).not.toBe(first.id);
      expect(dispatcher.seen).toHaveLength(0);
    });
  });

  describe("the approved path", () => {
    it("serves the approved call and records who approved it", async () => {
      const ticket = await hold();
      const decision = await decide(ticket.id, "approve");
      expect(decision.body).toEqual({ outcome: "recorded", ticket: ticket.id, decision: "approve" });

      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(served.body).toMatchObject({ outcome: "ran", id: "toolu_hold" });
      expect(dispatcher.seen.map(c => c.tool)).toEqual(["merge_pr"]);
      expect(rows().map(row => [row.outcome, row.approver, row.ticket])).toEqual([
        ["held", null, ticket.id],
        ["approved", "U0BOSS", ticket.id],
        ["ran", "U0BOSS", ticket.id]
      ]);
    });

    // Reaching the dispatcher is what opens a connection and resolves a
    // credential, so this is the assertion that a ticket is not a thing an
    // upstream ever sees.
    it("sends no ticket upstream", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");
      await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(dispatcher.seen).toHaveLength(1);
      expect(dispatcher.seen[0] && "ticket" in dispatcher.seen[0]).toBe(false);
    });

    it("meters the call the approval let through", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");
      const before = (await meter.read(CHANNEL)).toolCalls;

      await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect((await meter.read(CHANNEL)).toolCalls).toBe(before + 1);
    });
  });

  // The worst case #124 has to cover, and its own server because the dispatcher
  // has to throw for the whole lifecycle rather than for one call: a human
  // looked at a destructive call and approved it, the ticket was spent, the
  // upstream may well have acted, and the proxy then failed before it could
  // answer. The `unanswered` row must carry both the ticket and the approver, or
  // an operator reconstructing the incident sees an approval whose call simply
  // vanished.
  describe("an approved call the proxy then fails to answer", () => {
    let failing: Server;
    let failingPort: number;
    let failingAuditDir: string;
    let failingAuditFile: string;
    let failingAuditDb: AuditDb;

    beforeAll(async () => {
      failingAuditDir = mkdtempSync(join(tmpdir(), "libero-proxy-approval-fail-"));
      failingAuditFile = join(failingAuditDir, "audit.db");
      failingAuditDb = openAuditDb({ file: failingAuditFile });

      failing = createProxyServer({
        tls: loadTlsOptions({
          cert: join(certs, "proxy", "server.pem"),
          key: join(certs, "proxy", "server.key"),
          ca: join(certs, "ca.pem")
        }),
        sheets,
        spend: meter,
        // Always, which is harmless: the hold and the decision never reach a
        // dispatcher, so only the re-submission can provoke this.
        dispatcher: {
          dispatch: () => {
            throw new RedactionError("empty_value");
          }
        },
        catalog: createUnavailableCatalog(),
        audit: createSqliteAuditWriter({ db: failingAuditDb }),
        logger: createJsonLogger(() => {})
      });
      await new Promise<void>(resolve => {
        failing.listen(0, "127.0.0.1", () => {
          failingPort = (failing.address() as AddressInfo).port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      failing.closeAllConnections();
      await new Promise<void>(resolve => failing.close(() => resolve()));
      failingAuditDb.close();
      rmSync(failingAuditDir, { recursive: true, force: true });
    });

    it("records the unanswered call against its ticket and its approver", async () => {
      const before = lastAuditId(failingAuditFile);
      const to = (path: string, body: unknown): Promise<Response> =>
        call(path, clientCert(certs, CHANNEL), "POST", failingPort, JSON.stringify(body));

      const held = await to("/v1/tools/call", HELD_CALL);
      const ticket = (held.body as { ticket: { id: string } }).ticket;
      await to("/v1/approvals", { ticket: ticket.id, decision: "approve", approver: "U0BOSS" });

      const served = await to("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(served.status).toBe(500);
      expect(ToolCallResponse.safeParse(served.body).success).toBe(false);
      // Three rows, one ticket, and the last of them is the one this is about.
      expect(auditRows(failingAuditFile, before).map(row => [row.outcome, row.approver, row.ticket])).toEqual([
        ["held", null, ticket.id],
        ["approved", "U0BOSS", ticket.id],
        ["unanswered", "U0BOSS", ticket.id]
      ]);
    });
  });

  describe("a re-submission that is not the approved call", () => {
    it("refuses one carrying a ticket it never minted", async () => {
      await hold();

      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: "tk-never-minted" });

      expect(served.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_unknown" }
      });
      expect(dispatcher.seen).toHaveLength(0);
    });

    it("refuses one whose ticket no human has decided", async () => {
      const ticket = await hold();

      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(served.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_pending" }
      });
      expect(dispatcher.seen).toHaveLength(0);
    });

    it("refuses one a human declined, and records the deny with its approver", async () => {
      const ticket = await hold();
      await decide(ticket.id, "deny");

      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(served.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_denied" }
      });
      expect(dispatcher.seen).toHaveLength(0);
      expect(rows().map(row => [row.outcome, row.approver, row.refusal_reason])).toEqual([
        ["held", null, "approval_required"],
        ["denied", "U0BOSS", "approval_denied"],
        ["refused", null, "approval_denied"]
      ]);
    });

    it("refuses the second run of a single-use ticket", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");
      await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      const again = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(again.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_spent" }
      });
      expect(dispatcher.seen).toHaveLength(1);
    });

    // Approve-then-mutate. The attack the whole re-submission design exists to
    // stop, so it is asserted on the reason *and* on the dispatcher.
    it("refuses one whose arguments changed after approval", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");

      const served = await send("/v1/tools/call", {
        ...HELD_CALL,
        arguments: { pr: 9999 },
        ticket: ticket.id
      });

      expect(served.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_mismatch" }
      });
      expect(dispatcher.seen).toHaveLength(0);
      // And the approval survives it: a bad re-submission does not destroy a
      // decision a human gave.
      const good = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      expect(good.body).toMatchObject({ outcome: "ran" });
    });

    it("refuses one pointed at a different tool", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");

      const served = await send("/v1/tools/call", {
        ...HELD_CALL,
        tool: "list_prs",
        ticket: ticket.id
      });

      expect(served.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_mismatch" }
      });
      expect(dispatcher.seen).toHaveLength(0);
    });
  });

  describe("the deadline", () => {
    it("refuses a re-submission after it, and records the expiry once", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");
      brokerClock = ticket.expiresAt;

      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      const again = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(served.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_expired" }
      });
      expect(again.body).toMatchObject({ refusal: { reason: "approval_expired" } });
      expect(dispatcher.seen).toHaveLength(0);

      // One `expired` row for the ticket however many times it is presented,
      // and no approver on it: the approval was too late to mean anything.
      const expired = rows().filter(row => row.outcome === "expired");
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({ ticket: ticket.id, approver: null });
    });

    it("refuses a decision that arrives after it", async () => {
      const ticket = await hold();
      brokerClock = ticket.expiresAt;

      const decision = await decide(ticket.id, "approve");

      expect(decision.body).toEqual({ outcome: "expired", ticket: ticket.id });
      expect(rows().filter(row => row.outcome === "approved")).toHaveLength(0);
    });
  });

  describe("one channel cannot decide another's ticket", () => {
    // The acceptance criterion, and the second half is what makes it a real
    // test: after the foreign attempt fails, the ticket is still decidable by
    // the channel that owns it, and the call still runs.
    it("refuses the decision and leaves the ticket decidable by its own channel", async () => {
      const ticket = await hold();

      const foreign = await decide(ticket.id, "approve", OTHER_CHANNEL);

      // Indistinguishable from a ticket that never existed. The lookup never
      // reaches another channel's tickets, so there is nothing to leak.
      expect(foreign.body).toEqual({ outcome: "unknown", ticket: ticket.id });
      expect(rows().filter(row => row.outcome === "approved")).toHaveLength(0);

      const mine = await decide(ticket.id, "approve");
      expect(mine.body).toMatchObject({ outcome: "recorded" });
      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      expect(served.body).toMatchObject({ outcome: "ran" });
    });

    it("refuses a re-submission of another channel's ticket", async () => {
      // The other channel gets the *same* sheet on purpose. Without it this
      // would refuse on the sheet before the ticket was ever consulted, and
      // would pass whether or not tickets were scoped at all. With it,
      // enforcement says yes for both channels and the only thing left that can
      // refuse is that the ticket belongs to someone else.
      writeSheet(OTHER_CHANNEL, SHEET);
      const ticket = await hold();
      await decide(ticket.id, "approve");

      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id }, OTHER_CHANNEL);

      expect(served.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "approval_unknown" }
      });
      expect(dispatcher.seen).toHaveLength(0);

      // And it is still spendable by the channel that owns it.
      const mine = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      expect(mine.body).toMatchObject({ outcome: "ran" });
    });
  });

  describe("the sheet still governs a redeemed call", () => {
    afterEach(() => {
      writeSheet(CHANNEL, SHEET);
    });

    /**
     * The most important test in this issue.
     *
     * A ticket is not a permission. Fifteen minutes pass between the hold and
     * the click, and an operator's edit inside that window has to win — else an
     * approval is a bypass, which is the thing the feature exists to prevent.
     *
     * The second half matters as much: the refusal does not burn the approval,
     * so fixing the sheet inside the window does not cost the human a second
     * click.
     */
    it("refuses a redemption the sheet no longer allows, without spending the ticket", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");

      writeSheet(CHANNEL, SHEET.replace('  [[mcp_server.tool]]\n  name = "merge_pr"\n  approval = "required"\n', ""));
      const refused = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });

      expect(refused.body).toMatchObject({
        outcome: "refused",
        refusal: { reason: "tool_not_allowed" }
      });
      expect(dispatcher.seen).toHaveLength(0);

      writeSheet(CHANNEL, SHEET);
      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      expect(served.body).toMatchObject({ outcome: "ran" });
    });

    // The operator turned approval off during the hold, so the call runs on its
    // own merits — and the ticket is spent anyway, because it named this exact
    // call and leaving it live would let a second re-submission run a second.
    it("spends the ticket even when the sheet stopped requiring approval", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve");

      writeSheet(CHANNEL, SHEET.replace('  name = "merge_pr"\n  approval = "required"', '  name = "merge_pr"\n  approval = "none"'));
      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      expect(served.body).toMatchObject({ outcome: "ran" });

      const again = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      expect(again.body).toMatchObject({ refusal: { reason: "approval_spent" } });
      expect(dispatcher.seen).toHaveLength(1);
    });
  });

  describe("the decision route", () => {
    it("keeps the first verdict when a second click disagrees", async () => {
      const ticket = await hold();
      await decide(ticket.id, "approve", CHANNEL, "U0FIRST");

      const second = await decide(ticket.id, "deny", CHANNEL, "U0SECOND");

      expect(second.body).toEqual({
        outcome: "already_decided",
        ticket: ticket.id,
        decision: "approve"
      });
      expect(rows().filter(row => row.outcome === "denied")).toHaveLength(0);
      const served = await send("/v1/tools/call", { ...HELD_CALL, ticket: ticket.id });
      expect(served.body).toMatchObject({ outcome: "ran" });
    });

    it("refuses a body that names a channel", async () => {
      const ticket = await hold();

      const response = await send("/v1/approvals", {
        ticket: ticket.id,
        decision: "approve",
        approver: "U0BOSS",
        channel: OTHER_CHANNEL
      });

      expect(response.status).toBe(400);
    });

    it("answers 405 to a GET", async () => {
      const response = await call("/v1/approvals", clientCert(certs, CHANNEL), "GET", brokerPort);

      expect(response.status).toBe(405);
    });

    it("needs a certificate like every other route", async () => {
      await expect(
        call("/v1/approvals", undefined, "POST", brokerPort, JSON.stringify({}))
      ).rejects.toThrow();
    });
  });
});
