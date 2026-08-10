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

export interface ProxyEnv {
  readonly channelsRoot: string;
  readonly vaultFile: string;
  readonly vaultKey: string;
  readonly budgetDb: string;
  readonly auditDb: string;
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
      PROXY_PORT: "0",
      PROXY_CHANNELS_ROOT: env.channelsRoot,
      PROXY_VAULT_FILE: env.vaultFile,
      PROXY_VAULT_KEY: env.vaultKey,
      PROXY_BUDGET_DB: env.budgetDb,
      PROXY_AUDIT_DB: env.auditDb,
      PROXY_TLS_CERT: env.tlsCert,
      PROXY_TLS_KEY: env.tlsKey,
      PROXY_TLS_CA: env.tlsCa
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  // A crashed vitest worker never runs `afterAll`. Without this, a proxy
  // holding an open vault outlives the run that started it.
  const killOnExit = (): void => {
    child.kill("SIGKILL");
  };
  process.once("exit", killOnExit);

  cleanup.add("proxy process", async () => {
    process.removeListener("exit", killOnExit);
    await stop(child);
  });

  let buffered = "";
  const consume = (chunk: Buffer): void => {
    buffered += chunk.toString();
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at < 0) break;
      lines.push(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
    }
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

  return { url: `https://127.0.0.1:${port}`, port, log: () => [...lines] };
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
