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
import { createSemaphore } from "./semaphore.js";

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

/**
 * How many `run_code` calls the deployment will have in flight at once (#405).
 *
 * **The bound that makes the sandbox's cost computable**, and until this landed
 * there was none. `PROXY_MAX_UPSTREAM_CONCURRENCY` bounds the MCP pool and has
 * never bounded a built-in; each run here is *two* containers — the sandbox and
 * its per-run egress hop — plus an ephemeral network, against a deployment guide
 * whose stated minimum is 2 vCPU and 2 GB. Unbounded N against that host is a
 * channel exhausting the machine without exceeding any limit it was given.
 *
 * **Two, and far below `DEFAULT_UPSTREAM_CONCURRENCY`'s eight**, because the
 * units are not comparable: that number counts sockets and this one counts
 * containers with a memory cgroup each. What bounds the memory is the product
 * of this and the runner's `RUNNER_MAX_MEMORY_MB`, so the two have to be chosen
 * together — which is why `deploy/docker-compose.yml` ships *one* beside a
 * ceiling of 2048 MB rather than this default beside it. This is what to do
 * when a composition has said nothing at all.
 *
 * **Per deployment and not per channel.** The thing being protected is the host,
 * which is a property of the sum rather than of any one channel, and the
 * semaphore's FIFO queue is what stops a busy channel jumping ahead of a quiet
 * one. A per-channel bound is a second number with nothing behind it yet; it is
 * a real thing to want under contention and is not this.
 */
export const DEFAULT_SANDBOX_CONCURRENCY = 2;

/**
 * How long a call waits for a permit before giving up.
 *
 * A constant rather than a second environment variable, on the argument
 * `QUEUE_WAIT_MS` makes about itself in ./mcp-pool.ts: the operator's decision
 * is how many runs their host tolerates, and how long this process holds one
 * waiting is a consequence of numbers that are not theirs.
 *
 * **Ten seconds, twice the MCP pool's five, because what is ahead in the queue
 * is different.** A queued MCP call waits behind a request; a queued run waits
 * behind a *container*, which has a wall-time cap of its own and a create-start-
 * teardown cycle around it. Five seconds would expire against a run ahead that
 * was always going to finish, which is the case a queue exists for.
 *
 * It is not sized against the whole run budget for the reason #253 names: the
 * wait and the call it is for must not stack, so `run` spends this out of the
 * call's budget rather than beside it.
 */
export const SANDBOX_QUEUE_WAIT_MS = 10_000;

export interface SandboxDispatcherOptions {
  /** `https://runner:8444`, from the composition. */
  readonly url: string;
  readonly tls: { readonly cert: string; readonly key: string; readonly ca: string };
  readonly logger: Logger;
  /**
   * Runs in flight at once. Absent means `DEFAULT_SANDBOX_CONCURRENCY`.
   *
   * The gate is here rather than in the runner for three reasons, and the third
   * is the one that matters. `createSemaphore` is already in this package, and a
   * runner-side copy would be a duplication with somewhere else to go. The
   * runner has no idea which channel a run is for and must not — a channel id on
   * `SandboxRunRequest` is the shape CLAUDE.md forbids — so a gate there could
   * never grow a per-channel bound. And enforcement lives in the proxy by
   * invariant. What makes a bound here a real one rather than advice is that the
   * runner pins exactly one peer, so this process is the only caller there is.
   */
  readonly maxConcurrency?: number;
  /** How long a call queues. Injected only so a test can shorten it. */
  readonly queueWaitMs?: number;
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

  const limiter = createSemaphore(options.maxConcurrency ?? DEFAULT_SANDBOX_CONCURRENCY);
  const queueWaitMs = options.queueWaitMs ?? SANDBOX_QUEUE_WAIT_MS;

