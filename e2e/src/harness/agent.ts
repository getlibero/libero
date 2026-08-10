// The agent side: the production composition, in this process.
//
// **Why this half is not spawned.** `createSlackSurface` builds the real
// `SocketModeClient` and the real `WebClient`, forwards neither of the
// injection seams that exist beneath it, and sets no `slackApiUrl` — so a
// spawned `apps/server/dist/index.js` reaches slack.com or nothing. Running it
// would need a test-only switch in the production path, or a fake Socket Mode
// WebSocket server *and* a fake Web API with no way to point the SDK at them.
// The model would not have been a blocker (`AGENT_PROVIDER=openai-compatible`
// with `OPENAI_BASE_URL` serves completions locally); Slack is, alone.
//
// Nothing is lost by keeping it here, because the process boundary that matters
// is the proxy's — see proxy-process.ts. And the composition is not
// approximated: `createServer` is the same function apps/server/src/index.ts
// calls, given the same dependency graph. What differs is the Slack surface and
// the completion client, which is what the two fakes are.
//
// The transport is real. `createProxyTransport` opens a mutual-TLS connection
// with this channel's client certificate, and the proxy resolves the channel
// from that certificate's CN and from nowhere else — so a channel the harness
// did not mint a certificate for is a channel it cannot reach, here as in
// production.

import { createProxyTransport } from "@getlibero/agent";
import type { CompletionClient, ProxyTransport } from "@getlibero/agent";
import { createGateway, createStubSlack } from "@getlibero/gateway";
import type { LogFields, LogLevel, Logger, Scheduler, SlackGateway, StubSlack } from "@getlibero/gateway";
import { createServer, createSheetResolver } from "@getlibero/server";
import type { Cleanup } from "./cleanup.js";

export interface AgentOptions {
  /** The spawned proxy's `https://127.0.0.1:<port>`. */
  readonly proxyUrl: string;
  readonly caPath: string;
  readonly clientCertDir: string;
  /** The same directory the proxy reads. Here it is caps and a model name. */
  readonly channelsRoot: string;
  readonly completion: CompletionClient;
  /** Falls back to this when a sheet names no model. Never widens anything. */
  readonly model?: string;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  /**
   * Wraps the real transport before the composition gets it.
   *
   * How a case makes the agent misbehave — see harness/transport.ts. The
   * agent is the untrusted half, so interfering with what it sends is a
   * faithful compromise rather than a mode; the wrapper never sees the
   * certificate, which stays the transport's.
   */
  readonly wrapTransport?: (inner: ProxyTransport) => ProxyTransport;
  /**
   * Whether this front-end has anywhere to put an approval card.
   *
   * `false` composes with no prompter, which is the documented degraded mode:
   * a held call is relayed to the model as a refusal and nothing runs. It is a
   * real front-end shape, not a test switch — see `SlackSurfaceLike.cards`.
   */
  readonly cards?: boolean;
}

export interface AgentSide {
  readonly slack: StubSlack;
  readonly gateway: SlackGateway;
  /** Every structured log line this side emitted — one of the canary surfaces. */
  log(): Array<{ level: LogLevel; fields: LogFields }>;
}

/**
 * Composes the agent side and connects the stub socket.
 *
 * Returns once `start()` has resolved, so a caller can deliver a mention
 * immediately.
 */
export async function startAgent(cleanup: Cleanup, options: AgentOptions): Promise<AgentSide> {
  const slack = createStubSlack();
  const lines: Array<{ level: LogLevel; fields: LogFields }> = [];
  // Capturing rather than silent: what this side logged is a surface the canary
  // scan reads, and a silent logger would make that assertion vacuous.
  const logger: Logger = { log: (level, fields) => void lines.push({ level, fields }) };

  const real = createProxyTransport({
    url: options.proxyUrl,
    caPath: options.caPath,
    clientCertDir: options.clientCertDir
  });
  const transport = options.wrapTransport === undefined ? real : options.wrapTransport(real);

  const tasks = new AbortController();

  const { gateway } = createServer({
    slack: ({ handler, onDecision }) => ({
      gateway: createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onDecision,
        logger
      }),
      // Omitted rather than stubbed when a case asks for no card path: the
      // composition reads its absence as "no one to ask" and wires no prompter,
      // which is the shape being tested. A stub that accepted cards and dropped
      // them would test nothing.
      ...(options.cards === false ? {} : { cards: slack.poster })
    }),
    completion: options.completion,
    transport,
    sheets: createSheetResolver({
      root: options.channelsRoot,
      model: options.model ?? "e2e-model",
      logger
    }),
    signal: tasks.signal,
    logger,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {})
  });

  cleanup.add("agent side", async () => {
    // Abort first, then close, which is the order index.ts uses and for the
    // same reason: `stop()` refuses to post a reply that arrives after it, so
    // the other order spends tokens on answers nobody will ever see.
    tasks.abort();
    await gateway.stop();
  });

  await gateway.start();
  return { slack, gateway, log: () => [...lines] };
}
