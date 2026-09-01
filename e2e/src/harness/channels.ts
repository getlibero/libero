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
/**
 * A `[[builtin]]` entry, which since #394 is not the same shape as a tool.
 *
 * `run_code` carries sandbox caps the other two have no use for, and the schema
 * makes that a discriminated union so a cap on the wrong block is an issue
 * naming the field rather than a key zod quietly strips. Here the caps are
 * simply optional, because this writer is producing TOML for the schema to
 * judge — writing a bad sheet on purpose is a thing a case may want to do.
 */
export interface SheetBuiltin extends SheetTool {
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly timeoutSeconds?: number;
}

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
  readonly auth?: {
    readonly issuer: string;
    readonly scopes?: readonly string[];
    /**
     * The sheet's `dpop` posture (#505). Absent leaves the schema's default,
     * `prefer` — which against an issuer that advertises nothing is the bearer
     * path, and is what every case written before #506 wants.
     */
    readonly dpop?: "prefer" | "require" | "off";
  };
  readonly tools: readonly SheetTool[];
  readonly serverName?: string;
  /**
   * Wall clock for one task.
   *
   * Generous by default, and it has to be: the loop's cap is a real
   * `AbortSignal.timeout` that no fake timer can drive, so this is spent in
   * real seconds. Small enough that a hang fails as a cap with a clear stop
   * reason rather than as a bare runner timeout with none.
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
  /**
   * `[llm] max_result_chars`, the channel's bound on one tool answer.
   *
   * Written out only by the case that is about the bound itself, like
   * `maxHistoryMessages` above. The default of 32,768 is what makes "nothing
   * binary reaches a model until an operator raises a number" true, so a case
   * that wants a payload to *cross* has to say so here — and one that wants to
   * watch it degrade should leave this alone rather than pick a small number,
   * because the default is the behaviour every deployment has.
   */
  readonly maxResultChars?: number;
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
  readonly builtins?: readonly SheetBuiltin[];
  /**
   * The `[egress]` block: where sandboxed code may reach (#219).
   *
   * **Absent and empty are the same grant and it is "nowhere".** A run whose
   * channel lists no hosts gets no network at all — not a filtered one — so a
   * case proving that needs to write nothing, and a case proving the opposite
   * needs an entry here and a `run_code` builtin beside it.
   *
   * Patterns, not hosts: `isEgressAllowed` decides and it takes what an operator
   * wrote, wildcard and all.
   */
  readonly egress?: readonly string[];
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
   *
   * **`summarize` is written out beside `enabled`, and it has to be, because it
   * is not gated by it (#308).** `createSummarySweep` tests `[memory] summarize`
   * and nothing else, so a sheet that turned memory *off* and said nothing about
   * summarizing would still carry `summarize = true` from the schema's prefault
   * — and every sheet this harness wrote before #308 did exactly that. Nothing
   * noticed only because no sweep was composed.
   *
   * What it would have cost the moment one was: `staleThreads` has no minimum
   * message count, every fixture `ts` in this suite is months in the past, and
   * `MAX_THREADS_PER_SWEEP` is three — so the four files that deliver a plain
   * message would each have got up to three summarization turns, three of them
   * against one-entry scripts. They would have failed with "the model was asked
   * for turn N; the script has 1", which reads like a bug in the sweep.
   *
   * The inversion is `enabled`'s, for a sharper reason: there the prefault is
   * merely on, here it is on *and* unreachable from the switch a reader would
   * expect to turn it off.
   */
  readonly memory?: {
    readonly enabled?: boolean;
    readonly summarize?: boolean;
    readonly maxFileChars?: number;
  };
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
   *
   * `curate` is written out for `[memory] summarize`'s reason exactly (#308).
   * The schema prefaults it `true` (#295) and the merge curator gates on
   * `enabled && curate`, so a case that turned skills on to test retrieval would
   * silently also be a case that spends a model call a day proposing merges. It
   * is off unless asked.
   *
   * The two clocks take the ordinary spread-ternary rather than joining the two
   * switches, because inheriting their schema defaults costs nothing: thirty and
   * ninety days spend nothing, write nothing, and consume no script entry. Only
   * a case driving the clocks has an opinion, and the schema refuses
   * `stale_after_days` above `archive_after_days` — so lowering the first alone
   * parses and raising it alone does not.
   */
  readonly skills?: {
    readonly enabled?: boolean;
    readonly curate?: boolean;
    readonly authorAfterToolCalls?: number;
    readonly topK?: number;
    readonly maxSkillChars?: number;
    readonly maxSkills?: number;
    readonly staleAfterDays?: number;
    readonly archiveAfterDays?: number;
  };
  /**
   * The `[ambient]` block: whether this channel is spoken to unbidden (#321).
   *
   * **Off unless a case says otherwise, and here the schema agrees** — unlike
   * `[memory]` and `[skills]` above, whose prefaults are on and whose sheets
   * therefore have to say `false` out loud. `[ambient] enabled` is the one
   * switch on a team sheet that defaults off, so writing it is belt and braces
   * rather than a correction.
   *
   * It is written anyway, for the reason #308 found the hard way: a block left
   * to its prefault is a block no case can see the value of, and this is the one
   * whose accidental default would be *the agent speaking to a channel nobody
   * asked*. A reader of a rig's sheet should be able to tell without knowing the
   * schema.
   *
   * The two figures are here because a case driving the pregate has an opinion
   * about both: `heartbeatEveryMinutes` is what the scheduler wakes on, and
   * `answerAfterIdleMinutes` is what counts as unanswered — the knob the
   * front-running case drives from both sides.
   */
  readonly ambient?: {
    readonly enabled?: boolean;
    readonly heartbeatEveryMinutes?: number;
    readonly answerAfterIdleMinutes?: number;
    /**
     * `[ambient] heartbeat` (#461). Absent writes no line, inheriting `true`.
     *
     * **Written only when a case says so**, which is the opposite of `enabled`
     * above and for the reason that one gives in reverse. `enabled`'s accidental
     * default would be the agent speaking to a channel nobody asked, so the rig
     * writes it out loud whatever it is. This one's accidental default is the
     * behaviour every case before #461 already had, so a sheet that says nothing
     * is exactly the sheet those cases were written against — and writing it
     * would make every existing rig's sheet differ from the sheet it was
     * verified with.
     */
    readonly heartbeat?: boolean;
    /**
     * `[ambient] tools` (#348). Absent writes no line, inheriting `false`.
     *
     * Written only when a case says so, which is `heartbeat`'s rule above and
     * for the same reason: the inherited value is what every case written before
     * this existed was verified against, so writing it would make every rig's
     * sheet differ from the one its assertions were checked against.
     */
    readonly tools?: boolean;
    /**
     * `[[ambient.rule]]` entries (#461).
     *
     * Absent writes no block, which is every channel that names no standing
     * rules — and, since the whole point of the surface is that only a sheet can
     * declare one, it is also the state `rule-injection` asserts a compromised
     * model cannot leave.
     *
     * `days` is optional here because it is optional in the schema, and absent
     * means daily. A case that wants a rule not to fire today says so by naming
     * days rather than by choosing an instant, which is the readable half.
     */
    readonly rules?: readonly {
      readonly name: string;
      readonly at: readonly string[];
      readonly days?: readonly string[];
      /** `timezone` (#470). Absent writes no line, which is the rule read in UTC. */
      readonly timezone?: string;
      readonly question: string;
    }[];
  };
  /**
   * The `[[shared_skill]]` entries this channel's sheet names (#436).
   *
   * **Absent writes no block at all**, which is the sheet a channel has when its
   * operator publishes nothing to it — and, with `RigOptions.sharedSkills`
   * absent too, the deployment that mounted no third root. Both halves are
   * needed: the root is where the file is, and this is which channels get it.
   * That the two are separate is the property `shared-skill-poisoning.test.ts`
   * leans on, since a file in the root that no sheet names must reach nothing.
   *
   * `load` has no default here because it has none in the schema either — the
   * two modes are different regions of the prompt, and a spec that let one be
   * inferred would be a rig choosing which.
   */
  readonly sharedSkills?: readonly { readonly name: string; readonly load: "always" | "retrieved" }[];
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
          ...(spec.maxResultChars !== undefined
            ? [`max_result_chars = ${spec.maxResultChars}`]
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
          `summarize = ${spec.memory?.summarize ?? false}`,
          ...(spec.memory?.maxFileChars !== undefined
            ? [`max_file_chars = ${spec.memory.maxFileChars}`]
            : []),
          ``,
          `[skills]`,
          `enabled = ${spec.skills?.enabled ?? false}`,
          `curate = ${spec.skills?.curate ?? false}`,
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
          ...(spec.skills?.staleAfterDays !== undefined
            ? [`stale_after_days = ${spec.skills.staleAfterDays}`]
            : []),
          ...(spec.skills?.archiveAfterDays !== undefined
            ? [`archive_after_days = ${spec.skills.archiveAfterDays}`]
            : []),
          ...(spec.sharedSkills ?? []).flatMap(shared => [
            ``,
            `[[shared_skill]]`,
            `name = "${shared.name}"`,
            `load = "${shared.load}"`
          ]),
          ``,
          `[ambient]`,
          `enabled = ${spec.ambient?.enabled ?? false}`,
          ...(spec.ambient?.heartbeat !== undefined
            ? [`heartbeat = ${spec.ambient.heartbeat}`]
            : []),
          ...(spec.ambient?.tools !== undefined ? [`tools = ${spec.ambient.tools}`] : []),
          ...(spec.ambient?.heartbeatEveryMinutes !== undefined
            ? [`heartbeat_every_minutes = ${spec.ambient.heartbeatEveryMinutes}`]
            : []),
          ...(spec.ambient?.answerAfterIdleMinutes !== undefined
            ? [`answer_after_idle_minutes = ${spec.ambient.answerAfterIdleMinutes}`]
            : []),
          // Nested under `[ambient]`, so these have to sit after that table's own
          // keys and before the next `[block]`. TOML reads the placement rather
          // than the name: written anywhere below `[[mcp_server]]` they would
          // silently belong to something else, or fail to parse.
          ...(spec.ambient?.rules ?? []).flatMap(rule => [
            ``,
            `[[ambient.rule]]`,
            `name = "${rule.name}"`,
            `at = [${rule.at.map(time => `"${time}"`).join(", ")}]`,
            ...(rule.days === undefined
              ? []
              : [`days = [${rule.days.map(day => `"${day}"`).join(", ")}]`]),
            ...(rule.timezone === undefined ? [] : [`timezone = "${rule.timezone}"`]),
            `question = "${rule.question}"`
          ]),
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
                  : [`  scopes = [${spec.auth.scopes.map(scope => `"${scope}"`).join(", ")}]`]),
                ...(spec.auth.dpop === undefined ? [] : [`  dpop = "${spec.auth.dpop}"`])
              ]),
          ``,
          tools,
          ...(spec.builtins === undefined
            ? []
            : spec.builtins.flatMap(builtin => [
                ``,
                `[[builtin]]`,
                `name = "${builtin.name}"`,
                ...(builtin.approval !== undefined ? [`approval = "${builtin.approval}"`] : []),
                ...(builtin.cpus !== undefined ? [`cpus = ${builtin.cpus}`] : []),
                ...(builtin.memoryMb !== undefined ? [`memory_mb = ${builtin.memoryMb}`] : []),
                ...(builtin.timeoutSeconds !== undefined ? [`timeout_seconds = ${builtin.timeoutSeconds}`] : [])
              ])),
          // Written only when a case asks for it, so every sheet in this suite
          // that says nothing keeps granting nothing — which is the default an
          // operator gets and the fixture the no-network case needs.
          ...(spec.egress === undefined
            ? []
            : [``, `[egress]`, `allow = [${spec.egress.map(pattern => `"${pattern}"`).join(", ")}]`])
        ].join("\n")
      );
    }
  };
}
