// The gateway + agent composition, as a function of its dependencies.
//
// This is the wiring: gateway → handler → router → task → loop, plus the
// approval broker's client half. It is apart from index.ts so that composing it
// does not mean starting a process — index.ts reads the environment, builds the
// adapters, and handles signals, and everything it does after that is one call
// to `createServer`.
//
// The split exists because two callers need the same wiring and only one of them
// is a process. The e2e suite runs the agent side in-process against a spawned
// proxy, and `held-call.test.ts` runs it against a fake transport; both go
// through this function rather than restating the graph, which is what keeps
// "the tests exercise the production composition" true rather than asserted. A
// second copy of these nine lines is how a seam gets fixed in one place and
// stays broken in the other.
//
// It holds no environment, no token, and no default that could stand in for one.
// Every dependency arrives constructed.

import type { CompletionClient, ProxyTransport } from "@getlibero/agent";
import { createProxyApprovalsClient } from "@getlibero/agent";
import type {
  CardPoster,
  ChannelPoster,
  DecisionHandler,
  Logger,
  MentionHandler,
  MessageHandler,
  RevisionHandler,
  Scheduler,
  SlackGateway,
  UserDirectory
} from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import { createProactivePoster } from "./proactive/proactive.js";
import type { ProactivePoster } from "./proactive/proactive.js";
import { createAmbientScheduler } from "./session/ambient.js";
import type {
  AmbientHeartbeat,
  AmbientRuleFire,
  AmbientScheduler,
  AmbientTaskFire
} from "./session/ambient.js";
import type { ChannelLister } from "./session/channels.js";
import { createDecisionHandler } from "./approvals/decisions.js";
import { createHeldCallPrompter } from "./approvals/prompter.js";
import { createChecklistReporter } from "./checklist/checklist.js";
import { createApprovalRegistry } from "./approvals/registry.js";
import type { ApprovalRegistry } from "./approvals/registry.js";
import { createMentionHandler } from "./handler.js";
import { createMessageIngest, createRevisionIngest } from "./ingest.js";
import type { QueryEmbedder } from "./session/embed.js";
import type { Recall } from "./session/recall.js";
import type { SkillEmbedSweep } from "./session/skill-embed.js";
import type { SkillCuratePass } from "./session/skill-curate.js";
import type { SkillLifecyclePass } from "./session/skill-lifecycle.js";
import type { SkillRecall } from "./session/skill-recall.js";
import type { SharedSkillReader } from "./session/shared-skills.js";
import type { SharedSkillPoolOpener } from "./session/skill-pool.js";
import type { SkillFilesOpener } from "./session/skills.js";
import type { SummarySweep } from "./session/summarize.js";
import type { DisplayNameLookup } from "./session/names.js";
import { createSessionRegistry } from "./session/registry.js";
import { createChannelRouter } from "./session/router.js";
import { createTaskRunner } from "./session/task.js";
import type { SheetResolver } from "./session/sheet.js";
import type { MemoryFileOpener } from "./session/memory.js";
import type { MessageStoreOpener } from "./session/store.js";

/**
 * The Slack side, once built.
 *
 * Structurally `SlackSurface` from @getlibero/gateway, restated here so this
 * file does not require the surface to have come from `createSlackSurface` — a
 * test builds one over `createStubSlack` instead.
 */
export interface SlackSurfaceLike {
  readonly gateway: SlackGateway;
  /**
   * Where an approval card goes — when there is anywhere.
   *
   * Optional because "no one to ask" is a real front-end rather than a test
   * mode. `createProxyToolClient` takes its prompter optionally for the same
   * reason: without one, a held call is relayed to the model as the
   * refusal-shaped result it already is, which is safe and abandons a call a
   * human could have approved. A surface with no card path therefore gets no
   * prompter, and that degraded mode is the documented fallback rather than a
   * misconfiguration.
   *
   * Slack always has one. `createSlackSurface` returns it.
   */
  readonly cards?: CardPoster;
  /**
   * Where a proactive post goes — when there is anywhere (#318).
   *
   * Optional on `cards`' terms and with a sharper degradation: without it the
   * ambient heartbeat is not built at all, because everything a heartbeat
   * produces is a post. A turn that spent model calls and could say nothing
   * would be worse than the clock this composition already ships with no reader
   * — a due channel logs `ambient_due` and runs nothing, which is honest.
   *
   * Slack always has one. `createSlackSurface` returns it.
   */
  readonly channel?: ChannelPoster;
  /**
   * Who a user id is, for the transcript the router assembles.
   *
   * Optional on the same terms as `cards`: a front-end with no directory to ask
   * renders every author as its id, which is a readable transcript with worse
   * attribution rather than no transcript. It comes off the surface rather than
   * out of `ServerDeps` because it must share the surface's Slack client — a
   * second one on the same bot token would give the process two rate-limit
   * queues over one API.
   */
  readonly users?: UserDirectory;
}

