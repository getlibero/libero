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

import type {
  ApprovalMode,
  BudgetLimit,
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
  | { readonly outcome: "allow"; readonly upstream: McpServer }
  | { readonly outcome: "hold"; readonly upstream: McpServer; readonly refusal: ToolRefusal }
  | { readonly outcome: "refuse"; readonly refusal: ToolRefusal };

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

/** Same destination, same authentication. Everything dispatch reads. */
function sameUpstream(a: McpServer, b: McpServer): boolean {
  return a.transport === b.transport && a.url === b.url && a.credential === b.credential;
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

  if (resolveApproval(tools, call.tool) === "required") {
    return {
      outcome: "hold",
      upstream,
      refusal: { reason: "approval_required", server: call.server, tool: call.tool }
    };
  }

  return { outcome: "allow", upstream };
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
  const listed: PermittedTool[] = [];
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

      const entries = toolsNamed(serversNamed(sheet, server.name), entry.name);
      listed.push({
        server: server.name,
        tool: entry.name,
        approval: resolveApproval(entries, entry.name)
      });
    }
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
  return state.status === "active" ? permittedTools(state.sheet) : [];
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
