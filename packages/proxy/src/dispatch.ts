// What happens past the decision.
//
// Three seams now: the spend meter, the dispatcher that serves an allowed call,
// and the catalog that asks an upstream what it offers. They are here rather
// than inside the routes because a route's job ends at the decision, and
// everything past it is credentials, connections, and accounting — none of
// which a route owns.
//
// All three are required options on the server rather than defaulted ones. A
// deployment that silently meters zero spend because someone left an option
// out is exactly the failure worth designing away, and a default is how that
// happens — the omission has to be a type error, not a quiet allow.
//
// The catalog is a separate interface from the dispatcher even though one
// object implements both, for the reason `SpendMeter` is split into three
// below: the listing route closes over `ToolCatalog` and nothing wider, so a
// route that asks an upstream what it offers has no method that runs anything.
// One interface with both would also break what the server's tests assert
// against a recording dispatcher — that a refused or held call leaves no trace
// there — by putting listing traffic on the same seam.

import type { BudgetSpend, CallLimits, Target } from "./enforce.js";
import type { XMcpHeaderDeclaration } from "./vendor/mcp-param-headers.js";
import type {
  BudgetLimit,
  BuiltinToolName,
  McpServer,
  ResolvedToolCall,
  TokenUsageReport,
  ToolInputSchema,
  ToolRefusal,
  ToolResult
} from "@getlibero/schema";

/**
 * How much this channel has spent today.
 *
 * Raw counters, never a verdict: enforcement compares them against the sheet,
 * because the comparison and the weighting are policy and live with the sheet.
 * ./budget-meter.ts is the implementation, and it owns persistence and
 * rollover.
 *
 * **A read can be stale by the calls in flight beside it.** The server reads
 * here, decides, and only then records, so two concurrent calls for one channel
 * can both see the count below the cap and both be served. The overshoot is
 * bounded by that channel's concurrency — a task's loop is sequential — and the
 * property that matters survives it: a runaway loop overshoots once and is then
 * refused for the rest of the day. Tokens lag further by construction, since a
 * turn's tokens are reported after the calls they paid for. Closing the window
 * means holding a per-channel lock across read → decide → record, which is a
 * clean change and not this seam's job.
 */
export interface SpendReader {
  read(channel: string): BudgetSpend | Promise<BudgetSpend>;
}

/**
 * Counts a call the proxy has committed to serving.
 *
 * No count parameter. It is called once per served call, from one place, and a
 * caller that could write "5" is a caller that could write "0".
 */
export interface ToolCallRecorder {
  recordToolCall(channel: string): void | Promise<void>;
}

/**
 * Records what a turn cost, once.
 *
 * Separate from `ToolCallRecorder` rather than one `record({tokens, calls})`,
 * and the split is load-bearing. The tool-call count is written by the proxy
 * from its own observation; the token count is written from a report the agent
 * sends. One method would make it structurally possible for the report route to
 * write a tool-call count — and `daily_tool_calls` holding under agent
 * compromise is precisely the property that would cost.
 *
 * The report route (./spend-route.ts) closes over this interface and nothing
 * wider, so it cannot read a counter either.
 */
export interface TokenRecorder {
  /**
   * `model` is the id the provider echoed back, or absent when it echoed none
   * (#62). It is a **dimension of the count** — which row the tokens land in —
   * and never an authorization input: an implementation may not read a sheet on
   * it, and an absent one is metered under a reserved bucket rather than being
   * refused here. What that bucket costs a channel is `./enforce.ts`'s answer,
   * on the next call, from the sheet.
   */
  recordTokens(
    channel: string,
    turn: string,
    usage: TokenUsageReport,
    model?: string
  ): SpendRecord | Promise<SpendRecord>;
}

/**
 * Whether a report moved the meter. `duplicate` is the right answer to a retry
 * and is not a failure — nothing was denied, because reporting is not asking.
 */
export type SpendRecord = { readonly outcome: "recorded" | "duplicate" };

/**
 * Takes a channel's one soft-limit warning for a limit, for today (#99).
 *
 * `true` to the caller that took it, `false` to every caller after — so the
 * decision to *deliver* is this call's answer rather than something the server
 * works out from a counter it read a moment ago. Two concurrent calls that both
 * cross the threshold race here, and one of them loses.
 *
 * A fourth interface rather than a method on `SpendReader`, on `TokenRecorder`'s
 * argument: the report route closes over the recorder alone and must not be able
 * to spend a channel's warning, and a reader that could take one would be a read
 * with a side effect. It writes no counter, so nothing about who may call it
 * bears on what a channel can be charged.
 */
