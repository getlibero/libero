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
import type { CompletionClient, EmbeddingClient, ProxyTransport } from "@getlibero/agent";
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
  createSharedSkillPoolOpener,
  createSharedSkillReader,
  createSheetResolver,
  createSkillFilesOpener,
  createSkillRecall
} from "@getlibero/server";
import type { Cleanup } from "./cleanup.js";
import { ambientDeps } from "./ambient.js";
import { backgroundPasses } from "./passes.js";
import type { BackgroundPass } from "./passes.js";

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
  /**
   * Which background passes this composition includes (#308).
   *
   * Absent composes none, which is what every case that is not about a pass
   * gets and why they all still pass. See ./passes.ts on why they are named one
   * at a time rather than turned on together.
   */
  readonly passes?: readonly BackgroundPass[];
  /**
   * The clock those passes read, and nothing else reads.
   *
   * A third clock beside `now`, which is the approval prompter's: a pass clock
   * pinned to a fixed instant would freeze a card's expiry too. Real time plus
   * an offset, moving forward only — see `RigOptions.passClock`.
   */
  readonly passClock?: () => number;
  /**
   * How this composition embeds, or absent for the deployment that configured
   * nothing.
   *
   * Reaches the background passes and never the task path: `embed` stays
   * unwired, so skill retrieval runs on full text whatever this says.
   */
  readonly embedding?: EmbeddingClient;
  /**
   * Whether this side composes the ambient clock and the heartbeat (#321).
   *
   * Absent leaves `createServer` with the same two `undefined`s it received
   * before this existed, so no case that did not ask gains a clock, an
   * enumerator, or a `Server.ambient` to drive. See ./ambient.ts.
   */
  readonly ambient?: boolean;
  /**
   * `AGENT_SHARED_SKILLS_ROOT` — the operator's shared skill root (#437).
   *
   * Absent leaves `createServer` with the two `undefined`s it received before
   * this existed, so no case that did not ask gains a standing region in its
   * system prompt or a second half to its retrieval pool. See ./shared-skills.ts.
   *
   * **Both halves are composed from one root**, exactly as index.ts does it: the
   * standing reader for `load = "always"` and the pool opener for the retrieved
   * half. Wiring one and not the other would be a rig that could only attack
   * half the feature.
   */
  readonly sharedSkillsRoot?: string;
}

