// The model, scripted.
//
// Each case is a deterministic sequence of completions, so a hostile model is a
// list rather than a prompt — no live provider, no sampling, no flakes. The
// fake sits at the `CompletionClient` seam and nowhere lower, which is the
// convention packages/agent/src/loop/loop.test.ts sets: faking at fetch would
// be testing a provider adapter, which is that adapter's own suite's job.
//
// `seen` is not a debugging convenience. The model's transcript is where a
// leaked credential actually lands — a tool result carrying one becomes a
// `tool` message on the very next turn — so it is one of the surfaces the
// canary scan reads, and the most important one.

import {
  CURATION_SYSTEM_PROMPT,
  SKILL_AUTHOR_SYSTEM_PROMPT,
  SKILL_MERGE_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT
} from "@getlibero/agent";
import { resultText } from "@getlibero/schema";
import type {
  CompletionClient,
  CompletionRequest,
  CompletionResponse,
  TokenUsage,
  ToolCall
} from "@getlibero/agent";

export interface ScriptedModel {
  readonly client: CompletionClient;
  /** Every request the model was given, in order, across every task. */
  readonly seen: CompletionRequest[];
}

/** Token counts have to be non-zero, or `daily_tokens` never moves and proves nothing. */
const USAGE = { inputTokens: 12, outputTokens: 7 } as const;

/**
 * What one scripted turn reports, in total.
 *
 * Exported so a budget case sizes its sheet off the script — `daily_tokens: 2 *
 * TURN_TOKENS` says "the third call is over the line" in a way that survives
 * someone changing the numbers above, and a literal 38 does not.
 */
export const TURN_TOKENS = USAGE.inputTokens + USAGE.outputTokens;

/**
 * The same turn, reporting different tokens.
 *
 * A wrapper rather than a parameter on `calls`/`says`, because usage is
 * irrelevant to almost every case and an extra argument on the two helpers
 * every file uses would be noise in all of them. The one case that needs it is
 * about *which bucket* spend lands in — a turn reporting cache reads and
 * nothing else — and it reads better as a decoration than as a fourth
 * positional argument.
 */
export function withUsage(response: CompletionResponse, usage: TokenUsage): CompletionResponse {
  return { ...response, usage };
}

/**
 * The same turn, with a gateway's own cost figure on it (#239).
 *
 * `withUsage`'s shape and its argument. Only a router reports one — a direct
 * provider call carries none — so every turn in this suite is the ordinary
 * shape until a case says otherwise, and the cases that say otherwise are about
 * the price-drift record.
 *
 * Nano-USD, as `CompletionResponse.costNanoUsd` carries it.
 */
export function withReportedCost(
  response: CompletionResponse,
  costNanoUsd: number
): CompletionResponse {
  return { ...response, costNanoUsd };
}

/**
 * The model the scripted provider says it served (#62).
 *
 * Every turn carries it, because a real provider echoes one on every response
 * and a rig whose turns silently had none would meter its whole suite under the
 * proxy's `(unreported)` bucket — which is a state worth reaching deliberately
 * and never by accident.
 */
export const SERVED_MODEL = "claude-sonnet-4-6";

/**
 * The same turn, served by a different model, or by none.
 *
 * `withUsage`'s shape and its argument: a decoration rather than a parameter on
 * `calls`/`says`, because the model is irrelevant to every case that is not
 * about pricing. Passing `undefined` is the provider that echoed nothing, which
 * is the case a dollar cap has to fail closed on — spelled explicitly, so a
 * script cannot arrive at it by forgetting.
 */
export function servedBy(
  response: CompletionResponse,
  model: string | undefined
): CompletionResponse {
  if (model === undefined) {
    // Deleted from a copy rather than set to `undefined`. `CompletionResponse`
    // has `exactOptionalPropertyTypes` behind it, and the agent's spend client
    // reads absence rather than the value — a present key holding `undefined`
    // is a different thing from a provider that echoed nothing.
    const stripped = { ...response };
    delete stripped.model;
    return stripped;
  }
  return { ...response, model };
}

/** One turn's answer: text and stop. */
export function says(text: string): CompletionResponse {
  return { text, toolCalls: [], stopReason: "end_turn", usage: { ...USAGE }, model: SERVED_MODEL };
}

/** One turn's answer: call a tool. `name` is the flat name the listing published. */
export function calls(name: string, args: Record<string, unknown>, id = "call-1"): CompletionResponse {
  const toolCall: ToolCall = { id, name, arguments: args };
  return { text: "", toolCalls: [toolCall], stopReason: "tool_use", usage: { ...USAGE }, model: SERVED_MODEL };
}

/**
 * One turn of a script: an answer, or a function of the request that produced it.
 *
 * The function form exists for one shape and should stay rare — a model whose
 * answer depends on what it was handed. Everything else is a constant, because
 * a scripted attacker that computes its own turns is a program, and a program
 * is harder to read than the sequence it stands for.
 */
