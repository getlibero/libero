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
import type {
  LogFields,
  LogLevel,
  Logger,
  PostedCard,
  Scheduler,
  SlackCard,
  SlackGateway,
  StubSlack
} from "@getlibero/gateway";
import {
  createMemoryFileOpener,
  createMessageStoreOpener,
  createServer,
  createSheetResolver,
  createSkillFilesOpener,
  createSkillRecall
} from "@getlibero/server";
import type { Cleanup } from "./cleanup.js";

export interface AgentOptions {
  /** The spawned proxy's `https://127.0.0.1:<port>`. */
  readonly proxyUrl: string;
  readonly caPath: string;
  readonly clientCertDir: string;
  /** The same directory the proxy reads. Here it is caps and a model name. */
  readonly channelsRoot: string;
  /**
   * Where the per-channel message stores go — `AGENT_STORE_ROOT`.
   *
   * A separate directory from `channelsRoot`, exactly as in production, and the
   * separation is the point rather than tidiness: the channels root is where
   * the proxy reads its authorization from and is read-only to both services.
   * A case can assert that nothing appeared under it.
   */
  readonly storeRoot: string;
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
  /**
   * The workspace's directory, as ids to names.
   *
   * What the assembled transcript attributes messages to. An id with no entry
   * has no name and renders as itself, which is a departed user.
   */
  readonly users?: Record<string, string>;
}

export interface AgentSide {
  readonly slack: StubSlack;
  readonly gateway: SlackGateway;
  /** Every structured log line this side emitted — one of the canary surfaces. */
  log(): Array<{ level: LogLevel; fields: LogFields }>;
  /**
   * Resolves with the first log line whose fields all equal `match`.
   *
   * `ProxyProcess.waitForLog`'s shape, and here for a related reason rather
   * than for symmetry. That one exists because a line and its response cross
   * two pipes; this one exists because **work on this side outlives the call
   * that started it**. The curation turn (#227) is enqueued on the session's
   * mutex and deliberately not awaited, so `deliverMention` resolves while it
   * is still to run — and a case that read `log()` the moment a mention settled
   * would be asserting against a file nobody has written yet.
   *
   * Polled rather than woken, unlike the proxy's: these lines arrive by a
   * function call inside this process, so there is no pipe to hang a listener
   * on and a short poll settles as fast as a listener would.
   *
   * It counts, which the proxy's does not, because the work it exists to wait
   * for happens once per task: a case asserting after its second mention has to
   * be able to say *which* curation turn it is waiting on, and "the first line
   * that matches" answered that question one task ago.
   */
  waitForLog(
    match: Readonly<Record<string, unknown>>,
    count?: number,
    timeoutMs?: number
  ): Promise<LogFields[]>;
}

/** A line, if its fields hold every entry of `match` at the same value. */
function fieldsMatch(
  line: { fields: LogFields },
  match: Readonly<Record<string, unknown>>
): boolean {
  const fields = line.fields as unknown as Record<string, unknown>;
  return Object.entries(match).every(([key, value]) => fields[key] === value);
}

/**
 * The approval card among the thread's cards.
 *
 * Since #68 a tool-calling task also posts a live checklist, so a thread that
 * holds a call has two cards in it and `cards[0]` is whichever went up first —
 * which is a race, because the checklist is posted from the loop and the
 * approval card from the tool client. Every approval assertion goes through
 * here instead.
 *
 * The actions block is the discriminator, and it is exact rather than a
 * heuristic: only the amber approval card draws buttons, and a checklist has no
 * interactive element in any state. Reading `slack.cards` rather than the edited
 * state is deliberate — a decided card drops its actions block, so the posted
 * copy is the one that still identifies itself.
 */
export function approvalCardOf(
  agent: AgentSide
): (PostedCard & { threadTs: string; card: SlackCard }) | undefined {
  return agent.slack.cards.find(posted =>
    posted.card.blocks.some(block => block["type"] === "actions")
  );
}

