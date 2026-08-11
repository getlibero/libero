// The enforcement decision: given a channel's team sheet and a call it wants to
// make, is the call allowed, refused, or held for a human.
//
// A pure function. No I/O, no clock, no network, no model — the same inputs
// give the same answer every time, and the answer can be table-tested without
// standing anything up. That is the point rather than a convenience: the
// security property is that enforcement resolves from the team sheet without
// the model's cooperation, and a function that cannot reach anything is a
// function the model cannot influence.
//
// What is deliberately *not* here: nothing in this file inspects tool arguments
// to decide anything. Arguments are written by the model, so a rule that reads
// them is a rule the model can phrase its way around, and calling that a
// mitigation would be exactly the thing the repository's rules forbid. The
// heuristic below reads the tool's *name*, which comes from the team sheet's
// allowlist and not from the model.

import { BUILTIN_SERVER } from "@getlibero/schema";
import type {
  ApprovalMode,
  BudgetLimit,
  BuiltinToolName,
  McpServer,
  PermittedTool,
  ResolvedToolCall,
  TeamSheet,
  ToolEntry,
  ToolRefusal
} from "@getlibero/schema";
import type { SheetState } from "./team-sheet-store.js";

/**
 * Verbs that default a tool to approval-required when its sheet entry says
 * nothing either way. From the architecture; the sheet overrides with an
 * explicit `approval = "none"`.
 */
export const DESTRUCTIVE_VERBS = ["delete", "drop", "transfer", "deploy"] as const;

/**
 * Spend so far, for the channel, for the day.
 *
 * Raw counts, not a verdict and not a total. The decision compares them against
 * the sheet, because the sheet is where policy lives — the meter's job ends at
 * counting, and it owns persistence and rollover (./budget-meter.ts).
 *
 * The four token counts stay apart all the way to here for the same reason.
 * What a cached token is worth against `daily_tokens` is a per-channel team
 * sheet setting, so the weighting is policy and belongs on this side; a meter
 * that stored a weighted total would have baked yesterday's weights into the
 * numbers and an operator's edit could not reach spend already recorded.
 */