/**
 * Builds the Slack surface once the two things it dispatches to exist.
 *
 * A factory rather than an already-built surface, because the dependency runs
 * both ways: `createSlackSurface` takes the mention handler and the decision
 * handler at construction, and this function is what builds them — the prompter
 * inside the mention handler needs `surface.cards`. Passing a constructed
 * surface would push that knot out to every caller.
 *
 * It also keeps what belongs to the process in the process. `onFatal` exits,
 * `backoff` and `random` are the reconnect ladder's: none of them are the
 * composition's business, and none appear below.
 */
export type SlackSurfaceFactory = (wiring: {
  readonly handler: MentionHandler;
  readonly onDecision: DecisionHandler;
  /**
   * Where an ordinary message goes. Always passed, even with no store: with
   * nowhere to file one it is a function that does nothing, which is cheaper
   * than making every implementer handle its absence.
   */
  readonly onMessage: MessageHandler;
  /**
   * Where a deletion or an edit goes. Always passed, on `onMessage`'s terms and
   * for a sharper reason: the two arrive on one subscription, so a surface that
   * took the first without the second would be a surface that files messages
   * and never lets one go.
   */
  readonly onRevision: RevisionHandler;
}) => SlackSurfaceLike;

/**
 * Builds the heartbeat over the capability that lets it speak (#318).
 *
 * The argument is the whole reason this is a factory. See `ServerDeps.heartbeat`
 * — a `ProactivePoster` is minted inside `createServer` and this is the only
 * hand it is dealt into.
 */
export type AmbientHeartbeatFactory = (post: ProactivePoster) => AmbientHeartbeat;

/**
 * Builds the fire path over the same capability (#324).
 *
 * A second factory rather than a second return from the first, because the two
 * are wired independently: a deployment can have a heartbeat and no fire path
 * (which is every deployment before #324) and the reverse is a legitimate
 * composition too — a channel that wants scheduled checks and no unbidden
 * noticing. One factory returning both would make each of those a `null` inside
 * a tuple.
 *
 * It takes the poster for `AmbientHeartbeatFactory`'s reason, which is the whole
 * withholding discipline: the capability is minted in `createServer` and reaches
 * exactly the consumers that produce posts, so the four background passes still
 * cannot name the type.
 */
export type AmbientTaskFireFactory = (post: ProactivePoster) => AmbientTaskFire;

/**
 * Running a due standing rule (#461). The third of these, and the same shape.
 *
 * A third factory for the second's reason, sharpened by there now being three:
 * every combination of the three is a legitimate deployment. Rules with no
 * heartbeat is a channel that writes `heartbeat = false`, and it is the
 * configuration #461 exists to make possible — so a single factory returning a
 * triple would spell each of those as a `null` in a tuple.
 */
export type AmbientRuleFireFactory = (post: ProactivePoster) => AmbientRuleFire;

