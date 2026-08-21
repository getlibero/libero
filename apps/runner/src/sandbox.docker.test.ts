// The acceptance cases that need a real container runtime (#395).
//
// #395 asks for the sandbox's properties to be "covered by a test, not
// asserted", and there is no way to honour that against a fake: a stub that
// records `ReadonlyRootfs: true` proves this file sent the flag, not that the
// kernel enforced it. So these run real containers, and the repository gains its
// first suite that needs a Docker daemon.
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

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "expect";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDockerClient, type DockerClient } from "./docker.js";
import { runInSandbox, SANDBOX_PIDS_LIMIT, SANDBOX_WORKDIR } from "./run.js";

/**
 * The image these cases run against.
 *
 * Not digest-pinned, unlike the deployment's — `sandboxImageFromEnv` requires a
 * digest and is tested for it separately. Here a tag is right: pinning would
 * mean this file names a specific published layer and stops working when it is
 * garbage-collected, to prove nothing these cases are about.
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

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
 * `describe`'s `skip` option is read when the file is collected, which is
 * before any `beforeAll` has run. A first version of this asked the daemon
 * inside `beforeAll` and set a flag; the flag was still `false` at collection
 * time, so
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
}, { timeout: 300_000 });

afterAll(() => {
  // Nothing to clean: `runInSandbox` removes each container in a `finally`, and
  // the case below asserts it.
});

const run = (
  code: string,
  caps: Partial<{ cpus: number; memoryMb: number; timeoutSeconds: number }> = {},
  egressAllow: readonly string[] = []
) =>
  runInSandbox(
    { code, caps: { cpus: 1, memoryMb: 512, timeoutSeconds: 30, ...caps }, egressAllow: [...egressAllow] },
    { docker, config: { image: IMAGE, command: [...COMMAND] }, newRunId: () => randomUUID() }
  );

describe("a real sandbox container", { skip: !socketPresent }, () => {
  it("runs the code and gives back what it printed", { timeout: 120_000 }, async () => {
    const result = await run("import sys; print('out'); print('err', file=sys.stderr)");

    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    // The two streams stay apart, which is the whole reason the runner does not
    // ask for a TTY.
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
  });

  // A program that failed is a normal answer to a question, not an error of
  // ours: it is `completed` with a non-zero status, and the proxy renders it.
  it("reports a non-zero exit as a completed run", { timeout: 120_000 }, async () => {
    const result = await run("import sys; sys.exit(3)");
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(3);
  });

  it("has a read-only rootfs", { timeout: 120_000 }, async () => {
    // Written against a path outside the workdir, so this cannot pass because
    // of where it wrote rather than because the rootfs refused.
    const result = await run("open('/root-write-probe','w').write('x')");
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Read-only file system|OSError|PermissionError/);
  });

  it(
    "has a writable tmpfs workdir, which is the positive control for the case above",
    { timeout: 120_000 },
    async () => {
        // Without this, "the write failed" would also pass on a container where
        // nothing is writable and the sandbox is useless.
        const result = await run(
          `open('${SANDBOX_WORKDIR}/probe','w').write('x'); print(open('${SANDBOX_WORKDIR}/probe').read())`
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("x\n");
      }
  );

  it("gives each run its own workdir, so nothing survives between them", { timeout: 120_000 }, async () => {
    await run(`open('${SANDBOX_WORKDIR}/left-behind','w').write('x')`);
    const second = await run(
      `import os; print(os.path.exists('${SANDBOX_WORKDIR}/left-behind'))`
    );
    expect(second.stdout).toBe("False\n");
  });

  it("mounts the workdir as tmpfs rather than as part of the image", { timeout: 120_000 }, async () => {
    const result = await run(
      `import subprocess; print(subprocess.run(['sh','-c','df -PT ${SANDBOX_WORKDIR} 2>/dev/null || mount'],capture_output=True,text=True).stdout)`
    );
    expect(result.stdout).toMatch(/tmpfs/);
  });

  // The workdir is sized to the memory cap rather than fixed, so a program
  // cannot use it to spend that cap sideways — filling it is the same bound as
  // allocating, and it stops at the same number.
  it("bounds the workdir at the channel's memory cap", { timeout: 120_000 }, async () => {
    const result = await run(`open('${SANDBOX_WORKDIR}/big','wb').write(b'x' * 192 * 1024 * 1024)`, {
      memoryMb: 64
    });
    // The exit status and nothing else: the kernel's OOM killer ends the
    // process rather than the program raising, so there is no traceback to
    // match on — which is itself the demonstration. Filling the workdir *is*
    // spending the memory cap, because they are the same cap.
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("wrote");
  });

  // The other half, and the reason the fixed 64 MiB had to go: a cap big enough
  // to hold a package tree gets a workdir big enough to hold it.
  it("gives a bigger cap a bigger workdir", { timeout: 120_000 }, async () => {
    const result = await run(`open('${SANDBOX_WORKDIR}/big','wb').write(b'x' * 192 * 1024 * 1024)\nprint("wrote")`, {
      memoryMb: 512
    });
    expect(result.stdout).toContain("wrote");
    expect(result.exitCode).toBe(0);
  });

  it("has no network at all", { timeout: 120_000 }, async () => {
    // Not "cannot resolve a name" — no route, no interface but loopback. A DNS
    // failure alone would also pass on a container that had a network and a
    // broken resolver, which is a different and much weaker property.
    const result = await run(
      "import socket; s=socket.socket(); s.settimeout(5); s.connect(('1.1.1.1',53)); print('reached')"
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("reached");
    expect(result.stderr).toMatch(/Network is unreachable|OSError|timed out/);
  });

  it("enforces the memory cap", { timeout: 120_000 }, async () => {
    const result = await run("x = bytearray(400 * 1024 * 1024); print(len(x))", { memoryMb: 64 });
    // The kernel's OOM killer ends the process rather than the program raising,
    // so what is asserted is that it did not succeed — not the mechanism.
    expect(result.stdout).not.toMatch(/419430400/);
    expect(result.exitCode).not.toBe(0);
  });

  it("kills a run at its wall-time cap and says so", { timeout: 120_000 }, async () => {
    const started = Date.now();
    const result = await run("import time\nprint('before', flush=True)\ntime.sleep(120)", { timeoutSeconds: 5 });

    expect(result.outcome).toBe("timed_out");
    // A kill is not a refusal and not a ProxyError — the request was served, and
    // what it printed before the deadline is a real answer.
    expect(result.stdout).toContain("before");
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(90_000);
  });

  it("bounds the number of processes", { timeout: 120_000 }, async () => {
    const result = await run(
      `import subprocess; subprocess.run(['sh','-c','i=0; while [ $i -lt ${SANDBOX_PIDS_LIMIT + 200} ]; do sleep 5 & i=$((i+1)); done; echo spawned'],capture_output=True,text=True,timeout=20)`
    );
    expect(result.stdout).not.toContain("spawned");
  });

  it("removes the container, so nothing is left holding a tmpfs", { timeout: 120_000 }, async () => {
    await run("print('done')");
    // `docker ps -a` over the whole daemon rather than a recorded id, because
    // the property is "none are left", and a leak would most likely be a
    // container this run never learned the id of.
    const listed = execFileSync("docker", ["ps", "-a", "--filter", `ancestor=${IMAGE}`, "--format", "{{.ID}}"], {
      encoding: "utf8"
    }).trim();
    expect(listed).toBe("");
  });

  it("runs as a non-root user", { timeout: 120_000 }, async () => {
    const result = await run("import os; print(os.getuid())");
    expect(result.stdout.trim()).not.toBe("0");
  });
});

// #219's acceptance, against real containers on real networks. Nothing here is
// a stub: a hop container really runs, a per-run network really has no default
// route, and the allowed case really opens a TLS connection to a public host.
//
// **These reach the internet**, which is why they are their own block and why
// the positive control is the first case. A sandbox that reaches nothing would
// pass every denial assertion below, and the suite's standing rule is that a
// "reached nothing" claim is worth nothing without proof the surface reaches
// something.
describe("a sandbox with an egress grant", { skip: !socketPresent }, () => {
  // Docker's default bridge, which has a route out. In a deployment this is the
  // compose file's `sandbox-egress`; here it is the network that exists on any
  // host running these tests.
  const EGRESS_NETWORK = "bridge";

  /**
   * The hop runs *this repository's* runner image, so the image has to exist.
   *
   * Built here rather than assumed, and that is the second thing CI taught this
   * file. The `images` job builds it; the `build` job that runs the tests does
   * not, so the first run of these cases failed with "No such image" — a
   * dependency on another job's side effect, which is the kind of coupling that
   * works until somebody reorders a workflow.
   *
   * A bind mount of `dist` would have been faster and is the thing to refuse:
   * `ContainerSpec` deliberately has no `Binds`, because a spec field that
   * reaches the host filesystem is exactly what #393 designed the request shape
   * to make impossible. A test is not a reason to add one.
   */
  const RUNNER_IMAGE = process.env["RUNNER_IMAGE"] ?? "ghcr.io/getlibero/runner:latest";

  beforeAll(() => {
    try {
      execFileSync("docker", ["image", "inspect", RUNNER_IMAGE], { stdio: "pipe" });
    } catch {
      execFileSync("docker", ["build", "-f", "apps/runner/Dockerfile", "-t", RUNNER_IMAGE, "."], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        timeout: 900_000
      });
    }
  }, { timeout: 900_000 });

  const withEgress = (
    code: string,
    allow: readonly string[],
    caps: Partial<{ cpus: number; memoryMb: number; timeoutSeconds: number }> = {}
  ) =>
    runInSandbox(
      { code, caps: { cpus: 1, memoryMb: 512, timeoutSeconds: 60, ...caps }, egressAllow: [...allow] },
      {
        docker,
        config: {
          image: IMAGE,
          command: [...COMMAND],
          // The hop runs *this repository's* runner image. A plain `node` image
          // would test a hop that is not the one that ships.
          egress: {
            image: RUNNER_IMAGE,
            command: ["node", "dist/hop.js"],
            network: EGRESS_NETWORK,
            port: 8080
          }
        },
        newRunId: () => randomUUID()
      }
    );

  const FETCH = (host: string) =>
    `import urllib.request
print(urllib.request.urlopen("https://${host}/", timeout=25).status)`;

  it("reaches a host the sheet allows", { timeout: 180_000 }, async () => {
    const result = await withEgress(FETCH("example.com"), ["example.com"]);

    expect(result.outcome).toBe("completed");
    expect(result.stdout.trim()).toBe("200");
  });

  it("is denied a host the sheet does not allow, and the run ends", { timeout: 180_000 }, async () => {
    const result = await withEgress(
      `${FETCH("example.org")}
print("kept going")`,
      ["example.com"]
    );

    expect(result.outcome).toBe("egress_denied");
    expect(result.deniedHost).toBe("example.org");
    // Terminal, not best-effort (#393): the program does not get to carry on
    // after the denial and print its next line.
    expect(result.stdout).not.toContain("kept going");
  });

  it(
    "has no route out except the hop, so ignoring the proxy reaches nothing",
    { timeout: 180_000 },
    async () => {
        // Dials an address directly, with no proxy involved. This is the case that
        // proves enforcement is topological rather than a convention the code could
        // decline to follow: there is no default route on the per-run network.
        const result = await withEgress(
          "import socket; s=socket.socket(); s.settimeout(10); s.connect(('93.184.215.14',443)); print('reached')",
          ["example.com"]
        );

        expect(result.stdout).not.toContain("reached");
        expect(result.exitCode).not.toBe(0);
      }
  );

  it("cannot reach the metadata address even when the sheet lists it", { timeout: 180_000 }, async () => {
    const result = await withEgress(FETCH("169.254.169.254"), ["169.254.169.254"]);
    expect(result.outcome).toBe("egress_denied");
    expect(result.deniedHost).toBe("169.254.169.254");
  });

  // `noexec` on the workdir cannot dlopen a shared object, which rules out every
  // native Python wheel — and Docker adds `noexec` unless you ask for the
  // opposite, so this guards a mount option that is easy to regain by accident.
  //
  // It lives in this block rather than beside the other workdir cases because it
  // needs a package index, which needs a hop. A real extension module rather
  // than a hand-rolled binary, because what is being protected is the thing
  // people actually reach for — and `pypi.org` plus `files.pythonhosted.org` is
  // the whole allowlist that takes, which is the recipe the docs give.
  it("installs a package and loads its native extension", { timeout: 900_000 }, async () => {
    const result = await withEgress(
      [
        "import subprocess, sys",
        `r = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--target", "${SANDBOX_WORKDIR}/pkgs", "numpy"], capture_output=True, text=True, timeout=540)`,
        'print("install", r.returncode, r.stderr[-300:])',
        `sys.path.insert(0, "${SANDBOX_WORKDIR}/pkgs")`,
        "import numpy",
        'print("native", numpy.arange(5).sum())'
      ].join("\n"),
      ["pypi.org", "files.pythonhosted.org"],
      { memoryMb: 2048, timeoutSeconds: 600 }
    );

    expect(result.stdout).toContain("install 0");
    // The assertion that fails the moment `exec` leaves the mount: numpy
    // installs either way and imports only with it.
    expect(result.stdout).toContain("native 10");
  });

  it("leaves no container and no network behind", { timeout: 180_000 }, async () => {
    await withEgress(FETCH("example.com"), ["example.com"]);

    const networks = execFileSync("docker", ["network", "ls", "--filter", "name=libero-sandbox-", "--format", "{{.Name}}"], {
      encoding: "utf8"
    }).trim();
    const containers = execFileSync("docker", ["ps", "-a", "--filter", "name=libero-hop-", "--format", "{{.ID}}"], {
      encoding: "utf8"
    }).trim();

    // A leaked network is a bridge interface on the host that nothing will ever
    // clean up, which is worse than a leaked container.
    expect(networks).toBe("");
    expect(containers).toBe("");
  });
});