/**
 * Composes the agent side and connects the stub socket.
 *
 * Returns once `start()` has resolved, so a caller can deliver a mention
 * immediately.
 */
export async function startAgent(cleanup: Cleanup, options: AgentOptions): Promise<AgentSide> {
  const slack = createStubSlack(options.users !== undefined ? { users: options.users } : {});
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
    slack: ({ handler, onDecision, onMessage, onRevision }) => ({
      gateway: createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onDecision,
        onMessage,
        // #233. Omitting this was not a decision — it was the rig quietly
        // dropping every `message_deleted` and `message_changed` on the floor,
        // so a suite whose whole purpose is checking what reaches the store
        // could not see a deletion at all. Nothing failed; the events simply
        // went nowhere, which is the shape of gap this suite exists to catch in
        // the product and had in itself.
        onRevision,
        logger
      }),
      // Omitted rather than stubbed when a case asks for no card path: the
      // composition reads its absence as "no one to ask" and wires no prompter,
      // which is the shape being tested. A stub that accepted cards and dropped
      // them would test nothing.
      ...(options.cards === false ? {} : { cards: slack.poster }),
      // Always present. Unlike cards, a directory has no degraded mode worth a
      // case: without one every author renders as an id, which is the same
      // transcript with worse names.
      users: slack.users
    }),
    completion: options.completion,
    transport,
    sheets: createSheetResolver({
      root: options.channelsRoot,
      model: options.model ?? "e2e-model",
      logger
    }),
    // Real, and gated on the sheet the harness wrote: a channel with a
    // certificate but no sheet gets no store here, exactly as in production.
    store: createMessageStoreOpener({
      storeRoot: options.storeRoot,
      channelsRoot: options.channelsRoot,
      logger
    }),
    // And so is the memory opener (#228). Wiring it changes nothing for a case
    // that did not ask for it: `channels.ts` writes `[memory] enabled = false`
    // unless a sheet says otherwise, so the curation turn is never reached and
    // no existing script gains an entry. What it buys is that a case which
    // *does* ask gets the production path — the same opener index.ts builds,
    // over the same split roots, so `MEMORY.md` lands beside `store.db` and
    // provably not in the channels root.
    memory: createMemoryFileOpener({
      storeRoot: options.storeRoot,
      channelsRoot: options.channelsRoot,
      logger
    }),
    // The skills directory and the retrieval over it (#293), on the memory
    // opener's terms and for its reason: `channels.ts` writes
    // `[skills] enabled = false` unless a sheet says otherwise, so wiring these
    // changes nothing for a case that did not ask, and a case that *does* ask
    // gets the production path over the same split roots — `skills/` beside
    // `store.db`, and provably not in the channels root.
    //
    // **No `embed` is wired, so retrieval runs on full text alone.** That is a
    // real deployment rather than a gap — the team sheet calls it the behaviour
    // for a process with no embedding provider — and it is the right one here:
    // an embedding client is a second live provider this suite's ESLint block
    // exists to keep out, and a fake one would put a hand-built vector space
    // between an attack and the thing it is attacking.
    skills: createSkillFilesOpener({
      storeRoot: options.storeRoot,
      channelsRoot: options.channelsRoot,
      logger
    }),
    skillRecall: createSkillRecall({ logger }),
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
  const waitForLog = async (
    match: Readonly<Record<string, unknown>>,
    count = 1,
    timeoutMs = 10_000
  ): Promise<LogFields[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = lines.filter(line => fieldsMatch(line, match));
      if (found.length >= count) return found.map(line => line.fields);
      if (Date.now() >= deadline) {
        throw new Error(
          `e2e: ${found.length} agent log lines matching ${JSON.stringify(match)}, ` +
            `expected ${count}, within ${timeoutMs}ms`
        );
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };

  return { slack, gateway, log: () => [...lines], waitForLog };
}