export interface ServerDeps {
  readonly slack: SlackSurfaceFactory;
  readonly completion: CompletionClient;
  /**
   * The mutual-TLS connection to the tool proxy service. Required: there is no
   * toolless mode, here or in the task runner beneath it.
   */
  readonly transport: ProxyTransport;
  /** What each channel's team sheet resolves to. Per task, never cached here. */
  readonly sheets: SheetResolver;
  /**
   * How a channel gets its message store.
   *
   * Optional, and the degradation is the one `cards` documents: a process with
   * nowhere to file a message still answers mentions, and a front-end that has
   * no store is a real front-end rather than a test mode. Production always has
   * one — `AGENT_STORE_ROOT` is required.
   */
  readonly store?: MessageStoreOpener;
  /**
   * How a channel gets its `MEMORY.md`.
   *
   * Optional, and its absence is the process as it behaved before phase 2: no
   * curated memory in a task's opening context, and no curation turn after a
   * reply. Separate from `store` rather than folded into it because the two are
   * opened at different moments — a store once per session, a memory file per
   * task, since its cap comes from the team sheet.
   */
  readonly memory?: MemoryFileOpener;
  /**
   * The quiescence sweep (#231).
   *
   * Optional, and its absence is a deployment with no thread summaries — memory
   * Layers 1 and 2 are whole without them. Built by the process rather than here
   * because it needs a completion client, an embedding client and the spend
   * reporter, none of which this file holds.
   */
  readonly summarize?: SummarySweep;
  /**
   * Semantic recall at the head of a task (#232).
   *
   * Built by the process for `summarize`'s reason — it needs an embedding client
   * and the spend reporter, neither of which this file holds. Its absence is a
   * task that starts from the transcript and `MEMORY.md` alone.
   */
  readonly recall?: Recall;
  /**
   * The one embedding of the incoming request (#292), shared by both retrievers.
   *
   * Built by the process for `recall`'s reason, and the two now come as a pair:
   * `recall` no longer embeds anything of its own, so wiring it without this is
   * a deployment whose semantic recall never returns anything.
   */
  readonly embed?: QueryEmbedder;
  /**
   * How a channel's `skills/` directory is opened (#292).
   *
   * `memory`'s shape and its reason — opened per task because its cap is the
   * sheet's. Its absence is a task that starts with no playbooks, which is how
   * every task started before phase 3.
   */
  readonly skills?: SkillFilesOpener;
  /**
   * Skill retrieval at the head of a task (#292).
   *
   * Unlike `recall`, this one *can* be built here — it needs no embedding client,
   * because the vector reaches it as an argument. It is a dependency anyway, so
   * that a deployment can wire the directory without the retrieval or the other
   * way round, and so a test can supply either half.
   */
  readonly skillRecall?: SkillRecall;
  /**
   * The standing region's shared skills (#435).
   *
   * `skillRecall`'s standing: buildable here in principle — it needs no model
   * and no embedding client — and a dependency anyway, so a deployment can wire
   * the third root without the rest and a test can supply either half. Its
   * absence is a task whose standing region is the channel description alone,
   * which is every task before #435 and every deployment that publishes no
   * shared skills.
   */
  readonly sharedSkills?: SharedSkillReader;
  /**
   * How the retrieved half of the shared library is opened for a channel (#436).
   *
   * `sharedSkills`' sibling and the same root, wanted by the router rather than
   * by the task runner: this half is retrieved inside the session's lock, where
   * the standing half is composed outside it.
   */
  readonly sharedSkillPool?: SharedSkillPoolOpener;
  /**
   * The skill-embedding pass (#305), run on channel activity beside `summarize`.
   *
   * Built by the process for `summarize`'s reason — it needs an embedding client
   * and the spend reporter, neither of which this file holds. Its absence is a
   * deployment whose skills retrieve on their lexical leg alone, which is what
   * #292 shipped and what a process with no embedding provider does regardless.
   *
   * It takes the same `skills` opener this file already holds, so wiring it
   * without that one is a pass that opens no directory and embeds nothing.
   */
  readonly embedSkills?: SkillEmbedSweep;
  /**
   * The skill lifecycle job (#294), run on channel activity beside the other two.
   *
   * Built by the process for their reason and for none of their reasons: it needs
   * neither a model client nor the spend reporter, because it spends nothing. It
   * is built out there because the sheet resolver and the `skills` opener are, and
   * a pass wired without the latter opens no directory and ages nothing.
   *
   * Its absence is a deployment whose skill statuses only ever move by hand.
   */
  readonly lifecycleSkills?: SkillLifecyclePass;
  /**
   * The merge curator (#295), run on channel activity beside the other three.
   *
   * Built by the process for `summarize`'s reason and not the lifecycle job's: it
   * needs a completion client and the spend reporter, neither of which this file
   * holds. It takes the `skills` opener this file already has plus a `proposals`
   * one, so wiring it without either is a pass that proposes nothing.
   *
   * Its absence is a deployment whose playbooks are never proposed for merging.
   */
  readonly curateSkills?: SkillCuratePass;
  /**
   * Which channels exist, for the ambient scheduler's enumerator (#317).
   *
   * Built by the process for the openers' reason — it closes over
   * `AGENT_CHANNELS_ROOT`, and this file holds no environment. Its absence is a
   * deployment with no clock: `Server.ambient` is not built, and `[ambient]` is
   * parsed and unread exactly as it was before this issue.
   */
  readonly channels?: ChannelLister;
  /**
   * What runs when a channel's cadence comes due (#319), as a factory over the
   * one thing this process can speak with.
   *
   * Optional beside `channels` rather than folded into it, because the two are
   * separable in the direction that matters: a deployment can have the clock
   * without the turn — which is what ships here — and a due channel then logs
   * `ambient_due` and runs nothing. The other direction is not a deployment: a
   * heartbeat with no enumerator is never invoked.
   *
   * **A factory rather than a built pass, and that is the withholding
   * discipline rather than a style (#318).** Every other background pass —
   * `summarize`, `embedSkills`, `lifecycleSkills`, `curateSkills` — arrives
   * already built, because everything it needs is something the process holds.
   * This one needs a capability that does not exist until `createServer` calls
   * the `slack` factory, so an already-built heartbeat would force this function
   * to hand the poster back out to index.ts, and from there it is reachable by
   * everything the process constructs. As a factory the capability is minted and
   * consumed inside this file and reaches exactly one consumer.
   *
   * What that buys is checkable rather than asserted: the four passes above are
   * constructed with no `ProactivePoster` and cannot name the type, so the
   * quiescence sweep, the skill-embed pass, the lifecycle job and the merge
   * curator still cannot post — which is what `session/skill-curate.ts` says
   * about why a proposal is a file, and it stays true after this.
   */
  readonly heartbeat?: AmbientHeartbeatFactory;
  /**
   * Runs a due scheduled check (#324). `AmbientHeartbeatFactory`'s shape and its
   * discipline, for the same reason: it produces a post, so it is minted here.
   *
   * Absent, the clock still notices a due ticket and logs `ambient_check_due` —
   * and **leaves it pending**, which is the opposite of what it does with a
   * heartbeat it cannot run. A heartbeat is an opportunity and skipping one costs
   * nothing; a check is a thing somebody approved, and consuming it without
   * running it would be the silent loss this design refused to build.
   */
  readonly fireTask?: AmbientTaskFireFactory;
  /**
   * Runs a due standing rule (#461). The same shape and the same discipline, and
   * the third caller is what makes the factory pattern's claim checkable rather
   * than a coincidence of there having been two.
   *
   * Absent, the clock notices a due rule and logs `ambient_rule_due`, and there is
   * nothing to leave pending — a rule's next occurrence is computed rather than
   * stored, so a deployment with no fire path simply never speaks and loses
   * nothing it was holding.
   */
  readonly fireRule?: AmbientRuleFireFactory;
  /** Cancels every task in flight. Omitted by a caller with no shutdown to run. */
  readonly signal?: AbortSignal;
  /** Defaults to silent, so a test asserting on behaviour is not also a log sink. */
  readonly logger?: Logger;
  /** Injected for tests: the approval card's clock. Omitted in production. */
  readonly now?: () => number;
  /**
   * Injected for tests: the session's clock. Omitted in production.
   *
   * Deliberately not `now`. That one is the approval deadline's, and a test
   * pinning it to a fixed instant would also freeze session ageing and the
   * follow-up window — so a test about a card would silently be a test about a
   * thread that never goes quiet. Two names because they are two clocks.
   *
   * It reaches the three things that measure a session's time: eviction, the
   * queue's `queuedMs`, and how long a worked thread stays answerable. All
   * three, or a thread activated on one clock would be read on another.
   */
  readonly sessionClock?: () => number;
  /**
   * Injected for tests: the proactive post window's clock. Omitted in production.
   *
   * A fourth clock, and separate from the other three for the reason
   * `sessionClock` gives about being separate from `now`: they measure different
   * things and a test that pinned one would silently be pinning another. `now`
   * is the approval deadline's. `sessionClock` reaches exactly three readers —
   * eviction, `queuedMs`, and the follow-up window — and its own comment says
   * all three or none, because a thread activated on one clock must not be read
   * on a different one. This one measures how long it has been since the agent
   * last spoke in a channel, which is none of those, and folding it into either
   * would make a test about a four-hour window also a test about session
   * eviction.
   */
  readonly proactiveClock?: () => number;
  /** Injected for tests: the approval deadline's timer. Omitted in production. */
  readonly scheduler?: Scheduler;
}

