// The container runtime, spoken to directly over its unix socket.
//
// **No client library, and that is the decision rather than the shortcut.** The
// Docker Engine API is HTTP/1.1 over a unix socket, which `node:http` speaks
// with a `socketPath` and no dependency at all. A library here would be a
// package with a view of — and a hand on — the one socket in this deployment
// that is equivalent to root on the host, inside the one service that holds it.
// That is the edge packages/proxy/src/server.ts's header tells a reviewer to
// reject, and packages/agent/src/proxy/transport.ts already made the same call
// for the same reason. This repository has hand-rolled an HTTPS client and an
// HTTPS server rather than take a dependency; this is a third instance of one
// argument, not a new one.
//
// The surface used is five calls — create, start, wait, logs, remove, plus kill
// on the timeout path. Everything else the Engine API offers is not reachable
// from here, which is most of what makes the runner's own compromise smaller
// than the daemon's.
//
// ## What this module does not decide
//
// It does not decide *what* to run. `createContainer` takes a spec that ./run.ts
// builds, and ./run.ts builds it from the runner's environment and the request's
// caps — never from anything a caller can put in the request body. This module
// would happily send `Privileged: true` if handed it; the reason nothing can is
// that no field on `SandboxRunRequest` reaches here. Keeping that true is a
// property of ./run.ts and of the schema, and this file is deliberately dumb so
// there is only one place to check it.

import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

/** How long any single Engine API call may take, apart from `wait`. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * The most bytes a control-plane reply may be.
 *
 * Create and wait answer small JSON. A daemon answering something enormous is a
 * daemon this process should not be buffering, and the bound is the same shape
 * `MAX_CONTROL_BODY_BYTES` takes in the proxy's outbound path.
 */
const MAX_CONTROL_BODY_BYTES = 65_536;

/** Thrown for anything the daemon said that this module cannot use. */
export class DockerError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

/**
 * What one container should be.
 *
 * A structural type rather than the Engine API's own vocabulary, so ./run.ts
 * reads as a list of decisions and this file does the translating. The fields
 * are exactly the ones #395 requires be true and testable, plus the hardening
 * that costs nothing to add and would be noticed only in its absence.
 */
export interface ContainerSpec {
  readonly image: string;
  readonly command: readonly string[];
  readonly workdir: string;
  /** Bytes. */
  readonly memory: number;
  /** Docker counts cpu in billionths. */
  readonly nanoCpus: number;
  readonly tmpfsSize: number;
  readonly pidsLimit: number;
}

export interface DockerClientOptions {
  readonly socketPath: string;
}

export interface CreatedContainer {
  readonly id: string;
}