export interface WarningClaimer {
  claimWarning(channel: string, limit: BudgetLimit): boolean | Promise<boolean>;
}

export interface SpendMeter extends SpendReader, ToolCallRecorder, TokenRecorder, WarningClaimer {}

/**
 * Marks a provisional implementation.
 *
 * A symbol rather than a name or an `instanceof`, so the mark cannot be set by
 * accident and does not widen the interfaces: a real implementation has no way
 * to acquire it without importing this and saying so.
 */
const PROVISIONAL = Symbol("libero.provisional");

type Provisional<T> = T & { readonly [PROVISIONAL]: true };

export function markProvisional<T extends object>(value: T): Provisional<T> {
  return Object.assign(value, { [PROVISIONAL]: true as const });
}

function isProvisional(value: object): boolean {
  return PROVISIONAL in value;
}

/**
 * What serving an allowed call produced.
 *
 * A result type rather than exceptions, matching `Decision` and
 * `ChannelIdentity`: on this path a thrown value can carry a credential in its
 * message, so the states worth distinguishing are enumerated instead.
 *
 * `refused` is here as well as in `decide` because one refusal reason cannot be
 * answered from the team sheet alone: `credential_unresolved` needs the vault
 * (#51). That is a refusal discovered while serving, not a permission denied
 * before it.
 *
 * `egress_denied` is **not** one of these, though an earlier note here guessed
 * it would be. The destination of an MCP call comes from the `[[mcp_server]]`
 * block that authorized the tool, so nothing about it is discovered at dispatch
 * time; `[egress]` governs the destinations the sheet does not pin, and its
 * first caller is the sandbox runner. See packages/schema/src/egress.ts.
 */
export type Dispatch =
  | { readonly outcome: "ran"; readonly result: ToolResult }
  | { readonly outcome: "refused"; readonly refusal: ToolRefusal }
  /** No upstream is built. Becomes a 501, not a refusal: nothing was denied. */
  | { readonly outcome: "unavailable" };

/**
 * Serves an allowed call.
 *
 * The seam ./http-dispatcher.ts fills, and behind it the MCP client pool. The
 * server calls this **only** on an `allow`,
 * which is the property the tests assert against a recording implementation: a
 * refused or held call must leave no trace here, because reaching this
 * interface at all is what opens a connection and resolves a secret.
 *
 * `target` is what enforcement matched, passed in rather than looked up. A
 * dispatcher that resolved the sheet itself could get a different answer than
 * the decision did — sheets are watched and reload on file change — and would
 * then send the call somewhere nothing approved. See the note on `Decision` in
 * ./enforce.ts. It also keeps this interface free of the sheet store, so a
 * dispatcher cannot read policy it has no business reading.
 *
 * It is a union because a permitted call may be served by an upstream or by this
 * process itself (#64), and both arrive here having passed the same gate. A
 * built-in reachable any other way would be the bypass that design exists to
 * rule out, and the type is what rules it out: the only source of a `Target` is
 * a `Decision`.
 *
 * `limits` arrives the same way and for the same reason — resolved once by the
 * decision that authorized the call, rather than looked up here against a sheet
 * that may have reloaded since. It holds what the *channel* set; the bound on
 * bytes read off the wire is the deployment's and reaches the client through its
 * own options, so nothing on this interface can raise it.
 */
export interface ToolDispatcher {
  dispatch(call: ResolvedToolCall, target: Target, limits: CallLimits): Dispatch | Promise<Dispatch>;
}

/**
 * Serves a call bound for an MCP upstream.
 *
 * ./http-dispatcher.ts fills this, and it takes an `McpServer` rather than a
 * `Target` deliberately: the arm that holds the vault and the client pool
 * structurally cannot be handed a built-in, so there is no branch in it that
 * could mistake one for an upstream with a missing url. `createToolDispatcher`
 * is the only thing that narrows, and it is a switch with no I/O.
 */
export interface McpToolDispatcher {
  dispatch(call: ResolvedToolCall, upstream: McpServer, limits: CallLimits): Dispatch | Promise<Dispatch>;
}

/**
 * Serves a call this process implements itself.
 *
 * Narrower than `ToolDispatcher` on both ends, and each narrowing is the point.
 * It takes a `BuiltinToolName` rather than a `Target`, so it structurally cannot
 * be handed an upstream; and it is synchronous, because every built-in so far
 * reads a local SQLite file and a promise here would invite one that does not.
 *
 * It lives behind `createToolDispatcher` rather than being wired into the server
 * directly, so `ToolDispatcher` stays the one seam the server holds.
 */
