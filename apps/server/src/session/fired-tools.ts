// Giving an unattended turn tools, without giving the loop a second shape (#348).
//
// A fired check or a standing rule that may look things up is a ReAct loop like
// any other — and `runAgentTask` already takes the two seams it needs, a
// `ToolSource` that lists and a `ToolExecutor` that runs. So nothing in
// `packages/agent` changes. What this file adds is a pair of wrappers around the
// channel's ordinary proxy client, and everything unattended about the turn lives
// in them.
//
// ## Why `post_finding` is intercepted rather than served
//
// The turn's answer is a post, and posting is `apps/server`'s capability — the
// tool proxy service has no verb for it and must not grow one. So the source
// offers `post_finding` beside the channel's real tools and the executor handles
// that one name itself, delegating every other call to the proxy client.
//
// Three properties fall out of that rather than being re-argued:
//
//   - **Silence is still calling no tool.** With one tool that was structural;
//     with twelve it still is, because the model either calls `post_finding`
//     before it stops or it does not. There is no sentinel to recognize and no
//     "when unsure, post" default — the rule `parseAmbientFinding` states.
//   - **One post per firing.** The interceptor *records* the text and answers the
//     model; the caller posts once, after the loop ends. A model that calls it
//     twice cannot produce two messages, because producing messages is not what
//     the call does.
//   - **Every other call meets the proxy's gates**, because every other call *is*
//     the ordinary client. There is no second path and no bypass to audit.
//
// ## What makes it unattended, and what that costs
//
// Two things, and neither is a branch in this file.
//
// **No prompter.** `createProxyToolClient` takes one optionally, and without it a
// held call comes back to the model as the refusal it already is. That is the
// documented degraded mode, and here it is the *designed* mode: an approval card
// needs somebody to click it, and a fired turn has no requesting user and no
// thread to put one in. Waiting out a deadline against a person who does not know
// the turn exists is the failure this avoids.
//
// Because `resolveApproval` already holds a destructive *name* by default, the
// practical line that draws is **read yes, write no** — without this file
// knowing what "destructive" means. An operator who wants otherwise says
// `approval = "none"` on that tool, in the sheet, where it is reviewed.
//
// **`AMBIENT_REQUESTING_USER`.** Every call carries it, so the audit log says
// plainly that no person asked. It is reserved by an alphabet no user id can
// reach, and the task id beside it says which clock fired.

import {
  AMBIENT_FINDING_TOOL,
  AMBIENT_REQUESTING_USER,
  SCHEDULED_CHECK_TOOL_DEFINITION,
  parseAmbientFinding,
  textBlock
} from "@getlibero/schema";
import type { AmbientFinding, AmbientFindingFailure } from "@getlibero/schema";
import type { ToolDefinition, ToolExecutor, ToolSource } from "@getlibero/agent";

/** What the interceptor caught, once the loop has finished. */
export interface FiredToolsOutcome {
  /** The finding the model asked to post, or `null` if it never asked. */
  readonly finding: AmbientFinding | null;
  /**
   * Why a `post_finding` call could not be used, when one was made and failed.
   *
   * Separate from `finding: null`, which is the turn deliberately saying nothing.
   * A model that called the tool and got its arguments wrong tried to speak and
   * failed, and the caller tells the channel — where silence is left alone.
   */
  readonly unusable?: AmbientFindingFailure;
}

/**
 * The tools an unattended turn is offered, and what runs them.
 *
 * `outcome` is live: it is read after `runAgentTask` returns, not during.
 */
export interface FiredTools {
  readonly source: ToolSource;
  readonly executor: ToolExecutor;
  outcome(): FiredToolsOutcome;
}

/** What one already-built proxy client looks like to this file. */
export interface FiredToolsOptions {
  /** The channel's ordinary tool client, built with **no prompter**. */
  readonly tools: ToolSource & ToolExecutor;
}

/**
 * The answer a `post_finding` call gets.
 *
 * It says the text is recorded rather than posted, because that is what
 * happened — the post is the caller's, after the loop. A model told "posted"
 * would be told something this process cannot yet know is true, and one told
 * nothing would have no reason to stop calling.
 */
const RECORDED = "Recorded. It will be posted when you finish; do not call this again.";

/** The answer a second `post_finding` call gets. Refused, not stacked. */
const ALREADY = "You have already recorded an answer for this run. Nothing further was recorded.";

export function createFiredTools(options: FiredToolsOptions): FiredTools {
  let finding: AmbientFinding | null = null;
  let unusable: AmbientFindingFailure | undefined;

  return {
    source: {
      async list(signal?: AbortSignal): Promise<ToolDefinition[]> {
        // The channel's real tools, from the proxy, plus the one this file
        // serves. Appended rather than prepended so a listing an operator reads
        // in a log matches the sheet's own order, with the local one last.
        const listed = await options.tools.list(signal);
        return [...listed, SCHEDULED_CHECK_TOOL_DEFINITION];
      }
    },

    executor: {
      async execute(call, attribution, signal) {
        if (call.name !== AMBIENT_FINDING_TOOL) {
          // Everything else is the ordinary client, with the attribution the
          // caller minted. Nothing is rewritten here: a wrapper that edited the
          // attribution on the way past would be a second place the audit log's
          // "who asked" is decided.
          return options.tools.execute(call, attribution, signal);
        }

        if (finding !== null || unusable !== undefined) {
          return { content: [textBlock(ALREADY)], isError: true };
        }

        const parsed = parseAmbientFinding(call.name, call.arguments);
        if (parsed.ok) {
          finding = parsed.finding;
          return { content: [textBlock(RECORDED)] };
        }

        // The same parse the single-turn shape used, and the same two outcomes.
        // Recorded rather than thrown: the model is told, and the caller decides
        // whether the channel hears about it.
        unusable = parsed.reason;
        return { content: [textBlock(`That answer could not be used: ${parsed.reason}.`)], isError: true };
      }
    },

    outcome(): FiredToolsOutcome {
      return unusable === undefined ? { finding } : { finding, unusable };
    }
  };
}

/** The attribution every unattended call carries. One place, so it cannot drift. */
export const firedAttribution = (taskId: string): { requestingUser: string; taskId: string } => ({
  requestingUser: AMBIENT_REQUESTING_USER,
  taskId
});
