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
// the next mention, which is the same freshness a stat-guarded cache would give
// and none of the invalidation state that #63, #66, and #67 would have to work
// around.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { TeamSheet } from "@getlibero/schema";
import { ChannelId, parseTeamSheet } from "@getlibero/schema";
import type { TaskSettings } from "./types.js";

/** The sheet's filename inside a channel's directory. */
export const SHEET_FILENAME = "channel.toml";

export type SheetResolver = (channel: string) => Promise<TaskSettings>;

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
export function settingsFrom(sheet: TeamSheet, fallbackModel: string): TaskSettings {
  return {
    model: sheet.llm.model ?? fallbackModel,
    caps: {
      maxToolCalls: sheet.llm.max_tool_calls_per_task,
      maxWallTimeMs: sheet.llm.max_task_seconds * 1000,
      maxTokens: sheet.llm.max_tokens_per_task,
      maxOutputTokensPerTurn: sheet.llm.max_tokens_per_turn
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

  const defaults = (): TaskSettings => ({
    model: options.model,
    // Spread: the constant is an exported mutable object, and handing the same
    // one to every channel is a caller away from one channel's edit becoming
    // every channel's.
    caps: { ...DEFAULT_AGENT_LOOP_CAPS }
  });

  return async (channel: string): Promise<TaskSettings> => {
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
