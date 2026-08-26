import { BUILTIN_SERVER, BuiltinToolName } from "./builtin.js";
import { EgressPattern } from "./egress.js";
import { MEMORY_OP_MAX_TEXT_CHARS } from "./memory-op.js";
import { CertificateSha256, CredentialName, ResourceName } from "./names.js";
import { SCHEDULED_TASK_MAX_PROMPT_CHARS } from "./schedule-task.js";
import { SKILL_BODY_MAX_CHARS, SKILL_NAME_PATTERN, SkillName } from "./skill.js";
import { z } from "zod";

/**
 * The team sheet — the per-channel manifest declaring which tools exist,
 * which credentials (by name only) they use, what needs human approval,
 * and how much the channel may spend. See the architecture doc,
 * site/src/content/docs/docs/architecture.md ("The team sheet").
 *
 * This schema is the single source of truth: the proxy validates sheets
 * against it on file change, and invalid sheets are rejected loudly while
 * the previous valid version stays active.
 */

export const ApprovalMode = z.enum(["required", "none"]);

// Server, tool, and credential names are the same shapes the proxy accepts in a
// call and returns in a refusal — imported, not restated, so a name that parses
// in a sheet is a name that survives the round trip. See ./names.ts.
export const ToolEntry = z.object({
  name: ResourceName,
  approval: ApprovalMode.optional(),
  // This tool's own ceiling on what its answer may spend of the channel's
  // context, overriding `[llm] max_result_chars`. Optional because most tools
  // want the channel's number; a tool that returns file listings or diffs is
  // where an operator needs a different one, in either direction.
  //
  // Two entries naming one tool are an operator slip rather than a policy, so
  // they resolve the way `resolveApproval` resolves a disagreement about
  // approval: the most restrictive wins. See packages/proxy/src/enforce.ts.
  max_result_chars: z.number().int().positive().optional(),
});

/**
 * What every `[[builtin]]` block carries, whichever tool it names (#64).
 *
 * The same two optional fields `ToolEntry` carries, resolved by the same two
 * functions in packages/proxy/src/enforce.ts on the same most-restrictive-wins
 * rule. That is deliberate rather than convenient: a built-in is not a bypass,
 * so it earns its approval and its result bound the way every other tool does.
 *
 * `name` is not here because it is the discriminator — see `BuiltinEntry` below,
 * where each member declares its own literal. It is still the reason this block
 * exists at all: a closed set, so a misspelled tool is an issue at
 * `builtin.<n>.name` rather than an entry that parses, lists as permitted, and
 * is refused at dispatch. See ./builtin.ts for the argument in full.
 *
 * There is no `server` field. The provider is the proxy, there is one of it, and
 * the name it answers to is `BUILTIN_SERVER`.
 */
const builtinEntryBase = {
  approval: ApprovalMode.optional(),
  max_result_chars: z.number().int().positive().optional(),
};

/**
 * How much machine one `run_code` call may have.
 *
 * Three caps, each with a default at the tight end, so a block that lists the
 * tool and says nothing gets the small box and loosening it is a line somebody
 * wrote. That is the same direction as the approval default and for the same
 * reason: the sheet is a grant, and the grant should be the narrow reading of
 * what an operator typed.
 *
 * Sheet-settable rather than deployment-only because the thing being sized is a
 * channel's work — one channel doing numerical work and another asking for a
 * date calculation should not have to share a number. What is *not* here is the
 * image: #393 put that in the runner's own environment, pinned by digest, so a
 * sheet cannot choose a toolchain and a channel cannot reach a container this
 * deployment did not build. A field here would be a channel naming what runs on
 * the host, which is the whole shape that decision refused.
 *
 * `cpus` is fractional because the runtime's own limit is (`--cpus=0.5` is a
 * real answer and a common one); the other two are integers because a
 * half-megabyte and a half-second are not units anybody means.
 *
 * A deployment ceiling over these — an operator capping what any sheet may ask
 * for — is not here and is not missing. It is `RUNNER_MAX_CPUS`,
 * `RUNNER_MAX_MEMORY_MB` and `RUNNER_MAX_TIMEOUT_SECONDS` in the runner (#405),
 * because a bound this file cannot check is a promise this file cannot keep and
 * the process that builds the container spec is the one that can keep it.
 *
 * The consequence for a reader of a sheet: **the numbers below are what a
 * channel may ask for, not what it will get.** A deployment whose ceiling is
 * lower clamps rather than refuses, and says so — the run reports the caps it
 * actually had and the channel is told which fields were sized down. So a
 * `[[builtin]]` block is still the honest record of what the channel asked
 * for, and the deployment is where the answer lives.
 */
const sandboxLimits = {
  cpus: z.number().positive().max(64).default(1),
  memory_mb: z.number().int().positive().max(65_536).default(512),
  timeout_seconds: z.number().int().positive().max(3_600).default(30),
};

/**
 * A `[[builtin]]` block, discriminated on the tool it grants.
 *
 * A union rather than one object with optional sandbox fields, for the reason
 * `McpServer` above is one: a flat shape admits a sheet that parses and means
 * something other than it says. `cpus` on a `search_channel_history` block would
 * be stripped in silence by zod and the operator would read the sheet as having
 * sized something. Declared `undefined` on the members that have no sandbox, a
 * stray cap is an issue at `builtin.<n>.cpus` — which names the field, where
 * `.strict()` would report `unrecognized_keys` against the block and name
 * nothing.
 *
 * The two store-backed members share a shape and are still written out
 * separately, because the discriminator is what makes the error message name the
 * block's own tool.
 *
 * **`BuiltinToolName.extract` rather than `z.literal`**, and that is the drift
 * guard rather than a style. A discriminator has to be a literal, so this file
 * became a second place every built-in's name is spelled — and two lists of the
 * same names in two files is the thing ./builtin.ts's enum exists to avoid.
 * `extract` narrows the enum instead of restating it, so a member renamed or
 * removed there is a type error here rather than a block shape for a tool that
 * no longer exists. It does not catch the other direction — a new enum member
 * with no block shape here — but that one is already loud: `BUILTIN_TOOLS` and
 * the executor's switch both fail the build, and a sheet could not grant it.
 *
 * Every member stays structurally assignable to `ToolEntry` — `name` is
 * narrower and the extra fields are additions — which is what lets
 * `resolveApproval` and `resolveLimits` in packages/proxy/src/enforce.ts take
 * one unchanged.
 */
export const BuiltinEntry = z.discriminatedUnion("name", [
  z.object({
    ...builtinEntryBase,
    name: BuiltinToolName.extract(["search_channel_history"]),
    cpus: z.undefined().optional(),
    memory_mb: z.undefined().optional(),
    timeout_seconds: z.undefined().optional(),
  }),
  z.object({
    ...builtinEntryBase,
    name: BuiltinToolName.extract(["schedule_task"]),
    cpus: z.undefined().optional(),
    memory_mb: z.undefined().optional(),
    timeout_seconds: z.undefined().optional(),
  }),
  z.object({
    ...builtinEntryBase,
    name: BuiltinToolName.extract(["run_code"]),
    ...sandboxLimits,
  }),
]);

/**
 * One OAuth scope token, RFC 6749's charset: printable ASCII minus space,
 * double quote, and backslash. Bounded because a scope is a word, not a
 * document, and the list below is bounded for the same reason.
 */
const ScopeToken = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);

/**
 * The `auth` block on an http server (#255): the upstream is secured by an
 * OAuth 2.1 authorization server rather than a service token. Everything in it
 * is a declaration, not a secret — no token, no lifetime, no endpoint. The
 * grant material it points at lives in the proxy's token store, keyed by the
 * block's `credential` name; see "Two credential stores" in
 * packages/proxy/README.md.
 *
 * `issuer` is an RFC 8414 issuer identifier: a URL with no query and no
 * fragment. It is compared byte-for-byte — against the discovery metadata's
 * own `issuer` and against the stored grant's — so it is kept exactly as
 * written, never normalized. No https requirement, for the reason `url` above
 * has none: the test issuer is a loopback address. The token endpoint is not a
 * field; it is discovered from the issuer at mint time and refused unless it
 * sits on the issuer's own origin.
 *
 * `scopes` widening past what the stored grant holds is a re-grant, not an
 * escalation: the proxy fails closed and the operator re-runs the grant flow.
 *
 * `scheme` is the discriminant a second auth shape would join; today the union
 * has one member.
 */
const OAuthConfig = z.object({
  scheme: z.literal("oauth"),
  issuer: z
    .url()
    .refine(
      value => {
        const parsed = new URL(value);
        return parsed.search === "" && parsed.hash === "";
      },
      { message: "an issuer identifier has no query and no fragment" },
    ),
  scopes: z.array(ScopeToken).max(16).default([]),
});

export const AuthConfig = OAuthConfig;
export type AuthConfig = z.infer<typeof AuthConfig>;

// Everything a server block carries whatever it speaks. Spread into both
// members below rather than restated, so the two transports cannot drift in
// what they allow beyond the one field that distinguishes them.
const mcpServerBase = {
  name: ResourceName,
  /** Name of a credential in the proxy vault. Never a secret value. */
  credential: CredentialName.optional(),
  tool: z.array(ToolEntry).default([]),
};

