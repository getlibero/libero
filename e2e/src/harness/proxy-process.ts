// The proxy, as a separate operating-system process.
//
// **This is the half that has to be spawned.** The security property the design
// hangs on is that tool credentials live only in the proxy, so the process
// boundary is what the leak assertions are about: with the vault in this
// process's heap, "the credential never reached the agent" would be a claim
// about JavaScript module scope. It is spawned as its real built entrypoint,
// so the environment contract and the startup path are the deployment's.
//
// The environment handed to the child is built from nothing.
// `...process.env` would let a developer's own ANTHROPIC_API_KEY, PROXY_*, or
// NODE_OPTIONS into the process under test, and a security suite whose subject
// inherits the operator's environment is not testing what it claims to. PATH is
// passed because `node` resolves its own helpers through it.

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Cleanup } from "./cleanup.js";

/** stdin is ignored, so only the two readable pipes are typed. */
type ProxyChild = ChildProcessByStdio<null, Readable, Readable>;

/** Long enough for TLS material to load and SQLite to open; short enough to fail a hang. */
const READY_TIMEOUT_MS = 15_000;
/** After SIGTERM. See `stop` for why this is not simply "wait for close". */
const TERM_GRACE_MS = 2_000;
/** How long `waitForLog` waits. Generous — it is a pipe, not a network. */
const LOG_TIMEOUT_MS = 5_000;

export interface ProxyEnv {
  readonly channelsRoot: string;
  readonly vaultFile: string;
  readonly vaultKey: string;
  readonly budgetDb: string;
  readonly auditDb: string;
  /**
   * The attempt store (#364). Always set by the rig, because the compose file
   * ships the variable set — capture on is the deployment default, and a rig
   * that left it off would be testing a deployment nobody ships.
   */
  readonly attemptsDb: string;
  readonly driftDb: string;
  /**
   * The per-channel message stores (#64). The same directory the in-process
   * agent writes under, so a message the stub Slack delivered is one this
   * spawned process can read back — which is the whole of what the
   * `search_channel_history` cases prove.
   */
  readonly storeRoot: string;
  /**
   * The price table (#62). Optional, as the variable is: a rig whose sheets set
   * no `daily_usd` needs none, and passing one anyway would give every case in
   * the suite a price table nothing in it asserts on.
   */
  readonly priceTable?: string;
  /**
   * The port to bind, when a caller cannot take the OS's pick. Absent means 0,
   * which every fresh spawn wants; `restartProxy` passes the old port because
   * the agent's transport captured the url at composition and a respawn that
   * moved would leave it dialling a dead socket.
   */
  readonly port?: number;
  /**
   * Where a sandbox runner is listening, or absent (#395, #396).
   *
   * Off by default for the reason ambient is: a rig that started a runner would
   * make every case pay for a Docker daemon, and the suite has to run on a
   * machine that has none.
   */
  readonly runner?: { readonly url: string; readonly clientCert: string; readonly clientKey: string };
  /**
   * `PROXY_UPSTREAM_TIMEOUT_MS`. Optional, as the variable is: absent keeps
   * the package's thirty seconds, which every case not about a hanging token
   * endpoint wants — a rig that quietly shortened it would put a clock inside
   * every slow-but-honest fixture.
   */
  readonly upstreamTimeoutMs?: number;
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly tlsCa: string;
}

export interface ProxyProcess {
  /** `https://127.0.0.1:<bound port>` — what PROXY_URL is set to. */
  readonly url: string;
  readonly port: number;
  /** Every line the process wrote, stdout and stderr, in arrival order. */
  log(): string[];
  /**
   * Resolves with the first log line whose fields all equal `match`.
   *
   * The only way to assert on this process's output, and the reason is a race
   * that `log()` alone cannot avoid: a line and the response it accompanies
   * cross two different pipes. The proxy writes `identity_rejected` before it
   * sends the 401, but the stdout write and the TLS write arrive here in
   * whatever order the kernel delivers them, so a case that reads `log()` the
   * moment its request settles is a coin flip. Some lines have no response at
   * all to be ordered against — `tls_client_rejected` fires on a socket event.
   *
   * Matches on equality across the given fields only, so a case names the two
   * or three that carry its claim rather than restating a whole log line.
   */
  waitForLog(match: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /**
   * Kills this process and waits for it to go — the first half of a restart.
   *
   * The cleanup stack keeps its own disposer and stopping twice is fine: the
   * module's stop checks for an already-exited child. What this half does not
   * do is respawn — that is `Rig.restartProxy`, which is where the state that
   * must survive a death (the port, the env) lives.
   */
  stop(): Promise<void>;
}

/** A line, if it is JSON holding every field of `match` at the same value. */
function matches(line: string, match: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(match)) {
    if (fields[key] !== value) return null;
  }
  return fields;
}

function entrypoint(): string {
  const require = createRequire(import.meta.url);
  let resolved: string;
  try {
    resolved = require.resolve("@getlibero/proxy-server");
  } catch {
    throw new Error("e2e: @getlibero/proxy-server does not resolve. Run `pnpm -r build` first.");
  }
  if (!existsSync(resolved)) {
    throw new Error(`e2e: ${resolved} does not exist. Run \`pnpm -r build\` first.`);
  }
  return resolved;
}

/**
 * Spawns the proxy and resolves once it is listening.
 *
 * Readiness is the process's own `listening` log line, which carries the bound
 * port — PROXY_PORT is 0, so the OS chooses and nothing here has to reserve a
 * port and race everything else on the host. Waiting for a line rather than
 * sleeping is also what makes a startup failure a readable error instead of a
 * connection refused several seconds later.
 */
