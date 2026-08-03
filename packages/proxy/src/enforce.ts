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
 * The seam for the budget meter (#38). The decision takes counters and compares
 * them against the sheet, rather than taking a verdict — the sheet is where
 * policy lives, so the comparison belongs on this side and the meter stays
 * accounting. #38 supplies the numbers and owns persistence and rollover.
 */
export interface BudgetSpend {
  readonly tokens: number;
  readonly toolCalls: number;
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
 * `hold` carries a refusal rather than a bare marker so that a deployment with
 * no approval broker wired — which is every deployment until #37 lands — can
 * relay it to the channel as an ordinary refusal and be correct. The seam
 * degrades to the safe behaviour instead of to an unhandled case.
 */
export type Decision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "hold"; readonly refusal: ToolRefusal }
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
 * Which daily limit, if either, is spent.
 *
 * Tokens are checked before tool calls so that a channel over both gets the
 * same answer every time. `>=` because a channel that has spent exactly its
 * limit has no budget left for the next call.
 */
function exhaustedLimit(sheet: TeamSheet, spend: BudgetSpend): BudgetLimit | null {
  if (spend.tokens >= sheet.budget.daily_tokens) return "daily_tokens";
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

  const limit = exhaustedLimit(sheet, spend);
  if (limit !== null) {
    return refuse({ reason: "budget_exhausted", limit });
  }

  if (resolveApproval(tools, call.tool) === "required") {
    return { outcome: "hold", refusal: { reason: "approval_required", server: call.server, tool: call.tool } };
  }

  return { outcome: "allow" };
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
      // distinct.
      const key = `${server.name} ${entry.name}`;
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
