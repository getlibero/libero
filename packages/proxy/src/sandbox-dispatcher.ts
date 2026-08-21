// The arm that serves `run_code` by asking the runner (#395).
//
// **This module holds no credential, and that is enforced rather than promised**
// — `eslint.config.mjs` blocks it from importing ./vault.js, ./token-store.js
// and ./grant-flow.js by name. The runner it talks to holds the Docker socket,
// which is equivalent to root on the host; the whole shape of #393's decision is
// that the process with that privilege and the process with the credentials are
// different ones. An import edge from here to the vault would not break that,
// but it is the first step of the drift that would, and it costs nothing to
// forbid now.
//
// The transport is `node:https` directly, for the reason
// packages/agent/src/proxy/transport.ts gives about itself and this package's
// server gives about itself: an HTTP client dependency here is a package with a
// view of every sandbox run the deployment makes, inside the process holding
// every tool credential.
//
// ## What comes back, and what it is called
//
// A run that ends on its own is `ran` — including one that exits non-zero, which
// is a program that failed rather than a governance decision or a broken proxy.
// A run killed at its wall-time cap is also `ran`: #395 is explicit that a
// timeout is not a refusal and not a `ProxyError`, because the request *was*
// served and what it printed before the kill is a real answer.
//
// The only `unavailable` here is a runner this deployment cannot reach, which is
// the same 501 an unbuilt upstream gives and says the same thing: the sheet is
// right and the deployment is not finished.
//
// There is deliberately no `refused` arm yet. The refusal this surface will grow
// is `egress_denied` (#219), when a run reaching a host the sheet does not allow
// ends the run — and that one *is* a governance decision. Adding it now, with no
// hop to produce it, would be a branch nothing can reach.

