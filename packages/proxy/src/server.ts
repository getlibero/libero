// The tool proxy's HTTP surface.
//
// Node's own https server and an exact-match route table, no framework. This
// process holds every credential in the deployment, so its dependency list is
// a security property in its own right.
//
// The rule, stated as what is actually enforced rather than as "zero": nothing
// third-party here beyond what reading a team sheet and speaking MCP require,
// and each of those was a decision with a written record. Reading a sheet is
// zod and smol-toml, reached through @getlibero/schema. Speaking MCP is
// `@modelcontextprotocol/client` and its tree, adopted in #185 after a
// dependency audit, a custody spike and a licence check, and implemented in
// #188. A framework, a logger, a TOML parser, or a *second* HTTP client this
// process pulls in directly are all still things a reviewer should reject. The
// claim was previously "zero", which was never quite true: zod has been in this
// tree since the first team-sheet import.
//
// The MCP client is allowed the one thing nothing else here is — it drives the
// wire — and what makes that acceptable is that it cannot reach the network
// except through the `fetch` ./mcp-client.ts hands it, which is ./outbound.ts's
// guarded fetch: still the only function that reveals a credential, still the
// only one that scrubs a reply. An ESLint ban, a `boundary-check` grep and a
// test in outbound.test.ts each keep the SDK inside that one module.
//
// A version bump of it is a security review rather than a chore, for the reason
// this paragraph exists at all: it lands inside the process that holds every
// credential in the deployment. See packages/proxy/README.md for the two
// questions such a review has to answer.
//
// Every request that reaches a route has already proved two things: it opened
// a connection with a certificate the local CA signed, and that certificate
// named a channel. Routes therefore receive a channel id rather than deriving
// one, and no route may accept a channel from a header, a query parameter, or
// a body.
//
// Three of the routes below take a body, and only one of them decides whether
// anything may run. `/v1/tools/call` is the gate. `/v1/spend` is a write to the
// budget meter and nothing else. `/v1/approvals` records what a human said
// about a call the gate already held — it authorizes nothing on its own, and
// the call it concerns still has to come back through the gate and be enforced
// again. None of the three shares a handler, and only the first resolves a team
// sheet; see ./spend-route.ts and ./approvals-route.ts, where each states the
// asymmetry and what keeps it.
//
// The MCP client pool sits behind the dispatcher seam, past the point where
// enforcement has already answered. Credential injection is built —
// ./http-dispatcher.ts resolves a credential and ./outbound.ts attaches it —
// but no route reaches the vault even so: a credential is resolved by whatever
// serves an allowed call, and this file hands that a decision rather than a
// secret.
//
// One route now holds an interface that *asks* an upstream a question — the
// listing, through `ToolCatalog` — and that is not the same thing as holding
// the pool. `ToolCatalog` has no method that runs anything, and the object
// behind it resolved the credential in the module that holds the vault. This
// file still holds neither a vault nor a pool, and ./listing-route.ts states
// what it cannot reach and has an ESLint block saying so.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type ServerOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import {
  type AuditOutcome,
  PROXY_ERROR_STATUS,
  type ProxyError,
  type ProxyErrorCode,
  type RefusalReason,
  type ResolvedToolCall,
  ToolCall,
  type ToolCallResponse,
  type ToolRefusal,
  type ToolResult,
  resolveToolCall
} from "@getlibero/schema";
import { createApprovalStore, type RedeemResult } from "./approvals.js";
import { createApprovalsRoute } from "./approvals-route.js";
import { type AuditWriter, hashArguments } from "./audit-log.js";
import {
  assertServableComposition,
  type SpendMeter,
  type ToolCatalog,
  type ToolDispatcher
} from "./dispatch.js";
import { decideFromState } from "./enforce.js";
import { matchesPin, resolveChannel } from "./identity.js";
import { createListingRoute } from "./listing-route.js";
import { createJsonLogger, type Logger } from "./log.js";
import { createSpendRoute } from "./spend-route.js";
import { NO_PRICES } from "./price-table-store.js";
import type { PriceTableStore } from "./price-table-store.js";
import type { TeamSheetStore } from "./team-sheet-store.js";

/**
 * The most a tool call may weigh.
 *
 * A tool call is an id, two names, and the model's arguments. A megabyte is
 * already far more than any of that, and the cap exists so a client cannot
 * make this process buffer without bound — the check runs before the bytes are
 * kept, not after.
 */
export const MAX_BODY_BYTES = 1_048_576;

