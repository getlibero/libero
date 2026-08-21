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
//
// One client is built here rather than faked, and only one: the spend sender,
// because "a completed task moves the meter" is a claim about a real
// connection — the report has to arrive as the channel its certificate names,
// with the channel nowhere in what it sent. Everything else the spend client
// does is ./spend.test.ts, at the transport seam.

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { SpendReport } from "@getlibero/schema";
import { after as afterAll, before as beforeAll, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { createProxySpendClient } from "./spend.js";
import { ProxyClientError, createProxyTransport, type ProxyTransport } from "./transport.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CHANNEL = "C024BE91L";
const OTHER_CHANNEL = "C7ZZZ9999";
/** Its material is replaced mid-test, so it is nobody else's channel. */
const ROTATING = "C0ROTATING";

interface Seen {
  method: string;
  path: string;
  body: string;
  /** The CN the listener read off the peer certificate, exactly as the proxy does. */
  commonName: string | undefined;
  /** And the digest the proxy's pin check compares (#79). */
  fingerprint: string | undefined;
}

let certs: string;
let foreignCerts: string;
let server: Server;
let port: number;
let seen: Seen[] = [];
let answer: { status: number; body: unknown; delayMs?: number } = {
  status: 200,
  body: { tools: [] }
};

/** What the proxy's own identity resolver reads: the subject CN, and the digest. */
function commonNameOf(socket: TLSSocket): string | undefined {
  const cn: unknown = socket.getPeerCertificate().subject?.CN;
  return typeof cn === "string" ? cn : undefined;
}

function fingerprintOf(socket: TLSSocket): string | undefined {
  const fp: unknown = socket.getPeerCertificate().fingerprint256;
  return typeof fp === "string" ? fp : undefined;
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

// Cert minting is the slow part of this hook and it got slower in #395, which
// added the runner's server certificate and the proxy's client certificate to
// `dev-certs.sh` — two more RSA keypairs per mint, on a script this hook runs
// twice. That outran vitest's 10s hook default on a loaded CI runner, where the
// whole file failed with "Hook timed out". `node:test` supplies no default, so
// what this number does now is bound a hang rather than raise a ceiling — and it
// still has to be larger than the worst honest case.
//
// A timeout rather than a faster script: the cases are about mutual TLS, not
// about how long a keypair takes, and the script mints what the deployment
// actually uses.
beforeAll(async () => {
  certs = mkdtempSync(join(tmpdir(), "libero-agent-certs-"));
  // A second, unrelated CA. Its certificates are well-formed and worthless.
  foreignCerts = mkdtempSync(join(tmpdir(), "libero-agent-foreign-"));
  mint(certs, [CHANNEL, OTHER_CHANNEL, ROTATING]);
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
          commonName: commonNameOf(req.socket as TLSSocket),
          fingerprint: fingerprintOf(req.socket as TLSSocket)
        });
        const payload = answer.body === undefined ? "" : JSON.stringify(answer.body);
        // `delayMs` exists for one case: a request still on the wire while the
        // client rebuilds that channel's agent underneath it.
        const reply = (): void => {
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(payload);
        };
        if (answer.delayMs === undefined) reply();
        else setTimeout(reply, answer.delayMs);
      });
    }
  );

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // See the note above `mint`: two mints of a script that got slower in #395.
}, { timeout: 60_000 });

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

