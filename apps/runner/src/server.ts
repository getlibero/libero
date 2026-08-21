// The runner's HTTP surface: one route, one peer.
//
// This process holds the Docker socket, which is equivalent to root on the host.
// Everything about this file is an argument that the socket is nonetheless in
// the right place — the credentials live in the proxy, the privilege lives here,
// and the two are different processes. See packages/proxy/README.md, "Reaching a
// runtime", for why that trade is the inverse of mounting the socket into the
// process holding every tool credential rather than a softened version of it.
//
// ## Two walls, and why the second one is not redundant
//
// `scripts/dev-certs.sh` mints one CA, and the *agent* holds client certificates
// it signed. So a listener that trusted the CA alone would accept a call from a
// compromised agent process: no team sheet, no `decide`, no meter, no audit row.
// That is the security property inverted by the service added to protect it.
//
// So: mutual TLS against the CA, **and** a check that the peer's
// `fingerprint256` is the one pinned fingerprint this runner accepts. That is
// packages/proxy/src/identity.ts's discipline verbatim — a CA signature is
// necessary and not sufficient, the pin is the authorization — so the deployment
// has one idea in it rather than two.
//
// The second wall is the network. `deploy/docker-compose.yml` puts this service
// on an `internal: true` network whose only other member is the proxy, so the
// agent has no route here at all and the pin is defence in depth. Neither is
// meant to be load-bearing alone.
//
// ## What this file will not do
//
// It will not report *why* a peer was rejected. A caller learns that it was
// refused; the reason goes to the log, where an operator reads it. The proxy's
// own identity gate takes the same line and for the same reason: a rejection
// that explains itself is an oracle for the thing it rejected.

import { createServer, type Server, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { SandboxRunRequest, type SandboxRunResult } from "@getlibero/schema";

/**
 * The most a request body may be.
 *
 * The code bound is 64k and the envelope around it is small, so this is roomy
 * by a wide margin and still refuses a caller trying to make this process
 * buffer. Checked against the streamed length rather than `content-length`,
 * which a caller writes.
 */
const MAX_BODY_BYTES = 262_144;

export interface RunnerLogger {
  log(level: "info" | "warn" | "error", fields: Record<string, unknown>): void;
}

export interface RunnerServerOptions {
  readonly tls: ServerOptions;
  /**
   * The one client certificate fingerprint this runner serves.
   *
   * Lowercased hex with or without colons; compared after normalizing both
   * sides, so an operator pasting either spelling out of `openssl` gets the
   * same answer.
   */
  readonly clientPin: string;
  readonly logger: RunnerLogger;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}

/** Colons out, case folded — the same normalization the proxy's pin check uses. */
export function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").toLowerCase();
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
};

export function createRunnerServer(options: RunnerServerOptions): Server {
  const pin = normalizeFingerprint(options.clientPin);

  const server = createServer(options.tls, (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(error => {
      // Nothing from a thrown value reaches the caller. A Docker error carries
      // the daemon's message, which can name host paths, and this is the one
      // process where that is worth being careful about.
      options.logger.log("error", { event: "run_failed", reason: reasonOf(error) });
      if (!res.headersSent) send(res, 500, { error: "run_failed" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    // Node answers `{}` rather than null when there is no certificate, which is
    // the same shape a certificate with no fingerprint has. Both are refused.
    const fingerprint = typeof peer.fingerprint256 === "string" ? normalizeFingerprint(peer.fingerprint256) : "";
    if (fingerprint === "" || fingerprint !== pin) {
      options.logger.log("warn", { event: "peer_rejected", fingerprint: fingerprint === "" ? "absent" : fingerprint });
      send(res, 403, { error: "not_pinned" });
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/run") {
      send(res, 404, { error: "no_such_route" });
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      send(res, 413, { error: "body_too_large" });
      return;
    }

    let parsed: SandboxRunRequest;
    try {
      parsed = SandboxRunRequest.parse(JSON.parse(body));
    } catch {
      // No zod detail in the reply. The caller is the proxy and the proxy built
      // this body from a shape it shares; a mismatch is a version skew for an
      // operator to read in the log, not a schema tutorial for the wire.
      options.logger.log("warn", { event: "bad_request" });
      send(res, 400, { error: "bad_request" });
      return;
    }

    const started = Date.now();
    const result = await options.run(parsed);
    options.logger.log("info", {
      event: "run_finished",
      outcome: result.outcome,
      exit_code: result.exitCode,
      truncated: result.truncated,
      duration_ms: Date.now() - started
    });
    send(res, 200, result);
  }

  server.on("tlsClientError", (error: Error & { code?: string }) => {
    // The handshake failed, so there is no request and no response to write.
    // A peer with no certificate, or one this CA did not sign, surfaces here.
    options.logger.log("warn", { event: "tls_client_rejected", reason: error.code ?? error.name });
  });

  return server;
}

/**
 * Read the body, refusing to buffer past the bound. `null` means too large.
 *
 * **Past the bound the buffer is dropped and the rest is drained, not refused
 * mid-flight.** Destroying the socket bounds memory just as well and is the
 * first thing to reach for — it is what this did first — but it races the
 * response: a client still writing its body gets EPIPE and never reads the 413,
 * so the operator's symptom becomes a broken pipe rather than "the body was too
 * large". Draining costs only the read, since nothing past the bound is kept.
 *
 * The same argument, and the same shape, as `readJsonBody` in
 * packages/proxy/src/server.ts. Duplicated rather than imported for this
 * service's whole reason for existing: an import would put the package holding
 * the vault into the image of the process holding the Docker socket.
 */
async function readBody(req: IncomingMessage): Promise<string | null> {
  let chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  // A claim by the client, honoured only as an early exit. The running total
  // below is what actually bounds memory, because a chunked request can omit
  // this header or lie about it.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) tooLarge = true;

  for await (const chunk of req) {
    if (tooLarge) continue;
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks = [];
      continue;
    }
    chunks.push(chunk as Buffer);
  }

  return tooLarge ? null : Buffer.concat(chunks).toString("utf8");
}

/** An errno or an error name, and never a message — the proxy's rule, for its reason. */
function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown";
}
