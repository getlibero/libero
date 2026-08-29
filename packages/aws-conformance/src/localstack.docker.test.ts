// The custody contract against a real Secrets Manager implementation.
//
// `packages/proxy/src/custody-aws.test.ts` runs the same sixty-seven cases
// against a fake this repository wrote. This runs them against LocalStack, which
// is somebody else's reading of the same API — and that is the whole of why the
// package exists. #483 shipped the GCP backend with no independent
// implementation to check against and said so; AWS has one, so not using it
// would have been leaving proof on the table.
//
// ## What this proves that the fake does not, and what it still does not
//
// **Proves:** that the request shapes are ones an implementation other than
// ours accepts — the JSON body, the `X-Amz-Target`, the `Filters` spelling on
// `ListSecrets`, the staging-label dance `UpdateSecretVersionStage` needs, and
// `ForceDeleteWithoutRecovery`. A misreading of the API in
// `custody-aws-client.ts` that our own fake happily mirrored fails here.
//
// **Does not prove:** the signature. LocalStack accepts any well-formed
// `Authorization` header, so SigV4 is checked by the fake — which recomputes
// every signature — and by the differential cases in
// `custody-aws-client.test.ts`. Nor IAM, quotas, KMS, replication, or the
// recovery window this backend always bypasses. A real account remains the only
// place all of that is true at once, and nobody has run this against one.
//
// **IMDS is stubbed here**, because LocalStack does not emulate it: a twenty-line
// `node:http` server serving the three legs. That half is exercised against the
// fake instead, which does model IMDSv2's PUT-then-GET.
//
// ## The gate
//
// Two-sided, `packages/litellm-conformance/src/sidecar.docker.test.ts`'s and
// `apps/runner/src/sandbox.docker.test.ts`'s, worded alike on purpose:
// `ci-partition.test.ts` greps for the sentence to learn which packages need a
// daemon, so a suite that gated differently would be invisible to the check
// that keeps it in the right job.
//
// ## Which CI job runs this
//
// `sandbox`, as a third step after `@getlibero/runner` and
// `@getlibero/litellm-conformance`. The decision `ci-partition.test.ts` forces:
// the runner's two leak assertions are filtered by `ancestor=python:3.13-alpine`
// and by `name=libero-hop-`, and a LocalStack container matches neither — the
// containers below are named `libero-localstack-*`. A job of its own would buy
// a fourth runner to avoid a collision that does not exist.

import { after as afterAll, before as beforeAll, describe } from "node:test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openAwsCustody, openAwsVaultAdmin } from "@getlibero/proxy";
import type { Custody, Secret } from "@getlibero/proxy";
// A subpath rather than the barrel, `@getlibero/test-kit/reporter`'s shape and
// its reason: this module imports `node:test` and `expect`, and the barrel is
// loaded by the serving proxy.
import { runCustodyConformance } from "@getlibero/proxy/conformance";
import type { CustodyFixture } from "@getlibero/proxy/conformance";

/**
 * A tag rather than a digest, for `sandbox.docker.test.ts`'s reason: pinning
 * would make this file name a published layer and stop working when that layer
 * moves. The major is pinned because the API surface is what is under test.
 */
const IMAGE = "localstack/localstack:3";

/** LocalStack takes any credentials; these are the ones its own docs use. */
const ACCESS_KEY_ID = "test";
const SECRET_ACCESS_KEY = "test";
const REGION = "us-east-1";

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
  return (
    [
      "/var/run/docker.sock",
      `${home}/.orbstack/run/docker.sock`,
      `${home}/.docker/run/docker.sock`
    ].find(isSocket) ?? "/var/run/docker.sock"
  );
}

const socketPath = process.env["RUNNER_DOCKER_SOCKET"] ?? guessSocket();
const socketPresent = isSocket(socketPath);

if (inCi && !socketPresent) {
  throw new Error(
    `aws-conformance: CI=true and no Docker socket at ${socketPath}. These cases are #484's acceptance and must not be skipped in CI.`
  );
}

let container = "";
let endpoint = "";
/** Repointed by `sever`/`corrupt`; read afresh for every handle. */
let liveEndpoint = "";
let imds: Server | undefined;
let imdsUrl = "";

