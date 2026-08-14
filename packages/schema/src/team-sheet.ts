import { BUILTIN_SERVER, BuiltinToolName } from "./builtin.js";
import { EgressPattern } from "./egress.js";
import { MEMORY_OP_MAX_TEXT_CHARS } from "./memory-op.js";
import { CertificateSha256, CredentialName, ResourceName } from "./names.js";
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
 * One entry in `[[builtin]]` — a tool the proxy implements itself (#64).
 *
 * The same two optional fields `ToolEntry` carries, resolved by the same two
 * functions in packages/proxy/src/enforce.ts on the same most-restrictive-wins
 * rule. That is deliberate rather than convenient: a built-in is not a bypass,
 * so it earns its approval and its result bound the way every other tool does.
 * It is structurally assignable to `ToolEntry` — `name` is narrower — which is
 * what lets `resolveApproval` and `resolveLimits` take it unchanged.
 *
 * `name` is the one difference, and it is why this block exists at all: a closed
 * enum, so a misspelled tool is an issue at `builtin.<n>.name` rather than an
 * entry that parses, lists as permitted, and is refused at dispatch. See
 * ./builtin.ts for the argument in full.
 *
 * There is no `server` field. The provider is the proxy, there is one of it, and
 * the name it answers to is `BUILTIN_SERVER`.
 */
export const BuiltinEntry = z.object({
  name: BuiltinToolName,
  approval: ApprovalMode.optional(),
  max_result_chars: z.number().int().positive().optional(),
});

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

export const TeamSheet = z.object({
  channel: z.object({
    name: z.string().min(1),
    description: z.string().default(""),
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
      // The invoice, in US dollars (#62). PARSED BUT NOT YET ENFORCED — a sheet
      // setting it today is metered exactly as one that does not.
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
      // `schedule` beside its own `enabled = false`, and a channel keeping its
      // figures through a temporary opt-out is the ordinary case.

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
  ambient: z
    .object({
      enabled: z.boolean().default(false),
      schedule: z.string().optional(),
    })
    .prefault({}),
});

export type TeamSheet = z.infer<typeof TeamSheet>;