// Re-exported because this file is the package's entry point and a composition
// root cannot call `createServer` without building a `sheets` — index.ts does
// exactly this. Kept to the dependencies a caller must construct: the router,
// the task runner, and the handler are wired below and are nobody else's to
// build.
// The proactive post surface (#318). Exported for the composition roots' reason
// above and for one more: `HEARTBEAT_POST_WINDOW_MS` is the bound a test asserts
// against, and a caller stepping a clock over `4 * 60 * 60 * 1000` would be
// asserting a number nobody named.
export { HEARTBEAT_POST_WINDOW_MS, createProactivePoster } from "./proactive/proactive.js";
export { MAX_CHECK_MESSAGES, createAmbientTaskFire, renderCheckFailureNotice } from "./session/check.js";
export { createAmbientRuleFire, renderRuleFailureNotice } from "./session/rule.js";
export type { RuleOptions, RuleSettings } from "./session/rule.js";
export { nextRuleOccurrence } from "./session/rule-clock.js";
export type { CheckOptions, CheckSettings } from "./session/check.js";
export { MAX_HEARTBEAT_MESSAGES, createAmbientHeartbeat } from "./session/heartbeat.js";
export { renderProposalNotice } from "./session/heartbeat.js";
export type { HeartbeatOptions, HeartbeatSettings } from "./session/heartbeat.js";
export type {
  ProactivePost,
  ProactivePoster,
  ProactivePosterOptions
} from "./proactive/proactive.js";

