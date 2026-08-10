// The team sheets, in a temporary channels root.
//
// Both processes read this directory, and they read it for different reasons:
// for the proxy it is the authorization source, and for the agent side it is
// four caps and a model name. The suite writes one root and points both at it,
// which is what the deployment does.
//
// Sheets are written as TOML text rather than built from the zod schema. The
// schema is what the proxy parses *with*, so generating the file from it would
// mean a malformed sheet could never be written — and "the proxy refuses a
// sheet it cannot parse" is a claim the attack cases need to be able to make.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cleanup } from "./cleanup.js";

/** One tool as a sheet names it. Tools not listed do not exist for the channel. */
export interface SheetTool {
  readonly name: string;
  /** Omitted lets the proxy's destructive-name heuristic decide. */
  readonly approval?: "none" | "required";
}

export interface SheetSpec {
  /** The upstream's single MCP endpoint. Known only after the fake server starts. */
  readonly url: string;
  /** A credential *name*. The value lives in the vault and never here. */
  readonly credential?: string;
  readonly tools: readonly SheetTool[];
  readonly serverName?: string;
  /**
   * Wall clock for one task.
   *
   * Generous by default, and it has to be: the loop's cap is a real
   * `AbortSignal.timeout` that no fake timer can drive, so this is spent in
   * real seconds. Small enough that a hang fails as a cap with a clear stop
   * reason rather than as a vitest timeout with none.
   */
  readonly maxTaskSeconds?: number;
  readonly maxToolCallsPerTask?: number;
  readonly dailyTokens?: number;
  readonly dailyToolCalls?: number;
  /**
   * What a cached token is worth against `dailyTokens`.
   *
   * Written out rather than left to the schema's defaults by the one case that
   * is about the weighting itself: a sheet whose ratio is implicit makes a
   * budget assertion depend on a default nothing in the case names.
   */
  readonly cacheReadWeight?: number;
  readonly cacheWriteWeight?: number;
}

export interface ChannelsRoot {
  readonly path: string;
  /** Writes or replaces one channel's sheet. */
  write(channelId: string, spec: SheetSpec): void;
  /** Writes verbatim text, for the cases that need a sheet the parser refuses. */
  writeRaw(channelId: string, toml: string): void;
  /** Removes a channel's sheet — which is how a channel is revoked. */
  remove(channelId: string): void;
}

export function tempChannelsRoot(cleanup: Cleanup): ChannelsRoot {
  const path = mkdtempSync(join(tmpdir(), "libero-e2e-channels-"));
  cleanup.add("channels", () => rmSync(path, { recursive: true, force: true }));

  const writeRaw = (channelId: string, toml: string): void => {
    const dir = join(path, channelId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "channel.toml"), toml, "utf8");
  };

  return {
    path,
    writeRaw,
    remove(channelId: string): void {
      rmSync(join(path, channelId), { recursive: true, force: true });
    },
    write(channelId: string, spec: SheetSpec): void {
      const server = spec.serverName ?? "github";
      const tools = spec.tools
        .map(
          tool =>
            `  [[mcp_server.tool]]\n  name = "${tool.name}"\n` +
            (tool.approval !== undefined ? `  approval = "${tool.approval}"\n` : "")
        )
        .join("\n");

      writeRaw(
        channelId,
        [
          `[channel]`,
          `name = "e2e"`,
          `description = "End-to-end suite."`,
          ``,
          `[llm]`,
          `max_task_seconds = ${spec.maxTaskSeconds ?? 30}`,
          `max_tool_calls_per_task = ${spec.maxToolCallsPerTask ?? 5}`,
          ``,
          `[budget]`,
          `daily_tokens = ${spec.dailyTokens ?? 1_000_000}`,
          `daily_tool_calls = ${spec.dailyToolCalls ?? 200}`,
          ...(spec.cacheReadWeight !== undefined ? [`cache_read_weight = ${spec.cacheReadWeight}`] : []),
          ...(spec.cacheWriteWeight !== undefined ? [`cache_write_weight = ${spec.cacheWriteWeight}`] : []),
          ``,
          `[[mcp_server]]`,
          `name = "${server}"`,
          `transport = "http"`,
          `url = "${spec.url}"`,
          ...(spec.credential !== undefined ? [`credential = "${spec.credential}"`] : []),
          ``,
          tools
        ].join("\n")
      );
    }
  };
}