/**
 * An MCP server, discriminated on transport so `url` cannot be wrong.
 *
 * A union rather than one object with an optional `url`, because a flat shape
 * admits two sheets that parse and cannot serve a call: `http` with nothing to
 * call, and `stdio` with a field that is silently ignored. The sheet is the
 * admin surface and the loader's promise is that an invalid sheet is rejected
 * loudly while the previous valid version stays in force — a sheet that parses
 * and then fails at dispatch moves the failure from the operator's terminal at
 * edit time to the far end of a Slack thread.
 *
 * The `stdio` member declares `url` as undefined rather than relying on
 * `.strict()`. Zod strips keys it does not know, so an undeclared `url` on a
 * stdio block would be dropped in silence, which is the failure this exists to
 * prevent. Declared, a present `url` is an issue at `mcp_server.<n>.url` —
 * `.strict()` would report `unrecognized_keys` against the block and name no
 * field, and the field name is what an operator needs.
 *
 * `auth` takes the same treatment for the same reason: an OAuth block on a
 * stdio server would be stripped in silence and the operator would read the
 * sheet as secured. Declared undefined, it is an issue at
 * `mcp_server.<n>.auth`.
 */
export const McpServer = z.discriminatedUnion("transport", [
  z
    .object({
      ...mcpServerBase,
      transport: z.literal("http"),
      /** Required: an HTTP upstream with no address is not addressable. */
      url: z.url(),
      auth: AuthConfig.optional(),
    })
    .check(ctx => {
      // An OAuth block with no credential name has no grant to key: the name
      // is what the grant flow stored the refresh token under. The issue lands
      // on `credential` because that is the field the operator must add.
      if (ctx.value.auth === undefined || ctx.value.credential !== undefined) return;
      ctx.issues.push({
        code: "custom",
        input: ctx.value.credential,
        path: ["credential"],
        message: "an OAuth upstream needs a credential name for the grant the flow stored",
      });
    }),
  z.object({
    ...mcpServerBase,
    transport: z.literal("stdio"),
    /** Not permitted: a stdio upstream is a process, not an address. */
    url: z.undefined().optional(),
    /** Not permitted: OAuth secures an http upstream, not a process. */
    auth: z.undefined().optional(),
  }),
]);

// Inferred types alongside the schemas, as TeamSheet already has. Enforcement
// reads a sheet apart from parsing one, and reaching for
// TeamSheet["mcp_server"][number] at each of those sites is how two names for
// the same thing get started.
export type ApprovalMode = z.infer<typeof ApprovalMode>;
export type ToolEntry = z.infer<typeof ToolEntry>;
export type BuiltinEntry = z.infer<typeof BuiltinEntry>;
export type McpServer = z.infer<typeof McpServer>;

/**
 * The `[[mcp_server]]` list, refusing a block that claims the built-in name.
 *
 * `BUILTIN_SERVER` is the name a built-in call travels under, and nothing in
 * `decide` consults a transport before it matches on it — so a sheet naming an
 * http server `libero` would be a channel whose `search_channel_history` left
 * the process. Refused at parse rather than resolved at dispatch, because the
 * sheet is the admin surface and this is exactly the class of mistake the
 * discriminated union above exists to catch: one that parses and then cannot
 * serve a call.
 *
 * The issue lands at `mcp_server.<n>.name`, which is what an operator needs.
 * `parseTeamSheet` reports the path and the code and deliberately not the
 * message, so the path is the whole diagnosis and the message below is for
 * whoever calls zod directly.
 */
const McpServerList = z.array(McpServer).check(ctx => {
  ctx.value.forEach((server, index) => {
    if (server.name !== BUILTIN_SERVER) return;
    ctx.issues.push({
      code: "custom",
      input: server.name,
      path: [index, "name"],
      message: `"${BUILTIN_SERVER}" is reserved for the proxy's own built-in tools; declare those in [[builtin]]`,
    });
  });
});

/**
 * How a shared skill reaches a task, and there is no default on purpose (#432).
 *
 * The two modes are not two settings of one dial. `always` is charged against
 * every turn of every task in the channel, whether or not the request had
 * anything to do with it; `retrieved` is charged only where the request matched,
 * and competes for `[skills] top_k` with the channel's own playbooks. An
 * operator holds an opinion about which of those a given skill deserves, and an
 * entry that does not say is a line somebody half-wrote — a mistake, not a
 * preference. Defaulting it either way would make the cheap mode a thing you get
 * by forgetting or the expensive mode a thing you get by forgetting, and both of
 * those are decisions taken from the operator by the schema.
 */
export const SharedSkillLoad = z.enum(["always", "retrieved"]);

/**
 * One `[[shared_skill]]` block: a name, and how it loads.
 *
 * `name` is the same `SkillName` a channel's own playbook is held to, imported
 * rather than restated, so a name that parses here is a name the store can map to
 * `<name>.md` in the shared root. Nothing else is here — see the block's own
 * comment on `shared_skill` below for why there is no path, no digest, and no
 * existence check.
 */
export const SharedSkillEntry = z.object({
  name: SkillName,
  load: SharedSkillLoad,
});

export type SharedSkillLoad = z.infer<typeof SharedSkillLoad>;
export type SharedSkillEntry = z.infer<typeof SharedSkillEntry>;

/**
 * The `[[shared_skill]]` list, refusing two blocks that name one skill.
 *
 * **A departure from `[[mcp_server]]` and `[[mcp_server.tool]]`, which tolerate
 * duplicates, and the difference is that something resolves those.** Two tool
 * entries disagreeing about approval have a most-restrictive reading —
 * `required` beats `none`, and `resolveApproval` in packages/proxy/src/enforce.ts
 * applies it — because approval is an ordered quantity.
 *
 * `load` is not. Ask which of `always` and `retrieved` is the more restrictive and
 * there are two defensible answers: `always` puts more text in front of the model
 * on every turn, which is looser on budget, and it removes a retrieval decision,
 * which is tighter on what can surprise a channel. A field with two defensible
 * readings is a field with no most-restrictive rule, and inventing one would put a
 * coin flip in a resolver that the standing composer and the retrieval pool would
 * both have to apply the same way forever. The alternative to resolving is
 * dropping one silently, which is the case `parseSkillFile` already refuses for a
 * repeated frontmatter key: there is no answer to which one was meant, and taking
 * the last is how something a human wrote disappears with nothing to read
 * afterwards.
 *
 * **Two entries with the *same* mode are refused too**, which is not pedantry: the
 * always-count at the foot of this file is arithmetic over this list, and
 * admitting a repeat would mean deciding whether it counts once or twice — a
 * second question with no good answer, asked only because the first was ducked.
 *
 * The issue lands at `shared_skill.<n>.name` on the *later* block, because that is
 * the line to delete, and every duplicate is reported rather than the first, which
 * is `McpServerList`'s rule above. The message names no value out of the file,
 * also that check's discipline: `parseTeamSheet` reports the path and the code and
 * never the message, so the path is the whole diagnosis, and a message that
 * interpolated the name would be a value from the sheet sitting in a string only
 * a direct zod caller ever sees — which is how the habit starts.
 *
 * One consequence worth knowing before writing a test against it: an issue pushed
 * here suppresses the root `.check()`, so a sheet that is both duplicated and over
 * the always-count reports the duplicate alone. Both are refusals, so nothing is
 * lost — but a fixture for the count has to be otherwise valid.
 */
const SharedSkillList = z.array(SharedSkillEntry).check(ctx => {
  const seen = new Set<string>();
  ctx.value.forEach((entry, index) => {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      return;
    }
    ctx.issues.push({
      code: "custom",
      input: entry.name,
      path: [index, "name"],
      message: "this skill is already named above; one shared skill is one entry, in one mode",
    });
  });
});

/**
 * A time of day on a 24-hour clock, `HH:MM`, in UTC.
 *
 * The first time-of-day shape in this package, and it is a string rather than an
 * hour and a minute because the operator writing it is copying a clock:
 * `at = ["09:00"]` is the thing a person means, and `hour = 9, minute = 0` is
 * that thing taken apart for the parser's convenience.
 *
 * **Zero-padded, and `"9:00"` does not parse.** One spelling per instant, which
 * is the rule `SkillName` keeps for names and `normalizeCertificateSha256` keeps
 * for digests, and the cost of two spellings is paid downstream forever: the
 * duplicate check on the list below would have to normalize before it could
 * compare, and every log line and rendered rule would have to pick one anyway.
 * Refusing is a character class.
 *
 * **UTC, and the zone is not written on the rule.** `"0 9 * * 1-5"` is 09:00 for
 * nobody in particular, which is the half of `heartbeat_every_minutes`' argument
 * against cron that survives; this shape answers it by naming one zone for
 * everybody rather than by leaving it to be guessed. The honest cost, stated
 * here rather than discovered by an operator: a rule written by a team in a DST
 * zone drifts by an hour twice a year.
 *
 * A `timezone` field is the fix and it is additive — the server does the
 * next-occurrence arithmetic, where Node's built-in `Intl` handles IANA zones
 * with no dependency, so nothing about this package's dependency-free bundle
 * blocks it. Shipping UTC first is a scope decision, not a limitation of the
 * shape, and a rule written today keeps its meaning when the zone arrives:
 * absent means UTC.
 */
export const ClockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a zero-padded 24-hour time in UTC, like "09:00"');

/**
 * The days a rule may name.
 *
 * Lower-case three-letter abbreviations, which is one spelling of each day for
 * `ClockTime`'s reason. An enum rather than a number so that nothing here has an
 * off-by-one about which day a week starts on — cron's `0` is Sunday in most
 * dialects and Monday in some, and a silent disagreement about that is a rule
 * that fires on the wrong day while parsing perfectly.
 */