export {
  DEFAULT_AMBIENT_SETTINGS,
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  createSheetResolver
} from "./session/sheet.js";
export type { SheetResolver } from "./session/sheet.js";
export type { DisplayNameLookup, NameCache } from "./session/names.js";
export { createMessageStoreOpener } from "./session/store.js";
export { createMemoryFileOpener } from "./session/memory.js";
export type { MemoryFileOpener, MemoryFileOpenerOptions } from "./session/memory.js";
export type { MessageStoreOpener, MessageStoreOpenerOptions } from "./session/store.js";
export { createSkillFilesOpener } from "./session/skills.js";
export type { SkillFilesOpener, SkillFilesOpenerOptions } from "./session/skills.js";
export { SKILLS_MAX_CHARS, createSkillRecall } from "./session/skill-recall.js";
export { createSharedSkillReader } from "./session/shared-skills.js";
export type { SharedSkillReader, SharedSkillRequest } from "./session/shared-skills.js";
export { createSharedSkillPoolOpener } from "./session/skill-pool.js";
export type { SharedSkillPool, SharedSkillPoolOpener } from "./session/skill-pool.js";
export type { LoadedSkill, SkillRecall } from "./session/skill-recall.js";
export { createQueryEmbedder } from "./session/embed.js";
export type { QueryEmbedder } from "./session/embed.js";
export type { AmbientSettings, MemorySettings, SkillSettings } from "./session/types.js";
export type {
  ChannelSettings,
  HistoryBounds,
  SessionKey,
  TaskRequest,
  TaskReply,
  TaskSettings
} from "./session/types.js";