/** One stream of a container's output, already demultiplexed. */
export interface ContainerLogs {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface DockerClient {
  create(spec: ContainerSpec): Promise<CreatedContainer>;
  start(id: string): Promise<void>;
  /** Resolves with the exit status, or null if `timeoutMs` elapsed first. */
  wait(id: string, timeoutMs: number): Promise<number | null>;
  kill(id: string): Promise<void>;
  logs(id: string, maxBytes: number): Promise<ContainerLogs>;
  remove(id: string): Promise<void>;
  /** A cheap call used to prove the daemon is reachable before anything is created. */
  ping(): Promise<void>;
}

export function createDockerClient(options: DockerClientOptions): DockerClient {
  const call = (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      const req = httpRequest(
        {
          socketPath: options.socketPath,
          path,
          method,
          timeout: timeoutMs,
          headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": payload.length }
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_CONTROL_BODY_BYTES) {
              res.destroy();
              reject(new DockerError(`docker: reply over ${MAX_CONTROL_BODY_BYTES} bytes from ${path}`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        }
      );
      // The daemon's socket, not a network peer: a failure here is an operator
      // condition (no socket, wrong group, daemon down) and the message names
      // the path so it is actionable rather than mysterious.
      req.on("error", error => reject(new DockerError(`docker: ${options.socketPath}: ${(error as Error).message}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new DockerError(`docker: ${method} ${path} timed out`));
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const expect = async (method: string, path: string, ok: readonly number[], body?: unknown, timeoutMs?: number) => {
    const reply = await call(method, path, body, timeoutMs);
    if (!ok.includes(reply.status)) {
      // The daemon's own message, trimmed. It names the real fault — an image
      // that is not present, a cgroup limit the kernel refused — and inventing
      // a substitute here would cost an operator the only useful sentence.
      throw new DockerError(`docker: ${method} ${path} answered ${reply.status}: ${reply.body.slice(0, 512)}`, reply.status);
    }
    return reply;
  };

  return {
    async ping() {
      await expect("GET", "/_ping", [200]);
    },

    async create(spec) {
      const reply = await expect("POST", "/containers/create", [201], {
        Image: spec.image,
        Cmd: [...spec.command],
        WorkingDir: spec.workdir,
        // Belt and braces with `NetworkMode: "none"` below. Both are set because
        // they are enforced at different layers and #395's acceptance is that a
        // run with no `[egress]` block has no network *at all*.
        NetworkDisabled: true,
        AttachStdout: true,
        AttachStderr: true,
        // No TTY, on purpose: a TTY merges the two streams into one and the
        // result shape keeps them apart. The cost is demultiplexing in ./logs,
        // which is twenty lines.
        Tty: false,
        OpenStdin: false,
        // nobody:nogroup. The rootfs is read-only anyway, but a process that is
        // not root inside the container is one fewer thing depending on that.
        User: "65534:65534",
        Env: [],
        HostConfig: {
          ReadonlyRootfs: true,
          NetworkMode: "none",
          // `mode=1777` is load-bearing, not decoration. Docker mounts a tmpfs
          // root-owned and 0755 by default, and the container runs as uid 65534
          // — so without it the one writable path in the sandbox is writable by
          // nobody, and every program that opens a file fails. The suite caught
          // it because the read-only-rootfs case has a positive control.
          Tmpfs: { [spec.workdir]: `rw,noexec,nosuid,mode=1777,size=${spec.tmpfsSize}` },
          Memory: spec.memory,
          // Without this the kernel counts swap separately and a container can
          // exceed its memory cap by swapping. Equal values mean no swap.
          MemorySwap: spec.memory,
          NanoCpus: spec.nanoCpus,
          PidsLimit: spec.pidsLimit,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          // Removal is explicit, in ./run.ts's `finally`, because the logs have
          // to be read after the container exits and `AutoRemove` races that.
          AutoRemove: false,
          RestartPolicy: { Name: "no" }
        }
      });
      const parsed = JSON.parse(reply.body) as { Id?: unknown };
      if (typeof parsed.Id !== "string" || parsed.Id === "") {
        throw new DockerError("docker: create answered without a container id");
      }
      return { id: parsed.Id };
    },

    async start(id) {
      await expect("POST", `/containers/${id}/start`, [204, 304]);
    },

    async wait(id, timeoutMs) {
      try {
        // The daemon holds this request open until the container exits, so the
        // wall-time cap is this call's own timeout rather than a second timer
        // racing it.
        const reply = await expect("POST", `/containers/${id}/wait`, [200], undefined, timeoutMs);
        const parsed = JSON.parse(reply.body) as { StatusCode?: unknown };
        return typeof parsed.StatusCode === "number" ? parsed.StatusCode : null;
      } catch (error) {
        if (error instanceof DockerError && error.message.includes("timed out")) return null;
        throw error;
      }
    },

    async kill(id) {
      // 409 is "already stopped", which on this path is a race we won rather
      // than a fault: the container exited between the wait timing out and this.
      await expect("POST", `/containers/${id}/kill`, [204, 409]);
    },

    async logs(id, maxBytes) {
      return await readLogs(options.socketPath, id, maxBytes);
    },

    async remove(id) {
      await expect("DELETE", `/containers/${id}?force=1&v=1`, [204, 404]);
    }
  };
}

/**
 * Read a finished container's output and split the two streams apart.
 *
 * Docker frames a non-TTY log stream: an eight-byte header whose first byte is
 * the stream (1 stdout, 2 stderr) and whose last four are the payload length,
 * big-endian, then that many bytes. This walks the frames rather than treating
 * the body as text, because treating it as text puts the header bytes into the
 * model's context and silently corrupts any output containing a newline at the
 * wrong offset.
 *
 * It reads a bounded prefix and says so. Stopping early rather than reading and
 * discarding is deliberate: the point of the bound is to not buffer it.
 */
async function readLogs(socketPath: string, id: string, maxBytes: number): Promise<ContainerLogs> {
  const raw = await new Promise<{ buffer: Buffer; truncated: boolean }>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path: `/containers/${id}/logs?stdout=1&stderr=1`,
        method: "GET",
        timeout: CALL_TIMEOUT_MS
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new DockerError(`docker: logs answered ${res.statusCode}`, res.statusCode));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("close", () => resolve({ buffer: Buffer.concat(chunks), truncated }));
        res.on("error", reject);
      }
    );
    req.on("error", error => reject(new DockerError(`docker: logs: ${(error as Error).message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new DockerError("docker: logs timed out"));
    });
    req.end();
  });

  return demultiplex(raw.buffer, raw.truncated);
}

/** The frame walk. Exported for its own test — the framing is easy to get subtly wrong. */
export function demultiplex(buffer: Buffer, truncated: boolean): ContainerLogs {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + length, buffer.length);
    // A frame the bound cut in half is still worth its bytes; the flag already
    // says the tail is missing, so there is nothing to gain by dropping it.
    if (stream === 2) err.push(buffer.subarray(start, end));
    else out.push(buffer.subarray(start, end));
    offset = start + length;
  }

  return {
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    truncated: truncated || offset > buffer.length
  };
}
