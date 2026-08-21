// The acceptance cases that need a real container runtime (#395).
//
// #395 asks for the sandbox's properties to be "covered by a test, not
// asserted", and there is no way to honour that against a fake: a stub that
// records `ReadonlyRootfs: true` proves this file sent the flag, not that the
// kernel enforced it. So these run real containers, and the repository gains its
// first vitest suite that needs a Docker daemon.
//
// ## The gate, and why it is not a plain skip
//
// A test that silently skips is close to the thing CLAUDE.md warns about: a test
// that encodes a gap. So the gate is two-sided.
//
//   - **No daemon, not CI** — skipped. A contributor without Docker can still
//     run `pnpm test`, which is the only reason to allow skipping at all.
//   - **No daemon, CI=true** — these fail. CI has a daemon (the `images` job
//     builds through the compose file), so an absent one there means the runner
//     changed or the workflow did, and quietly reporting green would be exactly
//     the false comfort the rule forbids.
//
// The daemon is probed once, before anything is collected, so the reason a case
// did not run is a property of the environment rather than of the case.
//
// ## What is deliberately not here
//
// Nothing about egress. A run in this milestone's first half has no network at
// all, which is asserted below; the filtering hop that would make `[egress]`
// mean something is #219, and a case for it now would be a case against nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { createDockerClient, type DockerClient } from "./docker.js";
import { runInSandbox, SANDBOX_PIDS_LIMIT, SANDBOX_TMPFS_BYTES, SANDBOX_WORKDIR } from "./run.js";

/**
 * The image these cases run against.
 *
 * Not digest-pinned, unlike the deployment's — `sandboxImageFromEnv` requires a
 * digest and is tested for it separately. Here a tag is right: pinning would
 * mean this file names a specific published layer and stops working when it is
 * garbage-collected, to prove nothing these cases are about.
 */
const IMAGE = "python:3.13-alpine";
const COMMAND = ["python3", "-c"] as const;

const socketPath = process.env["RUNNER_DOCKER_SOCKET"] ?? guessSocket();
const inCi = process.env["CI"] === "true" || process.env["CI"] === "1";

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

function guessSocket(): string {
  const home = process.env["HOME"] ?? "";
  const candidates = ["/var/run/docker.sock", `${home}/.orbstack/run/docker.sock`, `${home}/.docker/run/docker.sock`];
  return candidates.find(isSocket) ?? "/var/run/docker.sock";
}

/**
 * The gate is probed **synchronously, at module load**, and that is not a style
 * choice — it is the whole difference between a gate and a lie.
 *
 * `describe.skipIf` is evaluated when the file is collected, which is before any
 * `beforeAll` has run. A first version of this asked the daemon inside
 * `beforeAll` and set a flag; the flag was still `false` at collection time, so
 * the suite skipped itself in CI as cheerfully as it did on a laptop, and the
 * loud CI failure below never ran. It reported thirteen skipped cases and a
 * green build. That is precisely the test-that-encodes-a-gap this repository has
 * been bitten by three times, so it is written down rather than quietly fixed.
 */
const socketPresent = isSocket(socketPath);

if (inCi && !socketPresent) {
  // Thrown at import, so the file fails rather than skipping. CI has a daemon —
  // the `images` job builds through the compose file — so an absent one means
  // the environment changed, and #395's acceptance would otherwise go unchecked.
  throw new Error(
    `runner: CI=true and no Docker socket at ${socketPath}. These cases are #395's acceptance and must not be skipped in CI.`
  );
}

let docker: DockerClient;

beforeAll(async () => {
  docker = createDockerClient({ socketPath });
  // The socket exists — that was the gate. A daemon that will not answer one is
  // a real fault whether or not this is CI, so this throws either way rather
  // than degrading into a skip that cannot be seen.
  await docker.ping();

  // Pull once, here rather than per case: the first `create` against an absent
  // image fails with a 404 that reads as a bug in this file rather than as a
  // missing image.
  execFileSync("docker", ["pull", "--quiet", IMAGE], { stdio: "pipe", timeout: 300_000 });
}, 300_000);

afterAll(() => {
  // Nothing to clean: `runInSandbox` removes each container in a `finally`, and
  // the case below asserts it.
});

const run = (code: string, caps: Partial<{ cpus: number; memoryMb: number; timeoutSeconds: number }> = {}) =>
  runInSandbox(
    { code, caps: { cpus: 1, memoryMb: 512, timeoutSeconds: 30, ...caps } },
    { docker, config: { image: IMAGE, command: [...COMMAND] } }
  );

