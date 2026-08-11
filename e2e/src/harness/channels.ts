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
  /**
   * How much of the channel's conversation a task starts with.
   *
   * Written out only by the case that is about the bound itself. Left to the
   * schema's default otherwise, which is what every other case wants: enough
   * history that a stored message is visible, without a number in the fixture
   * that nothing asserts on.
   */
  readonly maxHistoryMessages?: number;
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
  /**
   * Where the soft limit sits, as a fraction of the two above (#99).
   *
   * Left to the schema's default except by the case that is about the warning
   * itself, for `cacheReadWeight`'s reason — and because the default is what
   * every other sheet here is implicitly asserting is harmless: a channel
   * nowhere near either limit is never told anything.
   */
  readonly warnAt?: number;
  /**
   * The `[[builtin]]` block: tools the proxy implements itself (#64).
   *
   * Absent by default, so every existing case keeps a sheet that grants none —
   * which is also the "a channel whose sheet omits it is refused" fixture,
   * obtained by writing nothing rather than by writing an exclusion.
   */
  readonly builtins?: readonly SheetTool[];
  /**
   * The certificates allowed to speak for this channel, as SHA-256 digests
   * (#79).
   *
   * Defaulted by the rig to the one certificate it minted for this channel, so
   * every case that is not about pinning writes nothing and gets a sheet that
   * matches the certificate the agent will present. The case that *is* about
   * pinning names its own — one certificate to revoke a second, or two at once
   * to show a rotation with no gap.
   */
  readonly pins?: readonly string[];
}

export interface ChannelsRoot {
  readonly path: string;
  /** Writes or replaces one channel's sheet. */
  write(channelId: string, spec: SheetSpec): void;
  /** Writes verbatim text, for the cases that need a sheet the parser refuses. */
  writeRaw(channelId: string, toml: string): void;
  /**
   * Removes a channel's sheet — which is how a channel is *retired*. Revoking
   * one leaked key without retiring the channel is `pins` above (#79).
   */
  remove(channelId: string): void;
}

/**
 * How a sheet gets its `certificate_sha256` when the case does not name one.
 *
 * The rig passes the digest of the certificate it minted for that channel, so
 * the default sheet pins the default identity and no existing case has to say
 * anything about pinning. A channel with no certificate minted for it — the
 * "unprovisioned" fixtures — has no digest to pin, and gets a placeholder that
 * matches nothing, which is the honest sheet for a channel that cannot call.
 */
export type DefaultPins = (channelId: string) => readonly string[];

const UNMINTED = "00".repeat(32);

export function tempChannelsRoot(cleanup: Cleanup, defaultPins: DefaultPins): ChannelsRoot {
  const path = mkdtempSync(join(tmpdir(), "libero-e2e-channels-"));
  cleanup.add("channels", () => rmSync(path, { recursive: true, force: true }));

  // An empty list does not parse — the schema makes "this channel pins nothing"
  // unsayable on purpose — so a channel with no certificate minted for it gets
  // a digest no certificate can have. Same effect, said in a sheet that parses.
  const pinsFor = (channelId: string, spec: SheetSpec): readonly string[] => {
    const pins = spec.pins ?? defaultPins(channelId);
    return pins.length > 0 ? pins : [UNMINTED];
  };

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
          `certificate_sha256 = [${pinsFor(channelId, spec).map(pin => `"${pin}"`).join(", ")}]`,
          ``,
          `[llm]`,
          `max_task_seconds = ${spec.maxTaskSeconds ?? 30}`,
          `max_tool_calls_per_task = ${spec.maxToolCallsPerTask ?? 5}`,
          ...(spec.maxHistoryMessages !== undefined
            ? [`max_history_messages = ${spec.maxHistoryMessages}`]
            : []),
          ``,
          `[budget]`,
          `daily_tokens = ${spec.dailyTokens ?? 1_000_000}`,
          `daily_tool_calls = ${spec.dailyToolCalls ?? 200}`,
          ...(spec.cacheReadWeight !== undefined ? [`cache_read_weight = ${spec.cacheReadWeight}`] : []),
          ...(spec.cacheWriteWeight !== undefined ? [`cache_write_weight = ${spec.cacheWriteWeight}`] : []),
          ...(spec.warnAt !== undefined ? [`warn_at = ${spec.warnAt}`] : []),
          ``,
          `[[mcp_server]]`,
          `name = "${server}"`,
          `transport = "http"`,
          `url = "${spec.url}"`,
          ...(spec.credential !== undefined ? [`credential = "${spec.credential}"`] : []),
          ``,
          tools,
          ...(spec.builtins === undefined
            ? []
            : spec.builtins.flatMap(builtin => [
                ``,
                `[[builtin]]`,
                `name = "${builtin.name}"`,
                ...(builtin.approval !== undefined ? [`approval = "${builtin.approval}"`] : [])
              ]))
        ].join("\n")
      );
    }
  };
}
