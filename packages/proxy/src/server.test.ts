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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import type { Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProxyError } from "@getlibero/schema";
import { createJsonLogger } from "./log.js";
import { createProxyServer } from "./server.js";
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
function call(path: string, client?: ClientCert, method = "GET", targetPort = port): Promise<Response> {
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
    req.end();
  });
}

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

  server = createProxyServer({
    tls: loadTlsOptions({
      cert: join(certs, "proxy", "server.pem"),
      key: join(certs, "proxy", "server.key"),
      ca: join(certs, "ca.pem")
    }),
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

afterAll(() => {
  server.close();
  rmSync(certs, { recursive: true, force: true });
  rmSync(foreignCerts, { recursive: true, force: true });
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