export interface BuiltinDispatcher {
  run(call: ResolvedToolCall, tool: BuiltinToolName, limits: CallLimits): Dispatch;
}

/**
 * The two arms, as the one seam the server holds.
 *
 * A composite rather than a branch inside `HttpDispatcher`, and the reason is
 * what each arm is allowed to hold. `HttpDispatcher` owns a vault and a client
 * pool; the built-in owns a path to a directory of channel stores. Neither
 * should be able to reach the other's, and a single object implementing both
 * would hold both. Here the switch is the only thing that holds either, and it
 * is four lines with no I/O.
 *
 * **Provisional iff both arms are.** `assertServableComposition` asks whether a
 * dispatcher can really serve a call; this one can if either arm can, so a real
 * built-in beside the unavailable MCP dispatcher still demands a real meter —
 * which is right, because a built-in draws on the same budget.
 */
export function createToolDispatcher(arms: {
  readonly mcp: McpToolDispatcher;
  /**
   * Optional, defaulting to the unavailable arm.
   *
   * A composition with no store root to read is every test that is not about
   * built-ins, and it degrades to a 501 — the same honest answer an unbuilt
   * upstream gives. It is not a silent degradation: a channel whose sheet grants
   * a built-in gets `not_implemented`, which says the sheet is right and the
   * process is not finished. `apps/proxy-server` always passes a real one.
   */
  readonly builtin?: BuiltinDispatcher;
}): ToolDispatcher {
  const builtin = arms.builtin ?? createUnavailableBuiltinDispatcher();

  const dispatcher: ToolDispatcher = {
    dispatch(call, target, limits) {
      switch (target.kind) {
        case "mcp":
          return arms.mcp.dispatch(call, target.upstream, limits);
        case "builtin":
          return builtin.run(call, target.tool, limits);
      }
    }
  };

  return isProvisional(arms.mcp) && isProvisional(builtin)
    ? markProvisional(dispatcher)
    : dispatcher;
}

/**
 * A built-in arm with nothing behind it.
 *
 * The counterpart to `createUnavailableDispatcher`, for a composition that has
 * no store root to read — which is every test that is not about built-ins, and
 * nothing in production.
 */
export function createUnavailableBuiltinDispatcher(): Provisional<BuiltinDispatcher> {
  return markProvisional({ run: () => ({ outcome: "unavailable" }) as Dispatch });
}

/**
 * A dispatcher with nothing behind it.
 *
 * The honest state of the current deployment: enforcement is real and works,
 * and a call it permits has nowhere to go. Answering 501 rather than a refusal
 * keeps the two readable apart — an operator seeing `not_implemented` knows
 * their team sheet is correct and the proxy is unfinished, which is true.
 */
export function createUnavailableDispatcher(): Provisional<McpToolDispatcher> {
  return markProvisional({ dispatch: () => ({ outcome: "unavailable" }) as Dispatch });
}

/**
 * What an upstream said about one of its tools, after the proxy bounded it.
 *
 * Both fields optional and both absent when the upstream could not be asked or
 * said nothing publishable. Nothing here identifies the tool: the map this
 * arrives in is keyed by name, and a name inside the value would be a second
 * copy that could disagree with the key.
 */
export interface UpstreamToolDescription {
  readonly description?: string;
  /**
   * Typed as the schema's shape rather than a bare record, because the bound
   * that produced it has already established the one thing that shape claims.
   * Carrying it in the type is what lets the listing route put this on the wire
   * without a second check nobody would keep in step with the first.
   */
  readonly inputSchema?: ToolInputSchema;
}

/**
 * What a dispatcher knows about a tool that its arguments do not say.
 *
 * Empty is a legitimate answer and the common one: most tools declare no
 * `x-mcp-header`, and a cold or failing catalog answers this way too. A call is
 * never blocked for want of one.
 */
export interface UpstreamCallDefinition {
  readonly paramDeclarations: readonly XMcpHeaderDeclaration[];
}