export interface ProxyServerOptions {
  /** From `loadTlsOptions`. Passed through to the https server verbatim. */
  tls: ServerOptions;
  /** Resolves the team sheet that authorizes each channel. */
  sheets: TeamSheetStore;
  /**
   * The operator's price table (#62), read once per decision.
   *
   * Read here rather than resolved inside `decide`, which is pure and must stay
   * so — and read per call rather than at startup, so a corrected price
   * re-prices today's spend on the channel's next call exactly as a sheet edit
   * takes effect on it. `NO_PRICES` is a real value and the right default: a
   * deployment with no table prices nothing, which refuses a channel that caps
   * in dollars and changes nothing for one that does not.
   */
  prices?: PriceTableStore;
  /**
   * Required, not defaulted, both of them. See the note in ./dispatch.ts: a
   * missing meter that reads as unmetered, or a missing dispatcher that reads
   * as permissive, are the two ways an option with a default goes wrong here.
   */
  spend: SpendMeter;
  dispatcher: ToolDispatcher;
  /**
   * Asks each upstream what its tools take, so a listing carries real
   * definitions. Required on the same argument as the two above, and it is
   * about legibility rather than safety: a catalog can widen nothing, but an
   * optional one defaults to thin listings forever, and a deployment that left
   * it out would look exactly like one whose upstreams are all slow. The
   * omission should be a type error. `createUnavailableCatalog()` is the
   * deliberate way to say "publish thin".
   */
  catalog: ToolCatalog;
  /**
   * Where every decided call is recorded. Required on the same argument, and
   * the argument is strongest here: an optional writer defaults to *no audit*,
   * and a proxy serving calls with no durable record misbehaves in no visible
   * way at all — there is simply nothing to read after an incident. `logger`
   * and `now` below are optional because each has a correct default. "Not
   * audited" is not a correct default for anything.
   */
  audit: AuditWriter;
  logger?: Logger;
  /** Clock, injected for tests. */
  now?: () => number;
}

/** What a route is handed. The channel is authenticated, not asserted. */
export interface RequestContext {
  readonly channel: string;
  readonly requestId: string;
  /**
   * The parsed JSON body, for routes that asked for one, and `undefined` for
   * every other route. `unknown` rather than a shape: this has been through
   * `JSON.parse` and nothing else, and the route validates it against a schema
   * before reading a field off it.
   */
  readonly body: unknown;
}

/** An HTTP status and the body to serialize. */
export interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
}

/** May return a promise; the dispatcher resolves it before serializing. */
export type RouteHandler = (ctx: RequestContext) => RouteResponse | Promise<RouteResponse>;

interface Route {
  readonly handler: RouteHandler;
  /**
   * Whether this route reads a request body. Opt-in, so the default stays
   * "drain it": a route that does not declare a body cannot be made to consume
   * one, and adding a route does not require remembering to.
   */
  readonly body?: "json";
}

const ok = (body: unknown): RouteResponse => ({ status: 200, body });

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "too_large" | "malformed" };

/**
 * Read a JSON request body, refusing to buffer past the cap.
 *
 * Two checks, not one. `content-length` is a claim by the client and is
 * honoured only as an early exit; the running total is what actually bounds
 * memory, because a chunked request can omit the header or lie about it.
 *
 * Past the cap the buffer is dropped and the rest of the body is **drained,
 * not refused mid-flight**. Destroying the socket would bound memory just as
 * well and is the first thing to reach for, but it races the response: a client
 * still writing its body gets EPIPE and never reads the 413, so the operator's
 * symptom becomes a broken pipe rather than "the body was too large". Draining
 * costs only the read — nothing past the cap is retained — and buys an answer
 * the caller can act on.
 *
 * A malformed body is not distinguished from an empty one here. Both fail the
 * route's schema parse, and the caller learns its body was not a valid call
 * either way.
 */
function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise(resolve => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (read: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(read);
    };
    const tooLarge = (): void => {
      // Drop what was buffered; from here the stream is read and discarded.
      chunks = [];
      settle({ ok: false, reason: "too_large" });
    };

    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) tooLarge();

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        // The parse error is not kept. It quotes the input, and the input is
        // written by the model.
        settle({ ok: false, reason: "malformed" });
      }
    });
    // A connection that dies mid-body is not a request the proxy can answer,
    // and it must not leave this promise pending and the response open.
    req.on("error", () => {
      settle({ ok: false, reason: "malformed" });
    });
    req.resume();
  });
}

function proxyError(
  code: ProxyErrorCode,
  message: string,
  requestId: string,
  channel?: string
): ProxyError {
  return {
    error: {
      code,
      message,
      requestId,
      ...(channel !== undefined ? { channel } : {})
    }
  };
}

/**
 * The refusal for a re-submission that was not served.
 *
 * Total over the redeem outcomes that are not `redeemed`, so a new state in
 * ./approvals.ts cannot be added without deciding what a channel is told about
 * it — the same discipline `refusalMessage` imposes one level down.
 *
 * Each names the *submitted* call rather than the ticketed one. The reader is in
 * the channel that raised both, so a second server/tool pair in the sentence
 * would add length rather than information.
 */