export interface BudgetSpend {
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface EnforcementInput {
  readonly sheet: TeamSheet;
  /**
   * Bound to a channel already. The decision does not read `channel` — the
   * sheet *is* that channel's — but taking the resolved shape means a call
   * cannot be enforced against before it has been tied to a certificate.
   */
  readonly call: ResolvedToolCall;
  readonly spend: BudgetSpend;
}

/**
 * The three answers.
 *
 * `hold` carries a refusal rather than a bare marker so that a client with
 * nothing to do with an approval can relay it to the channel as an ordinary
 * refusal and be correct. That was the whole of the story before the approval
 * broker; it is now the degradation rather than the behaviour, and it still
 * holds — a client that ignores the ticket abandons the call, which is safe.
 *
 * **`allow` and `hold` both carry the sheet entry they matched**, and that is a
 * security property rather than a convenience. The dispatcher needs a
 * destination and a credential name, and the only two ways to get them are this
 * field or a second lookup after the fact. A second lookup can disagree with the
 * first — the sheet is watched and reloads on file change, so the entry that
 * authorized the call is not necessarily the entry a later read returns — and
 * the call would then go somewhere the decision never approved. Handing the
 * matched entry forward closes that window by construction: there is nothing to
 * re-resolve.
 *
 * `hold` needs it for the same reason and more urgently. An approved call comes
 * back as a re-submission and is enforced *again*, and in the ordinary case that
 * second decision is another `hold` — the tool still requires approval, which is
 * why there was a ticket. So the hold path is the one the dispatcher runs from
 * on every approved call, and a decision that answered `hold` with no upstream
 * would leave a redeemed call with nowhere to go. The alternative, a ticket
 * carrying a cached upstream, is that second lookup made worse: a whole ticket
 * lifetime stale rather than milliseconds.
 *
 * Enforcement itself knows nothing about tickets. `decide` is pure, has no
 * clock, and reads no approval state — it answers "may this channel call this",
 * and whether a human approved this exact call is a different question answered
 * elsewhere. Neither question is allowed to stand in for the other.
 */
export type Decision =
  | { readonly outcome: "allow"; readonly target: Target; readonly limits: CallLimits }
  | {
      readonly outcome: "hold";
      readonly target: Target;
      readonly refusal: ToolRefusal;
      readonly limits: CallLimits;
    }
  | { readonly outcome: "refuse"; readonly refusal: ToolRefusal };

/**
 * Where a permitted call goes.
 *
 * The shape that carries "a built-in is not a bypass" (#64). Both kinds come out
 * of the same `decide`, having passed the same allowlist, the same budget check
 * and the same approval rule — so a dispatcher cannot serve a built-in without
 * having been through the gate, because the only way to obtain one of these is
 * to be handed a `Decision`.
 *
 * A union rather than an `McpServer` with a magic transport. The alternative was
 * weighed and rejected in `packages/schema/src/builtin.ts`; the part that
 * matters here is that `decide` returning an `McpServer` for something that is
 * not a server would be a claim the code makes and a reader has to check,
 * whereas this one the dispatcher has to handle.
 *
 * `builtin` carries the tool name and nothing else, because there is nothing
 * else: the provider is this process, there is one of it, and the channel comes
 * from the client certificate rather than from anything on the decision.
 */
export type Target =
  | { readonly kind: "mcp"; readonly upstream: McpServer }
  | { readonly kind: "builtin"; readonly tool: BuiltinToolName };

/**
 * What a served call may spend of the channel's context.
 *
 * Rides on the decision for the reason `upstream` does, and the argument above
 * applies to it unchanged: resolving it in the dispatcher would be the second
 * lookup that paragraph refuses, one field over, against a sheet that may have
 * reloaded in between. `hold` carries it too, because an approved call comes
 * back as a re-submission and is decided again — which means a redeemed ticket
 * runs under whatever the sheet says at redemption, not what it said when the
 * human clicked. That is the same freshness `upstream` already has and is the
 * behaviour wanted: an operator tightening a bound during a hold should win.
 *
 * A named type rather than a bare `number` parameter, because
 * `dispatch(call, upstream, 32768)` reads as nothing at a call site.
 *
 * One field, and the *other* bound is pointedly not here: how many bytes the
 * proxy will read off an upstream is `PROXY_MAX_RESPONSE_BYTES`, settled per
 * process rather than per channel, because that heap is shared by every channel
 * the proxy serves. It reaches the client through `McpClientOptions` and never
 * through a decision.
 */
export interface CallLimits {
  /** Characters of `ToolResult.content` the model may see. Past it, truncated with a notice. */
  readonly maxResultChars: number;
}

const refuse = (refusal: ToolRefusal): Decision => ({ outcome: "refuse", refusal });

/**
 * Whether a tool name reads as destructive.
 *
 * Case-insensitive substring, which over-fires: a tool called
 * `get_dropdown_options` contains "drop" and will be held. That direction is
 * chosen on purpose. Over-firing costs one approval click and one line in the
 * sheet to opt out of; under-firing runs an unreviewed destructive call. Token
 * splitting would trade the false positives for false negatives — `bulkdelete`
 * has no separator to split on — and this is not the place to want fewer
 * approvals.
 *
 * The heuristic is only ever a default. A sheet that says `approval = "none"`
 * for a tool has answered the question, and this is not consulted.
 */
export function isDestructiveName(tool: string): boolean {
  const lowered = tool.toLowerCase();
  return DESTRUCTIVE_VERBS.some(verb => lowered.includes(verb));
}

/**
 * Every server entry with this exact name.
 *
 * Exact, byte for byte. `GitHub` does not match `github`, and a name differing
 * by a space or a Cyrillic lookalike does not match either — it simply is not
 * on the list, and falls out as `server_not_allowed`. Matching loosely would
 * mean the name checked against the allowlist could differ from the name
 * dispatched to the server, and that gap is where a bypass lives.
 *
 * Scanning the array rather than indexing a lookup object, so a tool named
 * `constructor` cannot find something on `Object.prototype`.
 */
function serversNamed(sheet: TeamSheet, name: string): McpServer[] {
  return sheet.mcp_server.filter(server => server.name === name);
}

function toolsNamed(servers: readonly McpServer[], name: string): ToolEntry[] {
  return servers.flatMap(server => server.tool.filter(tool => tool.name === name));
}

/**
 * The entries that actually carry the tool, not merely the name.
 *
 * `toolsNamed` flattens the entries away because approval only cares about the
 * tool rows. Dispatch cares about which block they came from: a sheet may split
 * one server's tools across several `[[mcp_server]]` blocks, and the block that
 * listed the tool is the block that authorized it. Sending the call to a
 * different block that happens to share the name is the bypass `serversNamed`
 * warns about, one level down.
 */
function serversCarrying(servers: readonly McpServer[], tool: string): McpServer[] {
  return servers.filter(server => server.tool.some(entry => entry.name === tool));
}

/**
 * The identity of an upstream: same destination, same authentication.
 * Everything dispatch reads, as one string.
 *
 * This exists so the client pool and enforcement cannot drift. The pool keys
 * one client per upstream, and "one upstream" has to mean exactly what
 * `selectUpstream` means by it — otherwise the pool could merge two blocks
 * enforcement considers distinct, and a call authorized against one would be
 * sent on a connection built for the other. Restating the comparison in the
 * pool would be a rule written down twice; `sameUpstream` is defined in terms
 * of this instead, so there is one definition and a test that they agree.
 *
 * `JSON.stringify` of an array rather than joining on a delimiter: a URL may
 * legally contain any character a delimiter could be, and a key collision here
 * is two different upstreams sharing one credentialed client. The array form
 * is injective without needing an escape rule.
 *
 * The `credential` is a name, never a value (`CredentialName` in the schema),
 * so a key is safe to hold in a map and safe to log.
 */
export function upstreamKey(server: McpServer): string {
  return JSON.stringify([server.transport, server.url ?? null, server.credential ?? null]);
}

/** Same destination, same authentication. Everything dispatch reads. */
function sameUpstream(a: McpServer, b: McpServer): boolean {
  return upstreamKey(a) === upstreamKey(b);
}

/**
 * Which upstream serves the call, or `null` if the sheet does not say.
 *
 * Duplicate blocks are fine and common — that is how a sheet groups tools by
 * approval, and the allowlist unions them. They are only a problem when the
 * blocks carrying this tool disagree about where it goes, because then the
 * sheet authorizes one thing and describes two. Picking either would mean the
 * entry checked against the allowlist need not be the entry dispatched to.
 * Nothing here resolves that; the caller refuses.
 */
function selectUpstream(carriers: readonly McpServer[]): McpServer | null {
  const first = carriers[0];
  if (first === undefined) return null;
  return carriers.every(server => sameUpstream(server, first)) ? first : null;
}

/**
 * Whether a permitted tool needs a human, given every sheet entry naming it.
 *
 * One function with two callers — the decision below, and the tool listing the
 * proxy serves at session start. Those two must never disagree: the listing
 * telling a channel a tool runs freely while the decision holds it is a
 * confusing bug, and the reverse is an unreviewed destructive call. A rule
 * stated twice is a rule that eventually drifts, so it is stated once.
 *
 * Duplicate entries are an operator slip, not a syntax error, so they get a
 * defined resolution rather than an arbitrary one: the most restrictive entry
 * wins. A sheet listing a tool twice, once requiring approval, requires
 * approval. Explicit beats implicit, so an entry saying `none` suppresses the
 * heuristic even alongside an entry that says nothing.
 *
 * Callers pass entries that are already known to be permitted. An empty list
 * means the tool is not on the sheet at all, which is not this function's
 * question, and it answers `required` rather than inventing an allow.
 */
export function resolveApproval(entries: readonly ToolEntry[], tool: string): ApprovalMode {
  if (entries.length === 0) return "required";
  if (entries.some(entry => entry.approval === "required")) return "required";
  if (entries.some(entry => entry.approval === "none")) return "none";
  return isDestructiveName(tool) ? "required" : "none";
}

/**
 * What the day's tokens are worth against `daily_tokens`.
 *
 * Cache reads and cache writes bill differently from ordinary input tokens, and
 * by how much is the provider's decision — so the weights are team sheet fields
 * rather than constants, and a channel pins its provider by pinning
 * `[llm] model`. Counting a cache read at full weight would exhaust a heavily
 * cached channel for spend it never incurred; dropping it would let a loop
 * replaying a large cached context run far past what its number implies.
 *
 * A price *ratio*, not a price: `daily_tokens` is a token count, and
 * cost-denominated caps are a separate thing (#62). The product is fractional
 * and compared as such — rounding it would make the same sheet answer
 * differently depending on how the day's spend happened to split.
 */
function billableTokens(sheet: TeamSheet, spend: BudgetSpend): number {
  return (
    spend.inputTokens +
    spend.outputTokens +
    spend.cacheReadTokens * sheet.budget.cache_read_weight +
    spend.cacheWriteTokens * sheet.budget.cache_write_weight
  );
}

/**
 * Which daily limit, if either, is spent.
 *
 * Tokens are checked before tool calls so that a channel over both gets the
 * same answer every time. `>=` because a channel that has spent exactly its
 * limit has no budget left for the next call.
 */
function exhaustedLimit(sheet: TeamSheet, spend: BudgetSpend): BudgetLimit | null {
  if (billableTokens(sheet, spend) >= sheet.budget.daily_tokens) return "daily_tokens";
  if (spend.toolCalls >= sheet.budget.daily_tool_calls) return "daily_tool_calls";
  return null;
}

/**
 * The decision.
 *
 * Order is load-bearing. The allowlist resolves first, because whether a tool
 * exists for this channel is not a temporary condition and an operator asking
 * why a call failed is better served by "that tool is not listed" than by a
 * budget message that will be untrue tomorrow. Approval resolves last, so a
 * human is never asked to approve a call that would have been refused anyway.
 */
export function decide(input: EnforcementInput): Decision {
  const { sheet, call, spend } = input;

  // Before the allowlist scan, because `serversNamed` would answer empty for the
  // reserved name and refuse `server_not_allowed` even on a sheet that grants
  // built-ins. Nothing else about the order changes: the branch below runs the
  // same five steps in the same sequence, for the same reasons.
  //
  // The name is reserved at parse (`packages/schema/src/team-sheet.ts`), so
  // there is no sheet on which this branch and the one below both have an
  // answer. That is what makes matching on the name safe here rather than a
  // shadowing hazard.
  if (call.server === BUILTIN_SERVER) {
    return decideBuiltin(sheet, call, spend);
  }

  const servers = serversNamed(sheet, call.server);
  if (servers.length === 0) {
    return refuse({ reason: "server_not_allowed", server: call.server });
  }

  const tools = toolsNamed(servers, call.tool);
  if (tools.length === 0) {
    // A tool that is not listed does not exist as far as this channel is
    // concerned. Not "exists but is denied" — there is no such distinction to
    // leak, and the tool never appeared in the definitions the agent was given.
    return refuse({ reason: "tool_not_allowed", server: call.server, tool: call.tool });
  }

  // Before the budget and before approval, for the reason the ordering note
  // above gives: a sheet whose blocks contradict each other is a structural
  // fault, not a condition that clears tomorrow, and no human should be asked
  // to approve a call that has nowhere to go.
  const upstream = selectUpstream(serversCarrying(servers, call.tool));
  if (upstream === null) {
    return refuse({ reason: "server_ambiguous", server: call.server, tool: call.tool });
  }

  const limit = exhaustedLimit(sheet, spend);
  if (limit !== null) {
    return refuse({ reason: "budget_exhausted", limit });
  }

  const limits = resolveLimits(sheet, tools);

  if (resolveApproval(tools, call.tool) === "required") {
    return {
      outcome: "hold",
      target: { kind: "mcp", upstream },
      refusal: { reason: "approval_required", server: call.server, tool: call.tool },
      limits
    };
  }

  return { outcome: "allow", target: { kind: "mcp", upstream }, limits };
}

/**
 * The same decision for a tool this process implements itself (#64).
 *
 * Deliberately the *same five steps in the same order*, minus the one that has
 * no question to answer: there is a single provider, so no two blocks can
 * disagree about where a built-in goes and there is no `server_ambiguous` to
 * resolve. Everything else holds, and holds because it is the same code —
 * `exhaustedLimit`, `resolveLimits` and `resolveApproval` are the functions the
 * MCP branch calls, not copies of them, which is what keeps "a built-in draws on
 * the channel's meter and obeys the sheet's approval" a property rather than a
 * promise. `BuiltinEntry` is structurally a `ToolEntry`, which is what lets the
 * last two take it unchanged.
 *
 * The two refusals split the way the MCP branch's do, and the distinction is
 * worth keeping: an empty `[[builtin]]` is a channel with no built-ins at all
 * (`server_not_allowed`), and a non-empty one missing this name is a channel
 * with some but not this (`tool_not_allowed`).
 *
 * `search_channel_history` contains none of `DESTRUCTIVE_VERBS`, so an entry
 * with no `approval` line resolves to `none` through the heuristic's default. An
 * operator who wants a click writes it, exactly as the starter sheet does for
 * `merge_pull_request`.
 */
function decideBuiltin(
  sheet: TeamSheet,
  call: ResolvedToolCall,
  spend: BudgetSpend
): Decision {
  if (sheet.builtin.length === 0) {
    return refuse({ reason: "server_not_allowed", server: call.server });
  }

  const entries = sheet.builtin.filter(entry => entry.name === call.tool);
  // Destructured rather than length-checked so the name below is a
  // `BuiltinToolName` and not a `string`: the sheet's parse is what established
  // that, and re-narrowing it here would be a second opinion about a closed set.
  const first = entries[0];
  if (first === undefined) {
    return refuse({ reason: "tool_not_allowed", server: call.server, tool: call.tool });
  }

  const limit = exhaustedLimit(sheet, spend);
  if (limit !== null) {
    return refuse({ reason: "budget_exhausted", limit });
  }

  const target: Target = { kind: "builtin", tool: first.name };
  const limits = resolveLimits(sheet, entries);

  if (resolveApproval(entries, call.tool) === "required") {
    return {
      outcome: "hold",
      target,
      refusal: { reason: "approval_required", server: call.server, tool: call.tool },
      limits
    };
  }

  return { outcome: "allow", target, limits };
}

/**
 * What this tool's answer may spend of the channel's context.
 *
 * `resolveApproval`'s shape and its duplicate rule, for the same reason: two
 * entries naming one tool are an operator slip rather than a policy, so they get
 * a defined resolution instead of whichever the array happened to order first,
 * and the most restrictive wins. An entry naming nothing falls through to the
 * channel's `[llm] max_result_chars`, so an override may raise as well as lower
 * — a tool that returns diffs is as legitimate a reason to want more as a tool
 * that returns listings is to want less.
 *
 * Exported for the tests and for `decide`, not for `index.ts`: the resolved
 * numbers leave this module on a `Decision` and the rule that produced them
 * does not.
 */
export function resolveLimits(sheet: TeamSheet, entries: readonly ToolEntry[]): CallLimits {
  // The type predicate is required rather than decorative: a bare
  // `!== undefined` in a filter does not narrow, and `Math.min` over
  // `(number | undefined)[]` will not compile.
  const chars = entries.map(entry => entry.max_result_chars).filter((value): value is number => value !== undefined);

  return {
    maxResultChars: chars.length === 0 ? sheet.llm.max_result_chars : Math.min(...chars)
  };
}

/**
 * Everything this channel may call, as the session-start listing.
 *
 * The other half of the same policy: `decide` answers "may this call run", and
 * this answers "which calls could". They read the same sheet through the same
 * approval rule, so a tool listed here as `none` is a tool `decide` allows —
 * that agreement is a property of sharing `resolveApproval`, not of the two
 * functions being written to match.
 *
 * Order follows the sheet, and duplicates in the sheet collapse to one entry
 * per (server, tool) resolved most-restrictively — the listing describes what
 * a call would do, and a call cannot hit two entries differently.
 */
export function permittedTools(sheet: TeamSheet): PermittedTool[] {
  return permittedToolSources(sheet).map(source => source.tool);
}

/**
 * A permitted tool and where a call on it would go.
 *
 * `target` is `null` for exactly the tools `decide` refuses as
 * `server_ambiguous`: the blocks naming them disagree about where they go, so
 * there is no single upstream to ask about them either. Such a tool is still
 * listed — the describing fields are what an upstream fills in, not the row
 * itself — it simply cannot be described.
 *
 * A `builtin` target is never null. There is one provider and the sheet cannot
 * name a second, so the condition `null` reports has no way to arise.
 */
export interface PermittedToolSource {
  readonly tool: PermittedTool;
  readonly target: Target | null;
}

/**
 * The listing, plus where each entry would go.
 *
 * `permittedTools` is this with the second field dropped, so order, the
 * duplicate key, and the most-restrictive approval resolution live in one loop
 * and the two answers cannot drift.
 *
 * **The upstream is selected by the same expression `decide` uses**, rather than
 * by a second rule that resembles it. A listing that thought a tool belonged to
 * one block while the decision sent it to another would describe a call that is
 * not the call that runs — the same class of gap `serversNamed` warns about, and
 * the reason both halves already share `resolveApproval`.
 */
export function permittedToolSources(sheet: TeamSheet): PermittedToolSource[] {
  const listed: PermittedToolSource[] = [];
  const seen = new Set<string>();

  for (const server of sheet.mcp_server) {
    for (const entry of server.tool) {
      // Scanning the sheet rather than indexing a lookup object, for the same
      // reason `serversNamed` does: a tool named `constructor` must not find
      // something on `Object.prototype`. The Set is keyed on a separator that
      // cannot occur in a ResourceName, so `a.b` + `c` and `a` + `b.c` stay
      // distinct. Spelled as the escape, not a raw NUL byte — a raw byte makes
      // grep treat the whole file as binary and silently drop it from reviews.
      const key = `${server.name}\u0000${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const named = serversNamed(sheet, server.name);
      const upstream = selectUpstream(serversCarrying(named, entry.name));
      listed.push({
        tool: {
          server: server.name,
          tool: entry.name,
          approval: resolveApproval(toolsNamed(named, entry.name), entry.name)
        },
        target: upstream === null ? null : { kind: "mcp", upstream }
      });
    }
  }

  // Built-ins after the upstreams, and that ordering is a choice rather than an
  // accident of where the loop sits. The listing's order is the sheet's, and
  // `MAX_DESCRIBED_TOOLS` reads that as the operator's priority — so putting
  // these last says a channel's own history is the thing to drop first if a
  // catalog ever fills the budget. It is also the order the starter sheet writes
  // them in.
  //
  // The same `seen` set, so the key rule is stated once. Nothing can collide
  // across the two loops in practice, because `BUILTIN_SERVER` is reserved at
  // parse — sharing the set is what makes that a redundancy rather than an
  // assumption.
  for (const entry of sheet.builtin) {
    const key = `${BUILTIN_SERVER}\u0000${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const named = sheet.builtin.filter(other => other.name === entry.name);
    listed.push({
      tool: {
        server: BUILTIN_SERVER,
        tool: entry.name,
        approval: resolveApproval(named, entry.name)
      },
      target: { kind: "builtin", tool: entry.name }
    });
  }

  return listed;
}

/**
 * The same listing, starting from what the team-sheet store resolved.
 *
 * A channel with no sheet, or with one that has never parsed, permits nothing
 * and gets an empty list. That is the honest answer rather than an error:
 * listing asks what is permitted, and "nothing" is a permission state. The
 * refusal reason a caller would want is the one its next call gets, from
 * `decideFromState`, which is where the distinction between an absent sheet
 * and an unreadable one is worth drawing.
 */
export function permittedToolsFromState(state: SheetState): PermittedTool[] {
  return permittedToolSourcesFromState(state).map(source => source.tool);
}

/** The same, for the caller that also needs to know which upstream to ask. */
export function permittedToolSourcesFromState(state: SheetState): PermittedToolSource[] {
  return state.status === "active" ? permittedToolSources(state.sheet) : [];
}

/**
 * The same decision, starting from what the team-sheet store resolved.
 *
 * Split from `decide` so the policy stays a pure function of a sheet and a
 * call, table-testable with nothing but two objects. This half handles the two
 * states in which there is no sheet to reason about, and it is where a channel
 * with no provisioning becomes a refusal rather than an exception.
 *
 * A stale sheet is enforced, not refused. The file on disk failing to parse
 * does not withdraw what the operator last successfully said, and the loader
 * has already logged the fault loudly; the call proceeds under the retained
 * sheet. Surfacing staleness in-thread is a gateway concern, not this one.
 */
export function decideFromState(
  state: SheetState,
  call: ResolvedToolCall,
  spend: BudgetSpend
): Decision {
  switch (state.status) {
    case "absent":
      return refuse({ reason: "no_team_sheet" });
    case "unusable":
      return refuse({ reason: "team_sheet_unreadable" });
    case "active":
      return decide({ sheet: state.sheet, call, spend });
  }
}