/** The three IMDSv2 legs, which LocalStack does not emulate. */
async function startImds(): Promise<{ server: Server; url: string }> {
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    const text = (status: number, body: string): void => {
      outgoing.writeHead(status, { "content-type": "text/plain" });
      outgoing.end(body);
    };
    if (path === "/latest/api/token") {
      text(200, "stub-imds-token");
      return;
    }
    if (incoming.headers["x-aws-ec2-metadata-token"] !== "stub-imds-token") {
      text(401, "unauthorized");
      return;
    }
    if (path === "/latest/meta-data/iam/security-credentials/") {
      text(200, "libero-proxy-role");
      return;
    }
    if (path === "/latest/meta-data/iam/security-credentials/libero-proxy-role") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(
        JSON.stringify({
          Code: "Success",
          AccessKeyId: ACCESS_KEY_ID,
          SecretAccessKey: SECRET_ACCESS_KEY,
          Expiration: new Date(Date.now() + 3_600_000).toISOString()
        })
      );
      return;
    }
    text(404, "not found");
  });
  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  if (!socketPresent) return;

  execFileSync("docker", ["pull", "--quiet", IMAGE], { stdio: "pipe", timeout: 600_000 });

  const name = `libero-localstack-${randomUUID().slice(0, 8)}`;
  container = execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--publish",
      "127.0.0.1:0:4566",
      "--env",
      "SERVICES=secretsmanager",
      "--env",
      "EAGER_SERVICE_LOADING=1",
      IMAGE
    ],
    { encoding: "utf8", timeout: 120_000 }
  ).trim();

  const mapped = execFileSync("docker", ["port", name, "4566/tcp"], { encoding: "utf8" })
    .split("\n")[0]
    ?.trim();
  endpoint = `http://127.0.0.1:${mapped?.slice(mapped.lastIndexOf(":") + 1) ?? "4566"}`;

  // LocalStack reports its own readiness; polling the health endpoint is what
  // its documentation says to do, and is cheaper than a fixed sleep that is
  // either too short on a cold runner or wasted on a warm one.
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/_localstack/health`);
      const body = (await response.json()) as { services?: Record<string, string> };
      if (body.services?.["secretsmanager"] === "available") break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `aws-conformance: localstack did not become ready. ${execFileSync(
          "docker",
          ["logs", "--tail", "40", name],
          { encoding: "utf8" }
        )}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }

  liveEndpoint = endpoint;
  const started = await startImds();
  imds = started.server;
  imdsUrl = started.url;
});

afterAll(() => {
  if (container !== "") {
    execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
  }
  imds?.close();
});

// The other side of the gate. `skip` is read at collection, which is why the
// probe above is synchronous. Accounted for in the reporter's `ALLOWED_SKIPS`,
// so a contributor without a daemon sees a named absence rather than a green
// tick over sixty-seven cases that did not run.
describe("localstack", { skip: !socketPresent }, () => {
  runCustodyConformance({
    name: "aws secrets manager (localstack)",

    reveal: (secret: Secret) => secret.reveal(),

    async open(deps = {}): Promise<CustodyFixture> {
      // A prefix per fixture: LocalStack is one account for the whole file, so
      // this is what keeps a case from seeing another's secrets.
      const prefix = `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      let reachable = liveEndpoint;
      const options = () => ({
        region: REGION,
        prefix,
        endpoints: { secretsManager: reachable, metadata: imdsUrl }
      });

      const opened: Custody[] = [];
      const stores = await openAwsCustody(options(), deps);
      const admin = await openAwsVaultAdmin(options());

      return {
        stores,
        admin,

        async reopen(): Promise<Custody> {
          const handle = await openAwsCustody(options(), deps);
          opened.push(handle);
          return handle;
        },

        failureWords: [
          "unreachable",
          "timed_out",
          "denied",
          "redirected",
          "too_large",
          "malformed_response"
        ],

        // A fresh handle points at a port nothing listens on; the open one must
        // keep answering from what it holds, which is the freshness clause.
        sever(): void {
          reachable = "http://127.0.0.1:1";
        },

        // Same move, and it yields `unreachable` where the fake yields
        // `malformed_response`. The conformance suite asks only that the word
        // is in this backend's set and maps into `CustodyFailure`, which both
        // do; the malformed path is exercised against the fake, where a
        // response body can be shaped at will.
        corrupt(): void {
          reachable = "http://127.0.0.1:1";
        },

        async dispose(): Promise<void> {
          for (const handle of opened) handle.close();
          stores.close();
          admin.close();
        }
      };
    }
  });
});
