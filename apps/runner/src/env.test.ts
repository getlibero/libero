import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  clientPinFromEnv,
  dockerSocketFromEnv,
  hostFromEnv,
  portFromEnv,
  requiredEnv,
  sandboxCommandFromEnv,
  sandboxImageFromEnv,
  sandboxCeilingFromEnv,
  ceilingIsEmpty
} from "./env.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PIN = "b".repeat(64);

describe("required values", () => {
  it("treats an empty string as absent", () => {
    // A compose file carrying `RUNNER_SANDBOX_IMAGE=` has not set an image, and
    // reading it as one starts a process that fails at the first call instead
    // of at boot.
    expect(() => requiredEnv({ X: "" }, "X")).toThrow(/X is required/);
    expect(() => requiredEnv({}, "X")).toThrow(/X is required/);
  });

  it("names the variable, because the message is the whole of the fix", () => {
    expect(() => dockerSocketFromEnv({})).toThrow(/RUNNER_DOCKER_SOCKET/);
  });
});

describe("the sandbox image", () => {
  it("takes one pinned by digest", () => {
    expect(sandboxImageFromEnv({ RUNNER_SANDBOX_IMAGE: `python:3.13-alpine@${DIGEST}` })).toBe(
      `python:3.13-alpine@${DIGEST}`
    );
  });

  // #393 decided the image is a deployment fact. A floating tag makes it a fact
  // about whenever the daemon last pulled, which is not reviewable and is not
  // the same image twice.
  it("refuses a floating tag", () => {
    expect(() => sandboxImageFromEnv({ RUNNER_SANDBOX_IMAGE: "python:3.13-alpine" })).toThrow(/pinned by digest/);
    expect(() => sandboxImageFromEnv({ RUNNER_SANDBOX_IMAGE: "python" })).toThrow(/pinned by digest/);
  });

  it("refuses a digest that is not one", () => {
    expect(() => sandboxImageFromEnv({ RUNNER_SANDBOX_IMAGE: "python@sha256:short" })).toThrow(/pinned by digest/);
  });
});

describe("the sandbox command", () => {
  it("takes a JSON array", () => {
    expect(sandboxCommandFromEnv({ RUNNER_SANDBOX_COMMAND: '["python3","-c"]' })).toEqual(["python3", "-c"]);
  });

  // The reason it is JSON rather than a string to split: a flag containing a
  // space is one flag, and splitting makes it two.
  it("keeps a flag containing a space whole", () => {
    expect(sandboxCommandFromEnv({ RUNNER_SANDBOX_COMMAND: '["sh","-c","set -e; exec python3 -c"]' })).toEqual([
      "sh",
      "-c",
      "set -e; exec python3 -c"
    ]);
  });

  each([["notjson"], ["{}"], ["[]"], ['["ok",""]'], ['["ok",3]']])("refuses %s", raw => {
    expect(() => sandboxCommandFromEnv({ RUNNER_SANDBOX_COMMAND: raw })).toThrow();
  });
});

describe("the client pin", () => {
  it("takes either spelling openssl prints", () => {
    const colons = PIN.replace(/(.{2})(?=.)/g, "$1:").toUpperCase();
    expect(clientPinFromEnv({ RUNNER_CLIENT_PIN: PIN })).toBe(PIN);
    expect(clientPinFromEnv({ RUNNER_CLIENT_PIN: colons })).toBe(PIN);
  });

  // Required with no "any peer this CA signed" fallback, because that fallback
  // is the hole: the agent holds certificates the same CA signed, so a runner
  // trusting the CA alone would serve a compromised agent process directly.
  it("is required", () => {
    expect(() => clientPinFromEnv({})).toThrow(/RUNNER_CLIENT_PIN is required/);
  });

  it("refuses something that is not a sha256 fingerprint", () => {
    expect(() => clientPinFromEnv({ RUNNER_CLIENT_PIN: "nope" })).toThrow(/not a sha256 fingerprint/);
  });
});

