import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { Server } from "node:https";
import type { SandboxRunRequest, SandboxRunResult } from "@getlibero/schema";
import { createRunnerServer, normalizeFingerprint } from "./server.js";
import { loadRunnerTls } from "./tls.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Real certificates from the real script, for the reason
 * packages/proxy/src/server.test.ts mints its own: the pin this server enforces
 * is `fingerprint256` as Node computes it, and a fixture agreeing with the
 * script but not with Node would pass while the deployment failed.
 *
 * Two client certificates are minted. The second is the whole point of the
 * file — it is signed by the *same CA*, exactly as an agent's channel
 * certificate is, and must still be refused.
 */
let dir: string;
let ca: string;
let server: Server;
let port: number;
let calls: SandboxRunRequest[] = [];

const RESULT: SandboxRunResult = {
  outcome: "completed",
  stdout: "ok\n",
  stderr: "",
  exitCode: 0,
  truncated: false
};

const mint = (args: string[]) => execFileSync("sh", ["scripts/dev-certs.sh", ...args], { cwd: REPO_ROOT, env: { ...process.env, OUT: dir }, stdio: "pipe" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "runner-certs-"));
  // `--raw-cn` is the existing hook for a principal that is not a channel.
  mint(["--out", dir, "--raw-cn", "pinned=libero-proxy", "--raw-cn", "impostor=libero-proxy"]);
  ca = join(dir, "ca.pem");

  server = createRunnerServer({
    tls: loadRunnerTls({ cert: join(dir, "runner/server.pem"), key: join(dir, "runner/server.key"), ca }),
    clientPin: new X509Certificate(readFileSync(join(dir, "agent/client-pinned.pem"))).fingerprint256,
    logger: { log: () => {} },
    run: async request => {
      calls.push(request);
      return RESULT;
    }
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(() => {
  server?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

const call = (label: string, body: string, path = "/v1/run", method = "POST") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        ca: readFileSync(ca),
        cert: readFileSync(join(dir, `agent/client-${label}.pem`)),
        key: readFileSync(join(dir, `agent/client-${label}.key`)),
        servername: "runner",
        headers: { "content-type": "application/json", "content-length": payload.length }
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

const RUN = JSON.stringify({ code: "print(1)", caps: { cpus: 1, memoryMb: 512, timeoutSeconds: 30 } });

describe("the runner's one route", () => {
  it("serves the pinned peer", async () => {
    calls = [];
    const reply = await call("pinned", RUN);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.code).toBe("print(1)");
  });

  // The case this file exists for. `scripts/dev-certs.sh` mints ONE CA, and the
  // agent holds client certificates it signed — so a listener trusting the CA
  // alone would serve a compromised agent process: no team sheet, no `decide`,
  // no meter, no audit row. This certificate is valid, signed by the same CA,
  // carries the same CN, and is refused because its fingerprint is not the pin.
  it("refuses a different certificate the same CA signed", async () => {
    calls = [];
    const reply = await call("impostor", RUN);
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ error: "not_pinned" });
    // The positive control for this assertion is the case above: without it,
    // "nothing ran" would also pass on a server that never runs anything.
    expect(calls).toEqual([]);
  });

  it("says nothing about why a peer was refused", async () => {
    const reply = await call("impostor", RUN);
    // No CN, no fingerprint, no "expected". A rejection that explains itself is
    // an oracle for the thing it rejected; the reason goes to the log.
    expect(reply.body).not.toMatch(/libero-proxy|fingerprint|expected/i);
  });

  it("checks the pin before the route, so an unpinned peer cannot probe for one", async () => {
    const reply = await call("impostor", RUN, "/v1/does-not-exist");
    expect(reply.status).toBe(403);
  });

  it("answers 404 for anything but POST /v1/run", async () => {
    expect((await call("pinned", RUN, "/v1/other")).status).toBe(404);
    expect((await call("pinned", RUN, "/v1/run", "GET")).status).toBe(404);
  });

  it("refuses a body it cannot parse, without a schema tutorial on the wire", async () => {
    calls = [];
    const reply = await call("pinned", JSON.stringify({ code: "", caps: {} }));
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({ error: "bad_request" });
    expect(calls).toEqual([]);
  });

  it("refuses caps past the schema's ceiling rather than passing them to Docker", async () => {
    calls = [];
    const reply = await call(
      "pinned",
      JSON.stringify({ code: "x", caps: { cpus: 1, memoryMb: 512, timeoutSeconds: 999_999 } })
    );
    expect(reply.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses a body over the bound", async () => {
    calls = [];
    const reply = await call("pinned", JSON.stringify({ code: "x".repeat(300_000), caps: {} }));
    expect(reply.status).toBe(413);
    expect(calls).toEqual([]);
  });
});

describe("fingerprint normalization", () => {
  it("reads either spelling as the same value", () => {
    expect(normalizeFingerprint("AB:CD:EF")).toBe("abcdef");
    expect(normalizeFingerprint("abcdef")).toBe("abcdef");
  });
});