export async function spawnProxy(
  cleanup: Cleanup,
  env: ProxyEnv,
  nodeArgs: readonly string[] = []
): Promise<ProxyProcess> {
  const lines: string[] = [];
  const child: ProxyChild = spawn(process.execPath, [...nodeArgs, entrypoint()], {
    env: {
      PATH: process.env.PATH ?? "",
      PROXY_HOST: "127.0.0.1",
      PROXY_PORT: String(env.port ?? 0),
      PROXY_CHANNELS_ROOT: env.channelsRoot,
      PROXY_VAULT_FILE: env.vaultFile,
      PROXY_VAULT_KEY: env.vaultKey,
      PROXY_BUDGET_DB: env.budgetDb,
      PROXY_AUDIT_DB: env.auditDb,
      PROXY_ATTEMPTS_DB: env.attemptsDb,
      PROXY_DRIFT_DB: env.driftDb,
      PROXY_STORE_ROOT: env.storeRoot,
      // Absent rather than empty when the rig has no table, so the case that
      // exercises "this deployment has no prices" reaches the real code path
      // instead of one that parses an empty string.
      ...(env.priceTable === undefined ? {} : { PROXY_PRICE_TABLE: env.priceTable }),
      // Absent rather than empty when unset, per PROXY_PRICE_TABLE: the cases
      // not about the timeout reach the real default path.
      ...(env.upstreamTimeoutMs === undefined ? {} : { PROXY_UPSTREAM_TIMEOUT_MS: String(env.upstreamTimeoutMs) }),
      PROXY_TLS_CERT: env.tlsCert,
      PROXY_TLS_KEY: env.tlsKey,
      PROXY_TLS_CA: env.tlsCa,
      // The sandbox runner (#395), and absent unless a case stood one up.
      // Absent is not a degraded rig: it is the deployment most operators run,
      // and a channel granting `run_code` in it is answered `not_implemented`
      // rather than refused. Only the cases that attack the sandbox pay for a
      // runner, which is the same rule ambient and the background passes follow.
      ...(env.runner === undefined
        ? {}
        : {
            RUNNER_URL: env.runner.url,
            RUNNER_CLIENT_CERT: env.runner.clientCert,
            RUNNER_CLIENT_KEY: env.runner.clientKey,
            RUNNER_CLIENT_CA: env.tlsCa
          })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  // A test process that dies never runs `afterAll`. Without this, a proxy
  // holding an open vault outlives the run that started it.
  const killOnExit = (): void => {
    child.kill("SIGKILL");
  };
  process.once("exit", killOnExit);

  cleanup.add("proxy process", async () => {
    process.removeListener("exit", killOnExit);
    await stop(child);
  });

  // Woken on every completed line rather than polled, so `waitForLog` settles
  // as soon as the pipe delivers and a case that is right costs no wall clock.
  const waiters = new Set<() => void>();

  let buffered = "";
  const consume = (chunk: Buffer): void => {
    buffered += chunk.toString();
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at < 0) break;
      lines.push(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
    }
    for (const wake of [...waiters]) wake();
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  const port = await new Promise<number>((resolve, reject) => {
    const fail = (why: string): void => {
      clearTimeout(timer);
      reject(new Error(`e2e: the proxy ${why}. Output:\n${lines.join("\n") || "(none)"}`));
    };
    const timer = setTimeout(() => fail(`did not listen within ${READY_TIMEOUT_MS}ms`), READY_TIMEOUT_MS);

    const look = (): void => {
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const event = parsed as { event?: unknown; port?: unknown };
        if (event.event === "listening" && typeof event.port === "number") {
          clearTimeout(timer);
          resolve(event.port);
          return;
        }
      }
    };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.once("error", error => fail(`could not be spawned: ${error.message}`));
    child.once("exit", code => fail(`exited with code ${String(code)} before listening`));
  });

  const waitForLog = (
    match: Readonly<Record<string, unknown>>,
    timeoutMs: number = LOG_TIMEOUT_MS
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      // From zero, not from the end: the line a case is waiting for has often
      // already arrived by the time it asks, and a cursor here would turn the
      // race this exists to remove into a hang.
      let at = 0;
      const look = (): boolean => {
        for (; at < lines.length; at++) {
          const line = lines[at];
          const found = line === undefined ? null : matches(line, match);
          if (found !== null) {
            settle();
            resolve(found);
            return true;
          }
        }
        return false;
      };
      const settle = (): void => {
        clearTimeout(timer);
        waiters.delete(look);
      };
      const timer = setTimeout(() => {
        settle();
        reject(
          new Error(
            `e2e: no log line matched ${JSON.stringify(match)} within ${timeoutMs}ms. Output:\n${
              lines.join("\n") || "(none)"
            }`
          )
        );
      }, timeoutMs);

      if (look()) return;
      waiters.add(look);
    });

  return { url: `https://127.0.0.1:${port}`, port, log: () => [...lines], waitForLog, stop: () => stop(child) };
}

/**
 * SIGTERM, then SIGKILL if it does not go.
 *
 * The kill is not impatience. The agent side's transport keeps an HTTP agent
 * with `keepAlive: true` per channel, and the proxy's shutdown calls
 * `server.close()`, which waits for connections — so an idle keep-alive socket
 * can hold the listener open for the length of Node's keepAliveTimeout on every
 * teardown.
 *
 * Losing the graceful path costs nothing here, and the proxy's own second-signal
 * comment says why: both databases commit with `synchronous = FULL`, so every
 * count and every row either of them acknowledged is already on disk — which is
 * as true of a SIGKILL as of a clean exit, and is why that pragma was chosen.
 */
function stop(child: ProxyChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS);
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}
