// The transport over a real TLS connection, with real certificates.
//
// The certificates come from scripts/dev-certs.sh — the same script an operator
// runs, and the same one the proxy package tests against. Nothing here mocks TLS:
// "a client with no certificate cannot connect" and "the channel comes from the
// certificate" are only worth asserting against the real handshake.
//
// **The listener here is `node:https` and a switch, not the proxy.** The agent
// may not import the proxy — an ESLint rule and a CI grep both say so — and
// standing up the real server here would route around the boundary this file
// exists on the far side of. What the two ends agree on is @getlibero/schema,
// which is what both parse against. The two halves meeting for real is the e2e
// suite's job (#41).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProxyClientError, createProxyTransport, type ProxyTransport } from "./transport.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CHANNEL = "C024BE91L";
const OTHER_CHANNEL = "C7ZZZ9999";

interface Seen {
  method: string;
  path: string;
  body: string;
  /** The CN the listener read off the peer certificate, exactly as the proxy does. */
  commonName: string | undefined;
}

let certs: string;
let foreignCerts: string;
let server: Server;
let port: number;
let seen: Seen[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { tools: [] } };

/** What the proxy's own identity resolver reads: the subject CN, and nothing else. */
function commonNameOf(socket: TLSSocket): string | undefined {
  const cn: unknown = socket.getPeerCertificate().subject?.CN;
  return typeof cn === "string" ? cn : undefined;
}

function mint(out: string, channels: string[]): void {
  execFileSync("sh", ["scripts/dev-certs.sh", "--out", out, "--channels", channels.join(",")], {
    cwd: REPO_ROOT,
    stdio: "pipe"
  });
}

function transportTo(dir: string, port: number, url?: string): ProxyTransport {
  return createProxyTransport({
    url: url ?? `https://127.0.0.1:${port}`,
    caPath: join(certs, "ca.pem"),
    clientCertDir: join(dir, "agent"),
    timeoutMs: 5_000
  });
}

beforeAll(async () => {
  certs = mkdtempSync(join(tmpdir(), "libero-agent-certs-"));
  // A second, unrelated CA. Its certificates are well-formed and worthless.
  foreignCerts = mkdtempSync(join(tmpdir(), "libero-agent-foreign-"));
  mint(certs, [CHANNEL, OTHER_CHANNEL]);
  mint(foreignCerts, [CHANNEL]);

  server = createServer(
    {
      cert: readFileSync(join(certs, "proxy", "server.pem")),
      key: readFileSync(join(certs, "proxy", "server.key")),
      ca: readFileSync(join(certs, "ca.pem")),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3"
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
          commonName: commonNameOf(req.socket as TLSSocket)
        });
        const payload = answer.body === undefined ? "" : JSON.stringify(answer.body);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(payload);
      });
    }
  );

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(certs, { recursive: true, force: true });
  rmSync(foreignCerts, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: { tools: [] } };
});

describe("mutual TLS", () => {
  it("connects with the channel's certificate and gets an answer", async () => {
    const response = await transportTo(certs, port).request({
      channel: CHANNEL,
      method: "GET",
      path: "/v1/tools"
    });

    expect(response).toEqual({ status: 200, body: { tools: [] } });
    expect(seen[0]).toMatchObject({ method: "GET", path: "/v1/tools" });
  });

  // The property the whole boundary rests on. The client sends no channel; the
  // listener reads one off the certificate, exactly as identity.ts does.
  it("identifies the channel by the certificate it presents, and by nothing sent", async () => {
    await transportTo(certs, port).request({
      channel: CHANNEL,
      method: "POST",
      path: "/v1/tools/call",
      body: { id: "call-1", server: "github", tool: "list_prs" }
    });

    expect(seen[0]?.commonName).toBe(`channel:${CHANNEL}`);
    expect(seen[0]?.body).not.toContain(CHANNEL);
  });

  // One transport serves the whole process, and each channel's requests carry
  // that channel's key. A call cannot be attributed to a channel whose
  // certificate this process does not hold — there is no other way to be one.
  it("cannot attribute a call to a channel it holds no certificate for", async () => {
    const transport = transportTo(certs, port);

    await transport.request({ channel: CHANNEL, method: "GET", path: "/v1/tools" });
    await transport.request({ channel: OTHER_CHANNEL, method: "GET", path: "/v1/tools" });

    expect(seen.map(s => s.commonName)).toEqual([
      `channel:${CHANNEL}`,
      `channel:${OTHER_CHANNEL}`
    ]);

    // A channel with no certificate in the directory reaches nothing at all.
    await expect(
      transport.request({ channel: "C0NOTMINTED", method: "GET", path: "/v1/tools" })
    ).rejects.toMatchObject({ reason: "no_client_certificate" });
    expect(seen).toHaveLength(2);
  });

  // The proxy hangs up rather than sending a readable alert: under TLS 1.3 the
  // client finishes the handshake before the server judges its certificate, so
  // this is indistinguishable from the proxy going away. The reason says so
  // rather than picking one of the two.
  it("is cut off when its certificate comes from another CA", async () => {
    await expect(
      transportTo(foreignCerts, port).request({ channel: CHANNEL, method: "GET", path: "/v1/tools" })
    ).rejects.toMatchObject({ reason: "connection_reset" });
    expect(seen).toEqual([]);
  });

  // The id becomes a filename, so it is validated before it is one. A Slack
  // event is not a place to trust a path segment from.
  it("refuses a channel id that is not a safe path segment", async () => {
    const transport = transportTo(certs, port);
    for (const channel of ["..", "../../etc", "a/b", ".hidden", ""]) {
      await expect(
        transport.request({ channel, method: "GET", path: "/v1/tools" })
      ).rejects.toMatchObject({ reason: "no_client_certificate" });
    }
    expect(seen).toEqual([]);
  });
});