import { Agent, request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { SandboxRunResult, type SandboxCaps } from "@getlibero/schema";
import type { Dispatch, SandboxDispatcher } from "./dispatch.js";
import type { Logger } from "./log.js";

/**
 * The most the runner's reply may be.
 *
 * The runner bounds a container's output at a megabyte before it builds this
 * reply, so anything past this is a runner that is not the one we think it is.
 * Bounded here anyway, because "the other end promised" is not a bound.
 */
const MAX_REPLY_BYTES = 4_194_304;

/**
 * How long to wait beyond the run's own wall-time cap.
 *
 * The cap is enforced by the runner, which holds the container. This is the
 * allowance for everything around it — creating, starting, reading the logs back
 * and removing — so that a slow daemon shows up as a slow call rather than as a
 * client that hung up on a run still in progress. A client timeout below the
 * server's own cap would abandon containers.
 */
const OVERHEAD_MS = 30_000;

export interface SandboxDispatcherOptions {
  /** `https://runner:8444`, from the composition. */
  readonly url: string;
  readonly tls: { readonly cert: string; readonly key: string; readonly ca: string };
  readonly logger: Logger;
}

const ran = (content: string): Dispatch => ({ outcome: "ran", result: { content, isError: false } });

export function createSandboxDispatcher(options: SandboxDispatcherOptions): SandboxDispatcher {
  const target = new URL(options.url);
  if (target.protocol !== "https:") {
    // At construction, not per call. A plaintext runner url is a deployment
    // mistake that should stop the process rather than send code somewhere
    // unauthenticated once a channel happens to use the tool.
    throw new Error(`proxy: RUNNER_URL must be https, and was ${options.url}`);
  }

  // One agent for the lifetime of the process. Unlike the agent's client, this
  // end has no per-channel material and no rotation to follow: the proxy
  // presents one client certificate to one runner, so there is nothing to
  // re-read per request.
  const agent = new Agent({
    cert: readFileSync(options.tls.cert),
    key: readFileSync(options.tls.key),
    ca: readFileSync(options.tls.ca),
    keepAlive: true,
    minVersion: "TLSv1.3"
  });

  return {
    async run(call, grant, limits) {
      const caps: SandboxCaps = grant.caps;
      const body = Buffer.from(
        JSON.stringify({ code: codeOf(call), caps, egressAllow: [...grant.egressAllow] }),
        "utf8"
      );

      let reply: { status: number; body: string };
      try {
        reply = await post(agent, target, body, caps.timeoutSeconds * 1000 + OVERHEAD_MS);
      } catch (error) {
        // A reason code, never a message: a TLS error can carry a path, and this
        // is the process where that matters most.
        options.logger.log("error", { event: "runner_unreachable", channel: call.channel, reason: reasonOf(error) });
        return { outcome: "unavailable", reason: "runner_unreachable" };
      }

      if (reply.status !== 200) {
        options.logger.log("error", { event: "runner_refused", channel: call.channel, status: reply.status });
        return { outcome: "unavailable", reason: "runner_error" };
      }

      const parsed = SandboxRunResult.safeParse(JSON.parse(reply.body));
      if (!parsed.success) {
        // Two builds disagreeing about the shape. `unavailable` rather than a
        // throw, because a 501 tells an operator the deployment is inconsistent
        // where a 500 says only that something broke.
        options.logger.log("error", { event: "runner_reply_invalid", channel: call.channel });
        return { outcome: "unavailable", reason: "runner_error" };
      }

      // The one outcome that is a governance decision rather than a fact about
      // resources, and the only one that becomes a refusal (#219). A completed
      // run and a timed-out one are both `ran`: the request was served, and what
      // the program printed is a real answer. A denied destination is the sheet
      // saying no, and it reaches the channel and the audit log as such.
      const result = parsed.data;
      if (result.outcome === "egress_denied" && result.deniedHost !== null) {
        options.logger.log("warn", {
          event: "egress_denied",
          channel: call.channel,
          destination: result.deniedHost
        });
        return { outcome: "refused", refusal: { reason: "egress_denied", destination: result.deniedHost } };
      }

      return ran(render(result, limits.maxResultChars));
    }
  };
}

/**
 * The code the model wrote.
 *
 * `arguments` is parsed on the *runner's* side against the same schema, and it
 * is bounded on this side by `RunCodeArguments` in ./builtins.ts before a call
 * ever gets here. This reads the field and does not re-validate it, for the
 * reason ./builtin-dispatcher.ts parses at its own edge: the parse belongs where
 * the error result is constructed, and by here the decision has been made.
 */
function codeOf(call: { readonly arguments: Record<string, unknown> }): string {
  const code = call.arguments["code"];
  return typeof code === "string" ? code : "";
}

/**
 * The two streams and the exit, as the model sees them.
 *
 * Labelled rather than concatenated, because a program that printed an answer on
 * stdout and a deprecation warning on stderr should not make the model guess
 * which was which — and an empty stream is said to be empty rather than omitted,
 * so "it printed nothing" and "I did not tell you" are different sentences.
 *
 * The bound is the channel's `max_result_chars`, applied here rather than in the
 * runner, because it is the channel's number and the runner has never heard of
 * channels. Truncation says what was dropped, per #151.
 */
export function render(result: SandboxRunResult, maxChars: number): string {
  const head =
    result.outcome === "timed_out"
      ? "The run was stopped at its time limit. Output up to that point:"
      : `The program exited with status ${result.exitCode ?? "unknown"}.`;

  const parts = [head, `stdout:\n${result.stdout === "" ? "(empty)" : result.stdout}`, `stderr:\n${result.stderr === "" ? "(empty)" : result.stderr}`];
  if (result.truncated) parts.push("(the runner's own output limit cut this before the channel's did)");

  const whole = parts.join("\n\n");
  if (whole.length <= maxChars) return whole;
  const notice = `\n[result truncated: ${maxChars} of ${whole.length} characters]`;
  return whole.slice(0, maxChars) + notice;
}

function post(agent: Agent, target: URL, body: Buffer, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        agent,
        host: target.hostname,
        port: target.port === "" ? 443 : Number(target.port),
        path: "/v1/run",
        method: "POST",
        timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": body.length }
      },
      res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REPLY_BYTES) {
            res.destroy();
            reject(new Error("runner reply too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("runner timed out"));
    });
    req.write(body);
    req.end();
  });
}

/** An errno or an error name, and never a message. */
function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown";
}