export type ScriptTurn = CompletionResponse | ((request: CompletionRequest) => CompletionResponse);

/**
 * One turn's answer: post every tool result it was given, verbatim.
 *
 * The compromised model, doing the most damaging honest thing available to it —
 * relaying what the proxy handed it straight into the channel. It is how a leak
 * becomes public rather than merely present, and it makes the thread reply a
 * real surface for the canary scan instead of a fixed string the case wrote.
 *
 * What has to appear in that reply is the redaction marker: the model relayed
 * everything, and everything was a name.
 */
export function relays(): ScriptTurn {
  return request =>
    says(
      request.messages
        .filter(message => message.role === "tool")
        // Flattened with the canonical flatten, so a text result relays exactly
        // the characters it always did and a binary one relays the sentence
        // naming it rather than its payload. The canary scan depends on the
        // first half of that; #503 is what asserts the second.
        .map(message => resultText(message.content))
        .join("\n")
    );
}

/**
 * Fired as the model is asked for a turn, with the 1-based turn number.
 *
 * The seam a mid-flight mutation needs, and the reason it is here rather than
 * on the upstream: the loop lists tools once and only then enters the turn
 * loop, so anything this does on turn 1 is provably after the listing was
 * built and before the first tool call is submitted. That is the ordering a
 * case wants when it changes a team sheet between the two — the listing
 * carries the tool, and the call is judged against the sheet without it.
 *
 * Firing on the upstream's `tools/list` instead would depend on two things a
 * case cannot see: that hook also fires for `server/discover`, and the catalog
 * is cached per upstream for five minutes, so whether a later task asks the
 * upstream anything at all is not the case's to decide.
 */
export type ModelTurnHook = (turn: number) => void;

/**
 * Replays `script` one entry per turn.
 *
 * Running off the end throws rather than looping or returning something
 * plausible: a task that took more turns than the case scripted has stopped
 * being the scenario under test, and the error says which turn it was.
 */
export function scriptedModel(script: readonly ScriptTurn[], onTurn?: ModelTurnHook): ScriptedModel {
  const seen: CompletionRequest[] = [];
  return {
    seen,
    client: {
      complete(request: CompletionRequest): Promise<CompletionResponse> {
        const next = script[seen.length];
        seen.push(request);
        if (next === undefined) {
          throw new Error(`e2e: the model was asked for turn ${seen.length}; the script has ${script.length}`);
        }
        // Before the answer, so what it changes is in force by the time the
        // loop acts on that answer. A throw here propagates for the same
        // reason running off the end does: the scenario stopped being itself.
        onTurn?.(seen.length);
        // And the turn is built after the hook, so a computed answer sees the
        // world the hook left rather than the one it found.
        return Promise.resolve(typeof next === "function" ? next(request) : next);
      }
    }
  };
}

/**
 * The system prompts of the turns nobody asked for.
 *
 * Every one of these is a post-reply job or a background pass, and every one of
 * them is seeded with a single message — which is the same shape a task's
 * opening turn has. So the filter below cannot be "one message"; it has to name
 * them, and **it has to gain a member whenever the composition grows a turn
 * nobody asked for**, or `openingContexts` starts quietly counting one of them
 * as a task and every index after it is off by one.
 *
 * It lives here rather than in the case that needed it first (#293's) because
 * #308 made a second file need it, and because a filter whose correctness
 * depends on being complete should be in one place.
 */
const BACKGROUND_SYSTEM_PROMPTS: ReadonlySet<string> = new Set([
  SKILL_AUTHOR_SYSTEM_PROMPT,
  SKILL_MERGE_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  CURATION_SYSTEM_PROMPT
]);

/**
 * The opening context of each task, in order.
 *
 * **Two filters, and the second is the one that is easy to get wrong.** Dropping
 * the turns nobody asked for is obvious once the set above is complete. What is
 * left is still every *turn* of every task, and a tool-heavy task has several —
 * so the "second task" is not the second entry, which is what
 * `memory-curation.test.ts` can get away with only because each of its tasks is
 * a single turn.
 *
 * A task's opening context is its first turn, and a first turn is the one seeded
 * with exactly one message: `assembleContext` returns one `user` message however
 * much it packed into it, and every later turn of the same task carries the
 * transcript that grew from it.
 */
export function openingContexts(model: { seen: readonly CompletionRequest[] }): string[] {
  return model.seen
    .filter(request => request.system === undefined || !BACKGROUND_SYSTEM_PROMPTS.has(request.system))
    .filter(request => request.messages.length === 1)
    .map(request => {
      const seed = request.messages[0];
      if (seed === undefined || seed.role !== "user") throw new Error("expected a user message");
      return seed.content;
    });
}