describe("host and port", () => {
  it("falls back on an empty host, because Node reads one as every interface", () => {
    expect(hostFromEnv({ RUNNER_HOST: "" })).toBe("127.0.0.1");
    expect(hostFromEnv({})).toBe("127.0.0.1");
  });

  it("allows port 0, which is how a harness asks for a free one", () => {
    expect(portFromEnv({ RUNNER_PORT: "0" })).toBe(0);
  });

  each([["-1"], ["70000"], ["8443.5"], ["http"]])("refuses %s", raw => {
    expect(() => portFromEnv({ RUNNER_PORT: raw })).toThrow(/not a port number/);
  });
});

// The operator's ceiling over what any sheet may ask for (#405).
describe("the deployment ceiling", () => {
  // The one place this file's "required with no default" rule does not apply,
  // and the argument is that the two failure modes differ: a missing socket is
  // a deployment that cannot work, and a missing ceiling is one that works
  // exactly as it did before this landed. Defaulting one in would silently
  // shrink runs on every deployment whose sheets ask for more.
  it("bounds nothing when nothing is set", () => {
    const ceiling = sandboxCeilingFromEnv({});
    expect(ceiling).toEqual({});
    expect(ceilingIsEmpty(ceiling)).toBe(true);
  });

  it("treats an empty string as absent, as every other value here does", () => {
    expect(sandboxCeilingFromEnv({ RUNNER_MAX_CPUS: "", RUNNER_MAX_MEMORY_MB: "" })).toEqual({});
  });

  it("reads the three", () => {
    expect(
      sandboxCeilingFromEnv({
        RUNNER_MAX_CPUS: "1.5",
        RUNNER_MAX_MEMORY_MB: "2048",
        RUNNER_MAX_TIMEOUT_SECONDS: "300"
      })
    ).toEqual({ cpus: 1.5, memoryMb: 2048, timeoutSeconds: 300 });
  });

  // Each is independent: an operator who cares about memory and not about cpu
  // should not have to invent a number for the other two.
  it("takes one without the others", () => {
    const ceiling = sandboxCeilingFromEnv({ RUNNER_MAX_MEMORY_MB: "1024" });
    expect(ceiling).toEqual({ memoryMb: 1024 });
    expect(ceilingIsEmpty(ceiling)).toBe(false);
  });

  // `cpus` is fractional because the runtime's own limit is — `--cpus=0.5` is a
  // real answer — and the other two are whole for the reason the sheet's are:
  // half a megabyte and half a second are not units anybody means.
  it("allows a fractional cpu ceiling and refuses a fractional byte or second", () => {
    expect(sandboxCeilingFromEnv({ RUNNER_MAX_CPUS: "0.5" })).toEqual({ cpus: 0.5 });
    expect(() => sandboxCeilingFromEnv({ RUNNER_MAX_MEMORY_MB: "512.5" })).toThrow(/not a positive whole number/);
    expect(() => sandboxCeilingFromEnv({ RUNNER_MAX_TIMEOUT_SECONDS: "1.5" })).toThrow(/not a positive whole number/);
  });

  // Zero is an operator trying to say something, and it is not what ignoring it
  // would do — a ceiling of zero clamps every run to nothing.
  each([["0"], ["-1"], ["none"], ["unlimited"]])("refuses RUNNER_MAX_MEMORY_MB=%s", raw => {
    expect(() => sandboxCeilingFromEnv({ RUNNER_MAX_MEMORY_MB: raw })).toThrow(/RUNNER_MAX_MEMORY_MB/);
  });

  each([["0"], ["-0.5"], ["lots"]])("refuses RUNNER_MAX_CPUS=%s", raw => {
    expect(() => sandboxCeilingFromEnv({ RUNNER_MAX_CPUS: raw })).toThrow(/RUNNER_MAX_CPUS is not a positive number/);
  });

  // Deliberately not checked against `SandboxCaps`'s own maxima: a ceiling above
  // them clamps nothing and is harmless, and refusing it would be this file
  // having an opinion about a number that only ever makes a run smaller.
  it("accepts a ceiling above what any sheet could ask for", () => {
    expect(sandboxCeilingFromEnv({ RUNNER_MAX_MEMORY_MB: "999999" })).toEqual({ memoryMb: 999_999 });
  });
});
