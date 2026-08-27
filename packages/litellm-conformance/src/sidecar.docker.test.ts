// Does the agent's completion and embedding path survive a real LiteLLM
// sidecar? (#480, part of #428.)
//
// `packages/agent`'s own conformance suites answer that against fixtures, which
// is the right instrument for "does the adapter map this envelope correctly"
// and the wrong one for "is this the envelope LiteLLM sends". A fixture is a
// claim about a third party's wire format, and the third party is the one that
// changes it. So these cases start the image `deploy/docker-compose.yml` runs,
// point the real adapters at it, and read what comes back.
//
// ## What is faked, and what deliberately is not
//
// **The sidecar is real. The upstream behind it is not.** A real completion
// needs a provider key, and a suite that needs one runs nowhere — not on a
// contributor's laptop, not on a fork's CI, and not without putting a
// credential where a test can reach it. So the upstream is a local HTTP server
// speaking Anthropic's and OpenAI's response shapes, and LiteLLM is left to do
// the one job under test: translate that into an OpenAI-compatible envelope.
//
// That is not a weakened claim, because the fake is on the far side of the
// thing being tested. The question is what LiteLLM emits given known upstream
// counts, and knowing them exactly is what makes the assertion sharp: an
// upstream reporting 11 fresh, 7 read and 13 written is a fact this file
// chooses, so `prompt_tokens: 31` is a measurement rather than a coincidence.
//
// **The Anthropic dialect, not the OpenAI one**, for the upstream. It is the
// only one of the two that reports all four token tiers, and the four tiers are
// the whole of #480.
//
// ## The gate
//
// Two-sided, in `apps/runner/src/sandbox.docker.test.ts`'s words and for its
// reason. No daemon and not CI: skipped, so `pnpm test` works for a contributor
// without Docker. No daemon and `CI=true`: thrown at module load, so the file
// fails rather than reporting green on a runner that lost its socket.
//
// Probed synchronously at module load rather than in `beforeAll`, because
// `describe`'s `skip` option is read when the file is collected — the mistake
// that file records having made, not repeated here.
//
// ## Which CI job runs this
//
// `sandbox`, beside `@getlibero/runner`. That is the third daemon-gated package
// and the first time two share a job, so it is a decision rather than a default:
// `ci-partition.test.ts` requires only that a daemon-gated suite never runs
// beside a suite that is not, and the reason `e2e` and `sandbox` are apart is
// specific rather than general — `sandbox.docker.test.ts` asserts that nothing
// on the daemon descends from `python:3.13-alpine` while `sandbox-attack.test.ts`
// keeps a container running on exactly that image. Both of its leak assertions
// are filtered — `ancestor=python:3.13-alpine` and `name=libero-hop-` — and a
// LiteLLM container matches neither, which is why the containers below are
// named `libero-litellm-*` and never `libero-hop-*`. A job of its own would
// have cost a fourth runner to avoid a collision that does not exist.

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "expect";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createCompletionClient, createEmbeddingClient } from "@getlibero/agent";

/**
 * The image, by the tag `deploy/docker-compose.yml` runs.
 *
 * A tag rather than a digest, for `sandbox.docker.test.ts`'s reason: pinning
 * would make this file name a published layer and stop working when that layer
 * is collected, to prove nothing these cases are about. What matters is that it
 * is the same string the deployment uses — testing a version nobody runs would
 * answer a question nobody asked.
 */
const IMAGE = "ghcr.io/berriai/litellm:main-stable";

/** The one key, the way the compose file wires it: the agent's is the sidecar's. */
const MASTER_KEY = "sk-litellm-conformance-not-a-credential";

/** Counts the upstream reports, chosen so every tier is a distinct number. */
const UPSTREAM = { input: 11, output: 2, cacheRead: 7, cacheWrite: 13 } as const;

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
  // Thrown at import, so the file fails rather than skipping. This wording is
  // shared with the other two-sided gates on purpose: `ci-partition.test.ts`
  // greps for it to learn which packages need a daemon, so a suite that gates
  // differently would be invisible to the check that keeps it in the right job.
  throw new Error(
    `litellm-conformance: CI=true and no Docker socket at ${socketPath}. These cases are #480's acceptance and must not be skipped in CI.`
  );
}