/**
 * What one upstream said about the tools a sheet named.
 *
 * **Two fields rather than one map, because there are two ways to have no
 * entry and they are different instructions to the caller.** A name absent from
 * `described` is the ordinary degradation this file's contract is built on — the
 * upstream was down, slow, unreachable, or said nothing publishable — and the
 * caller lists the sheet's own row. A name in `excluded` is a tool the proxy
 * walked, found, and will not put in front of the model at all.
 *
 * Only one thing goes in `excluded`, and ./mcp-catalog.ts owns the argument for
 * why the degradation narrows there and nowhere else. What matters here is that
 * a caller cannot conflate the two by accident: absence keeps its old meaning,
 * so every existing degradation still behaves exactly as it did.
 *
 * Excluding deauthorizes nothing. The sheet still names the tool and
 * ./enforce.ts still decides a call on it — this is what the model is shown,
 * which was never the enforcement.
 */
export interface CatalogAnswer {
  readonly described: ReadonlyMap<string, UpstreamToolDescription>;
  readonly excluded: ReadonlySet<string>;
}

/**
 * Asks an upstream what it offers, so a listing can carry real tool definitions.
 *
 * The seam ./mcp-catalog.ts fills, held by the same object that fills
 * `ToolDispatcher` — the only thing in this package holding a `Vault` and a
 * client pool at once. Two interfaces rather than one method added to the
 * dispatcher, for the reason in this file's header.
 *
 * **Never rejects for an upstream failure.** Down, slow, ambiguous, speaking a
 * transport this proxy cannot reach, answering bytes that are not MCP: every
 * one of those is an empty answer and a log line, because the listing is not the
 * enforcement and a tool with no schema is still a tool the sheet permits. The
 * one thing that does propagate is a `RedactionError`, which is not an upstream
 * failure but this proxy unable to guarantee its own boundary.
 *
 * `wanted` is the tool names the sheet named, and it is a **bound rather than
 * the intersection**. The intersection is done by the caller, which iterates
 * the sheet — so a catalog naming a tool the sheet does not cannot add one.
 * What `wanted` buys is that an upstream cannot hide a sheet's tool behind two
 * hundred decoys and run the caller out of its own caps.
 */
export interface ToolCatalog {
  describe(upstream: McpServer, wanted: readonly string[]): Promise<CatalogAnswer>;
}

/** The answer from a catalog that asked nothing: describe nothing, withhold nothing. */
export const NO_CATALOG_ANSWER: CatalogAnswer = Object.freeze({
  described: new Map<string, UpstreamToolDescription>(),
  excluded: new Set<string>()
});

/**
 * A catalog with nothing behind it: every tool stays as the sheet wrote it.
 *
 * **Deliberately absent from `assertServableComposition`.** A catalog cannot
 * serve a call and cannot spend a budget, so pairing a provisional one with a
 * real dispatcher is not the silent failure that check exists for — it is a
 * proxy publishing thin listings, which is a first-class state this design
 * already has a name and a fallback for. The omission is decided, not missed.
 */
export function createUnavailableCatalog(): Provisional<ToolCatalog> {
  return markProvisional({
    describe: async () => NO_CATALOG_ANSWER
  });
}

/**
 * Refuse to compose a proxy that would serve calls without metering them.
 *
 * The one combination that is not allowed to exist: a dispatcher that really
 * serves a call, alongside a meter that cannot exhaust a budget. Every other
 * pairing is fine — a real meter with the unavailable dispatcher is just a
 * deployment ahead of its upstream.
 *
 * **There is no provisional meter left for this to reject.** `#96` deleted
 * `createUnmeteredSpend()` and wired the real one, so the check currently
 * cannot fire in this repository. It stays because the pairing it guards is the
 * thing that goes wrong next: the approval broker (#37), the MCP client pool
 * (#39), and the message store (#63) each land a seam before they land an
 * implementation, and a stand-in meter is the obvious way to test one of them.
 * The check is what catches that, rather than a reviewer noticing.
 *
 * A thrown error at construction rather than a warning in the log, because the
 * failure this prevents is silent by nature: an unmetered proxy does not
 * misbehave, it just never refuses, and nobody notices until a bill or an
 * incident. A process that will not start is noticed immediately.
 *
 * Deleting this check is a decision someone has to make deliberately, which is
 * the point of it being here rather than in a comment.
 */
export function assertServableComposition(spend: SpendMeter, dispatcher: ToolDispatcher): void {
  if (isProvisional(spend) && !isProvisional(dispatcher)) {
    throw new Error(
      "proxy: a dispatcher that serves tool calls needs a real spend meter — " +
        "a provisional meter never exhausts a budget (see createSqliteSpendMeter)"
    );
  }
}
