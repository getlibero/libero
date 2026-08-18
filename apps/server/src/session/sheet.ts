// The channel's team sheet, as far as this process is concerned: a model id and
// four per-task caps.
//
// **Advisory, and that is the whole shape of this file.** The tool proxy
// service resolves the same sheet from the same directory and enforces it —
// which tools exist, which need a human, what the channel has left in its daily
// budget. What is resolved here is defence in depth: caps the loop applies to
// its own turns, and the model the provider is asked for. Nothing decided here
// can widen what a channel is permitted to do.
//
// That is why every failure below falls back to the built-in defaults rather
// than refusing to run. A fallback cannot loosen an authorization decision,
// because the authorization decision is not made here. The opposite policy —
// no readable sheet, no task — would put one on the wrong side of the boundary
// and take a whole deployment dark the first time a volume is mounted at the
// wrong path.
//
// There is no cache, no stat, no fingerprint, and no watcher. One read per
// task, next to a TLS handshake and a model turn. An operator's edit lands on
// the next task, which is the same freshness a stat-guarded cache would give
// and none of the invalidation state the message store, the follow-up window,
// and the context assembler would have to work around.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { TeamSheet } from "@getlibero/schema";
import { ChannelId, parseTeamSheet } from "@getlibero/schema";
import type { ChannelSettings } from "./types.js";

/** The sheet's filename inside a channel's directory. */
export const SHEET_FILENAME = "channel.toml";

/**
 * What a channel gets when no sheet resolved.
 *
 * Mirrors the `[llm] max_history_*` defaults in `packages/schema`, the way
 * `DEFAULT_AGENT_LOOP_CAPS` mirrors the four caps beside them — and kept in step
 * by hand for the same reason: schema is the base package and holds the values,
 * but nothing here can reach a zod default without parsing a sheet that does
 * not exist.
 *
 * Falling back to *some* history rather than none, deliberately. A channel
 * whose sheet is missing or malformed still has a conversation, and answering
 * it with no context is a visible downgrade for an operator's typo. Nothing
 * here can widen anything — the proxy enforces the same file from its own copy.
 */
export const DEFAULT_HISTORY_BOUNDS = { maxMessages: 40, maxChars: 12_000 } as const;

/**
 * What a channel gets when no sheet resolved: the schema's own default, in
 * milliseconds.
 *
 * Mirrored by hand for the reason `DEFAULT_HISTORY_BOUNDS` is. Falling back to
 * the default rather than to zero, deliberately — a sheet with a typo in it
 * should not silently change how the agent behaves in a channel's threads, and
 * this can widen nothing: the proxy enforces the same file from its own copy,
 * and every task a follow-up starts is capped and metered exactly as a
 * mention's is.
 */
export const DEFAULT_FOLLOW_UP_WINDOW_MS = 900_000;

/**
 * What a channel gets when no sheet resolved: **curation off**, and that is the
 * one fallback on this page that departs from the schema's own default.
 *
 * Every other default here falls back to the schema's figure, because a fallback
 * cannot loosen an authorization decision — the proxy enforces the same file
 * from its own copy, so nothing resolved here is the decision. `[memory]` is the
 * exception the schema names: the proxy never opens `MEMORY.md` and holds no
 * second copy of these numbers, so for this block the fallback *is* the
 * decision.
 *
 * So the two failures are not symmetric and are not treated as though they were.
 * A typo that costs a channel its memory is a degradation the reply survives and
 * an operator notices; a typo that switches curation *on* for a channel that
 * wrote `enabled = false` is a policy violation, and it would be one this
 * process committed on its own. The cap is still the schema's figure — it only
 * matters when something is enabled, and inventing a second number for a
 * disabled feature is how the two drift.
 */
export const DEFAULT_MEMORY_SETTINGS = {
  enabled: false,
  maxFileChars: 32_768,
  // Off for `enabled`'s reason, and it is the stronger case of the two. Curation
  // writes a file the team can read and correct; summarization spends this
  // channel's tokens on conversations nobody addressed the agent about. A typo
  // that switches *that* on for a channel whose sheet says otherwise is the
  // failure this whole fallback exists to refuse.
  summarize: false,
  summarizeAfterIdleMs: 60 * 60_000
} as const;

