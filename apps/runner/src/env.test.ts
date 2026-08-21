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
  sandboxImageFromEnv
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