// The four background passes, on the block above's rule and not as an exception
// to it: a composition root cannot call `createServer` without building them
// either, and index.ts only avoids needing this because it lives inside the
// package. The e2e rig is the second composition root and reaches this file
// through the package's one export path (#308).
//
// The three interval constants come with them for `TURN_TOKENS`' reason: a
// caller stepping a clock over `25 * 60 * 60 * 1000` is asserting a number
// nobody named, where one stepping over `CURATE_INTERVAL_MS` is asserting the
// bound itself. `toSlackTs` likewise — a caller that formats its own Slack
// timestamp is testing the format rather than using it.
export { SWEEP_INTERVAL_MS, createSummarySweep, toSlackTs } from "./session/summarize.js";
export type {
  SummarySweep,
  SummarySweepOptions,
  SummarizeSettings
} from "./session/summarize.js";
export { MAX_SKILLS_PER_EMBED_PASS, createSkillEmbedSweep } from "./session/skill-embed.js";
export type {
  SkillEmbedSettings,
  SkillEmbedSweep,
  SkillEmbedSweepOptions
} from "./session/skill-embed.js";
export { LIFECYCLE_INTERVAL_MS, createSkillLifecyclePass } from "./session/skill-lifecycle.js";
export type {
  SkillLifecycleOptions,
  SkillLifecyclePass,
  SkillLifecycleSettings
} from "./session/skill-lifecycle.js";
export {
  CURATE_INTERVAL_MS,
  MAX_OPEN_PROPOSALS,
  createSkillCuratePass
} from "./session/skill-curate.js";
export type {
  SkillCuratePass,
  SkillCuratePassOptions,
  SkillCurateSettings
} from "./session/skill-curate.js";
export { createSkillProposalsOpener } from "./session/proposals.js";
export type { SkillProposalsOpener, SkillProposalsOpenerOptions } from "./session/proposals.js";

// The clock, on the same rule as the four passes above: a composition root
// cannot build one without this file's export path. The two constants come with
// it for their reason — a test stepping a clock over `60 * 1000` is asserting a
// number nobody named, where one stepping over `AMBIENT_RESCAN_MS` is asserting
// the bound itself.
export {
  AMBIENT_RESCAN_MS,
  MAX_CONCURRENT_HEARTBEATS,
  createAmbientScheduler,
  earliestDue
} from "./session/ambient.js";
export type {
  AmbientHeartbeat,
  AmbientRuleFire,
  AmbientScan,
  AmbientScheduler,
  AmbientSchedulerOptions,
  AmbientSchedulerSettings,
  AmbientTaskFire,
  AmbientTimer,
  DueEntry
} from "./session/ambient.js";
export { createChannelLister } from "./session/channels.js";
export type { ChannelLister, ChannelListerOptions } from "./session/channels.js";

export interface Server {
  readonly gateway: SlackGateway;
  /**
   * The ambient clock (#317), when this composition was given an enumerator.
   *
   * Returned rather than started, which is this function's whole rule: the
   * caller decides when, and for this one the answer is "after the gateway has
   * connected", because that is when there is a workspace to key a session with.
   */
  readonly ambient?: AmbientScheduler;
  /**
   * The process-scoped registry of open approval waits.
   *
   * Returned so a test can assert on what is outstanding. Nothing in a running
   * process needs it: the two ends that do — the prompter and the decision
   * handler — are wired to it below.
   */
  readonly registry: ApprovalRegistry;
}

/**
 * Wires the process together and starts nothing.
 *
 * The returned gateway is not connected; the caller decides when, and handles
 * what a failed connect means.
 */