export const AmbientRuleDay = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/**
 * What a rule is called.
 *
 * The grammar is `SKILL_NAME_PATTERN`, imported rather than restated, because a
 * name a human types and a machine renders should look the same everywhere in
 * this tree. The *schema* is not imported: `SkillName`'s own header argues bounds
 * for a name that is also a path segment and an index key, and a rule name is
 * neither — it is the word an operator reads in a diff and the word a firing is
 * metered under.
 */
export const AmbientRuleName = z
  .string()
  .min(1)
  .max(64)
  .regex(SKILL_NAME_PATTERN, "must be lowercase words joined by single dashes: letters and digits only");

/**
 * One `[[ambient.rule]]` block: a name, when it fires, and what it asks.
 *
 * `days` is optional and absent means daily, which is the one shape here that
 * could have been a default instead. It is left optional so that a sheet saying
 * nothing about days and a sheet listing all seven stay distinguishable in the
 * file an operator reads — the same reason the example sheet writes figures it
 * would otherwise inherit.
 *
 * `question` is bounded by `SCHEDULED_TASK_MAX_PROMPT_CHARS` rather than by a
 * number of its own, and the import is the point: the turn a rule fires is the
 * one a scheduled check fires, and that turn does no capping of its own because
 * its caller already did. Two independent five-hundreds would be a drift waiting
 * to happen. The argument for the figure carries over whole — this is the *whole*
 * context the fired turn gets, with no thread, nobody who asked, and no reply to
 * read up from. What does not carry is where it gets reviewed: a check's question
 * is read on an approval card, and a rule's is read in a pull request.
 */
export const AmbientRule = z.object({
  name: AmbientRuleName,
  at: z.array(ClockTime).min(1).max(4),
  days: z.array(AmbientRuleDay).min(1).max(7).optional(),
  question: z.string().min(1).max(SCHEDULED_TASK_MAX_PROMPT_CHARS),
});

export type AmbientRuleDay = z.infer<typeof AmbientRuleDay>;
export type AmbientRule = z.infer<typeof AmbientRule>;

/**
 * The `[[ambient.rule]]` list, capped, refusing a repeat anywhere in it.
 *
 * **The cap is the cadence floor and the duplicate check is what keeps it
 * honest.** Eight rules of four times each is thirty-two firings a day, and that
 * arithmetic is only true if a listed time is a firing. `at = ["09:00", "09:00"]`
 * would be two slots holding one instant, so a cap counting slots would be
 * counting something other than what it promises to bound — and the alternative
 * to refusing is deciding, in the server, whether a repeat fires once or twice,
 * which is a second question asked only because the first was ducked. That is
 * `SharedSkillList`'s reasoning above, applied to a list of times instead of a
 * list of modes. Days are refused the same way and for the same sentence.
 *
 * Names are refused for a different reason, and it is the one that made `name` a
 * field: a firing is metered and logged under it, so two rules sharing one name
 * are two costs nobody can tell apart afterwards.
 *
 * Every duplicate is reported rather than the first, and the issue lands on the
 * later one — the line to delete — which is `McpServerList`'s rule and
 * `SharedSkillList`'s. The messages name nothing out of the file, that check's
 * other discipline: `parseTeamSheet` reports the path and the code and never the
 * message, so a message interpolating a value from the sheet would sit in a
 * string only a direct zod caller ever reads.
 */
const AmbientRuleList = z
  .array(AmbientRule)
  .max(8)
  .check(ctx => {
    const names = new Set<string>();
    ctx.value.forEach((rule, index) => {
      if (names.has(rule.name)) {
        ctx.issues.push({
          code: "custom",
          input: rule.name,
          path: [index, "name"],
          message: "this rule is already named above; one rule is one entry",
        });
      } else {
        names.add(rule.name);
      }

      const times = new Set<string>();
      rule.at.forEach((time, position) => {
        if (!times.has(time)) {
          times.add(time);
          return;
        }
        ctx.issues.push({
          code: "custom",
          input: time,
          path: [index, "at", position],
          message: "this time is already listed; a rule fires once per occurrence",
        });
      });

      const days = new Set<string>();
      rule.days?.forEach((day, position) => {
        if (!days.has(day)) {
          days.add(day);
          return;
        }
        ctx.issues.push({
          code: "custom",
          input: day,
          path: [index, "days", position],
          message: "this day is already listed; a rule fires once per occurrence",
        });
      });
    });
  });