/**
 * What a channel gets when no sheet resolved: **skills off**, and the argument
 * is this file's second departure from the schema's own default rather than a
 * copy of the one above it.
 *
 * The schema asks that this constant make the case itself rather than point at
 * `DEFAULT_MEMORY_SETTINGS`, so: every other default on this page falls back to
 * the schema's figure because a fallback here cannot loosen an authorization
 * decision — the proxy enforces the same file from its own copy, so what is
 * resolved here is defence in depth. `[skills]` has no second copy. The proxy
 * never opens a skill file, never reads this directory, and has no opinion about
 * `top_k`; whatever this line says is what happens. So for this block the
 * fallback *is* the decision, and a decision made on a channel whose sheet could
 * not be read should be the quiet one.
 *
 * Concretely: a mistyped sheet that costs a channel its skills is a degradation
 * its replies survive and an operator notices. A mistyped sheet that switches
 * skill loading *on* for a channel that wrote `enabled = false` would be this
 * process injecting model-authored, cross-task text into a channel that asked
 * for none — a policy violation this process committed on its own, and one
 * nobody in the channel can see. The two failures are not symmetric.
 *
 * `curate` is `false` here too, and writing it rather than leaving it to
 * `enabled` is deliberate even though the pass checks both. A fallback for a
 * block with no second copy *is* the decision, so a reader should be able to see
 * it rather than prove it by composition — and the failure it stands against is
 * the sharper one of the two: an unreadable sheet that switched *curation* on
 * would be this process spending a channel's budget on a background turn and
 * writing files into their directory, on a channel whose sheet nobody could read.
 *
 * The other numbers are still the schema's figures. They only matter once
 * something is enabled, and inventing a second set for a disabled feature is
 * how two copies of a number drift.
 */
export const DEFAULT_SKILL_SETTINGS = {
  enabled: false,
  curate: false,
  authorAfterToolCalls: 5,
  topK: 3,
  maxSkillChars: 8_192,
  maxSkills: 100,
  staleAfterMs: 30 * 86_400_000,
  archiveAfterMs: 90 * 86_400_000
} as const;

/**
 * What a channel gets when no sheet resolved: **ambient off**, and this is the
 * page's third departure from the schema's default and the least arguable of
 * them.
 *
 * The two above make the case that a fallback here cannot loosen an
 * authorization decision, because the proxy enforces the same file from its own
 * copy — and then name `[memory]` and `[skills]` as the blocks with no second
 * copy, where the fallback *is* the decision. `[ambient]` is that, and worse:
 * the other two govern what a task does once somebody has asked for one, and
 * this one governs whether the agent speaks in a channel that asked for nothing
 * at all. There is no tool call in a heartbeat for the proxy to decide, so
 * nothing downstream would catch a mistake made here.
 *
 * So an unreadable sheet is silence. A channel that wrote `enabled = true` and
 * then broke its own file loses its heartbeats until the file parses, which an
 * operator notices; the opposite failure is this process speaking, unbidden, in
 * a channel whose sheet nobody could read.
 *
 * The two figures are still the schema's, for the reason the blocks above give:
 * they only matter once something is enabled, and a second set of numbers for a
 * disabled feature is how two copies of a number drift.
 */
export const DEFAULT_AMBIENT_SETTINGS = {
  enabled: false,
  heartbeatEveryMs: 15 * 60_000,
  answerAfterIdleMs: 60 * 60_000
} as const;

export type SheetResolver = (channel: string) => Promise<ChannelSettings>;

export interface SheetResolverOptions {
  /** The channels directory: one directory per channel, each with a sheet. */
  root: string;
  /** `AGENT_MODEL` — what a channel whose sheet names no model runs on. */
  model: string;
  logger?: Logger;
}

/**
 * Sheet to settings, field for field.
 *
 * Apart from the filesystem so the mapping is testable without one, and because
 * it is the half worth testing: every cap in the schema has a default, so this
 * never has to invent one, and the only thing it can get wrong is a name or a
 * unit.
 *
 * `max_task_seconds` is the one conversion rather than a rename — seconds in
 * the sheet because that is what an operator writes, milliseconds in the loop
 * because that is what `AbortSignal.timeout` takes.
 */
