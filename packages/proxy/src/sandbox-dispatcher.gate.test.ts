// The deployment's concurrency cap on `run_code` (#405).
//
// Its own file rather than more cases in ./sandbox-dispatcher.test.ts, because
// the requirement differs: that file renders a result and needs nothing, and
// every case here mints real certificates and stands up a TLS listener. The
// same split apps/runner/src keeps between `run.ts`'s tests and `server.ts`'s.
//
// **Against a real listener rather than a stubbed `post`.** The permit is
// acquired before the request and released in a `finally` around it, so a fake
// transport would be testing that the semaphore works — which
// ./semaphore.test.ts already does — instead of testing that this module holds
// one across every path out of a call, which is the thing that can break.

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "expect";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:https";
import { readFileSync } from "node:fs";
import type { ResolvedToolCall, SandboxCaps, SandboxRunResult } from "@getlibero/schema";
import { createSandboxDispatcher } from "./sandbox-dispatcher.js";
import type { SandboxDispatcher } from "./dispatch.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const CAPS: SandboxCaps = { cpus: 1, memoryMb: 512, timeoutSeconds: 1 };
const GRANT = { caps: CAPS, egressAllow: [] as readonly string[] };
const LIMITS = { maxResultChars: 10_000 };

const call = (id: string): ResolvedToolCall => ({
  id,
  server: "libero",
  tool: "run_code",
  arguments: { code: "print(1)" },
  requestingUser: "U1",
  task: "t1",
  channel: "C1"
});

const RUN: SandboxRunResult = {
  outcome: "completed",
  stdout: "1\n",
  stderr: "",
  exitCode: 0,
  truncated: false,
  deniedHost: null,
  appliedCaps: null
};

let dir: string;
let server: Server;
let url: string;

/**
 * Requests the fake runner has received and not yet answered.
 *
 * The whole rig: a run is "in flight" for exactly as long as the test wants it
 * to be, so a cap of one can be observed holding a second call out rather than
 * inferred from timing. Nothing here sleeps.
 */
let held: Array<(status: number) => void> = [];
/** Resolved each time a request reaches the listener, so a test can await arrival. */
let onArrival: (() => void) | null = null;

const nextArrival = () =>
  new Promise<void>(resolve => {
    onArrival = () => {
      onArrival = null;
      resolve();
    };
  });

/** Answer the oldest in-flight request. */
const releaseOne = (status = 200) => {
  const answer = held.shift();
  expect(answer).toBeDefined();
  answer?.(status);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sandbox-gate-certs-"));
  // The real script, for the reason every other TLS test in this repo uses it:
  // a fixture that agrees with the script but not with Node passes here and
  // fails in the deployment.
  execFileSync("sh", ["scripts/dev-certs.sh", "--out", dir], {
    cwd: REPO_ROOT,
    env: { ...process.env, OUT: dir },
    stdio: "pipe"
  });

  server = createServer(
    {
      cert: readFileSync(join(dir, "runner/server.pem")),
      key: readFileSync(join(dir, "runner/server.key")),
      ca: readFileSync(join(dir, "ca.pem")),
      requestCert: true,
      minVersion: "TLSv1.3"
    },
    (req, res) => {
      req.resume();
      req.on("end", () => {
        held.push(status => {
          const payload = Buffer.from(JSON.stringify(RUN), "utf8");
          res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
          res.end(payload);
        });
        onArrival?.();
      });
    }
  );

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // 127.0.0.1 is a SAN on the runner's server certificate, so this verifies
  // without the dispatcher having to be told a servername it never sets.
  url = `https://127.0.0.1:${port}`;
  // Minting a whole certificate tree is slow enough on a loaded CI runner to
  // need a bound chosen rather than inherited.
}, { timeout: 60_000 });

afterAll(() => {
  server?.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

const dispatcher = (maxConcurrency: number, queueWaitMs: number): SandboxDispatcher =>
  createSandboxDispatcher({
    url,
    tls: { cert: join(dir, "proxy/client.pem"), key: join(dir, "proxy/client.key"), ca: join(dir, "ca.pem") },
    logger: { log: () => {} },
    maxConcurrency,
    queueWaitMs
  });

describe("the deployment's concurrency cap", () => {
  // The bound itself. Each run is two containers and a network, so the count of
  // requests the runner has seen is the count of containers the host is holding.
  it("holds a second call out while the first is in flight", async () => {
    held = [];
    const sandbox = dispatcher(1, 5_000);
    const arrival = nextArrival();
    const first = sandbox.run(call("a"), GRANT, LIMITS);
    await arrival;

    const second = sandbox.run(call("b"), GRANT, LIMITS);
    // A macrotask is enough: if the gate were not there, the second request
    // would already have been written to the socket.
    await new Promise(resolve => setImmediate(resolve));
    expect(held).toHaveLength(1);

    const secondArrival = nextArrival();
    releaseOne();
    expect(await first).toMatchObject({ outcome: "ran" });

    // And it is served rather than dropped, which is the difference between a
    // queue and a cap.
    await secondArrival;
    releaseOne();
    expect(await second).toMatchObject({ outcome: "ran" });
  });

  // Not a refusal. Nothing about the channel's grant changed — the deployment
  // is full — so this must be the 501 an unreachable runner gets, not a
  // `ToolRefusal`, which is a closed set of governance decisions.
  it("gives up as unavailable rather than refusing, when the wait expires", async () => {
    held = [];
    const sandbox = dispatcher(1, 25);
    const arrival = nextArrival();
    const first = sandbox.run(call("a"), GRANT, LIMITS);
    await arrival;

    const busy = await sandbox.run(call("b"), GRANT, LIMITS);
    expect(busy).toEqual({ outcome: "unavailable", reason: "runner_busy" });
    // The call that gave up must never have reached the runner: a container
    // started for a caller that has stopped listening is the thing the cap is
    // for.
    expect(held).toHaveLength(1);

    releaseOne();
    await first;
  });

  // The `finally`, and the reason this file talks to a real listener. A permit
  // leaked on the error path turns a cap of two into a deployment that serves
  // two calls and then nothing, for as long as the process lives.
  it("releases the permit when the runner answers an error", async () => {
    held = [];
    const sandbox = dispatcher(1, 5_000);
    const arrival = nextArrival();
    const failing = sandbox.run(call("a"), GRANT, LIMITS);
    await arrival;
    releaseOne(500);
    expect(await failing).toEqual({ outcome: "unavailable", reason: "runner_error" });

    const nextRun = nextArrival();
    const after = sandbox.run(call("b"), GRANT, LIMITS);
    await nextRun;
    releaseOne();
    expect(await after).toMatchObject({ outcome: "ran" });
  });

  // The uncontended path is every call in a deployment that never reaches its
  // limit, and it must not queue, time, or otherwise notice the gate.
  it("does not gate a deployment below its limit", async () => {
    held = [];
    const sandbox = dispatcher(2, 25);
    const first = nextArrival();
    const a = sandbox.run(call("a"), GRANT, LIMITS);
    await first;
    const second = nextArrival();
    const b = sandbox.run(call("b"), GRANT, LIMITS);
    await second;
    expect(held).toHaveLength(2);
    releaseOne();
    releaseOne();
    expect(await a).toMatchObject({ outcome: "ran" });
    expect(await b).toMatchObject({ outcome: "ran" });
  });
});