export function createServer(deps: ServerDeps): Server {
  const logger = deps.logger ?? createSilentLogger();

  // The approval broker's client side: one registry of waits at process scope,
  // one decisions client over the same transport every tool call takes. The
  // channel a decision is relayed on comes from the waiting entry, which got it
  // from the mention's certificate-backed session — never from the click.
  const registry = createApprovalRegistry();
  const approvals = createProxyApprovalsClient({ transport: deps.transport });

  // The sessions are built here rather than left to the router, because two
  // things now hold them: the router, which queues a channel's model turns on a
  // session's mutex, and the ingest, which takes a session's store handle and
  // its set of active threads. One registry, so both see the same session — and
  // so a channel's file is opened once rather than once per path, and a thread
  // a task activated is one the ingest can see.
  //
  // Spread into all three of the things that measure a session's time, so a
  // thread cannot be activated on one clock and read on another. `deps.now` is
  // not among them — see `sessionClock` for why there are two.
  const clock = deps.sessionClock !== undefined ? { now: deps.sessionClock } : {};

  const sessions = createSessionRegistry({
    logger,
    ...(deps.store !== undefined ? { openStore: deps.store } : {}),
    ...clock
  });

  // The directory comes off the surface and the surface is built below, so this
  // closes over `surface` before it exists — the same trick `handleMention`
  // uses, and safe for the same reason: nothing dispatches before `start()`, and
  // both bindings exist the moment this function returns. Building the sessions
  // after the surface is not an option, because the ingest is one of the things
  // the surface is constructed *from*.
  //
  // A plain function rather than the `UserDirectory` itself, because this is
  // what crosses into `src/session/**` — an ESLint rule there allows no Slack
  // type through, and a name lookup is not one in any sense that matters.
  const names: DisplayNameLookup = userId => {
    const users = surface.users;
    return users === undefined ? Promise.resolve(undefined) : users.displayName(userId);
  };

  // Built before the surface, unlike the mention handler, because it does not
  // need one: what needs the surface is the prompter, and that is applied on
  // top of the router rather than inside it. Both entry points share this one
  // router — and must, since a second would mean a second session registry and
  // therefore two mutexes over one channel.
  const route = createChannelRouter({
    sheets: deps.sheets,
    sessions,
    names,
    ...(deps.memory !== undefined ? { memory: deps.memory } : {}),
    ...(deps.recall !== undefined ? { recall: deps.recall } : {}),
    ...(deps.embed !== undefined ? { embed: deps.embed } : {}),
    ...(deps.skills !== undefined ? { skills: deps.skills } : {}),
    ...(deps.skillRecall !== undefined ? { skillRecall: deps.skillRecall } : {}),
    ...(deps.sharedSkillPool !== undefined ? { sharedPool: deps.sharedSkillPool } : {}),
    task: createTaskRunner({
      completion: deps.completion,
      transport: deps.transport,
      logger,
      ...(deps.sharedSkills !== undefined ? { sharedSkills: deps.sharedSkills } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {})
    }),
    logger,
    ...clock
  });

  // A follow-up's card goes in the follow-up's own thread, so the factory is
  // applied per message rather than shared with the mention handler. It closes
  // over `prompter`, which is assigned below — safe for the same reason
  // `handleMention` is: nothing dispatches before `start()`.
  const ingest = createMessageIngest({
    sessions,
    names,
    route,
    onHeld: target => prompter?.(target),
    checklist: target => checklists?.(target),
    ...(deps.summarize !== undefined ? { summarize: deps.summarize } : {}),
    ...(deps.embedSkills !== undefined ? { embedSkills: deps.embedSkills } : {}),
    ...(deps.lifecycleSkills !== undefined ? { lifecycleSkills: deps.lifecycleSkills } : {}),
    ...(deps.curateSkills !== undefined ? { curateSkills: deps.curateSkills } : {}),
    logger,
    ...clock
  });

  // The other half of the same subscription, on the same sessions — so a
  // deletion reaches the file the append opened rather than a second handle on
  // it. It needs neither the router nor the card poster: nothing is answered and
  // nothing is posted, which is why it is built here in one line rather than
  // knotted into the closures above.
  const revisions = createRevisionIngest({ sessions, logger });

  const surface = deps.slack({
    // The prompter needs the surface's card poster and the surface needs the
    // handler, so the handler closes over a binding assigned just below. Safe:
    // nothing dispatches a mention before `start()`, and `handleMention` exists
    // the moment this function returns.
    handler: mention => handleMention(mention),
    // A click becomes a settled wait by way of the proxy — see
    // approvals/decisions.ts for the ordering and what each answer means.
    onDecision: createDecisionHandler({ registry, approvals, logger }),
    // Built above, over the same closure trick: it reaches the prompter, which
    // reaches this surface's cards.
    onMessage: ingest,
    onRevision: revisions
  });

  // `now` and `scheduler` reach the prompter and nothing else. They are the
  // approval deadline's clock, and routing the same injected scheduler into the
  // gateway's reconnect ladder would put timers a test did not ask about into
  // the queue it is asserting on.
  const cards = surface.cards;
  const prompter =
    cards === undefined
      ? undefined
      : createHeldCallPrompter({
          cards,
          registry,
          logger,
          ...(deps.now !== undefined ? { now: deps.now } : {}),
          ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {})
        });

  // The checklist rides the same card poster, and degrades the same way: a
  // front-end with nowhere to put a card runs tasks that post only their answer,
  // which is what every front-end did before #68.
  //
  // **`deps.scheduler` deliberately does not reach it**, which is the rule
  // stated just above turned on a second consumer: that scheduler is the
  // approval deadline's, and a test firing the next pending timer to expire a
  // ticket must not find an edit floor in the queue instead. The floor is a
  // duration rather than a moment and nothing outside this file asserts on it,
  // so the real timer is right here and `checklist.test.ts` injects its own.
  const checklists =
    cards === undefined ? undefined : createChecklistReporter({ cards, logger });

  // Slack in, request out, and everything below that mapping is transport
  // neutral: the router serializes per channel, the resolver reads that
  // channel's sheet, the runner runs one task on what the sheet said. The
  // prompter and checklist factories ride the same seam the reply does — the
  // mention's channel and thread are captured in handler.ts, and the router sees
  // two closures.
  const handleMention = createMentionHandler(route, prompter, checklists);

  // The ambient clock (#317). Built here rather than by the process because the
  // session registry is here, and a scheduler with its own would hold a second
  // mutex over every channel it ticked.
  //
  // The workspace is read off the gateway per scan rather than captured now: it
  // arrives during `start()`, from `auth.test`, and a scheduler that had read it
  // at composition time would hold `undefined` forever. This is the same
  // late-binding the `names` lookup above does with the user directory, and for
  // the same reason.
  // The one posting capability in this process (#318), and the only place it is
  // minted. Nothing below is handed it except the heartbeat factory.
  //
  // Built from `surface.channel` rather than from `surface.cards`, which is the
  // distinction the gateway draws: a card answers a held tool call and needs a
  // thread from an inbound event; this is a message with no event behind it. The
  // window that governs how often it may be used lives in the poster, not here
  // — see `HEARTBEAT_POST_WINDOW_MS`.
  const proactive: ProactivePoster | undefined =
    surface.channel === undefined
      ? undefined
      : createProactivePoster({
          poster: surface.channel,
          logger,
          ...(deps.proactiveClock !== undefined ? { now: deps.proactiveClock } : {})
        });

  // No poster, no heartbeat. Everything a heartbeat produces is a post, so a
  // turn built without one would spend model calls to reach a surface it does
  // not have — worse than the clock with no reader this composition already
  // supports, where a due channel logs `ambient_due` and runs nothing.
  const heartbeat =
    deps.heartbeat !== undefined && proactive !== undefined
      ? deps.heartbeat(proactive)
      : undefined;

  // Same rule, same reason: everything a fired check produces is a post, so one
  // built without a poster would spend a model call to reach a surface it does
  // not have. Without it the clock logs a due ticket and leaves it pending.
  const fireTask =
    deps.fireTask !== undefined && proactive !== undefined
      ? deps.fireTask(proactive)
      : undefined;

  // And a third time, for a standing rule (#461). Same rule, same reason: a rule's
  // whole output is a post, so one built without a poster would spend a model call
  // to reach a surface it does not have. Without it the clock logs a due rule and
  // runs nothing — and unlike a ticket there is nothing left pending, because the
  // next occurrence is computed rather than stored.
  const fireRule =
    deps.fireRule !== undefined && proactive !== undefined
      ? deps.fireRule(proactive)
      : undefined;

  const ambient =
    deps.channels === undefined
      ? undefined
      : createAmbientScheduler({
          channels: deps.channels,
          sessions,
          workspace: () => surface.gateway.workspace,
          settings: async channel => {
            const settings = await deps.sheets(channel);
            return {
              enabled: settings.ambient.enabled,
              heartbeat: settings.ambient.heartbeat,
              heartbeatEveryMs: settings.ambient.heartbeatEveryMs,
              rules: settings.ambient.rules
            };
          },
          ...(heartbeat !== undefined ? { heartbeat } : {}),
          ...(fireTask !== undefined ? { fireTask } : {}),
          ...(fireRule !== undefined ? { fireRule } : {}),
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          logger
        });

  return { gateway: surface.gateway, registry, ...(ambient === undefined ? {} : { ambient }) };
}