export function settingsFrom(sheet: TeamSheet, fallbackModel: string): ChannelSettings {
  return {
    model: sheet.llm.model ?? fallbackModel,
    caps: {
      maxToolCalls: sheet.llm.max_tool_calls_per_task,
      maxWallTimeMs: sheet.llm.max_task_seconds * 1000,
      maxTokens: sheet.llm.max_tokens_per_task,
      maxOutputTokensPerTurn: sheet.llm.max_tokens_per_turn
    },
    // Renames, not conversions — unlike `max_task_seconds` — so the only thing
    // this can get wrong is which field went where.
    history: {
      maxMessages: sheet.llm.max_history_messages,
      maxChars: sheet.llm.max_history_chars
    },
    // The second conversion, and the same one: seconds in the sheet because
    // that is what an operator writes, milliseconds here because that is what a
    // deadline is compared against.
    followUpWindowMs: sheet.llm.follow_up_window_seconds * 1000,
    // Renames again. Note this is the one block whose *fallback* differs from
    // the schema's default — see `DEFAULT_MEMORY_SETTINGS`. A sheet that parsed
    // gets exactly what it asked for, including `enabled = true` by omission,
    // because at that point the operator's file has said.
    memory: {
      enabled: sheet.memory.enabled,
      maxFileChars: sheet.memory.max_file_chars,
      summarize: sheet.memory.summarize,
      // Minutes on the sheet because that is the unit an operator thinks in;
      // milliseconds from here in, because that is the unit every other duration
      // in this process is already in and two units for one quantity is how a
      // number gets read as the wrong one.
      summarizeAfterIdleMs: sheet.memory.summarize_after_idle_minutes * 60_000
    },
    // Renames, and the same standing as the block above it — see
    // `DEFAULT_SKILL_SETTINGS` for why its fallback is not the schema's default.
    // `author_after_tool_calls` is not carried, because nothing reads it until
    // the author turn lands (#291).
    skills: {
      enabled: sheet.skills.enabled,
      curate: sheet.skills.curate,
      authorAfterToolCalls: sheet.skills.author_after_tool_calls,
      topK: sheet.skills.top_k,
      maxSkillChars: sheet.skills.max_skill_chars,
      maxSkills: sheet.skills.max_skills,
      // Days there, milliseconds here — `summarizeAfterIdleMs`'s conversion,
      // made once, where the sheet stops and this process starts.
      staleAfterMs: sheet.skills.stale_after_days * 86_400_000,
      archiveAfterMs: sheet.skills.archive_after_days * 86_400_000
    },
    // Renames and the minutes-to-milliseconds conversion again, and the same
    // standing as the two blocks above — see `DEFAULT_AMBIENT_SETTINGS` for why
    // its fallback is not the schema's default either. `answer_after_idle_ms`
    // is carried and unread until the evaluation turn lands (#319); the
    // scheduler reads the other two.
    ambient: {
      enabled: sheet.ambient.enabled,
      heartbeatEveryMs: sheet.ambient.heartbeat_every_minutes * 60_000,
      answerAfterIdleMs: sheet.ambient.answer_after_idle_minutes * 60_000
    }
  };
}

/** The errno of a failed read, or `undefined` when it was not a filesystem error. */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Builds the resolver. It never throws, and never returns partial settings.
 *
 * The sheet picks a **model id, not a provider**. `AGENT_PROVIDER` is this
 * process's and is not per-channel: a sheet naming a model the configured
 * provider does not serve fails at the provider, which the gateway logs as
 * `handler_failed`. Validating it here is impossible anyway — model ids are
 * opaque strings passed through verbatim by design.
 */
export function createSheetResolver(options: SheetResolverOptions): SheetResolver {
  const logger = options.logger ?? createSilentLogger();

  const defaults = (): ChannelSettings => ({
    model: options.model,
    // Spread: the constant is an exported mutable object, and handing the same
    // one to every channel is a caller away from one channel's edit becoming
    // every channel's.
    caps: { ...DEFAULT_AGENT_LOOP_CAPS },
    history: { ...DEFAULT_HISTORY_BOUNDS },
    followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
    memory: { ...DEFAULT_MEMORY_SETTINGS },
    skills: { ...DEFAULT_SKILL_SETTINGS },
    ambient: { ...DEFAULT_AMBIENT_SETTINGS }
  });

  return async (channel: string): Promise<ChannelSettings> => {
    // Before the join, not after. This id becomes a path segment, and the rule
    // for what may be one is stated once in the schema's `ChannelId` — this is
    // the second place that needs the same answer, so it asks rather than
    // reimplements. A rejected id touches the filesystem not at all.
    if (!ChannelId.safeParse(channel).success) {
      logger.log("error", {
        event: "team_sheet_invalid",
        channel,
        reason: "channel_id"
      });
      return defaults();
    }

    let text: string;
    try {
      text = await readFile(join(options.root, channel, SHEET_FILENAME), "utf8");
    } catch (error) {
      const code = errnoOf(error);

      // A channel with no sheet is a channel the tool proxy service refuses
      // every call for. It is unprovisioned, not broken, and one line per
      // mention forever says nothing an operator does not already know.
      if (code === "ENOENT") return defaults();

      logger.log("error", {
        event: "team_sheet_unreadable",
        channel,
        // The errno and nothing else: a code from someone else's closed
        // vocabulary, carrying no path and no file content.
        reason: code ?? "unknown"
      });
      return defaults();
    }

    const parsed = parseTeamSheet(text);
    if (!parsed.ok) {
      // The reason code only. The line, the column, and the failing field paths
      // are deliberately dropped: the authoritative resolver in the tool proxy
      // service watches this same file and already logs them, and `LogFields`
      // is a closed vocabulary that should not grow three fields to restate
      // another process's line. The event word is that service's word, so one
      // grep spans both ends.
      logger.log("error", {
        event: "team_sheet_invalid",
        channel,
        reason: parsed.reason
      });
      return defaults();
    }

    return settingsFrom(parsed.sheet, options.model);
  };
}