  return {
    async run(call, grant, limits) {
      const caps: SandboxCaps = grant.caps;
      const body = Buffer.from(
        JSON.stringify({ code: codeOf(call), caps, egressAllow: [...grant.egressAllow] }),
        "utf8"
      );

      // **One budget for the wait and the call it is for**, which is #253's fix
      // applied at the point the second stacking would have been introduced.
      // The whole allowance is the run's wall-time cap plus the overhead around
      // it; queueing spends out of that rather than beside it, so a call that
      // waited nine seconds gets what is left instead of a fresh full budget on
      // top. Doing it the other way would widen the window where the agent has
      // already hung up on a run still holding a container.
      const budgetMs = caps.timeoutSeconds * 1000 + OVERHEAD_MS;
      const waitStarted = Date.now();
      const permit = await limiter.acquire(Math.min(queueWaitMs, budgetMs));
      if (permit === null) {
        // Not a refusal. Nothing about the channel's grant changed — the
        // deployment is full — so this is the same 501 an unreachable runner
        // gets, with its own sentence. Spelling it as a `ToolRefusal` would put
        // a resource fact into a closed set of governance decisions.
        options.logger.log("warn", { event: "runner_busy", channel: call.channel, waiting: limiter.waiting });
        return { outcome: "unavailable", reason: "runner_busy" };
      }
      const remainingMs = Math.max(1, budgetMs - (Date.now() - waitStarted));

      try {
        let reply: { status: number; body: string };
        try {
          reply = await post(agent, target, body, remainingMs);
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

        return ran(render(result, limits.maxResultChars, caps));
      } finally {
        permit.release();
      }
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
export function render(result: SandboxRunResult, maxChars: number, asked: SandboxCaps): string {
  const head =
    result.outcome === "timed_out"
      ? "The run was stopped at its time limit. Output up to that point:"
      : `The program exited with status ${result.exitCode ?? "unknown"}.`;

  const parts = [head];
  // Second, ahead of the output, because it is what explains the output. The
  // case this exists for is a program the OOM reaper killed at a limit its
  // channel was never configured for, and a note after two streams of stderr is
  // a note read too late.
  const clamped = clampNotice(result.appliedCaps, asked);
  if (clamped !== null) parts.push(clamped);
  parts.push(`stdout:\n${result.stdout === "" ? "(empty)" : result.stdout}`, `stderr:\n${result.stderr === "" ? "(empty)" : result.stderr}`);
  if (result.truncated) parts.push("(the runner's own output limit cut this before the channel's did)");

  const whole = parts.join("\n\n");
  if (whole.length <= maxChars) return whole;
  const notice = `\n[result truncated: ${maxChars} of ${whole.length} characters]`;
  return whole.slice(0, maxChars) + notice;
}

/**
 * What the deployment's ceiling took away, in the sheet's own field names.
 *
 * `null` when nothing was clamped, which is every run on a deployment whose
 * ceiling is above its sheets — so the ordinary result gains no line at all.
 *
 * Both numbers, and the sheet's spelling rather than the wire's: the reader who
 * can act on this is looking at a `[[builtin]]` block that says `memory_mb`, and
 * a sentence naming `memoryMb` would be naming a field they cannot find. Only
 * the fields that actually differ, because listing the two that were honoured
 * beside the one that was not is how a note becomes noise.
 *
 * It says the deployment did this, not that the channel asked for too much.
 * The sheet is not wrong — it is a grant an operator wrote, bounded by a limit
 * the same operator set — and a sentence blaming the channel would send the
 * reader to edit the wrong file.
 */
function clampNotice(applied: SandboxCaps | null, asked: SandboxCaps): string | null {
  if (applied === null) return null;
  const fields: string[] = [];
  if (applied.cpus !== asked.cpus) fields.push(`cpus ${asked.cpus} to ${applied.cpus}`);
  if (applied.memoryMb !== asked.memoryMb) fields.push(`memory_mb ${asked.memoryMb} to ${applied.memoryMb}`);
  if (applied.timeoutSeconds !== asked.timeoutSeconds) {
    fields.push(`timeout_seconds ${asked.timeoutSeconds} to ${applied.timeoutSeconds}`);
  }
  // Defensive: a runner that set `appliedCaps` to the caps it was handed. Not
  // reachable from the runner in this repository, and the alternative is a
  // sentence that names no field at all.
  if (fields.length === 0) return null;
  return `This deployment's limits sized the run below what the channel is configured for: ${fields.join(", ")}.`;
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
