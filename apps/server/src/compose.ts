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
  Scheduler,
  SlackGateway
} from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import { createDecisionHandler } from "./approvals/decisions.js";
import { createHeldCallPrompter } from "./approvals/prompter.js";
import { createApprovalRegistry } from "./approvals/registry.js";
import type { ApprovalRegistry } from "./approvals/registry.js";
import { createMentionHandler } from "./handler.js";
import { createChannelRouter } from "./session/router.js";
import { createTaskRunner } from "./session/task.js";
import type { SheetResolver } from "./session/sheet.js";

/**
 * The Slack side, once built.
 *
 * Structurally `SlackSurface` from @getlibero/gateway, restated here so this
 * file does not require the surface to have come from `createSlackSurface` — a
 * test builds one over `createStubSlack` instead.
 */
export interface SlackSurfaceLike {
  readonly gateway: SlackGateway;
  readonly cards: CardPoster;
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
  /** Cancels every task in flight. Omitted by a caller with no shutdown to run. */
  readonly signal?: AbortSignal;
  /** Defaults to silent, so a test asserting on behaviour is not also a log sink. */
  readonly logger?: Logger;
  /** Injected for tests: the approval card's clock. Omitted in production. */
  readonly now?: () => number;
  /** Injected for tests: the approval deadline's timer. Omitted in production. */
  readonly scheduler?: Scheduler;
}

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

  const surface = deps.slack({
    // The prompter needs the surface's card poster and the surface needs the
    // handler, so the handler closes over a binding assigned just below. Safe:
    // nothing dispatches a mention before `start()`, and `handleMention` exists
    // the moment this function returns.
    handler: mention => handleMention(mention),
    // A click becomes a settled wait by way of the proxy — see
    // approvals/decisions.ts for the ordering and what each answer means.
    onDecision: createDecisionHandler({ registry, approvals, logger })
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
  const handleMention = createMentionHandler(
    createChannelRouter({
      sheets: deps.sheets,
      task: createTaskRunner({
        completion: deps.completion,
        transport: deps.transport,
        logger,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {})
      }),
      logger
    }),
    createHeldCallPrompter({
      cards: surface.cards,
      registry,
      logger,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.scheduler !== undefined ? { scheduler: deps.scheduler } : {})
    })
  );

  return { gateway: surface.gateway, registry };
}
