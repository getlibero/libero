// `clampCaps` — the deployment ceiling, and the half of ./run.ts that needs no
// daemon (#405).
//
// Separate from ./sandbox.docker.test.ts on this repository's stated rule that
// exactly one file requires a Docker daemon. Clamping is arithmetic over three
// numbers, and it is the arithmetic that decides how much of the host a channel
// can take, so it is worth testing where every developer runs it.

import { describe, it } from "node:test";
import { expect } from "expect";
import type { SandboxCaps } from "@getlibero/schema";
import type { ContainerSpec, DockerClient } from "./docker.js";
import { clampCaps, runInSandbox, sandboxTmpfsBytes } from "./run.js";

const ASKED: SandboxCaps = { cpus: 4, memoryMb: 4096, timeoutSeconds: 300 };

describe("clamping a sheet's caps to what the deployment allows", () => {
  // The supported deployment and today's behaviour: an operator who has set no
  // ceiling gets exactly what their sheets ask for.
  it("returns the caps untouched when there is no ceiling", () => {
    expect(clampCaps(ASKED, undefined)).toEqual(ASKED);
    expect(clampCaps(ASKED, {})).toEqual(ASKED);
  });

  it("takes the deployment's number when the sheet asks for more", () => {
    expect(clampCaps(ASKED, { memoryMb: 512 })).toEqual({ ...ASKED, memoryMb: 512 });
  });

  // The direction that makes this a ceiling rather than a setting: a sheet
  // asking for less than the deployment allows keeps its own number, because
  // the operator's bound is a maximum and not a size.
  it("leaves a sheet that asks for less alone", () => {
    expect(clampCaps(ASKED, { memoryMb: 65_536, cpus: 64, timeoutSeconds: 3_600 })).toEqual(ASKED);
  });

  // Per field rather than "take the ceiling if any field exceeds it", so a
  // sheet asking for a lot of memory and a little cpu keeps its little cpu.
  it("clamps each field independently", () => {
    expect(clampCaps(ASKED, { cpus: 1, memoryMb: 65_536 })).toEqual({ ...ASKED, cpus: 1 });
  });

  it("clamps all three at once", () => {
    expect(clampCaps(ASKED, { cpus: 0.5, memoryMb: 256, timeoutSeconds: 30 })).toEqual({
      cpus: 0.5,
      memoryMb: 256,
      timeoutSeconds: 30
    });
  });

  it("keeps a fractional cpu ceiling, which is a real answer to the runtime", () => {
    expect(clampCaps(ASKED, { cpus: 0.25 }).cpus).toBe(0.25);
  });

  // The tmpfs is sized from the memory cap, so `memory_mb = 65536` asks for 64
  // GB of RAM *and* 64 GB of scratch. Clamping before the spec is built is what
  // makes the ceiling bound both, and this pins that they cannot drift apart.
  it("bounds the scratch space with the memory it is derived from", () => {
    const applied = clampCaps(ASKED, { memoryMb: 512 });
    expect(sandboxTmpfsBytes(applied.memoryMb)).toBe(512 * 1024 * 1024);
    expect(sandboxTmpfsBytes(applied.memoryMb)).toBeLessThan(sandboxTmpfsBytes(ASKED.memoryMb));
  });

  // A run is clamped or it is not, and the caller decides by comparing. An
  // equal-valued ceiling must not read as a clamp, or every run on a deployment
  // whose ceiling matches its sheets would carry a notice saying nothing.
  it("returns caps equal to what was asked when the ceiling is exactly the ask", () => {
    expect(clampCaps(ASKED, { cpus: 4, memoryMb: 4096, timeoutSeconds: 300 })).toEqual(ASKED);
  });
});

/**
 * A daemon that records specs and answers success, and nothing more.
 *
 * Enough for the one thing the arithmetic above cannot prove on its own: that
 * the clamped number is what reaches the spec. No network methods, because a
 * run with no `[egress]` grant builds no hop and creates no network — which is
 * itself worth the fake being unable to do it.
 */
function recordingDocker(): { docker: DockerClient; specs: ContainerSpec[] } {
  const specs: ContainerSpec[] = [];
  const docker = {
    async create(spec: ContainerSpec) {
      specs.push(spec);
      return { id: `c${specs.length}` };
    },
    async start() {},
    async wait() {
      return 0;
    },
    async kill() {},
    async logs() {
      return { stdout: "", stderr: "", truncated: false };
    },
    async remove() {},
    async ping() {},
    async createNetwork(): Promise<string> {
      throw new Error("no network should be created for a run with no egress grant");
    },
    async connectNetwork() {
      throw new Error("unreachable");
    },
    async removeNetwork() {},
    followLogs() {
      return { stop() {} };
    }
  } satisfies DockerClient;
  return { docker, specs };
}

const CEILING = { cpus: 1, memoryMb: 256, timeoutSeconds: 30 };

const runWith = async (ceiling: typeof CEILING | undefined, onCapsClamped?: (a: SandboxCaps, b: SandboxCaps) => void) => {
  const { docker, specs } = recordingDocker();
  const result = await runInSandbox(
    { code: "print(1)", caps: ASKED, egressAllow: [] },
    {
      docker,
      config: { image: "img@sha256:x", command: ["python3", "-c"], ...(ceiling === undefined ? {} : { ceiling }) },
      ...(onCapsClamped === undefined ? {} : { onCapsClamped }),
      newRunId: () => "run-1"
    }
  );
  return { result, spec: specs[0] };
};

// The claim `clampCaps` cannot make on its own: nothing downstream re-reads
// `request.caps`. A spec, a tmpfs or a wall-time wait sized from what the sheet
// asked for would make the ceiling a number in a log line and nowhere else.
describe("a run under a ceiling", () => {
  it("sizes the container from the clamped caps, not the requested ones", async () => {
    const { spec } = await runWith(CEILING);
    expect(spec?.memory).toBe(256 * 1024 * 1024);
    expect(spec?.nanoCpus).toBe(1_000_000_000);
  });

  // The tmpfs is derived from the memory cap, so a ceiling that bounded one and
  // not the other would hand out scratch space the cgroup cannot account for.
  it("sizes the scratch space from the clamped memory too", async () => {
    const { spec } = await runWith(CEILING);
    expect(spec?.tmpfsSize).toBe(256 * 1024 * 1024);
  });

  it("reports what was applied, with both numbers, to the operator", async () => {
    const seen: Array<[SandboxCaps, SandboxCaps]> = [];
    await runWith(CEILING, (asked, applied) => seen.push([asked, applied]));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual(ASKED);
    expect(seen[0]?.[1]).toEqual(CEILING);
  });

  // The channel's half. Null on an unclamped run so the proxy has a field that
  // says "this was sized down" rather than two objects to diff.
  it("reports what was applied to the channel, and nothing when nothing was", async () => {
    expect((await runWith(CEILING)).result.appliedCaps).toEqual(CEILING);
    expect((await runWith(undefined)).result.appliedCaps).toBeNull();
  });

  it("tells nobody when the ceiling clamped nothing", async () => {
    const seen: SandboxCaps[] = [];
    await runWith({ cpus: 64, memoryMb: 65_536, timeoutSeconds: 3_600 }, (_, applied) => seen.push(applied));
    expect(seen).toHaveLength(0);
  });

  // A clamped run is still a run. Spelling it as anything else would put a
  // configuration mismatch between two files one operator wrote into the set of
  // governance decisions the channel is told about.
  it("still completes", async () => {
    expect((await runWith(CEILING)).result.outcome).toBe("completed");
  });
});