/**
 * The upstream LiteLLM talks to, speaking two dialects on one port.
 *
 * `/v1/messages` answers Anthropic's shape, which is the one carrying all four
 * token tiers; `/v1/embeddings` answers OpenAI's. One server rather than two
 * because what matters is the port LiteLLM was told to dial, and a second would
 * be a second thing to tear down.
 */
function startUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => void (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if ((request.url ?? "").includes("embeddings")) {
        response.end(
          JSON.stringify({
            object: "list",
            model: "upstream-embedding",
            data: [{ object: "embedding", index: 0, embedding: [0.25, 0.5, 0.75, 1] }],
            usage: { prompt_tokens: 9, total_tokens: 9 }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "msg_conformance",
          type: "message",
          role: "assistant",
          model: "upstream-completion",
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: UPSTREAM.input,
            output_tokens: UPSTREAM.output,
            cache_read_input_tokens: UPSTREAM.cacheRead,
            cache_creation_input_tokens: UPSTREAM.cacheWrite
          }
        })
      );
    });
  });

  return new Promise(resolve => {
    // Port 0, and the host rather than loopback: the container reaches back
    // through `host.docker.internal`, so a server bound to 127.0.0.1 would be
    // unreachable from it.
    server.listen(0, "0.0.0.0", () =>
      resolve({ server, port: (server.address() as AddressInfo).port })
    );
  });
}

let container = "";
let upstream: Server | undefined;
let baseUrl = "";