describe.skipIf(!socketPresent)("a real sandbox container", () => {
  it("runs the code and gives back what it printed", async () => {
    const result = await run("import sys; print('out'); print('err', file=sys.stderr)");

    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    // The two streams stay apart, which is the whole reason the runner does not
    // ask for a TTY.
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
  }, 120_000);

  // A program that failed is a normal answer to a question, not an error of
  // ours: it is `completed` with a non-zero status, and the proxy renders it.
  it("reports a non-zero exit as a completed run", async () => {
    const result = await run("import sys; sys.exit(3)");
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(3);
  }, 120_000);

  it("has a read-only rootfs", async () => {
    // Written against a path outside the workdir, so this cannot pass because
    // of where it wrote rather than because the rootfs refused.
    const result = await run("open('/root-write-probe','w').write('x')");
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Read-only file system|OSError|PermissionError/);
  }, 120_000);

  it("has a writable tmpfs workdir, which is the positive control for the case above", async () => {
    // Without this, "the write failed" would also pass on a container where
    // nothing is writable and the sandbox is useless.
    const result = await run(
      `open('${SANDBOX_WORKDIR}/probe','w').write('x'); print(open('${SANDBOX_WORKDIR}/probe').read())`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("x\n");
  }, 120_000);

  it("gives each run its own workdir, so nothing survives between them", async () => {
    await run(`open('${SANDBOX_WORKDIR}/left-behind','w').write('x')`);
    const second = await run(
      `import os; print(os.path.exists('${SANDBOX_WORKDIR}/left-behind'))`
    );
    expect(second.stdout).toBe("False\n");
  }, 120_000);

  it("mounts the workdir as tmpfs rather than as part of the image", async () => {
    const result = await run(
      `import subprocess; print(subprocess.run(['sh','-c','df -PT ${SANDBOX_WORKDIR} 2>/dev/null || mount'],capture_output=True,text=True).stdout)`
    );
    expect(result.stdout).toMatch(/tmpfs/);
  }, 120_000);

  it("bounds the workdir, so tmpfs cannot be used to spend the memory cap sideways", async () => {
    const megabytes = Math.floor(SANDBOX_TMPFS_BYTES / (1024 * 1024)) + 16;
    const result = await run(
      `open('${SANDBOX_WORKDIR}/big','wb').write(b'x' * ${megabytes} * 1024 * 1024)`,
      { memoryMb: 1024 }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/No space left|OSError/);
  }, 120_000);

  it("has no network at all", async () => {
    // Not "cannot resolve a name" — no route, no interface but loopback. A DNS
    // failure alone would also pass on a container that had a network and a
    // broken resolver, which is a different and much weaker property.
    const result = await run(
      "import socket; s=socket.socket(); s.settimeout(5); s.connect(('1.1.1.1',53)); print('reached')"
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("reached");
    expect(result.stderr).toMatch(/Network is unreachable|OSError|timed out/);
  }, 120_000);

  it("enforces the memory cap", async () => {
    const result = await run("x = bytearray(400 * 1024 * 1024); print(len(x))", { memoryMb: 64 });
    // The kernel's OOM killer ends the process rather than the program raising,
    // so what is asserted is that it did not succeed — not the mechanism.
    expect(result.stdout).not.toMatch(/419430400/);
    expect(result.exitCode).not.toBe(0);
  }, 120_000);

  it("kills a run at its wall-time cap and says so", async () => {
    const started = Date.now();
    const result = await run("import time\nprint('before', flush=True)\ntime.sleep(120)", { timeoutSeconds: 5 });

    expect(result.outcome).toBe("timed_out");
    // A kill is not a refusal and not a ProxyError — the request was served, and
    // what it printed before the deadline is a real answer.
    expect(result.stdout).toContain("before");
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(90_000);
  }, 120_000);

  it("bounds the number of processes", async () => {
    const result = await run(
      `import subprocess; subprocess.run(['sh','-c','i=0; while [ $i -lt ${SANDBOX_PIDS_LIMIT + 200} ]; do sleep 5 & i=$((i+1)); done; echo spawned'],capture_output=True,text=True,timeout=20)`
    );
    expect(result.stdout).not.toContain("spawned");
  }, 120_000);

  it("removes the container, so nothing is left holding a tmpfs", async () => {
    await run("print('done')");
    // `docker ps -a` over the whole daemon rather than a recorded id, because
    // the property is "none are left", and a leak would most likely be a
    // container this run never learned the id of.
    const listed = execFileSync("docker", ["ps", "-a", "--filter", `ancestor=${IMAGE}`, "--format", "{{.ID}}"], {
      encoding: "utf8"
    }).trim();
    expect(listed).toBe("");
  }, 120_000);

  it("runs as a non-root user", async () => {
    const result = await run("import os; print(os.getuid())");
    expect(result.stdout.trim()).not.toBe("0");
  }, 120_000);
});
