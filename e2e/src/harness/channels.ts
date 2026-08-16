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
  /**
   * The `[mcp_server.auth]` block: this upstream takes an OAuth token the proxy
   * mints, not a vault value. The issuer is the fake token issuer's url, known
   * only after it binds — and compared byte for byte against the grant record
   * and discovery's echo, so a case writes the same string in all three places
   * or fails as `issuer_mismatch`. The schema requires `credential` beside it:
   * that name is where the grant lives in the token store.
   */
  readonly auth?: { readonly issuer: string; readonly scopes?: readonly string[] };
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
  /**
   * The loop's own per-task token ceiling, `[llm] max_tokens_per_task`.
   *
   * Written out only by cases whose turns report large counts — a spend case
   * needs a turn to cost a readable number of dollars, which means a million
   * tokens, which is five times the schema's default. Left alone the loop would
   * end the task on its own cap and the case would prove nothing about the
   * proxy's meter, quietly and with the same number of upstream calls.
   */
  readonly maxTokensPerTask?: number;
  readonly dailyTokens?: number;
  readonly dailyToolCalls?: number;
  /**
   * The dollar cap (#62). Absent by default, and that default is load-bearing.
   *
   * A sheet without it never consults the price table at all, so every case in
   * this suite that is not about pricing keeps the behaviour it had before
   * prices existed — including the ones whose scripted model reports a model no
   * table prices. Setting it is what turns the price table into a gate.
   */
  readonly dailyUsd?: number;
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
   * The `[memory]` block: whether this channel curates a `MEMORY.md` (#227).
   *
   * **Off unless a case says otherwise, and that inversion is deliberate.** The
   * schema prefaults `enabled = true`, so a sheet that said nothing would turn
   * curation on for every case in this suite — and a curation turn is a model
   * turn, which consumes the next entry of a script written before curation
   * existed. Every case here would fail with "the model was asked for turn N;
   * the script has N", and the ones that did not would be silently asserting
   * against a transcript with an extra call in it.
   *
   * So this file writes `enabled = false` unless asked, for `dailyUsd`'s
   * reason: the default a fixture takes should be the one that leaves every
   * other case exactly as it was, and turning the feature on is what a case
   * about the feature does.
   */
  readonly memory?: { readonly enabled?: boolean; readonly maxFileChars?: number };
  /**
   * The `[skills]` block: whether this channel loads playbooks at the head of a
   * task and writes one after a tool-heavy one (#292, #291).
   *
   * **Off unless a case says otherwise, for `memory`'s reason exactly**, and the
   * argument is a little stronger here because both halves would bite. The
   * schema prefaults `enabled = true`, so a sheet that said nothing would give
   * every case in this suite a reconcile and a retrieval at the head of every
   * task — and, above the threshold, an author turn, which is a model turn that
   * consumes the next entry of a script written before skills existed.
   *
   * `authorAfterToolCalls` is here because a case about the write half should
   * not have to script six served tool calls to reach the default threshold. It
   * is the channel's `author_after_tool_calls` and the comparison is still
   * **strictly** greater, so the schema's floor of `1` is the cheapest a sheet
   * can ask for and means "two served calls". A case wanting the turn *not* to
   * fire says so with a script that serves fewer, not with a smaller number.
   */
  readonly skills?: {
    readonly enabled?: boolean;
    readonly authorAfterToolCalls?: number;
    readonly topK?: number;
    readonly maxSkillChars?: number;
    readonly maxSkills?: number;
  };
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
          ...(spec.maxTokensPerTask !== undefined
            ? [`max_tokens_per_task = ${spec.maxTokensPerTask}`]
            : []),
          ...(spec.maxHistoryMessages !== undefined
            ? [`max_history_messages = ${spec.maxHistoryMessages}`]
            : []),
          ``,
          `[budget]`,
          `daily_tokens = ${spec.dailyTokens ?? 1_000_000}`,
          `daily_tool_calls = ${spec.dailyToolCalls ?? 200}`,
          ...(spec.dailyUsd !== undefined ? [`daily_usd = ${spec.dailyUsd}`] : []),
          ...(spec.cacheReadWeight !== undefined ? [`cache_read_weight = ${spec.cacheReadWeight}`] : []),
          ...(spec.cacheWriteWeight !== undefined ? [`cache_write_weight = ${spec.cacheWriteWeight}`] : []),
          ...(spec.warnAt !== undefined ? [`warn_at = ${spec.warnAt}`] : []),
          ``,
          `[memory]`,
          `enabled = ${spec.memory?.enabled ?? false}`,
          ...(spec.memory?.maxFileChars !== undefined
            ? [`max_file_chars = ${spec.memory.maxFileChars}`]
            : []),
          ``,
          `[skills]`,
          `enabled = ${spec.skills?.enabled ?? false}`,
          ...(spec.skills?.authorAfterToolCalls !== undefined
            ? [`author_after_tool_calls = ${spec.skills.authorAfterToolCalls}`]
            : []),
          ...(spec.skills?.topK !== undefined ? [`top_k = ${spec.skills.topK}`] : []),
          ...(spec.skills?.maxSkillChars !== undefined
            ? [`max_skill_chars = ${spec.skills.maxSkillChars}`]
            : []),
          ...(spec.skills?.maxSkills !== undefined
            ? [`max_skills = ${spec.skills.maxSkills}`]
            : []),
          ``,
          `[[mcp_server]]`,
          `name = "${server}"`,
          `transport = "http"`,
          `url = "${spec.url}"`,
          ...(spec.credential !== undefined ? [`credential = "${spec.credential}"`] : []),
          ...(spec.auth === undefined
            ? []
            : [
                ``,
                `  [mcp_server.auth]`,
                `  scheme = "oauth"`,
                `  issuer = "${spec.auth.issuer}"`,
                ...(spec.auth.scopes === undefined
                  ? []
                  : [`  scopes = [${spec.auth.scopes.map(scope => `"${scope}"`).join(", ")}]`])
              ]),
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