function approvalRefusal(
  outcome: Exclude<RedeemResult["outcome"], "redeemed">,
  call: ResolvedToolCall
): ToolRefusal {
  const where = { server: call.server, tool: call.tool } as const;
  switch (outcome) {
    case "unknown":
      return { reason: "approval_unknown", ...where };
    case "pending":
      return { reason: "approval_pending", ...where };
    case "denied":
      return { reason: "approval_denied", ...where };
    case "spent":
      return { reason: "approval_spent", ...where };
    case "mismatch":
      return { reason: "approval_mismatch", ...where };
    case "expired":
      return { reason: "approval_expired", ...where };
  }
}

export function createProxyServer(options: ProxyServerOptions): Server {
  // Before anything binds. A proxy that would serve tool calls without
  // metering them does not get built.
  assertServableComposition(options.spend, options.dispatcher);

  const logger = options.logger ?? createJsonLogger();
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  /**
   * The approval broker's tickets.
   *
   * Built here rather than passed in on `ProxyServerOptions`, and that is
   * deliberate in both directions. It opens no file, takes no configuration, and
   * has nothing for a shutdown handler to close, so there is nothing an operator
   * would configure. And an injectable ticket store is a knob a future
   * composition could get wrong — handing the decision route something wider
   * than `ApprovalDecider` is exactly the mistake ./approvals.ts is shaped to
   * prevent, and it cannot be made from out here if the store is not out here.
   *
   * It shares this server's clock, so one process has one notion of when a
   * ticket dies.
   */
  const approvals = createApprovalStore({ now });

  /**
   * The tool listing: what this channel may call, and what those tools take.
   *
   * Not the enforcement — the call-time gate below is, and it holds on its own
   * against a tool that was never listed or was listed and has since been
   * removed. This keeps an unlisted tool out of the model's context, which is
   * worth doing and is not the same thing.
   *
   * Its own module since it began asking upstreams, so the claim about what it
   * cannot reach is a file an ESLint block can name. See ./listing-route.ts.
   */
  const listTools = createListingRoute({
    sheets: options.sheets,
    catalog: options.catalog,
    logger,
    ok
  });

  /**
   * The call-time gate. Order in here is the security property.
   *
   * The decision runs before anything else is touched: no credential is
   * resolved, no connection is opened, and the dispatcher is not reached
   * unless the answer was `allow`. A refused call must leave no trace upstream,
   * and the way that is true is that the only call to `options.dispatcher`
   * sits inside the `allow` branch.
   *
   * **Every call this route decides leaves exactly one audit row**, and that is
   * now total over the region below rather than true of the paths that worked.
   * Served, held, refused, permitted-with-no-upstream — and `unanswered` when
   * the handler threw before it could answer at all, written from the catch that
   * wraps everything downstream of the decision (#124). The rule holds in both
   * directions: no decided call escapes without a row, and none gets two.
   *
   * What leaves no row is what arrives *before* a decision, because until then
   * there is no call to describe:
   *
   *   - A body that fails `ToolCall.safeParse` (`tool_call_malformed`). There is
   *     no server, tool, task or requesting user to record. A row of nulls would
   *     be worse than the line: it would be counted.
   *   - A body over `MAX_BODY_BYTES`, rejected before it is parsed.
   *   - A throw out of `options.sheets.resolve`, `options.spend.read`, or
   *     `hashArguments` — everything above `decideFromState`. These reach the
   *     outer handler's catch (`handler_failed`) with a log line and no row, and
   *     that is the rule rather than a gap: nothing has been decided, nothing was
   *     metered, and no upstream was reached.
   *
   * The decision is what makes a row's subject exist, which is why the catch
   * opens where it does and not higher.
   */
  const callTool = async (ctx: RequestContext): Promise<RouteResponse> => {
    // Strict, so a body asserting a channel fails here rather than having the
    // field dropped. The channel comes from the certificate, below.
    const parsed = ToolCall.safeParse(ctx.body);
    if (!parsed.success) {
      // The zod issues are not relayed. They quote the input, and the input is
      // written by the model.
      logger.log("warn", {
        event: "tool_call_malformed",
        requestId: ctx.requestId,
        channel: ctx.channel
      });
      return {
        status: PROXY_ERROR_STATUS.bad_request,
        body: proxyError(
          "bad_request",
          "the request body is not a valid tool call",
          ctx.requestId,
          ctx.channel
        )
      };
    }

    /**
     * The ticket comes off the call at the edge and travels beside it.
     *
     * `ResolvedToolCall` structurally permits a `ticket` — it is `ToolCall &
     * { channel }` — but no value in flight below carries one, so enforcement
     * and the dispatcher *provably* never see a ticket rather than merely never
     * reading one. Which is the stronger version of the rule `EnforcementInput`
     * states: `decide` is pure, has no clock, and reads no approval state,
     * because "may this channel call this" and "did a human approve this exact
     * call" are two questions and neither may stand in for the other.
     */
    const { ticket, ...bare } = parsed.data;
    const call = resolveToolCall(bare, ctx.channel);
    // Hoisted out of the audit closure below: the mint, the redemption, and the
    // row all need the same hash, and computing it three times would invite the
    // three to disagree.
    const argumentsSha256 = hashArguments(call.arguments);
    const [state, spend] = await Promise.all([
      options.sheets.resolve(ctx.channel),
      options.spend.read(ctx.channel)
    ]);
    /**
     * **Enforcement runs for a re-submission exactly as it does for a first
     * call, and it runs first.**
     *
     * A ticket is not a permission and must never act like one. Up to fifteen
     * minutes pass between a hold and the click that answers it, and in that
     * window an operator can remove the tool from the allowlist, remove the
     * server, repoint the upstream, or make the sheet ambiguous — and other
     * calls can exhaust the budget. A ticket that skipped this would let a
     * fifteen-minute-old click override an edit made thirty seconds ago, which
     * is an approval turning into a bypass: the thing the whole feature exists
     * to prevent.
     *
     * So the sheet is the only authority on "may this channel call this", and
     * the ticket answers the narrower question of whether a human approved this
     * exact call. The redemption below happens only after this says yes.
     */
    // Synchronous, and deliberately not in the `Promise.all` above: a sheet
    // resolve is per channel and may touch disk, while this is one in-memory
    // object for the whole process.
    const decision = decideFromState(state, call, spend, options.prices?.current() ?? NO_PRICES);

    /**
     * Whether `audit` below was entered, read only by the catch at the bottom of
     * this handler. The argument for entry rather than success is at the
     * assignment, because that is the line a later edit would move.
     */
    let audited = false;

    /**
     * Record what happened to this call: a durable row, then the log line.
     *
     * **The row is written first, and a failure to write it fails the request.**
     * Not wrapped in anything that swallows — the throw becomes the handler's
     * 500 and the call is not answered. That is the same rule the meter is held
     * to eleven lines below (*a meter that cannot write must not serve*), for a
     * stronger reason: a proxy that cannot record what it did has its whole
     * accountability property switched off, and the realistic failures here —
     * a full disk, a read-only mount, an I/O error — are operator conditions
     * that should stop this process rather than be ridden through. Swallowing
     * would make "every call produces a row" true only while nothing is wrong,
     * which is not what an audit log is for.
     *
     * The `ran` row is the uncomfortable one, because by then the upstream has
     * already acted: a throw there answers 500 for a call that really executed.
     * Writing the row before dispatch would remove that, and costs the two
     * fields only the result has; writing two rows would break one-row-per-call
     * and make every count downstream wrong. What makes the residual small is
     * that the file is opened at startup before anything binds, so a missing
     * directory, a read-only mount and a schema from the future are all startup
     * failures — leaving only "the disk filled between the meter write and this
     * one", where refusing to serve is the right answer anyway.
     *
     * A throw on the way *to* this call — out of the meter, the broker, or the
     * dispatcher — no longer costs the row at all. The catch below writes an
     * `unanswered` one instead, so the residual above is now the only way a
     * decided call goes unrecorded, and it is a write failure rather than a
     * structural gap.
     *
     * Row first, log line second: a line asserting an outcome that no durable
     * write recorded is the one ordering that can lie about this.
     */
    const audit = async (event: {
      readonly outcome: AuditOutcome;
      readonly reason?: RefusalReason;
      readonly result?: ToolResult;
      /** Present on a `ran` or `unanswered` row a human's approval let through. */
      readonly approver?: string;
      /** Present on every row for a call that passed through the broker. */
      readonly ticket?: string;
    }): Promise<void> => {
      // Set on *entry*, not on success, and the difference is load-bearing: this
      // flag is what the catch below reads to decide whether the call still needs
      // a row, and "we got here" is the only answer that is safe in both
      // directions. `append` can succeed and this function still throw
      // afterwards — `logger.log` writes to a stream and can fail on EPIPE — and
      // a success flag would then let the catch append a *second* row for a call
      // that already has one, breaking the invariant everything downstream
      // counts on. Set on entry, the worst case is a row that was never written
      // because the write itself is what failed, which is the case where a
      // second attempt would fail identically and has already been logged.
      //
      // Safe because this closure is called at most once per request: every call
      // site is immediately followed by a `return` in a mutually exclusive
      // branch, and the dispatch switch is exhaustive.
      audited = true;

      try {
        await options.audit.append({
          at: now(),
          channel: ctx.channel,
          // Attribution, carried through to the operator's record. Asserted by
          // the agent and read by no decision above — `decideFromState` has
          // already run by the time this closure is called, and it never sees
          // them.
          requestingUser: call.requestingUser,
          task: call.task,
          requestId: ctx.requestId,
          callId: call.id,
          server: call.server,
          tool: call.tool,
          // A hash, never the arguments. Nothing on this path holds a
          // credential value, so nothing on it could redact one — see
          // ./audit-log.ts for why that is the whole argument.
          argumentsSha256,
          outcome: event.outcome,
          ...(event.reason !== undefined ? { refusalReason: event.reason } : {}),
          ...(event.approver !== undefined ? { approver: event.approver } : {}),
          ...(event.ticket !== undefined ? { ticket: event.ticket } : {}),
          ...(event.result !== undefined
            ? {
                // Bytes, not `String.length`, which counts UTF-16 code units:
                // this number exists to correlate with the next turn's input
                // tokens, and tokenizers are byte-shaped.
                resultBytes: Buffer.byteLength(event.result.content, "utf8"),
                resultIsError: event.result.isError
              }
            : {})
        });
      } catch (error) {
        // The thrown value is not inspected or logged, as at the outer handler:
        // in this process an exception is a thing that can carry a credential.
        // Naming the subsystem is what an operator debugging the 500 needs.
        logger.log("error", {
          event: "audit_write_failed",
          requestId: ctx.requestId,
          channel: ctx.channel
        });
        throw error;
      }

      logger.log("info", {
        event: "tool_call",
        requestId: ctx.requestId,
        channel: ctx.channel,
        server: call.server,
        tool: call.tool,
        requestingUser: call.requestingUser,
        task: call.task,
        outcome: event.outcome,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.approver !== undefined ? { approver: event.approver } : {}),
        ...(event.ticket !== undefined ? { ticket: event.ticket } : {})
      });
    };

    /**
     * Who approved this call, for the `ran` row. Set only by a redemption.
     *
     * Never taken from the request body — there is no field on `ToolCall` for an
     * approver and there must not be, because that would be exactly the
     * "asserted by the agent and read by a decision" combination
     * `requestingUser`'s doc forbids. It comes from the ticket, which the
     * decision route wrote from a click the gateway observed.
     *
     * Declared out here rather than beside the redemption that sets it, so the
     * catch below can read it. That is the case worth having it for: a human
     * approved the call, the ticket was spent, and the proxy then answered
     * nothing.
     */
    let approver: string | undefined;

    /**
     * Everything downstream of the decision, so nothing downstream of it can
     * fail without leaving a row (#124).
     *
     * The row this catch writes is `unanswered`: the call was decided, it was
     * metered, it may have reached the upstream, and the handler then threw
     * before it could answer. The word claims nothing more than that, because
     * nothing more is known — and the realistic cause is a failure on the
     * result's way back, by which time the tool has already run.
     *
     * **It opens here and not higher.** Above `decideFromState` there is no
     * decided call, so a row would assert an outcome for something nothing
     * decided; and it opens *after* the closure above rather than beside the
     * decision so the catch cannot reach `audit` in its temporal dead zone and
     * mask the real failure with a `ReferenceError`. Coverage is the same either
     * way — a function expression cannot throw.
     *
     * **It covers the meter write and the broker, not just the dispatcher.**
     * There is no statement at all between `recordToolCall` and `dispatch`, so
     * that window is empty by construction; what covering more buys is the
     * approval branches, which are in memory today and are the likeliest place
     * for someone to add an `await` later.
     *
     * **`catch` and not `finally`.** A `finally` cannot tell whether it is
     * unwinding, so the day someone adds an early `return` that legitimately
     * writes no row, it would file an `unanswered` one for a call that was
     * answered fine — a lie in a table nobody can amend. And a throw inside a
     * `finally` *replaces* the exception in flight, which is the masking this is
     * trying to avoid.
     *
     * **The catch cannot reach the result**, because `dispatched` is scoped
     * inside. That is deliberate rather than incidental: on a `RedactionError`
     * the result is bytes nobody could scrub, so the row is *unable* to measure
     * them rather than declining to.
     */
    try {
      // A refusal is refused whether or not a ticket came with it, and it is
      // refused *before* the ticket is touched. That ordering is what stops an
      // operator's edit during the hold from costing the human a second click:
      // the approval survives a refusal and can still be redeemed once the sheet
      // is fixed, inside the window.
      if (decision.outcome === "refuse") {
        // Awaited before the answer is composed. A fire-and-forget here would
        // look correct and would defeat the whole of the argument above.
        await audit({
          outcome: "refused",
          reason: decision.refusal.reason,
          ...(ticket !== undefined ? { ticket } : {})
        });
        // A refusal is a served request, not an error: 200 with the structured
        // shape. The agent relays it to the channel and carries on.
        return ok({ outcome: "refused", id: call.id, refusal: decision.refusal } satisfies ToolCallResponse);
      }

      if (ticket === undefined) {
        // A first submission. A hold mints a ticket and asks; anything else falls
        // through to the serve path exactly as it always did.
        if (decision.outcome === "hold") {
          const minted = approvals.mint(call, argumentsSha256);
          await audit({ outcome: "held", reason: decision.refusal.reason, ticket: minted.id });
          return ok({
            outcome: "held",
            id: call.id,
            refusal: decision.refusal,
            ticket: { id: minted.id, expiresAt: minted.expiresAt }
          } satisfies ToolCallResponse);
        }
      } else {
        const redeemed = approvals.redeem(ctx.channel, ticket, call, argumentsSha256);
        if (redeemed.outcome !== "redeemed") {
          const refusal = approvalRefusal(redeemed.outcome, call);
          // An expiry is a terminal fact about a ticket that no other request
          // will record, so it gets its own outcome — once, whoever observes it
          // first. Everything else here is an ordinary refusal: a denied ticket
          // already has its `denied` row, written by the decision route.
          await audit({
            outcome: redeemed.outcome === "expired" && redeemed.firstObserved ? "expired" : "refused",
            reason: refusal.reason,
            ticket
          });
          return ok({ outcome: "refused", id: call.id, refusal } satisfies ToolCallResponse);
        }
        approver = redeemed.ticket.approver ?? undefined;
      }

      // Falling through means one of two things: a first submission the sheet
      // allows outright, or a re-submission whose ticket was just spent. A third
      // case is possible and deliberately handled here rather than refused — the
      // operator set `approval = "none"` during the hold, so the decision is now
      // `allow` and the call runs on its own merits. The ticket is spent anyway,
      // because it named this exact call and leaving it live would let a second
      // re-submission run a second one, and the `ran` row still records the
      // approver: a human did approve it, and an operator reconstructing the
      // incident wants to know.

      // Counted at the moment the proxy commits to serving, not once the upstream
      // has answered. A crash between here and the reply loses the result, not
      // the count, and over-counting a call that then failed is the direction
      // that fails closed.
      //
      // A meter that cannot write must not serve. This is deliberately not
      // wrapped in anything that swallows: a throw becomes the handler's 500 and
      // the dispatcher below is never reached, because a served call that went
      // uncounted is an unmetered one — the exact state
      // `assertServableComposition` exists to prevent. The catch around it
      // records that the call went unanswered; it does not let it be served.
      await options.spend.recordToolCall(ctx.channel);

      // The target comes off the decision, not from a second lookup: the entry
      // that authorized the call is the entry the call goes to. See `Decision`.
      // It is also the only way to reach a built-in — there is no path to one
      // that has not been through `decide` (#64).
      const dispatched = await options.dispatcher.dispatch(call, decision.target, decision.limits);
      switch (dispatched.outcome) {
        case "ran": {
          await audit({
            outcome: "ran",
            result: dispatched.result,
            ...(approver !== undefined ? { approver } : {}),
            ...(ticket !== undefined ? { ticket } : {})
          });
          // The soft limit, and the one place it becomes a notice (#99).
          //
          // **Claimed here rather than beside the meter write**, because a claim
          // is spent whether or not anything is delivered: a call that reached
          // the upstream and came back `refused` or `unavailable` carries no
          // warning, and claiming before dispatch would burn the channel's one
          // notice on an answer that has nowhere to put it. This is the only
          // branch that can carry one, so it is the only branch that takes one.
          //
          // Not wrapped in anything that swallows, and it needs no argument of
          // its own: this is an insert into the file `recordToolCall` wrote to a
          // few statements ago, so a failure here is a failure there — and there
          // it is a 500 before the dispatcher is ever reached. A catch would be
          // a branch nothing can enter.
          const warning =
            decision.warning !== null &&
            (await options.spend.claimWarning(ctx.channel, decision.warning.limit))
              ? decision.warning
              : undefined;
          return ok({
            outcome: "ran",
            id: call.id,
            result: dispatched.result,
            ...(warning !== undefined ? { warning } : {})
          } satisfies ToolCallResponse);
        }
        case "refused":
          // Refused while serving rather than before: the vault could not resolve
          // a credential the sheet names (#51). The ticket is on the row because
          // it was spent — the approval is gone and the call did not run, which
          // is a thing an operator reading the lifecycle needs to see.
          await audit({
            outcome: "refused",
            reason: dispatched.refusal.reason,
            ...(ticket !== undefined ? { ticket } : {})
          });
          return ok({
            outcome: "refused",
            id: call.id,
            refusal: dispatched.refusal
          } satisfies ToolCallResponse);
        case "unavailable":
          await audit({ outcome: "unavailable", ...(ticket !== undefined ? { ticket } : {}) });
          return {
            status: PROXY_ERROR_STATUS.not_implemented,
            body: proxyError(
              "not_implemented",
              "the call is permitted, and this proxy has no upstream to serve it",
              ctx.requestId,
              ctx.channel
            )
          };
      }
    } catch (error) {
      if (!audited) {
        try {
          await audit({
            outcome: "unanswered",
            ...(approver !== undefined ? { approver } : {}),
            ...(ticket !== undefined ? { ticket } : {})
          });
        } catch {
          // The only swallow in this file, and it is the narrow one: the audit
          // write is what failed, `audit` has already logged
          // `audit_write_failed`, and rethrowing from here would replace the
          // failure the 500 is actually about with the failure to record it.
          // The thrown value is not read, as everywhere else on this path.
        }
      }
      // Unchanged from here: the outer handler logs `handler_failed` and answers
      // 500. Two lines now correlate by `requestId` — that one, and the
      // `tool_call` line the row above carries.
      throw error;
    }
  };

  // Built from `options.spend` narrowed to `TokenRecorder`, so the handler's
  // closure holds the write path and not the read one. See ./spend-route.ts.
  const recordSpend = createSpendRoute({ meter: options.spend, logger });

  // Narrowed to `ApprovalDecider`, so the handler can record a click and can
  // neither mint a ticket nor spend one. Same move, and a sharper reason: see
  // ./approvals-route.ts.
  const decideApproval = createApprovalsRoute({
    approvals,
    audit: options.audit,
    logger,
    now
  });

  const routes = new Map<string, Map<string, Route>>([
    [
      // Behind mutual TLS *and* the channel-identity gate like everything
      // else: there is no anonymous surface on this listener, and a caller
      // probing liveness needs a certificate that names a channel — any
      // CA-signed certificate is not enough. That is why docker-compose
      // carries no healthcheck yet; whether monitoring gets a carve-out from
      // the identity gate or a certificate of its own is decided by the issue
      // that adds one, not implied here.
      "/health",
      new Map<string, Route>([
        ["GET", { handler: () => ok({ status: "ok", uptimeMs: now() - startedAt }) }]
      ])
    ],
    [
      // What the connection authenticated as. Small, but it is the endpoint
      // that makes the identity binding observable to an operator with curl.
      "/v1/whoami",
      new Map<string, Route>([["GET", { handler: ctx => ok({ channel: ctx.channel }) }]])
    ],
    ["/v1/tools", new Map<string, Route>([["GET", { handler: listTools }]])],
    ["/v1/tools/call", new Map<string, Route>([["POST", { handler: callTool, body: "json" }]])],
    [
      // The one route on this listener with no authorization decision on it.
      // It resolves no team sheet, reads no allowlist, and returns no verdict —
      // reporting spend is not asking for anything, so there is nothing to
      // decide. It is also not built here: the handler comes from
      // ./spend-route.ts, which has no import that could reach a sheet, and it
      // is handed a `TokenRecorder` rather than the meter. See that file for
      // why the asymmetry is spelled out rather than left to be inferred.
      //
      // The channel still comes from the client certificate, exactly as it does
      // above. That is the one thing the two routes must share.
      "/v1/spend",
      new Map<string, Route>([["POST", { handler: recordSpend, body: "json" }]])
    ],
    [
      // A human's answer to a hold.
      //
      // The ticket id is in the body rather than the path. `/v1/tools/call`
      // names its resource the same way, so this is the consistent shape here
      // rather than the odd one — and it means one strict parse validates the
      // whole request. A `/v1/approvals/<id>` would need a path-parameter
      // mechanism the exact-match table above deliberately does not have, and
      // the id would reach the handler having been through no schema at all.
      //
      // Like /v1/spend, this route resolves no team sheet: the sheet is
      // enforced when the ticket is minted and again when it is redeemed, both
      // on /v1/tools/call. Unlike /v1/spend, it writes audit rows, because a
      // decision is a fact about a call that no later request will record.
      //
      // The channel comes from the client certificate here as everywhere. That
      // is what makes a ticket undecidable from any other channel's connection.
      "/v1/approvals",
      new Map<string, Route>([["POST", { handler: decideApproval, body: "json" }]])
    ]
  ]);

  /**
   * The second half of the identity gate: is this the certificate the channel's
   * team sheet says may speak for it (#79)?
   *
   * Answers `null` when the request may proceed, and a 401 otherwise.
   *
   * **Here rather than in `/v1/tools/call`.** A leaked key that could still
   * enumerate a channel's tools, read its spend, or decide its held calls would
   * be revoked in name only, so the check sits ahead of the route table and
   * covers every route on this listener — `/health` included, which is the same
   * answer that endpoint already gives to a certificate naming no channel.
   *
   * **Per request rather than at handshake.** The agent pools connections, so a
   * decision taken once per socket would go on serving a revoked key until that
   * socket closed. Resolving the sheet here gives revocation the freshness the
   * sheet already promises for every other permission: the next request.
   *
   * A sheet that is absent or has never parsed is passed through untouched.
   * There is nothing to check against, and those two states already have
   * answers further in — `no_team_sheet` and `team_sheet_unreadable` — which are
   * refusals naming what is wrong rather than a bare 401 that does not.
   */
  const pinRejection = async (
    channel: string,
    fingerprint: string,
    requestId: string,
    method: string,
    pathname: string
  ): Promise<RouteResponse | null> => {
    const state = await options.sheets.resolve(channel);
    if (state.status !== "active") return null;
    const pins = state.sheet.channel.certificate_sha256;
    if (matchesPin(fingerprint, pins)) return null;

    logger.log("warn", {
      event: "identity_rejected",
      requestId,
      channel,
      method,
      path: pathname,
      reason: "certificate_not_pinned",
      // The two facts a rotation gone wrong turns on: what arrived, and how many
      // fingerprints the sheet in force listed when it was judged.
      fingerprint,
      pins: pins.length
    });
    return {
      status: PROXY_ERROR_STATUS.unauthenticated,
      // No channel on the body, as with every other rejection from this gate: a
      // caller that failed to authenticate is told what it needs to fix and
      // nothing about the deployment it failed to reach.
      body: proxyError(
        "unauthenticated",
        "the client certificate is not one this channel's team sheet pins",
        requestId
      )
    };
  };

  const server = createServer(options.tls, (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    const method = req.method ?? "GET";

    // Draining is now per-route rather than unconditional, because a route
    // that reads a body has to attach its own listeners before anything
    // consumes the stream. Every path that does *not* read one still drains:
    // a client that sent a body and is never read from holds the socket open
    // waiting for it. Adding an early return here means adding a `drain()`.
    const drain = (): void => {
      req.resume();
    };

    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "https://proxy.invalid").pathname;
    } catch {
      drain();
      logger.log("warn", { event: "request", requestId, method, status: 400, reason: "bad_url" });
      sendJson(
        res,
        PROXY_ERROR_STATUS.bad_request,
        proxyError("bad_request", "the request line is not a valid URL", requestId)
      );
      return;
    }

    const identity = resolveChannel(req.socket as TLSSocket);
    if (!identity.ok) {
      drain();
      // Method and path included deliberately: an operator whose agent is
      // being turned away needs to see what it was trying to do, and neither
      // is a secret.
      logger.log("warn", {
        event: "identity_rejected",
        requestId,
        method,
        path: pathname,
        reason: identity.reason,
        ...(identity.commonName !== undefined ? { commonName: identity.commonName } : {})
      });
      // The reason stays in the log. A caller learns that its certificate does
      // not name a channel, not which of the ways it failed to.
      sendJson(
        res,
        PROXY_ERROR_STATUS.unauthenticated,
        proxyError(
          "unauthenticated",
          "the client certificate does not identify a channel",
          requestId
        )
      );
      return;
    }

    const { channel, fingerprint } = identity;
    const respond = (status: number, body: unknown): void => {
      logger.log("info", { event: "request", requestId, channel, method, path: pathname, status });
      sendJson(res, status, body);
    };

    // Promise-aware dispatch: the pin half of the identity gate resolves a team
    // sheet, the tool-call endpoint reads a body and the sheet again, and
    // without this the symptom would be a pending Promise serialized as {} with
    // status 200 — or a rejection escaping the process as an unhandled
    // rejection.
    //
    // Route lookup is inside the chain rather than before it because the pin
    // check has to come first: a certificate the sheet does not pin learns
    // which paths exist from nothing here, not even a 404.
    Promise.resolve()
      .then(async (): Promise<RouteResponse> => {
        const rejected = await pinRejection(channel, fingerprint, requestId, method, pathname);
        if (rejected !== null) {
          drain();
          return rejected;
        }

        const handlers = routes.get(pathname);
        if (handlers === undefined) {
          drain();
          return {
            status: PROXY_ERROR_STATUS.not_found,
            body: proxyError("not_found", `no route for ${pathname}`, requestId, channel)
          };
        }

        const route = handlers.get(method);
        if (route === undefined) {
          drain();
          res.setHeader("allow", [...handlers.keys()].join(", "));
          return {
            status: PROXY_ERROR_STATUS.method_not_allowed,
            body: proxyError(
              "method_not_allowed",
              `${method} is not allowed on ${pathname}`,
              requestId,
              channel
            )
          };
        }

        if (route.body !== "json") {
          drain();
          return route.handler({ channel, requestId, body: undefined });
        }

        const read = await readJsonBody(req, MAX_BODY_BYTES);
        if (!read.ok) {
          const code = read.reason === "too_large" ? "payload_too_large" : "bad_request";
          logger.log("warn", {
            event: "request_body_rejected",
            requestId,
            channel,
            method,
            path: pathname,
            reason: read.reason
          });
          return {
            status: PROXY_ERROR_STATUS[code],
            body: proxyError(
              code,
              read.reason === "too_large"
                ? `the request body exceeds ${MAX_BODY_BYTES} bytes`
                : "the request body is not valid JSON",
              requestId,
              channel
            )
          };
        }
        return route.handler({ channel, requestId, body: read.value });
      })
      .then(({ status, body }) => {
        respond(status, body);
      })
      .catch(() => {
        // The thrown value is deliberately not inspected or logged. In this
        // process an exception can carry a credential in its message, and the
        // requestId is enough to correlate the failure with the request.
        logger.log("error", { event: "handler_failed", requestId, channel, method, path: pathname });
        sendJson(
          res,
          PROXY_ERROR_STATUS.internal,
          proxyError("internal", "the proxy failed to handle the request", requestId, channel)
        );
      });
  });

  // Fires when a client presents no certificate, or one this CA did not sign.
  // The connection is already gone; this exists so a refused agent is visible
  // to an operator rather than silent.
  server.on("tlsClientError", (err: Error & { code?: string }) => {
    logger.log("warn", { event: "tls_client_rejected", reason: err.code ?? "unknown" });
  });

  return server;
}