export const TeamSheet = z.object({
  channel: z.object({
    name: z.string().min(1),
    // Free text with two readers: the human opening the sheet, and the model —
    // when non-empty it is appended to the system prompt of every task the
    // channel runs (#369). Operator-authored, which is what earns it that
    // placement; channel history never gets it. The cap keeps a paragraph from
    // becoming a standing tax on every task's `max_tokens_per_task`, and it is
    // a parse failure rather than a truncation because a sheet is a reviewed
    // file — an operator should hear "too long" at edit time, not have the
    // model quietly briefed on half a sentence.
    description: z.string().max(500).default(""),
    // Which client certificates may speak for this channel (#79).
    //
    // The certificate says *which channel* is calling; this says *which key* is
    // allowed to say it. Without it a leaked private key could not be revoked
    // without retiring the channel, because a re-mint carries the same
    // `CN=channel:<id>` as the key it replaces and the proxy has nothing to tell
    // them apart. Revocation is dropping a fingerprint from this list, which
    // keeps revocation an edit to the sheet — the operator workflow the design
    // already has — rather than a second surface beside it.
    //
    // **A list, because rotation needs an overlap.** Mint the replacement, add
    // its fingerprint here so both are accepted, swap the material, then drop
    // the old one. Each step is reversible and none of them is a gap in service.
    //
    // Required, and `min(1)`: a sheet naming no certificate must not parse. The
    // hazard is not the empty list itself — a channel that pins nothing simply
    // stops working — it is that "no pins" is one plausible refactor away from
    // reading as "any CA-signed certificate for this CN", which is the behaviour
    // this field exists to end. There is no value of this field that means that,
    // so no code downstream has to be trusted not to invent one.
    //
    // `max(4)` is the operator who stopped dropping old fingerprints. Two is a
    // rotation in progress; four is room for a mistake; ten is a list of keys
    // nobody has retired, which is what this field exists to prevent.
    //
    // Nothing here is a secret, as nothing in the sheet is: a fingerprint is a
    // digest of a public document, computable by anyone holding the certificate.
    certificate_sha256: z.array(CertificateSha256).min(1).max(4),
  }),
  // prefault, not default: an absent section is parsed through the inner
  // schema so nested defaults resolve (zod 4's default() short-circuits).
  llm: z
    .object({
      model: z.string().min(1).optional(),
      // The four per-task hard caps, mirroring DEFAULT_AGENT_LOOP_CAPS in
      // packages/agent/src/loop/types.ts — what the loop uses when no sheet
      // resolved. Keep the two in step by hand: schema is the base package and
      // cannot import from agent. Seconds here, milliseconds in the loop; the
      // conversion belongs to whoever maps sheet to caps.
      max_tool_calls_per_task: z.number().int().positive().default(25),
      max_task_seconds: z.number().int().positive().default(300),
      max_tokens_per_task: z.number().int().positive().default(200_000),
      max_tokens_per_turn: z.number().int().positive().default(8_192),
      // The two bounds on assembled context (#67), and they are not caps in the
      // sense the four above are. A cap stops a task that is already running;
      // these decide how much of the channel's conversation the task *starts*
      // with, and every character of it is charged against
      // `max_tokens_per_task` before the model has done anything. They live
      // here for the reason the caps do — a channel spending its own budget,
      // able to widen nothing — and they are deliberately not `AgentLoopCaps`,
      // because the loop never sees them: the context assembler is above it and
      // hands it a finished transcript.
      //
      // The upper bound on `max_history_messages` mirrors `READ_MAX_LIMIT` in
      // packages/memory, which is the most rows one read of a store returns.
      // Kept in step by hand, as the caps above are, and for the same reason:
      // this is the base package and cannot import either. Without it a sheet
      // could name a number the store would silently clamp — the one place that
      // clamp would surprise, since it is an operator's stated intent rather
      // than a model's argument.
      max_history_messages: z.number().int().nonnegative().max(200).default(40),
      max_history_chars: z.number().int().nonnegative().default(12_000),
      // How much of one tool answer reaches the model (#151), and here for the
      // reason the two bounds above are: it is charged against
      // `max_tokens_per_task`, so it spends the channel's own budget and can
      // widen nothing. A tool result past this is truncated and says so, rather
      // than being refused — a large answer is usually still a useful one, and a
      // short answer that admits it is better than a silently short one.
      //
      // `positive`, not `nonnegative`, unlike `max_history_chars`. Zero history
      // is a real answer — send the model the question and nothing around it —
      // but a zero-character result cap means every tool call returns nothing but
      // a truncation notice, which is not a policy anyone holds.
      //
      // **The companion bound is deliberately not here.** How many bytes the
      // proxy will read off an upstream before abandoning the response is
      // `PROXY_MAX_RESPONSE_BYTES`, a deployment setting, because the heap it
      // spends belongs to the process and is shared by every channel it serves —
      // a sheet able to raise it would be one channel degrading service for all
      // of them. That also means this field needs no upper bound of its own: the
      // wire cap admits at most N bytes, so the string this bounds is at most N
      // characters however large a number a sheet names.
      max_result_chars: z.number().int().positive().default(32_768),
      // How long a thread the agent has worked in goes on accepting replies
      // with no mention (#66). Here rather than in the process for the reason
      // the two bounds above are: it spends the channel's own budget and can
      // widen nothing, and whether an agent answers messages nobody addressed
      // to it is a channel's policy rather than a deployment's. `0` turns
      // follow-ups off, which is the only way to say so short of removing the
      // sheet.
      //
      // The upper bound mirrors `SESSION_IDLE_MS` in
      // apps/server/src/session/registry.ts, which is how long a session — and
      // therefore its set of active threads — survives with nothing to do. A
      // window longer than that would be cut short by eviction, so the sheet
      // refuses one loudly rather than advertising a number it cannot keep.
      // Kept in step by hand, as `max_history_messages` and `READ_MAX_LIMIT`
      // are, and for the same reason.
      follow_up_window_seconds: z.number().int().nonnegative().max(1800).default(900),
    })
    .prefault({}),
  // The daily caps the proxy meters, and the weights it counts them with.
  //
  // The two limits rest on different things, and the difference matters more
  // than the numbers. `daily_tool_calls` is counted by the proxy from calls it
  // serves, so it holds even under full compromise of the agent process.
  // `daily_tokens` is counted from what the agent reports — from the provider's
  // response envelope, not from anything the model writes, so it holds against
  // a prompt-injected model but not against a compromised agent process. See
  // ./spend-report.ts.
  budget: z
    .object({
      daily_tokens: z.number().int().positive().default(1_000_000),
      daily_tool_calls: z.number().int().positive().default(200),
      // The invoice, in US dollars (#62), enforced since #237/#238: a channel
      // at its dollar cap is refused, and a model absent from the price table
      // fails closed rather than metering as free.
      //
      // **Beside `daily_tokens`, never instead of it.** Tokens are the right
      // unit for a runaway brake and must work with no pricing knowledge at all:
      // a self-hosted Ollama channel has no dollar cost, and a router picking a
      // model absent from any price table still needs stopping. They are the
      // wrong unit for a *budget* — with the model switching per task the same
      // sixty thousand tokens is an order-of-magnitude cost swing, and the number
      // an operator wrote stops meaning what they thought it meant. Both are
      // optional and whichever binds first refuses.
      //
      // Optional with no default, unlike every other field here, because there
      // is no figure that is right for a channel whose operator has not said one.
      // A default token count is a brake; a default dollar cap is a bill.
      //
      // A float, and the only one in the cost path. It is an authored number,
      // converted to integer micro-units once at decision time — the accounting
      // itself accumulates nothing derived, and the proxy's price table is
      // integers throughout. See ./price-table.ts.
      daily_usd: z.number().positive().optional(),
      // What a cached token is worth against `daily_tokens`. Cache reads and
      // cache writes bill differently from ordinary input tokens, and by how
      // much is the provider's decision, not ours — so it is an operator
      // setting rather than a constant. The defaults are Anthropic's ratios;
      // a channel pins its provider by pinning `[llm] model`, which is what
      // makes a per-channel weight a per-provider weight.
      //
      // That last sentence is about these weights and does not extend to
      // `daily_usd` above. A weight is per channel because the operator wrote
      // it here; a price is per *model*, resolved against whichever model the
      // provider says it served, which under a router need not be the one this
      // sheet asked for.
      //
      // The meter stores the raw counts, so a weight edit applies to spend
      // already recorded today, on the next call. `0` is legal and means a
      // cache read costs nothing against the budget.
      cache_read_weight: z.number().nonnegative().max(100).default(0.1),
      cache_write_weight: z.number().nonnegative().max(100).default(1.25),
      // Where the soft limit sits, as a fraction of each hard limit above. At
      // `0.8` a channel is told once, in its thread, when it has spent four
      // fifths of either budget, and the call that told it still runs — a
      // warning is not a refusal. `0` turns it off, which is
      // `follow_up_window_seconds`'s spelling for the same thing.
      //
      // **A fraction rather than a pair of absolute soft values**, because then
      // the contradiction has nowhere to live: there is no way to write a soft
      // limit above the hard limit it belongs to, so this needs no cross-field
      // refinement and a sheet cannot express a warning that fires after the
      // refusal it exists to precede. `1` is excluded on the same ground rather
      // than as a range preference — a warning delivered at the moment the meter
      // is spent is the refusal, said twice. And a fraction follows an edit to
      // the number above it, where an absolute pair goes stale the day
      // `daily_tokens` moves and says nothing about it.
      //
      // One number for both limits. They are counted differently and hold
      // against different attackers, but "four fifths spent" reads the same
      // against either, and the warning names which one crossed.
      warn_at: z.number().min(0).lt(1).default(0.8),
    })
    .prefault({}),
  // What the agent remembers between tasks: `MEMORY.md`, one freeform markdown
  // file per channel, curated by a short turn after each reply (#222) and read
  // back into the context the next task starts from. See ./memory-op.ts for the
  // two operations that write it.
  //
  // **On by default, unlike `[ambient]` below, and the asymmetry is the point.**
  // Ambient is the agent starting work nobody asked for; curation is the agent
  // remembering something it was already asked about, into a capped file the
  // team can read, edit and delete, on a turn metered through the same per-turn
  // spend report as every other turn. Opting out is one line, and a channel that
  // says nothing gets the figures below.
  //
  // **This block is honoured by the agent, and by nothing else. It is the first
  // on this sheet of which that is true.** Everything above is enforced by the
  // proxy from its own copy of this file, which is what makes an agent process
  // under an attacker's control unable to widen it. The proxy never opens
  // `MEMORY.md` — its only reach into a channel's store is `openMessageReader`,
  // read-only — so there is no second copy of these numbers to check the first
  // against. In ./refusal.ts's terms this has the standing `daily_tokens` has
  // and not the standing `daily_tool_calls` has: it holds against a model that
  // has been talked into filling the file, and not against a compromised agent
  // process.
  //
  // **The consequence for whoever mirrors these values, stated here because this
  // is where the mirror's source lives.** `apps/server/src/session/sheet.ts`
  // resolves sheet values advisorily and falls back to its own defaults on any
  // failure, "because a fallback cannot loosen an authorization decision" — and
  // that justification does not reach this block, where the fallback *is* the
  // decision. The fallback for an unreadable or unparseable sheet is therefore
  // `enabled: false`, deliberately not the default below. An operator's typo
  // costing a channel its memory is a degradation the reply survives; a typo
  // switching curation on for a channel that wrote `enabled = false` is a policy
  // violation. It is the one hand-mirrored value that must differ from the one
  // here (#227).
  //
  // Characters rather than bytes, continuing `max_result_chars` and
  // `max_history_chars` above: two units for one kind of quantity in one file is
  // how a number gets read as the wrong one. A character bound is also checkable
  // on a JS string before anything is encoded, which is what lets the published
  // JSON Schema state the same figure to the model.
  memory: z
    .object({
      enabled: z.boolean().default(true),
      // The whole file, and it is spent on every task in the channel: `MEMORY.md`
      // enters the context a task starts from, so its size is charged against
      // `max_tokens_per_task` before the model has done anything. That is why the
      // default is the order of `max_result_chars` rather than the order of a
      // document — roughly eight thousand tokens, about 2.7× `max_history_chars`.
      // Memory is the persistent half of a task's opening context and history is
      // the recent half, and neither should dominate.
      //
      // At the cap an operation is refused and the file is left unchanged.
      // Nothing is truncated and nothing is dropped from the front: a silently
      // shortened memory is a fact the team believes it recorded, and there is no
      // way to tell from reading the file afterwards. Compaction is the model's
      // own work, done by replacing text with a shorter version of itself.
      //
      // The floor is `MEMORY_OP_MAX_TEXT_CHARS`, because a file cap below one
      // operation's ceiling is a channel where a legal operation is unwritable by
      // construction — the "parses, then cannot serve a call" class the
      // `McpServer` union refuses at parse for the same reason. A bound rather
      // than a `.check()`, since the other side is a constant and not a field:
      // the issue then lands at `memory.max_file_chars`, which is what an operator
      // has to edit. The roof is a sanity bound in the spirit of
      // `certificate_sha256`'s `max(4)` — past a quarter-megabyte the file has
      // stopped being a distillation and become a document the channel cannot
      // afford to read on every task, and the failure would arrive as every task
      // in the channel spending its opening context.
      max_file_chars: z
        .number()
        .int()
        .min(MEMORY_OP_MAX_TEXT_CHARS)
        .max(262_144)
        .default(32_768),
      // **How much one operation may carry is deliberately not a field here.** It
      // is 4096 characters, fixed in ./memory-op.ts, because it bounds what the
      // *model* may write rather than what this channel may spend — the class
      // this tree already keeps in constants, beside `MAX_TOOL_DESCRIPTION` and
      // `READ_MAX_LIMIT`. Making it settable would also dissolve the mechanism:
      // the published JSON Schema's `maxLength` would have to be built per
      // channel, so `MEMORY_TOOLS` would stop being a module constant and the
      // module-load guard would have nothing to guard. The aggregate an operator
      // does hold an opinion about is bounded above. Adding `max_op_chars` later
      // is a new optional field, so no sheet written today changes shape.
      //
      // No `.check()` on this block, and two candidates were considered. Tying
      // `max_file_chars` to `[llm] max_tokens_per_task` was rejected because
      // characters and tokens are different units at a model-dependent ratio, so
      // the rule would refuse sheets an operator meant. Refusing a cap set beside
      // `enabled = false` was rejected because `[ambient]` already permits
      // `heartbeat_every_minutes` beside its own `enabled = false`, and a channel
      // keeping its figures through a temporary opt-out is the ordinary case.

      // Thread summaries (#231): the second corpus semantic recall reads, and
      // the first thing on this sheet that spends model tokens **without anyone
      // having addressed the agent**.
      //
      // That is a real departure and it is stated rather than buried. Every
      // other model call in the deployment follows a mention; this one follows a
      // thread going quiet, in a channel whose members may never have used the
      // bot. The alternative — summarizing only threads the agent took part in —
      // was rejected on what it does to recall rather than on cost: it makes the
      // corpus the agent's own history instead of the channel's conversation,
      // and "what did we decide about X" is overwhelmingly a question about a
      // decision the team reached without the bot in the room.
      //
      // On by default for `enabled`'s reason, and bounded by the same things:
      // the per-turn spend report, `daily_tokens`, and `daily_usd`. A channel
      // that wants none of it writes one line.
      summarize: z.boolean().default(true),
      // How quiet a thread must be before it is summarized.
      //
      // **The one number here an operator genuinely holds an opinion about**,
      // because it is a fact about how a team talks rather than a resource
      // bound, and getting it wrong is a correctness problem rather than a cost
      // one. Too short and the pass summarizes a conversation still in progress
      // — an artifact that says the team was weighing X against Y, stored and
      // embedded, and then retrieved by exactly the query it is worst at
      // answering, because they went on to settle it. Too long and a concluded
      // thread stays out of recall while the answer it holds is still wanted.
      //
      // Sixty minutes: long enough that a thread with ordinary gaps in it is not
      // cut in half, short enough that a morning's decision is retrievable that
      // afternoon. The floor of five minutes is a bound rather than a
      // recommendation — a channel that sets it is asking for mid-conversation
      // summaries and should not be stopped, but a zero would summarize on every
      // message. The roof is a week, past which the thread has not gone quiet,
      // the channel has.
      //
      // A thread that wakes up is re-summarized whole and the old summary
      // replaced, so a threshold set too low degrades to wasted spend rather
      // than to a permanently wrong corpus.
      summarize_after_idle_minutes: z.number().int().min(5).max(10_080).default(60),
      // **How long a summary may be is deliberately not a field**, exactly as
      // `max_op_chars` is not: `SUMMARY_MAX_TEXT_CHARS` in ./thread-summary.ts
      // bounds what the model may write rather than what this channel may spend,
      // and it is chosen against retrieval — one vector stands for one summary,
      // so a longer summary is a vector averaged over more topics.
    })
    .prefault({}),
  // Skills: reusable playbooks the agent writes after a tool-heavy task and
  // loads back by retrieval at the head of a later one (#287). Files under
  // `skills/` in the agent state root, beside `MEMORY.md`. See ./skill.ts for
  // what one is and ./skill-op.ts for the two operations that write them.
  //
  // **The second block on this sheet honoured by the agent and not by the
  // proxy**, and everything `[memory]` says about that standing is true here
  // word for word: the proxy never opens a skill file, so there is no second
  // copy of these numbers to check the first against. In ./refusal.ts's terms
  // this has the standing `daily_tokens` has and not the standing
  // `daily_tool_calls` has — it holds against a model that has been talked into
  // filling the directory, and not against a compromised agent process. The same
  // consequence follows for whoever mirrors these values:
  // `apps/server/src/session/sheet.ts` must fall back to `enabled: false`,
  // deliberately not the default below, because for this block the fallback *is*
  // the decision. Its `DEFAULT_SKILL_SETTINGS` should carry that argument itself
  // rather than assume the reader has read `DEFAULT_MEMORY_SETTINGS` (#292).
  //
  // `[[shared_skill]]` below takes that standing unchanged, and takes it further:
  // the proxy does not read one field of it, the way it reads `[ambient] enabled`
  // only to refuse. There is no tool call whose decision a shared skill could
  // enter.
  //
  // **On by default, on the same test `[memory]` is on by.** That test asks
  // whether this is the agent starting work nobody asked for, which is
  // `[ambient]`, or the agent keeping something from work it was already asked
  // to do, which is curation. A skill is written out of a task somebody
  // requested, into capped text the team can read, edit and delete, on a turn
  // metered through the same per-turn spend report as every other turn. So it is
  // curation, and opting out is one line.
  //
  // Two things about that are worth knowing before leaving it on, and they are
  // the honest half of the same paragraph. **A skill is procedural where a
  // memory fact is declarative**: "the team decided X" steers a reply, while
  // "to deploy, run Y then Z" steers tool use. And it arrives by retrieval
  // rather than as one file the team reads whole, so a team may never see a
  // given skill unless they open the directory — which is why the directory is
  // theirs, in their own state root, in plain markdown. Nothing a skill says
  // widens what the channel may do: every call it induces meets the proxy's
  // gates exactly as if the same words had arrived in a mention.
  //
  // **Flipping this default to `false` later would be a behaviour change for
  // every sheet that never mentioned the block**, which is not the additive kind
  // of change the rest of this file's defaults are. Said now, because the moment
  // to notice it is before the first sheet is written.
  //
  // **`enabled` governs what this channel grows, and not what its operator
  // decrees.** It switches off the author turn, the merge curator, the lifecycle
  // clocks, and the retrieval of the playbooks in this channel's own directory —
  // the machinery that writes and ages machine-authored text. `[[shared_skill]]`
  // entries are none of that, and load either way; the argument is on that block,
  // and it is where the long form of this sentence lives.
  skills: z
    .object({
      enabled: z.boolean().default(true),
      // The merge curator (#295): a pass that looks for two playbooks that are
      // one playbook written twice, drafts the merge, and writes it as a
      // **proposal a person reads** into `proposals/` beside `skills/`. It
      // rewrites nothing. Applying it is editing one file and deleting another;
      // declining it is deleting the proposal.
      //
      // **This is the second thing on this sheet that spends model tokens with
      // nobody waiting on the answer**, `[memory] summarize` being the first, and
      // it takes that field's standing rather than `[ambient]`'s. The test
      // `enabled` above is decided on asks whether the agent is acting on the
      // world unbidden. This writes a document into the team's own directory and
      // does nothing else — no post, no tool call, and nothing the runtime ever
      // reads back. That is a draft left on a desk, not an act.
      //
      // **A second switch where the rest of the block is one**, for `[memory]`'s
      // reason exactly: `enabled = false` freezes everything this channel grows,
      // and this stops only the pass that proposes merges. A channel that wants its
      // playbooks written and retrieved but never second-guessed says so here
      // without giving up either.
      //
      // "Everything this channel grows" rather than "the whole feature", as this
      // said before #432: `[[shared_skill]]` entries are operator-decreed and are
      // honoured either way — see that block for the argument. The curator is
      // outside that distinction in the other direction, and the reason is worth
      // stating rather than deriving: it never nominates a pair that crosses the
      // line between grown and decreed, because the shared file is not this
      // channel's to rewrite and the proposal's two acts — replace one file, delete
      // the other — are acts nobody in the channel can perform.
      //
      // What bounds it is not this field: one pair per run, one run per channel
      // per day, a cap on how many proposals may be waiting unread, and the rule
      // that a pair is not reconsidered until one of the two descriptions moves.
      // A deployment with **no embedding provider** proposes nothing at all —
      // overlap is a question about two vectors, and unlike retrieval there is no
      // lexical answer to fall back to.
      //
      // Flipping this default to `false` later is `enabled`'s hazard again, and
      // the paragraph below applies to both.
      curate: z.boolean().default(true),
      // How many tool calls a task must *exceed* before the author turn runs.
      // Strictly greater, which is what the architecture page's "exceeding a
      // tool-call threshold" says and is worth pinning here rather than
      // discovering from two implementations later — this tree has a history of
      // an off-by-one becoming the contract.
      //
      // It counts calls the proxy **served**, not calls the model attempted. A
      // task whose six calls were all refused learned that this channel's sheet
      // does not grant those tools, and a playbook written from it would be a
      // playbook about tools that do not work here.
      //
      // Five, from the spec. The number is a proxy for "this task was real
      // work": below it the task was a question with a lookup, and a playbook
      // for that is a playbook for reading. No roof, matching
      // `max_tool_calls_per_task` above — a channel that sets it higher than its
      // own tool cap has turned authoring off the long way round, which is
      // legal, does no harm, and is not worth a cross-block rule that would
      // refuse a sheet mid-edit.
      author_after_tool_calls: z.number().int().min(1).default(5),
      // How many skills a task may open with.
      //
      // **This is a field where recall's equivalent is a constant, and the
      // difference is worth stating.** `RECALL_LIMIT` in the server is fixed at
      // five on the ground that what it bounds is what that process assembles
      // rather than a policy a channel holds an opinion about. The distinction
      // that makes this one a field: recall's corpus is grown by the machine —
      // one summary per quiet thread, whether or not anyone wanted it — while
      // the skill library is written and owned by the team, so how many of their
      // own playbooks a task opens with is a policy they do hold an opinion
      // about.
      //
      // Three rather than recall's five, because a skill is up to 4096
      // characters where a summary is 2048, and skills sit *beside* the recall
      // block in a task's opening context rather than instead of it. Zero does
      // not parse: that is `enabled = false` said a second way, and one switch
      // with two spellings is one of them going untested.
      //
      // **It bounds the whole pool, not this channel's half of it.** A shared skill
      // in `retrieved` mode competes here with the channel's own playbooks, and it
      // does so on a channel that has set `enabled = false` as well — which is what
      // makes this number's meaning independent of that switch. See
      // `[[shared_skill]]` below.
      //
      // **What this does not bound is the aggregate**, and the aggregate is what
      // a task actually pays. `top_k` times `max_skill_chars` is a worst case,
      // not a budget, and the counterpart to `RECALL_MAX_CHARS` — a ceiling on
      // the whole skills block, in characters, binding before this number does —
      // belongs on the agent side with recall's, as a constant, for the reason
      // recall's is one (#292).
      top_k: z.number().int().min(1).max(10).default(3),
      // The longest a skill's body may be, in characters. The body only: the
      // frontmatter is a handful of short lines and is not charged against this,
      // so an operation written at the model's own ceiling always fits.
      //
      // **The floor is `SKILL_BODY_MAX_CHARS`**, and the relationship is
      // `[memory]`'s exactly rather than its mirror. The constant in ./skill.ts
      // bounds what the *model* may write in one operation and is the figure the
      // published JSON Schema states; this bounds what a body may *be*, which is
      // a different quantity because a team can hand-write a playbook far longer
      // than any operation could produce. A cap below the constant would publish
      // a schema promising a length this channel refuses — a per-channel lie
      // inside a module constant, which is the exact failure keeping that figure
      // a constant exists to prevent. A bound rather than a `.check()`, so the
      // issue lands on `skills.max_skill_chars`, which is what an operator edits.
      //
      // The default is 8192 — twice the model's ceiling, which is room for the
      // team to write a longer playbook by hand without being room for a
      // document. The roof is a sanity bound in the spirit of `max_file_chars`'s:
      // past 64k a skill has stopped being a playbook, and unlike `MEMORY.md` it
      // is not one file but one of `max_skills`.
      max_skill_chars: z.number().int().min(SKILL_BODY_MAX_CHARS).max(65_536).default(8_192),
      // The two caps on the always-loaded set (#432), and they are the only fields
      // on this block that bound something the sheet does not itself contain.
      //
      // **What makes this text different from every other skill figure here: it
      // is charged on every turn of every task, whether or not it was relevant.**
      // `top_k` above bounds a pool assembled against a request, so a channel
      // pays for skills that matched something. A shared skill in `always` mode is
      // a standing instruction, and the only other thing on this sheet with that
      // standing is `MEMORY.md` — which is the team's own distillation of their
      // own work, rather than an operator's text arriving from a root the channel
      // cannot see.
      //
      // **The two caps are enforced in two different places, and that is the point
      // rather than an inconsistency.** How many entries a sheet declares is a
      // fact about *this file*, countable while it is open on an operator's
      // screen, so it is refused there — see the `.check()` at the foot of this
      // file. How many characters those entries amount to is a fact about files in
      // another root that can change without this file changing, so it cannot be
      // checked here and is enforced where the text is assembled, which drops a
      // breaching skill whole and logs it rather than truncating one. A
      // half-loaded playbook is a playbook that reads as complete and is missing
      // its last step.
      //
      // **Two, and 8192, which is two at the model's own ceiling.** That is
      // `SKILLS_MAX_CHARS`' construction in apps/server/src/session/skill-recall.ts
      // — `top_k` times `SKILL_BODY_MAX_CHARS`, and its comment already gives the
      // reason it is not the sum of the maxima a sheet permits: a budget that could
      // never bind would not be a budget. With `max_skill_chars` at its own default
      // the sum here would be 16384, so the character cap binds first whenever a
      // standing skill runs past the length the model itself may write, which is
      // the direction that wants to bind.
      //
      // **The floor is `SKILL_BODY_MAX_CHARS`**, so one skill at the model's
      // ceiling always fits — `max_file_chars`' relationship to
      // `MEMORY_OP_MAX_TEXT_CHARS`, for its reason, and a bound rather than a
      // `.check()` so the issue lands on the field an operator edits. Below it, an
      // entry this sheet permits could never load under any file the shared root
      // holds, which is the "parses, then cannot serve" class the `McpServer` union
      // refuses at parse.
      //
      // The count's roof is `top_k`'s, so no reading of this sheet lets the
      // standing set be larger than the largest pool retrieval may load; an
      // operator who wants more than that wants a library, and `retrieved` is the
      // library. `min(1)` rather than `min(0)` is `top_k`'s argument again — zero
      // is "name no entries" said a second way, and one policy with two spellings
      // is one of them going untested. The character roof is `max_file_chars`'
      // *default* rather than its roof: past 32k the standing set has stopped being
      // a standing instruction and become a document, and a block from another root
      // that can outweigh the channel's whole memory file is the failure this cap
      // exists to prevent.
      //
      // **There is deliberately no `.check()` relating this to `max_skill_chars`.**
      // The note on `[memory]` rejected two cross-field candidates, and the test it
      // gives is whether the wrong order expresses a policy somebody meant. An
      // 8192-character standing region beside a 65536-character per-skill cap says
      // something coherent and useful — long playbooks are retrieved, short ones may
      // stand — so a rule would refuse sheets an operator meant. That is the ground
      // the `max_file_chars`-against-`max_tokens_per_task` candidate was rejected
      // on, and it is *not* the `archive_after_days >= stale_after_days` case below,
      // which is one ordered quantity whose wrong order makes a state unreachable.
      //
      // Flipping either of these looser later is `enabled`'s hazard in reverse and
      // worse: a sheet that never mentioned them would start paying more on every
      // turn of every task with nothing in its own file changed. Said now, because
      // the moment to notice it is before the first sheet is written.
      max_always_skills: z.number().int().min(1).max(10).default(2),
      max_always_chars: z.number().int().min(SKILL_BODY_MAX_CHARS).max(32_768).default(8_192),
      // How many skills a channel may hold.
      //
      // **Nothing else bounds the library's size.** There is no delete
      // operation, archiving is a status rather than a removal, and the file is
      // the team's to remove — all of which is right, and all of which means
      // the count only ever goes up on its own. The costs that grow with it are
      // not the disk: it is what has to be re-read and re-embedded when the
      // directory is reconciled, and it is the curator's overlap pass, which
      // compares skills against each other and so grows as the square.
      //
      // A hundred is far more playbooks than a channel will write and far fewer
      // than the point where any of those hurt. At the cap an operation is
      // refused and the model is told to revise something instead, which is the
      // outcome the whole design prefers anyway.
      max_skills: z.number().int().min(1).max(1_000).default(100),
      // The two clocks the lifecycle job runs (#294). A skill nothing has
      // loaded for `stale_after_days` goes `stale`, and one nothing has loaded
      // for `archive_after_days` goes `archived` and leaves retrieval. The job
      // is deterministic, spends no tokens, and **never deletes a file** —
      // archiving is a status, and removing the file is the team's act.
      //
      // Thirty and ninety, from the spec.
      //
      // **Days rather than milliseconds**, which is
      // `summarize_after_idle_minutes`'s precedent: this sheet carries the unit
      // an operator thinks in and the conversion happens once, where the
      // settings are resolved. Nothing here is a duration a machine chose.
      //
      // **`min(1)` rather than `min(0)`.** Zero would be a second spelling of
      // "the clocks are off", which is the call `top_k` already made against
      // itself — one switch with two spellings is one of them going untested. A
      // channel that wants no archiving in practice writes a large number, and
      // the roof leaves ten years for it.
      //
      // What the clocks run on is **not** `created` in the file: that line is
      // model-authored, hand-editable documentation and no clock reads it. See
      // ./skill.ts. The index stamps when it first saw a skill and when a task
      // last loaded one, and those are what age it.
      stale_after_days: z.number().int().min(1).max(3_650).default(30),
      archive_after_days: z.number().int().min(1).max(3_650).default(90),
      // **How much one operation may carry is deliberately not a field here**,
      // exactly as `max_op_chars` is not on `[memory]`: `SKILL_BODY_MAX_CHARS`
      // and `SKILL_DESCRIPTION_MAX_CHARS` in ./skill.ts bound what the model may
      // write rather than what this channel may spend, and making either
      // settable would mean building the published JSON Schema per channel, so
      // `SKILL_TOOLS` would stop being a module constant.
      //
      // One degradation this block does not have a field for and should not
      // grow one for: a deployment with **no embedding provider configured**
      // has no vectors, and semantic recall skips entirely in that case. Skills
      // should not skip — they should retrieve on full text alone, because
      // unlike a thread summary a skill carries a hand-written description of
      // when it applies, which is exactly what a lexical index is good at. That
      // is a behaviour, not a setting (#292).
    })
    // **The one `.check()` on a block that spends model tokens, and the note on
    // `[memory]` above explains why it is not the exception it looks like.**
    // That note rejected two candidates, and both were rules across *different*
    // quantities: a character cap against a token cap, and a size beside a
    // switch. This is two fields in one block, in one unit, measuring one
    // ordered quantity — and the wrong order does not express a policy anybody
    // meant. It makes `stale` unreachable: a skill would archive before it could
    // ever be marked, so the waypoint the team is supposed to see in git never
    // appears.
    //
    // The issue lands on `archive_after_days` because that is the field an
    // operator edits to fix it, and because the defaults resolve first — so a
    // sheet that sets only `stale_after_days = 120` is refused against the
    // default ninety, which is the case the message has to read well for.
    .check(ctx => {
      if (ctx.value.archive_after_days >= ctx.value.stale_after_days) return;
      ctx.issues.push({
        code: "custom",
        input: ctx.value.archive_after_days,
        path: ["archive_after_days"],
        message: "a skill cannot archive before it goes stale",
      });
    })
    .prefault({}),
  // Skills an operator published, named here by reference (#432). The content
  // lives in a third root — not the channels root the proxy reads its
  // authorization from, and not the agent state root the channel's own skills are
  // written into. This block is the whole of what the sheet says about them: a
  // name, and how it loads.
  //
  // **Addressed as `shared/<name>`, always, and that is structural rather than a
  // precedence rule.** `sharedSkillRef` in ./skill.ts holds the argument and the
  // mechanism: `/` is outside `SKILL_NAME_PATTERN`, so a channel skill and a
  // shared skill of one name can never resolve to each other, and no code has to
  // arbitrate. It is the reservation `ModelId`'s sentinels get, not the one
  // `BUILTIN_SERVER` gets from the `.check()` above.
  //
  // **`[skills] enabled = false` does not refuse these entries, and that is the
  // decision rather than an oversight.** That switch governs the channel-grown
  // machinery — the author turn, the channel's own directory, and the retrieval of
  // what it holds. A shared skill is not grown; it is decreed, by the same operator
  // who wrote this file, in a root the channel cannot write. So the combination is
  // legible rather than contradictory, and it is a configuration somebody wants: no
  // playbooks of your own, use the house ones. The consequence for whoever builds
  // retrieval, written here so it is not re-derived: `enabled` gates the *channel
  // leg* of the pool and never the pool, so a channel with the switch off and a
  // `retrieved` entry here still resolves that entry, bounded by `top_k` and
  // `max_skill_chars` exactly as it would be with the switch on.
  //
  // **The proxy reads nothing here**, which is `[memory]`'s note and `[skills]`'
  // restatement of it, holding word for word: that service never opens a skill file
  // and now never opens a shared one either. Unlike `[ambient]` there is not even a
  // field it reads only to refuse — there is no tool call whose decision this could
  // enter.
  //
  // **No hash pin, and it was considered.** The `certificate_sha256` precedent pins
  // because minting material and authorizing it have different actors. Here they do
  // not: whoever edits this file is whoever edits the shared skill, one trust domain
  // in one git repository. A digest would make the sheet attest to content it does
  // not own, and what it would buy is a channel whose standing instructions silently
  // stop loading the day an operator fixes a typo in their own file — at the cost of
  // the single-point update that is the entire motivation. If a pin is ever wanted it
  // is a new optional field, so no sheet written today changes shape.
  //
  // **A named skill the root does not hold is not a parse error**, and cannot be:
  // the file is in another root, read by another process at another time, so a sheet
  // that parsed on Tuesday would stop parsing on Wednesday because somebody moved a
  // file this service has no business reading. A dangling name is dropped where the
  // text is assembled, with a log line naming it — the same outcome an over-long one
  // gets, and for the same reason. Nothing here should grow an existence check.
  shared_skill: SharedSkillList.default([]),
  mcp_server: McpServerList.default([]),
  // The tools the proxy implements itself (#64) — flat, because there is one
  // provider and it is the proxy. Named here for the same reason an
  // [[mcp_server.tool]] is named: a channel gets exactly the tools its sheet
  // lists, and a built-in is not an exception to that. See ./builtin.ts.
  builtin: z.array(BuiltinEntry).default([]),
  // Where traffic may go when the sheet does not already pin the destination —
  // the code-execution sandbox today. An [[mcp_server]] url is not listed here;
  // declaring it there is what authorizes it. See ./egress.ts.
  egress: z
    .object({
      allow: z.array(EgressPattern).default([]),
    })
    .prefault({}),
  // Proactive posting: the agent starting a task nobody asked for, on a clock of
  // its own. Off by default, and the block every other `enabled` on this sheet
  // argues by contrast with — see `[memory]` above.
  //
  // **Three of its five keys have readers, as of #317**, which is the ambient
  // scheduler: `enabled` decides whether a channel is enumerated into work at
  // all, and `heartbeat_every_minutes` is the cadence it is enumerated on. The
  // agent process re-reads this block per scan, so an edit lands on the next
  // tick with no restart — the freshness the proxy's per-call read gives
  // enforcement. `answer_after_idle_minutes` is the evaluation turn's, read
  // before any model call to decide whether a question has sat long enough to
  // be worth answering.
  //
  // **`heartbeat` and `rule` have no reader yet (#460), and the order is
  // deliberate.** #461 gives them one. The shape lands first so that a sheet
  // written today does not change when the clock learns to read it — which is
  // `[[shared_skill]]`'s posture one release ago, and which this block itself was
  // built in, one issue before #317 gave it a reader.
  //
  // **The tool proxy service reads `enabled`, and nothing else here.** An earlier
  // draft of this comment said it read none of it and never would, on the
  // argument that a heartbeat contains no tool call for that service to decide.
  // That argument is still right about heartbeats and was wrong about the block:
  // `schedule_task` (#323) *is* a tool call, and a create on a channel with this
  // switched off would be an approved ticket no clock will ever enumerate — so
  // the create is refused, in `decideBuiltin`, above the meter.
  //
  // The distinction that keeps `[memory]`'s standing intact for the rest of it:
  // the field is read there **only to refuse, never to permit**. Nothing an agent
  // process could do to its own copy of this block widens anything, because the
  // only thing the proxy does with it is say no. The cadence, the idle threshold
  // and the rules are still the agent's alone, and a heartbeat is still a thing
  // that service never sees. A rule is a question put to a model, not an
  // authorization — so nothing added here in #460 reaches a gate either, and
  // `enabled` stays the single field that crosses.
  ambient: z
    .object({
      enabled: z.boolean().default(false),
      // Whether the heartbeat evaluation runs — one of the two things `enabled`
      // turns on, now that there are two.
      //
      // **A channel wanting Monday digests and no heartbeat is a real
      // configuration**, which is what this field exists for (#358). The two
      // sources are different in kind rather than in cadence: the rules below are
      // a clock, and the heartbeat is a judgement about whether anything merits
      // saying at all. A team can want the first without the second.
      //
      // **Default `true`, which is the opposite of `enabled`'s default and not an
      // inconsistency.** `enabled` defaults off because unbidden speech is the
      // thing an operator has to ask for. This defaults on because by the time it
      // is read the operator has already asked, and a sheet that opted in and said
      // nothing else meant the behaviour this block has had since #317. Defaulting
      // it `false` would quietly change what `enabled = true` means for every
      // sheet already written, which is the hazard `[skills]`' caps state against
      // themselves.
      //
      // **`false` is not a second spelling of `enabled = false`**, the objection
      // this block's own `min(1)` bounds raise elsewhere. It stops one source;
      // `enabled` stops the block. What it *can* combine into — enabled, no
      // heartbeat, no rules — is a channel that is on and silent, and that is
      // taken up with the rest of the no-`.check()` argument at the foot of this
      // block.
      heartbeat: z.boolean().default(true),
      // How often anyone looks. **An interval rather than a cron expression,
      // and therefore a number rather than a grammar.**
      //
      // Cron would buy quiet hours and workday alignment, and the design gives
      // the first away for free: a tick with nothing new since the last
      // evaluated position is silent by construction and spends nothing, so an
      // 03:00 tick already costs nothing and says nothing. There is nothing left
      // for the expression to protect.
      //
      // **That is an argument about this field, and it does not carry to `rule`
      // below (#358).** What it says is that an interval has nothing more to say.
      // A rule has more to say, because a rule *speaks* at its instant rather than
      // looking at it — an 03:00 heartbeat is free, and an 03:00 digest is a post
      // at 03:00. The clock time this field refuses is the whole point of a rule,
      // and the two sit in one block without contradicting each other.
      //
      // Half of what cron would have cost has weakened since, and this comment
      // says so rather than repeating itself. `"0 9 * * 1-5"` is still 09:00 for
      // nobody, and this tree still refuses zoneless instants everywhere else it
      // parses one (see ./skill.ts on `created`, and the audit log's read path) —
      // which is why `rule` names UTC rather than leaving the zone to be guessed.
      // But the DST-correct next-after-instant arithmetic is the *server's* and
      // not this package's, and Node's built-in `Intl` does it with no dependency,
      // so it was never the CLI's dependency-free bundle that stood in the way.
      //
      // Which leaves an interval, and this sheet already spells those: an
      // integer with the unit in the field name, like
      // `summarize_after_idle_minutes` and `stale_after_days`. The conversion to
      // milliseconds happens once, where the settings are resolved.
      //
      // **`min(1)` rather than `min(0)`**, which is `stale_after_days`' argument
      // above: zero would be a second spelling of `enabled = false`, and one
      // switch with two spellings is one of them going untested. The roof is a
      // day, past which the heartbeat is not noticing anything. Fifteen minutes
      // because a brisk cadence is affordable here — a quiet channel's ticks are
      // free, so the figure trades against latency rather than against spend.
      heartbeat_every_minutes: z.number().int().min(1).max(1_440).default(15),
      // How long a question sits before the heartbeat may answer it.
      //
      // **The sibling of `[memory] summarize_after_idle_minutes`, in name and in
      // kind**, and it states the same rule: acting on content before it has
      // gone quiet says something the moment hasn't earned. Sampled at an
      // instant, "unanswered" is meaningless — a question typed thirty seconds
      // before a tick looks exactly like one the team has ignored for an hour,
      // and answering the first front-runs the teammates it was addressed to. A
      // team that wants the answer now tags the agent, which costs one word.
      //
      // This is the one number in this block an operator genuinely holds an
      // opinion about, by the test `summarize_after_idle_minutes` states for
      // itself: it is a fact about how a team talks rather than a resource
      // bound. The cadence above is the other kind, which is why that one is
      // free to default and this one is worth writing down.
      //
      // The two answer different questions — this is what counts as unanswered,
      // the cadence is how often anyone looks — so **the worst case for a
      // proactive answer is their sum**: seventy-five minutes at the defaults.
      // Bounds are that sibling's, for the same reasons it gives.
      answer_after_idle_minutes: z.number().int().min(5).max(10_080).default(60),
      // The clock times this channel speaks at, if any (#358).
      //
      // **Operator-authored, and that is the design rather than a detail of it.**
      // Every hard question about recurrence is a question about authority, and
      // putting the rules in this file answers each without machinery: the caps
      // are sanity bounds rather than injection bounds because rules are
      // human-grown; the approval is the reviewed edit that added the entry; and
      // a prompt-injected model cannot plant one, because the model has no write
      // path to this file. `schedule_task` had to answer all three with
      // mechanism — a pending cap, an approval card, a horizon. This answers them
      // by being here, which is why recurrence landed as a sheet block rather
      // than as a second verb.
      //
      // **Every rule is an ask, and the deterministic kind was declined rather
      // than deferred.** A `post` kind replaying verbatim text on a clock is
      // Slack's own reminder feature, which every workspace already has; what a
      // rule buys is an answer composed from the channel's state at the instant
      // it fires. So there is one kind, `question` is required, and there is no
      // `text` field for a later reader to wonder about.
      //
      // **The caps are the cadence floor, and they hold by construction.** Four
      // times a day per rule and eight rules per sheet, so no reading of this
      // block speaks more than thirty-two times a day — arithmetic over two list
      // lengths rather than an analysis somebody has to write correctly. That is
      // the reason this is fields rather than a cron string: `*/5 * * * *` is
      // exactly the flood this design must forbid, and forbidding it in a string
      // means parsing the expression and computing its minimum firing interval.
      // Four because a rule is one question, and a question worth asking at five
      // separate clock times is two rules; eight because a sheet with nine
      // standing rules has a scheduling problem rather than a tooling one, which
      // is `SCHEDULED_TASK_MAX_PENDING`'s judgement in its own words.
      //
      // **Neither cap is a field, and that is `max_skills`' rule read from the
      // other side.** How many rules a sheet may hold is not a figure to hand the
      // operator, because here the operator is both the author and the setter — a
      // cap you raise on yourself is a comment, and the floor above stops being
      // structural the moment a sheet can restate it. `[skills] max_skills` is a
      // field precisely because it bounds what the *machine* grows on a team's
      // behalf, which is two parties. This is one.
      rule: AmbientRuleList.default([]),
      // Whether a turn this block fires may call the channel's tools (#348).
      //
      // **Off by default, and the default is the whole reason the field
      // exists.** Without it, every channel that already lists tools would have
      // its checks and rules gain them the day this shipped — a capability
      // increase applied to sheets that did not change, which is exactly the
      // hazard `[skills]`' standing caps state against themselves one block up.
      // An operator writes one line and gets it; an operator who writes nothing
      // gets what they had.
      //
      // **It grants nothing new.** A fired turn opted in here reaches the same
      // allowlist a mention reaches — `[[mcp_server.tool]]` and `[[builtin]]`,
      // resolved per call in the proxy from this same file. This switch decides
      // *who may use* that list, not what is on it, so turning it on cannot
      // widen a channel beyond what its members can already ask for by hand.
      //
      // **A held call is refused rather than waited on**, and that is not a
      // field either. An approval card needs somebody to click it, and a fired
      // turn has no requesting user and no thread to put one in — so the
      // composition hands it no prompter, and a call the sheet holds comes back
      // to the model as the refusal it already is. The practical line that draws
      // is read-yes-write-no, because `resolveApproval` already holds a
      // destructive *name* by default: an operator who wants an unattended turn
      // to call something destructive has to say `approval = "none"` on that
      // tool, in this file, where it is reviewable.
      //
      // **What bounds the spend is not here either.** `[budget] daily_tool_calls`
      // is counted by the proxy from calls it served, so it holds against a
      // compromised agent process — which is a stronger bound than the pending
      // cap it displaces, and the reason `SCHEDULED_TASK_MAX_PENDING` did not
      // have to move when this landed.
      tools: z.boolean().default(false),
      // **The rate limit on unbidden posts is deliberately not a field**, and
      // the first implementer should not add one. At most one heartbeat-initiated
      // post per channel per rate window — stated in time rather than in ticks,
      // because one post per tick is no throttle once ticks are minutes apart —
      // and it is an architecture constant enforced in the posting surface, so
      // that tightening the cadence here cannot quietly loosen the throttle. It
      // belongs beside its mechanism, the way `APPROVAL_TTL_MS` does. Nothing
      // named `posts_per_hour` goes on this block.
      //
      // **A rule's post neither draws on that window nor is blocked by it**, and
      // the line is bidden against unbidden rather than proactive against
      // reactive. The throttle exists because nobody asked for a heartbeat's
      // post. A rule was asked for — in this file, by the operator whose edit is
      // reviewed before it runs — which is the standing a fired `schedule_task`
      // check's post already has. What bounds it instead is its own shape: one
      // post per firing, one firing per occurrence, occurrences bounded by `at`
      // and `days`, and rules bounded by the cap on the list.
      //
      // **Quiet hours are still not fields**, for the reason
      // `heartbeat_every_minutes` gives: a tick with nothing to weigh is already
      // silent, so the hours a channel sleeps cost it nothing to leave open. A
      // rule does not want them either, for the opposite reason — it names the
      // hours it speaks at, so every hour it does not name is quiet already.
      //
      // **A timezone is not a field *yet***, where before it was not a field at
      // all. UTC first, with the limit stated rather than left to be discovered:
      // a team in a DST zone writes a rule that drifts by an hour twice a year.
      // `ClockTime` above carries why that is a scope decision rather than a
      // property of the shape, and what an added zone would not break.
      //
      // No `.check()` on this block. `enabled = true` with no cadence written is
      // not an error: the switch is `enabled` and the figures beside it default,
      // as they do on `[memory]` and `[skills]`. Requiring a cadence would add
      // no consent — the sheet has already said "speak unbidden" — and would add
      // a way for a mistake here to reject the whole sheet.
      //
      // **`enabled = true` with `heartbeat = false` and no rules parses too**, and
      // it is the case that most looks like it wants refusing: a channel that is
      // on and silent reads as a third spelling of `enabled = false`, which is an
      // objection this file takes seriously enough to bound two other fields
      // with. It is admitted anyway, for the reason above and one more. The two
      // switches are not one dial, so there is no single field to land the issue
      // on; and the state is what a sheet looks like *between* two edits that both
      // work — the heartbeat turned off in the commit that adds the rules — so
      // refusing it would fail a sheet mid-thought. Nothing is lost by admitting
      // it: silence is what it asks for and silence is what it gets.
    })
    .prefault({}),
})
  // **The first `.check()` on this object, and it is here because there is
  // nowhere else it could be.** Everything else this file refuses is refusable
  // inside one block: a transport against its own url, a clock against its own
  // sibling. This one relates a top-level array, `[[shared_skill]]`, to a field
  // nested in another block, `[skills] max_always_skills` — and a rule that spans
  // two keys of this object has to live on this object.
  //
  // **A sheet over the cap fails to parse, rather than loading the first two and
  // dropping the rest.** The sheet is the admin surface and this package's promise
  // is that an invalid one is rejected loudly while the last valid version stays
  // in force. Truncating instead would move the failure from an operator's terminal
  // at edit time to a channel quietly running without the standing instruction its
  // own file names — and unlike a skill that was too long, which is dropped with a
  // line an operator can find, nothing would have gone wrong: the sheet would be
  // doing exactly what a rule nobody wrote said.
  //
  // **It is not a second spelling of the character bound beside it.** That one is
  // about files in a root this parser cannot read, and is enforced where the text is
  // assembled. This one is about lines in the file already in front of us, and
  // counting them is free.
  //
  // The issue lands on each offending entry's `load` — the word that made it count,
  // and the one-word edit that makes the sheet parse — rather than on
  // `skills.max_always_skills`, which is the field whose only fix is to raise what
  // every turn of every task pays, and which a sheet may never have mentioned.
  // Landing it on `shared_skill` itself would over-name: the cap counts only the
  // `always` entries, so a path naming the list implicates the `retrieved` blocks,
  // which are not at fault, and tells the operator to go and count. Every entry past
  // the cap is reported rather than the first, per `McpServerList` above — naming
  // only the first turns a sheet with five standing entries under a cap of two into
  // fix, reparse, be told again, three times over.
  //
  // The guard is `SkillCreated`'s in ./skill.ts, and it is load-bearing rather than
  // defensive: zod runs this check even when a *continuable* issue was already
  // recorded, so a sheet whose cap is `0` would otherwise be told its cap is too
  // small *and* that it has too many entries — one mistake reported as two. A cap
  // outside its own declared bounds has already been named by the field. (A *fatal*
  // issue skips this check entirely, and so does an issue pushed by `SharedSkillList`
  // above, which is why a duplicated name is reported without the count beside it.)
  .check(ctx => {
    const cap = ctx.value.skills.max_always_skills;
    if (!Number.isInteger(cap) || cap < 1) return;

    let standing = 0;
    ctx.value.shared_skill.forEach((entry, index) => {
      if (entry.load !== "always") return;
      standing += 1;
      if (standing <= cap) return;
      ctx.issues.push({
        code: "custom",
        input: entry.load,
        path: ["shared_skill", index, "load"],
        message: `at most ${cap} shared skills may load on every task; the rest belong in "retrieved"`,
      });
    });
  });

export type TeamSheet = z.infer<typeof TeamSheet>;