export interface AgentSide {
  readonly slack: StubSlack;
  readonly gateway: SlackGateway;
  /**
   * Runs one ambient scan at `at`, and answers how many channels it fired.
   *
   * `AmbientScheduler.scan` is documented as the whole of the scheduler's
   * behaviour so that a test drives it rather than waiting on a timer, and this
   * is that seam. Nothing here starts a clock.
   *
   * **The first scan of a channel never fires**, which is the scheduler's
   * first-sight rule rather than a wrinkle of this rig: a channel newly seen
   * enabled is scheduled at `now + cadence`, so a case wanting a heartbeat scans
   * once to be seen and again past the cadence. `Rig.heartbeat` does both.
   *
   * Throws on a rig that composed no clock, so a case that forgot
   * `RigOptions.ambient` fails as itself rather than as a silent no-op.
   */
  heartbeat(at: number): Promise<number>;
  /**
   * One scan at `at`, answering how many due *checks* ran (#324).
   *
   * The same scan `heartbeat` drives, counting the other kind of due thing —
   * and a separate verb because the two differ in the rule that matters to a
   * case. A heartbeat's deadline is invented by the scheduler and so cannot fire
   * on the scan that invents it; a ticket's instant is already on disk, so the
   * first scan past it fires. There is no sighting scan to do.
   */
  check(at: number): Promise<number>;
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
 * The approval card, once it is there.
 *
 * A hold is not something `deliverMention` resolves on: the mention is still in
 * flight while the model calls, the proxy mints a ticket and writes its `held`
 * row, and the tool client posts the card. Reading `approvalCardOf` before that
 * lands is a race, so every case that needs the card waits here first.
 *
 * **The bound is the harness's, and it is chosen here.** This replaced six
 * `vi.waitFor` calls that all took vitest's 1000 ms default, in files whose
 * `SETUP_MS` is a minute because the same rig mints certificates and spawns a
 * process — two numbers three orders of magnitude apart, and only one of them
 * chosen. One of the six failed a CI run on nothing but a loaded runner (#329).
 * The runner that supplied that default is gone (#202), and its replacement in
 * `@getlibero/test-kit` takes the timeout as a required argument — so the shape
 * of that failure is now unwritable rather than merely absent.
 * Ten seconds is `waitForLog`'s default above, for the same reason: a wait that
 * resolves the moment its condition holds costs nothing when things are quick,
 * so the number only has to be larger than the worst honest case.
 *
 * It throws rather than returning undefined, and says what the thread held.
 * `expected undefined to be defined` was the whole of what the CI failure
 * reported, and it does not distinguish a hold that was slow from a hold that
 * never happened — which is the first question worth answering.
 */
export async function waitForApprovalCard(
  agent: AgentSide,
  timeoutMs = 10_000
): Promise<PostedCard & { threadTs: string; card: SlackCard }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const card = approvalCardOf(agent);
    if (card !== undefined) return card;
    if (Date.now() >= deadline) {
      throw new Error(
        `e2e: no approval card within ${timeoutMs}ms. The thread holds ` +
          `${agent.slack.cards.length} card(s) and ${agent.slack.posted.length} reply/replies; ` +
          "a checklist with no approval card means the call was never held."
      );
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
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

  // Hoisted out of the dependency object below because two things need each of
  // them now, which is exactly why index.ts hoists the same two. One resolver
  // means `[memory] summarize` and `[skills] curate` are as fresh for a
  // background pass as they are for a reply; one skills opener means the passes
  // and the router reach the same directory under the same cap.
  const sheets = createSheetResolver({
    root: options.channelsRoot,
    model: options.model ?? "e2e-model",
    logger
  });
  const skills = createSkillFilesOpener({
    storeRoot: options.storeRoot,
    channelsRoot: options.channelsRoot,
    logger
  });

  const { gateway, ambient } = createServer({
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
        // #321. Omitting this was the same shape of gap `onRevision` was: the
        // gateway learns the app's own id and its workspace from one
        // `auth.test`, and without it `gateway.workspace` is `undefined`
        // forever — so the ambient clock refuses to scan, because a `SessionKey`
        // it invented would be a second session over a live channel. Nothing
        // failed before this; there was simply nothing asking.
        identity: slack.identity,
        logger
      }),
      // Omitted rather than stubbed when a case asks for no card path: the
      // composition reads its absence as "no one to ask" and wires no prompter,
      // which is the shape being tested. A stub that accepted cards and dropped
      // them would test nothing.
      ...(options.cards === false ? {} : { cards: slack.poster }),
      // The channel-post verb (#318), always present. Unlike cards it has no
      // degraded mode worth a case: a surface without it builds no heartbeat at
      // all, which is a composition decision `apps/server` already tests, and
      // here it would make every ambient case silently unreachable.
      channel: slack.poster,
      // Always present. Unlike cards, a directory has no degraded mode worth a
      // case: without one every author renders as an id, which is the same
      // transcript with worse names.
      users: slack.users
    }),
    completion: options.completion,
    transport,
    sheets,
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
    // **No `embed` is wired, so retrieval runs on full text alone**, and that is
    // unchanged by #308. It is a real deployment rather than a gap — the team
    // sheet calls it the behaviour for a process with no embedding provider —
    // and the one embedding client this rig can have is the constant fake in
    // ./embedding.ts, which reaches the background passes and never this. See
    // that file for why a fake that ranks nothing is not the thing the original
    // refusal was about.
    skills,
    skillRecall: createSkillRecall({ logger }),
    // The third root, when a case asked for one (#437). Absent composes neither
    // half — and `createSharedSkillReader` is deliberately not built with a null
    // root here, unlike index.ts: production wants the log line that tells an
    // operator their sheet names a skill no root holds, where a rig that never
    // asked for a root has no operator to tell.
    ...(options.sharedSkillsRoot === undefined
      ? {}
      : {
          sharedSkills: createSharedSkillReader({ root: options.sharedSkillsRoot, logger }),
          sharedSkillPool: createSharedSkillPoolOpener({ root: options.sharedSkillsRoot, logger })
        }),
    // The four background passes, when a case asked for them (#308). Absent
    // otherwise, so `createServer` receives the same four `undefined`s it
    // received before this option existed and no case that did not ask gains a
    // model turn, a file, or a row.
    ...(options.passes === undefined || options.passes.length === 0
      ? {}
      : backgroundPasses({
          passes: options.passes,
          completion: options.completion,
          embedding: options.embedding ?? null,
          transport,
          sheets,
          skills,
          storeRoot: options.storeRoot,
          channelsRoot: options.channelsRoot,
          logger,
          // The same signal the composition gets, and not optional in practice:
          // `cleanup` aborts before `gateway.stop()`, so a merge turn in flight
          // at teardown is cancelled rather than left to resolve into a rig
          // that has gone.
          signal: tasks.signal,
          ...(options.passClock !== undefined ? { now: options.passClock } : {})
        })),
    // The clock and the heartbeat, when a case asked (#321). Absent otherwise,
    // on the four passes' terms and for their reason: a case that did not ask
    // composes exactly what it composed before, and `Server.ambient` is not
    // built at all.
    // The rate window's clock, when a case is driving one (#318). Without it the
    // window is measured on `Date.now()` while a case steps a simulated one, so
    // "four hours later" would be four hours the window never saw. It is the
    // same figure the heartbeat reads, deliberately: a case advancing past the
    // window is advancing past the cadence too.
    ...(options.ambient === true && options.passClock !== undefined
      ? { proactiveClock: options.passClock }
      : {}),
    ...(options.ambient === true
      ? ambientDeps({
          completion: options.completion,
          transport,
          sheets,
          storeRoot: options.storeRoot,
          channelsRoot: options.channelsRoot,
          logger,
          signal: tasks.signal,
          ...(options.passClock !== undefined ? { now: options.passClock } : {})
        })
      : {}),
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

  return {
    slack,
    gateway,
    log: () => [...lines],
    waitForLog,
    async heartbeat(at: number): Promise<number> {
      if (ambient === undefined) {
        throw new Error("e2e: this rig composed no ambient clock — see RigOptions.ambient");
      }
      const { fired } = await ambient.scan(at);
      return fired;
    },
    async check(at: number): Promise<number> {
      if (ambient === undefined) {
        throw new Error("e2e: this rig composed no ambient clock — see RigOptions.ambient");
      }
      // The same scan, counting the other kind of due thing. Two counters rather
      // than one, so "nothing was due" is assertable for each — a case proving a
      // check did not fire must not be satisfied by a heartbeat that did.
      const { checks } = await ambient.scan(at);
      return checks;
    }
  };
}