// #79. A rotated certificate has to take effect without restarting this
// process: restarting it drops the Slack socket, which is the gap in service
// the rotation path exists not to have.
describe("rotating a channel's certificate", () => {
  const script = (...args: string[]): void => {
    execFileSync("sh", ["scripts/dev-certs.sh", "--out", certs, ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe"
    });
  };

  const digestOf = (dir: string, channel: string): string =>
    new X509Certificate(
      readFileSync(join(dir, "agent", `client-${channel}.pem`))
    ).fingerprint256;

  /** The real two-step, through the script an operator runs. */
  const rotate = (channel: string): void => {
    script("--rotate", channel);
    // `--promote` refuses unless the sheet already pins the replacement, which
    // is the proxy's half of the story and not this file's; there is no
    // channels root here, so this asks for the move directly.
    script("--promote", channel, "--force");
  };

  it("presents the new certificate on the next request, with no restart", async () => {
    const transport = transportTo(certs, port);
    const before = digestOf(certs, ROTATING);

    await transport.request({ channel: ROTATING, method: "GET", path: "/v1/tools" });
    expect(seen[0]?.fingerprint).toBe(before);

    rotate(ROTATING);
    const after = digestOf(certs, ROTATING);
    expect(after).not.toBe(before);

    await transport.request({ channel: ROTATING, method: "GET", path: "/v1/tools" });
    expect(seen[1]?.fingerprint).toBe(after);
  });

  // The cache is still a cache. An unchanged file is not re-read, and the
  // pooled connection is not thrown away, which is what makes a `stat` per
  // request the cheap half of this.
  it("keeps the pooled connection when the file has not changed", async () => {
    const transport = transportTo(certs, port);

    await transport.request({ channel: ROTATING, method: "GET", path: "/v1/tools" });
    await transport.request({ channel: ROTATING, method: "GET", path: "/v1/tools" });

    expect(seen).toHaveLength(2);
    expect(seen[1]?.fingerprint).toBe(seen[0]?.fingerprint);
  });

  // The regression that would make "no gap in service" false. Node's
  // `Agent.destroy()` tears down sockets that are in use, so destroying the
  // superseded agent inline would kill every tool call already on the wire at
  // the exact moment a rotation lands.
  it("does not cut off a request already in flight", async () => {
    const transport = transportTo(certs, port);
    answer = { status: 200, body: { tools: [] }, delayMs: 300 };

    const inFlight = transport.request({ channel: ROTATING, method: "GET", path: "/v1/tools" });
    // Long enough for the request to be on the wire, short enough to land
    // inside the delay above.
    await new Promise(resolve => setTimeout(resolve, 50));

    rotate(ROTATING);
    // Rebuilds this channel's agent, which is what retires the one the request
    // above is still using.
    await transport.request({ channel: ROTATING, method: "GET", path: "/v1/tools" });

    await expect(inFlight).resolves.toMatchObject({ status: 200 });
  });

  // `--promote` moves the key and then the certificate, so a process that
  // starts in between reads a new key with the certificate it replaced. That
  // fails the handshake, and a handshake failure arrives here as
  // `connection_reset` — the one reason in the taxonomy documented as
  // ambiguous. Named instead.
  it("refuses a certificate and key that are not a pair, rather than failing at the handshake", async () => {
    const mixed = mkdtempSync(join(tmpdir(), "libero-agent-mixed-"));
    try {
      mkdirSync(join(mixed, "agent"), { recursive: true });
      copyFileSync(
        join(certs, "agent", `client-${CHANNEL}.pem`),
        join(mixed, "agent", `client-${CHANNEL}.pem`)
      );
      copyFileSync(
        join(certs, "agent", `client-${OTHER_CHANNEL}.key`),
        join(mixed, "agent", `client-${CHANNEL}.key`)
      );

      await expect(
        transportTo(mixed, port).request({ channel: CHANNEL, method: "GET", path: "/v1/tools" })
      ).rejects.toMatchObject({ reason: "no_client_certificate" });
      expect(seen).toEqual([]);
    } finally {
      rmSync(mixed, { recursive: true, force: true });
    }
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

// The acceptance for #110, as close to it as this side of the boundary gets:
// real certificates, a real handshake, and the received bytes put through the
// same schema the proxy parses them with.
describe("reporting spend over the real connection", () => {
  const TURN = "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55";

  const spendClientFor = (channel: string): ReturnType<typeof createProxySpendClient> =>
    createProxySpendClient({ transport: transportTo(certs, port), channel });

  it("reaches the meter as the channel its certificate names", async () => {
    answer = { status: 200, body: { outcome: "recorded" } };

    const outcome = await spendClientFor(CHANNEL).report(TURN, {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadInputTokens: 4096
    });

    expect(outcome).toBe("recorded");
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/spend" });
    expect(seen[0]?.commonName).toBe(`channel:${CHANNEL}`);
    // The channel identified the connection and appears nowhere in what was
    // sent — which is what makes the certificate, and not the body, the thing
    // the meter counts against.
    expect(seen[0]?.body).not.toContain(CHANNEL);

    const report = SpendReport.parse(JSON.parse(seen[0]?.body ?? ""));
    expect(report.turn).toBe(TURN);
    expect(report.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadInputTokens: 4096,
      cacheCreationInputTokens: 0
    });
  });

  // A retry is meant to get this. The meter records the turn id, so a second
  // report under it moves nothing and says so, and the client hands that back
  // as a result rather than raising it.
  it("takes a duplicate for the same turn id as the success it is", async () => {
    const client = spendClientFor(CHANNEL);
    const usage = { inputTokens: 11, outputTokens: 7 };

    answer = { status: 200, body: { outcome: "recorded" } };
    await expect(client.report(TURN, usage)).resolves.toBe("recorded");

    answer = { status: 200, body: { outcome: "duplicate" } };
    await expect(client.report(TURN, usage)).resolves.toBe("duplicate");

    expect(JSON.parse(seen[1]?.body ?? "").turn).toBe(JSON.parse(seen[0]?.body ?? "").turn);
  });

  it("throws rather than hanging when nothing is listening", async () => {
    const client = createProxySpendClient({
      transport: transportTo(certs, port, "https://127.0.0.1:1"),
      channel: CHANNEL
    });

    await expect(client.report(TURN, { inputTokens: 11, outputTokens: 7 })).rejects.toMatchObject({
      reason: "unreachable"
    });
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