describe("a proxy that does not answer", () => {
  it("reports an unreachable proxy as unreachable", async () => {
    // Port 1 on loopback: nothing listens, and the connection is refused
    // rather than hanging.
    await expect(
      transportTo(certs, port, "https://127.0.0.1:1").request({
        channel: CHANNEL,
        method: "GET",
        path: "/v1/tools"
      })
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("reports a response that is not JSON as malformed", async () => {
    answer = { status: 200, body: undefined };
    const plain = createServer(
      {
        cert: readFileSync(join(certs, "proxy", "server.pem")),
        key: readFileSync(join(certs, "proxy", "server.key")),
        ca: readFileSync(join(certs, "ca.pem")),
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3"
      },
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("<html>a proxy in front of the proxy</html>");
      }
    );
    await new Promise<void>(resolve => plain.listen(0, "127.0.0.1", resolve));
    const plainPort = (plain.address() as AddressInfo).port;

    await expect(
      transportTo(certs, plainPort).request({ channel: CHANNEL, method: "GET", path: "/v1/tools" })
    ).rejects.toMatchObject({ reason: "malformed_response" });

    await new Promise<void>(resolve => plain.close(() => resolve()));
  });

  it("hands a non-200 back with its body, for the caller to make sense of", async () => {
    answer = { status: 401, body: { error: { code: "unauthenticated", message: "no", requestId: "r" } } };

    const response = await transportTo(certs, port).request({
      channel: CHANNEL,
      method: "GET",
      path: "/v1/tools"
    });

    // Not thrown here: a status is an answer, and which statuses mean what is
    // the tool client's to decide (./tools.ts).
    expect(response.status).toBe(401);
  });
});

describe("cancellation", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    await expect(
      transportTo(certs, port).request({
        channel: CHANNEL,
        method: "GET",
        path: "/v1/tools",
        signal: AbortSignal.abort()
      })
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(seen).toEqual([]);
  });

  it("abandons a request in flight when the signal fires", async () => {
    const slow = createServer(
      {
        cert: readFileSync(join(certs, "proxy", "server.pem")),
        key: readFileSync(join(certs, "proxy", "server.key")),
        ca: readFileSync(join(certs, "ca.pem")),
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3"
      },
      () => {
        // Never answers. The client's signal is the only thing that ends this.
      }
    );
    await new Promise<void>(resolve => slow.listen(0, "127.0.0.1", resolve));
    const slowPort = (slow.address() as AddressInfo).port;

    const controller = new AbortController();
    const pending = transportTo(certs, slowPort).request({
      channel: CHANNEL,
      method: "GET",
      path: "/v1/tools",
      signal: controller.signal
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    await new Promise<void>(resolve => slow.close(() => resolve()));
    slow.closeAllConnections();
  });
});

describe("the proxy's address", () => {
  // Mutual TLS is the proxy's only authentication. A plaintext URL is not a
  // weaker deployment: the client presents no certificate, the proxy resolves
  // no channel, and every call fails — after the process has come up healthy.
  it("refuses a plaintext URL at construction, not at the first call", () => {
    expect(() =>
      createProxyTransport({
        url: "http://proxy:8443",
        caPath: join(certs, "ca.pem"),
        clientCertDir: join(certs, "agent")
      })
    ).toThrow(ProxyClientError);
  });

  it("refuses a URL that is not one", () => {
    expect(() =>
      createProxyTransport({
        url: "not a url",
        caPath: join(certs, "ca.pem"),
        clientCertDir: join(certs, "agent")
      })
    ).toThrow(/not a URL/);
  });

  it("fails at construction when the CA cannot be read", () => {
    expect(() =>
      createProxyTransport({
        url: `https://127.0.0.1:${port}`,
        caPath: join(certs, "no-such-ca.pem"),
        clientCertDir: join(certs, "agent")
      })
    ).toThrow(/certificate authority/);
  });
});
