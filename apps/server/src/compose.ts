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
  DecisionHandler,
  Logger,
  MentionHandler,
  MessageHandler,
  Scheduler,
  SlackGateway,
  UserDirectory
} from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import { createDecisionHandler } from "./approvals/decisions.js";
import { createHeldCallPrompter } from "./approvals/prompter.js";
import { createApprovalRegistry } from "./approvals/registry.js";
import type { ApprovalRegistry } from "./approvals/registry.js";
import { createMentionHandler } from "./handler.js";
import { createMessageIngest } from "./ingest.js";
import type { DisplayNameLookup } from "./session/names.js";
import { createSessionRegistry } from "./session/registry.js";
import { createChannelRouter } from "./session/router.js";
import { createTaskRunner } from "./session/task.js";
import type { SheetResolver } from "./session/sheet.js";
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
}) => SlackSurfaceLike;

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
  /** Cancels every task in flight. Omitted by a caller with no shutdown to run. */
  readonly signal?: AbortSignal;
  /** Defaults to silent, so a test asserting on behaviour is not also a log sink. */
  readonly logger?: Logger;
  /** Injected for tests: the approval card's clock. Omitted in production. */
  readonly now?: () => number;
  /** Injected for tests: the approval deadline's timer. Omitted in production. */
  readonly scheduler?: Scheduler;
}

// Re-exported because this file is the package's entry point and a composition
// root cannot call `createServer` without building a `sheets` — index.ts does
// exactly this. Kept to the dependencies a caller must construct: the router,
// the task runner, and the handler are wired below and are nobody else's to
// build.
export { DEFAULT_HISTORY_BOUNDS, createSheetResolver } from "./session/sheet.js";
export type { SheetResolver } from "./session/sheet.js";
export type { DisplayNameLookup, NameCache } from "./session/names.js";
export { createMessageStoreOpener } from "./session/store.js";
export type { MessageStoreOpener, MessageStoreOpenerOptions } from "./session/store.js";
export type {
  ChannelSettings,
  HistoryBounds,
  SessionKey,
  TaskRequest,
  TaskReply,
  TaskSettings
} from "./session/types.js";

export interface Server {
  readonly gateway: SlackGateway;
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
  // no mutex at all. One registry, so both see the same session — and so a
  // channel's file is opened once rather than once per path.
  //
  // `deps.now` is not routed in. It is documented as the approval card's clock,
  // and the eviction clock is a different one: a test pinning the card's time
  // would silently freeze session ageing.
  const sessions = createSessionRegistry({
    logger,
    ...(deps.store !== undefined ? { openStore: deps.store } : {})
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

  const ingest = createMessageIngest({ sessions, names, logger });

  const surface = deps.slack({
    // The prompter needs the surface's card poster and the surface needs the
    // handler, so the handler closes over a binding assigned just below. Safe:
    // nothing dispatches a mention before `start()`, and `handleMention` exists
    // the moment this function returns.
    handler: mention => handleMention(mention),
    // A click becomes a settled wait by way of the proxy — see
    // approvals/decisions.ts for the ordering and what each answer means.
    onDecision: createDecisionHandler({ registry, approvals, logger }),
    // No closure trick needed: unlike the mention handler, the ingest does not
    // depend on the surface, so it exists before this call.
    onMessage: ingest
  });

  // Slack in, request out, and everything below that mapping is transport
  // neutral: the router serializes per channel, the resolver reads that
  // channel's sheet, the runner runs one task on what the sheet said. The
  // prompter factory rides the same seam the reply does — the mention's channel
  // and thread are captured in handler.ts, and the router sees a closure.
  //
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

  const handleMention = createMentionHandler(
    createChannelRouter({
      sheets: deps.sheets,
      sessions,
      names,
      task: createTaskRunner({
        completion: deps.completion,
        transport: deps.transport,
        logger,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {})
      }),
      logger
    }),
    prompter
  );

  return { gateway: surface.gateway, registry };
}