beforeAll(async () => {
  const started = await startUpstream();
  upstream = started.server;

  const directory = mkdtempSync(join(tmpdir(), "litellm-conformance-"));
  const config = join(directory, "config.yaml");
  // The aliases are deliberately not the upstream model ids: #62's rule is that
  // a router resolves an alias and the *served* id is what gets priced, and the
  // cases below assert LiteLLM echoes the alias rather than what it dialled.
  writeFileSync(
    config,
    [
      "model_list:",
      "  - model_name: conformance-completion",
      "    litellm_params:",
      "      model: anthropic/claude-sonnet-4-6",
      "      api_key: not-a-credential",
      `      api_base: http://host.docker.internal:${started.port}`,
      "  - model_name: conformance-embedding",
      "    litellm_params:",
      "      model: openai/text-embedding-3-small",
      "      api_key: not-a-credential",
      `      api_base: http://host.docker.internal:${started.port}/v1`,
      "general_settings:",
      "  master_key: os.environ/LITELLM_MASTER_KEY",
      ""
    ].join("\n")
  );

  execFileSync("docker", ["pull", "--quiet", IMAGE], { stdio: "pipe", timeout: 300_000 });

  // `libero-litellm-`, never `libero-hop-`: the runner's leak assertion filters
  // on that second prefix and this must not be caught by it.
  const name = `libero-litellm-${randomUUID()}`;
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      name,
      // Published on an ephemeral host port rather than a fixed one, so two
      // runs on one daemon cannot collide.
      "--publish",
      "127.0.0.1::4000",
      // Docker Desktop resolves this itself; a Linux daemon needs telling, and
      // CI is Linux.
      "--add-host",
      "host.docker.internal:host-gateway",
      "--env",
      `LITELLM_MASTER_KEY=${MASTER_KEY}`,
      "--volume",
      `${config}:/app/config.yaml:ro`,
      IMAGE,
      "--config",
      "/app/config.yaml"
    ],
    { stdio: "pipe", timeout: 120_000 }
  );
  container = name;

  const mapped = execFileSync("docker", ["port", name, "4000/tcp"], { encoding: "utf8" })
    .trim()
    .split("\n")[0] as string;
  baseUrl = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(":") + 1)}/v1`;

  // Readiness is polled rather than slept on: the image loads its config in
  // about a second locally and a fixed sleep would be either flaky or slow.
  // `waitFor` is not used because its subject is the process, not a value —
  // and #474's lesson was that a longer timeout is not the fix for a race.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const probe = await fetch(`${baseUrl.slice(0, -3)}/health/liveliness`);
      if (probe.ok) break;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `litellm-conformance: ${IMAGE} did not answer /health/liveliness within 120s.\n` +
          execFileSync("docker", ["logs", "--tail", "40", name], { encoding: "utf8" })
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}, { timeout: 600_000 });

afterAll(() => {
  if (container !== "") execFileSync("docker", ["rm", "--force", container], { stdio: "pipe" });
  upstream?.close();
});

// The other side of the gate. `skip` is read at collection, which is why the
// probe above is synchronous — a flag set in `beforeAll` would still be false
// here, and the suite would skip in CI too.
//
// A skip the reporter would otherwise fail the run for: it is accounted for in
// `ALLOWED_SKIPS`, so a contributor without a daemon sees a named absence
// rather than a green tick over cases that did not run.
describe("a live LiteLLM sidecar, through the agent's own adapters", { skip: !socketPresent }, () => {
  it("carries the four token tiers disjointly through the envelope", { timeout: 60_000 }, async () => {
    const response = await createCompletionClient({
      provider: "openai-compatible",
      apiKey: MASTER_KEY,
      baseUrl
    }).complete({
      model: "conformance-completion",
      maxTokens: 64,
      messages: [{ role: "user", content: "ping" }]
    });

    // The assertion #480 exists for, and the whole object rather than the
    // fields this file thought to name: a count that goes missing is the
    // failure, and a per-field check cannot see one.
    //
    // Note what LiteLLM sends to produce this. Its `prompt_tokens` is the SUM —
    // 31 here, not 11 — because the OpenAI convention counts cache hits inside
    // the prompt total while `TokenUsage` keeps the tiers disjoint, the way
    // `costMicroUsd` prices them. If `toUsage` stopped converting, this case
    // would read 31 fresh input tokens and the meter would charge the cached
    // ones twice.
    expect(response.usage).toEqual({
      inputTokens: UPSTREAM.input,
      outputTokens: UPSTREAM.output,
      cacheReadInputTokens: UPSTREAM.cacheRead,
      cacheCreationInputTokens: UPSTREAM.cacheWrite
    });
    expect(response.text).toBe("pong");
    expect(response.stopReason).toBe("end_turn");
  });

  // #62 against the router it was written for. The alias is what the sheet asks
  // for and what LiteLLM echoes; `upstream-completion` is what it dialled, and
  // the proxy's price table is keyed by the former.
  it("reports the alias LiteLLM served, not the upstream model it resolved to", { timeout: 60_000 }, async () => {
    const response = await createCompletionClient({
      provider: "openai-compatible",
      apiKey: MASTER_KEY,
      baseUrl
    }).complete({
      model: "conformance-completion",
      maxTokens: 64,
      messages: [{ role: "user", content: "ping" }]
    });

    expect(response.model).toBe("conformance-completion");
  });

  it("embeds through the sidecar, reporting vectors, usage and the served alias", { timeout: 60_000 }, async () => {
    const response = await createEmbeddingClient({
      provider: "openai-compatible",
      apiKey: MASTER_KEY,
      baseUrl
    }).embed({ model: "conformance-embedding", texts: ["the vault ships friday"] });

    expect(response.vectors).toHaveLength(1);
    expect(response.vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(response.vectors[0] ?? [])).toEqual([0.25, 0.5, 0.75, 1]);
    // One tier, and no conversion to do: an embedding call has no cache tiers
    // and no output tokens, so `prompt_tokens` is already exclusive.
    expect(response.usage).toEqual({ inputTokens: 9 });
    expect(response.model).toBe("conformance-embedding");
  });

  // The master key is the only thing standing between the sidecar's provider
  // keys and anything that can reach it, and `deploy/docker-compose.yml` wires
  // it to the agent's own required variable on the strength of that. Asserted
  // here rather than trusted, against the same running container.
  it("refuses a caller that presents no key", { timeout: 60_000 }, async () => {
    const response = await fetch(`${baseUrl}/models`);

    expect(response.status).toBe(401);
  });
});
