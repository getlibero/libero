// The two operations the curation turn may perform on a channel's `MEMORY.md`,
// and what each of them tells the model about itself.
//
// **These are not proxied tool calls, and they must never become built-ins.**
// The curation turn runs in the agent process (#226) and writes through
// `packages/memory` to `AGENT_STORE_ROOT/<channel>/MEMORY.md` (#225) — the root
// only the agent writes. No credential is involved, no upstream is dialled, and
// nothing crosses the mTLS boundary, so there is no `BuiltinToolName` member for
// either of these and nothing in `packages/proxy/src/builtins.ts`. The proxy's
// only reach into a channel's store is `openMessageReader`, which is read-only
// and offers `search` and `close`. What governs a memory op is the caps below
// and the meter on the turn that emitted it, which is deterministic; it is not
// an instruction to the model.
//
// **They live in this package anyway, and that is the whole reason this package
// exists.** The offerer is `packages/agent` and the executor is
// `packages/memory`, and those two must not import each other — the memory
// package is an ESLint-enforced leaf because both services open its files. The
// only module both ends already see is this one. CLAUDE.md has named this home
// since phase 1.
//
// **The description and the JSON Schema live here too, unlike the built-ins'.**
// `BUILTIN_TOOLS` sits in the proxy because the proxy both publishes those tools
// and serves their calls, so one package holds both halves. Here the two halves
// are two packages that cannot see each other, so the definitions go to the one
// they share. The pattern is otherwise copied from
// `packages/proxy/src/builtins.ts`: a zod parser beside a hand-written JSON
// Schema, a round-trip test rather than a generator, and a `Record` over the
// name enum so a third op cannot be named without being described. Its
// module-load description guard is the one part deliberately not copied — see
// the note above `MEMORY_TOOLS`.
//
// ## Two bounds, and both refuse rather than truncate
//
// `MEMORY_OP_MAX_TEXT_CHARS` bounds one op and is checkable here, on a string,
// before anything opens a file — which is what lets the JSON Schema state the
// same figure to the model. The file's own ceiling is `[memory] max_file_chars`
// in ./team-sheet.ts and can only be checked at write time, against a file this
// package never opens; that check is #225's. Neither shortens anything. A
// silently truncated memory is a fact the team believes it recorded and a
// sentence the model half-wrote, and there is no way to tell which from reading
// the file afterwards.
//
// ## The result vocabulary is memory-local, deliberately
//
// Not new members on `RefusalReason`. A `ToolRefusal` is two things at once: the
// sentence a channel reads, and a row's columns rebuilt by `auditRefusalMessage`
// on the operator's path. A memory op reaches no proxy, is decided by no gate,
// and writes no audit row — so a memory reason over there would be a member no
// row could ever carry, and `auditRefusalMessage` would grow an arm answering
// for evidence that does not exist. Per CLAUDE.md: nothing that is merely
// broken should be spelled as a refusal, and this is a third thing, which is an
// operation on the agent's own state failing its own bounds.

// **Nothing is imported from ./tool-listing.js at runtime, and that is load
// bearing rather than tidy.** `ToolInputSchema` arrives as a type, which erases,
// because a value import would make this package's module graph circular:
// ./tool-listing.js takes `ApprovalMode` from ./team-sheet.js, and
// ./team-sheet.js takes `MEMORY_OP_MAX_TEXT_CHARS` from here. The cycle does not
// fail to resolve — it resolves in an order that leaves `PermittedTool` built
// against an undefined `approval`, which surfaces as zod throwing while it
// formats an unrelated error. Keep this a type-only edge.
import { z } from "zod";
import type { ToolInputSchema } from "./tool-listing.js";

/**
 * The most text one operation may carry, in characters.
 *
 * A durable team fact is a sentence or a short list, not a document — the
 * curation turn is asked for what will still be true next week. Two bounds
 * decide the figure and it sits between them.
 *
 * **Above the floor:** a `memory_replace` that retires a stale section has to
 * fit inside one op, because compaction *is* replace-with-a-shorter-string —
 * there is deliberately no operation that rewrites the whole file. A ceiling of
 * a thousand characters would turn routine tidying into two ops that each half
 * match, and a half-applied compaction is worse than none.
 *
 * **Below the roof:** one op must not be able to spend the file. Against the
 * `[memory] max_file_chars` default of 32768 this is one sixteenth, so filling
 * a channel's memory in a single call is not available to a model that has been
 * talked into trying.
 *
 * It bounds `text`, `find` and `replace` alike, so a replace cannot smuggle
 * more text in than an append can.
 *
 * A constant rather than a team-sheet field. The argument is on the `[memory]`
 * block in ./team-sheet.ts, where an operator would look for it.
 */
export const MEMORY_OP_MAX_TEXT_CHARS = 4_096;

/**
 * The two operations, as a closed set.
 *
 * A `z.enum` for the reason `BuiltinToolName` is one: it makes `MEMORY_TOOLS`
 * below a totality check, so a third operation cannot be named without being
 * described to the model. The list is deliberately short and the architecture
 * page names exactly these two.
 *
 * **Not a member of `BuiltinToolName` and never to become one** — see the
 * header. A built-in is a proxied call a team sheet grants and the audit log
 * records; these are neither.
 */
export const MemoryToolName = z.enum(["memory_append", "memory_replace"]);

export type MemoryToolName = z.infer<typeof MemoryToolName>;

const OpText = z.string().max(MEMORY_OP_MAX_TEXT_CHARS);

/**
 * What the model may send to `memory_append`, parsed strictly.
 *
 * **`.strict()` is the acceptance criterion in executable form**, the way
 * `SearchChannelHistoryArguments` is. "No argument the model controls can reach
 * another channel's memory, or any other file" is true here because there is no
 * `path`, no `file` and no `channel` field to send, and an unknown key is a
 * rejection naming the key rather than one silently dropped. A model that writes
 * `{"text": "…", "path": "../other/MEMORY.md"}` gets an error, and whoever reads
 * the transcript can see that something tried.
 *
 * The file is resolved from the channel the session already is, by a store that
 * closed over one path. There is no code path by which an argument could reach
 * it.
 */
export const MemoryAppendArguments = z
  .object({
    text: OpText.min(1)
  })
  .strict();

export type MemoryAppendArguments = z.infer<typeof MemoryAppendArguments>;

/**
 * What the model may send to `memory_replace`, parsed strictly.
 *
 * `find` is non-empty because "matches exactly once" has no meaning for the
 * empty string. `replace` is required and *may* be empty: deletion is
 * replace-with-nothing and there is no other spelling of it, so an omitted
 * `replace` and an empty one would be two ways to say the same thing — which is
 * how one of them goes untested. A model that left the field out more likely
 * meant something else.
 */
export const MemoryReplaceArguments = z
  .object({
    find: OpText.min(1),
    replace: OpText
  })
  .strict();

export type MemoryReplaceArguments = z.infer<typeof MemoryReplaceArguments>;

/**
 * One operation, tagged, as the store executes it.
 *
 * A type with no zod object, for the reason `AuditRecord` has none: this is
 * constructed in-process by `parseMemoryOp` below and handed straight to
 * `packages/memory`. There is no boundary at which untrusted bytes become one,
 * and a `.parse()` on this shape would be an invitation to build one.
 *
 * **Tagged with `op`, whose values are the tool names**, so there is one
 * vocabulary for "which operation is this" across the turn that emits it, the
 * store that runs it, and the log that records it.
 *
 * **The arguments above are two strict objects rather than a
 * `z.discriminatedUnion("op", …)`, and that is not an oversight.** The
 * discriminant is the tool name in the provider's tool-use block, not a field
 * inside the arguments. A union keyed on an inner field would make the model
 * write the operation twice — once as the tool it called, once as `op` — and a
 * disagreement between the two has no right answer. It would also make the JSON
 * Schema wrong, since each tool is published with its own `inputSchema` and a
 * union's schema describes neither. This tagged shape is the *output*, minted
 * after the name has already picked a parser, and it exists so the store can
 * switch exhaustively over one type instead of offering two entry points.
 */
export type MemoryOp =
  | { readonly op: "memory_append"; readonly text: string }
  | { readonly op: "memory_replace"; readonly find: string; readonly replace: string };

/**
 * What `parseMemoryOp` answers. Never an exception.
 *
 * `text_too_long` is kept apart from `malformed_arguments` because the two send
 * the model to different fixes — shorten this, versus you sent the wrong shape —
 * and a model told the wrong one wastes the channel's next curation turn.
 */
export type MemoryOpParse =
  | { readonly ok: true; readonly op: MemoryOp }
  | {
      readonly ok: false;
      readonly reason: "unknown_tool" | "malformed_arguments" | "text_too_long";
    };

/**
 * Turn a tool name and whatever the model put in the arguments into an
 * operation, or into the reason it is not one.
 *
 * Here rather than in `packages/agent` because this is what makes "both ends
 * agree on one definition" load-bearing rather than aspirational: without it the
 * turn writes its own `switch (name)` and its own reading of zod's issues, and
 * the vocabulary the store answers in stops matching the one the turn speaks on
 * the first edit to either. It mirrors `parseTeamSheet` — a named parse in this
 * package that never throws and returns a structured account rather than prose.
 *
 * Never throws. A model emitting nonsense is an ordinary outcome of asking a
 * model for something, not an exceptional one.
 */
export function parseMemoryOp(name: string, args: unknown): MemoryOpParse {
  const tool = MemoryToolName.safeParse(name);
  if (!tool.success) return { ok: false, reason: "unknown_tool" };

  if (tool.data === "memory_append") {
    const parsed = MemoryAppendArguments.safeParse(args);
    if (!parsed.success) return { ok: false, reason: failureOf(parsed.error) };
    return { ok: true, op: { op: "memory_append", text: parsed.data.text } };
  }

  const parsed = MemoryReplaceArguments.safeParse(args);
  if (!parsed.success) return { ok: false, reason: failureOf(parsed.error) };
  return {
    ok: true,
    op: { op: "memory_replace", find: parsed.data.find, replace: parsed.data.replace }
  };
}

/**
 * Length alone, or something else.
 *
 * The one piece of cleverness in this module, and it is pinned by a test rather
 * than trusted: `memory-op.test.ts` asserts the distinction directly, so a zod
 * major that renames `too_big` fails the suite here instead of quietly telling
 * every model it sent the wrong keys.
 */
function failureOf(error: z.ZodError): "malformed_arguments" | "text_too_long" {
  return error.issues.every(issue => issue.code === "too_big")
    ? "text_too_long"
    : "malformed_arguments";
}

/**
 * Why an operation did not happen.
 *
 * A memory-local vocabulary rather than members on `RefusalReason` — the header
 * has the argument. The first three are this module's, decided before anything
 * opens a file; the last three are the store's (#225), decided against the file
 * itself.
 *
 * There is deliberately no member for a store that could not be opened at all.
 * Whether that is a result or an exception is #225's call to make when it writes
 * the I/O, and a member no code can reach is dead — adding one later is
 * additive, and removing one that shipped is not.
 */
export const MemoryOpFailure = z.enum([
  /** The model called something that is not one of the two operations. */
  "unknown_tool",
  /** The arguments did not parse: a missing field, a wrong type, an unknown key. */
  "malformed_arguments",
  /** One field was longer than `MEMORY_OP_MAX_TEXT_CHARS`. */
  "text_too_long",
  /** The file would have exceeded `[memory] max_file_chars`. Nothing was written. */
  "file_cap_exceeded",
  /** `find` appeared nowhere in the file. */
  "find_not_found",
  /** `find` appeared more than once, and an operation must name exactly one place. */
  "find_ambiguous"
]);

export type MemoryOpFailure = z.infer<typeof MemoryOpFailure>;

/**
 * What one operation did.
 *
 * A type rather than a zod object, for the reason `MemoryOp` is one: the store
 * builds it and the turn reads it, both inside the agent process, and nothing
 * parses it off a wire.
 *
 * Each variant carries exactly the facts its sentence needs, which is
 * `ToolRefusal`'s discipline and is worth keeping for the same reason — the
 * sentence cannot disagree with the outcome if there is nothing in it that was
 * not enumerated here.
 */
export type MemoryOpResult =
  | { readonly outcome: "written"; readonly chars: number; readonly limit: number }
  | { readonly outcome: "failed"; readonly reason: "find_ambiguous"; readonly matches: number }
  | {
      readonly outcome: "failed";
      readonly reason: "file_cap_exceeded";
      readonly chars: number;
      readonly limit: number;
    }
  | {
      readonly outcome: "failed";
      readonly reason: Exclude<MemoryOpFailure, "find_ambiguous" | "file_cap_exceeded">;
    };

/**
 * The sentence the curation turn hands back to the model.
 *
 * Total over the union, so a new outcome cannot be added without deciding what
 * the model is told about it — `refusalMessage`'s rule, and it holds here for
 * the same reason.
 *
 * **This one does quote figures, and `refusalMessage` deliberately does not.**
 * The rule over there is that the number lives in the team sheet, the sentence
 * is read in a channel, and the audit table has no column for it, so a quoted
 * figure would be the only place a message could disagree with the meter. Every
 * clause of that is different here. The reader is the model rather than a
 * person; the number comes from the store that has just enforced it, arriving on
 * the same result object rather than from a second read of anything; and the
 * figure is the entire point, because knowing how full the file is is what lets
 * a model compact instead of retrying the same op until the turn ends. Same
 * hazard, answered the other way, because the facts that made the answer are
 * not present.
 *
 * **No file content in any sentence** — not `find`, not `text`, not a line from
 * the file. The model wrote both and still has them, echoing them back makes a
 * long sentence out of a short one, and this is the only place a curated file's
 * contents could reach a log by accident.
 */
export function memoryOpMessage(result: MemoryOpResult): string {
  if (result.outcome === "written") {
    return `Written. MEMORY.md now holds ${result.chars} of ${result.limit} characters.`;
  }

  switch (result.reason) {
    case "unknown_tool":
      return "That is not one of this channel's memory operations. Nothing was written.";
    case "malformed_arguments":
      return "Those arguments do not match the operation's input schema. Nothing was written.";
    case "text_too_long":
      return `One memory operation may carry ${MEMORY_OP_MAX_TEXT_CHARS} characters and this one carried more. Nothing was written.`;
    case "file_cap_exceeded":
      return `MEMORY.md would be ${result.chars} characters and this channel's cap is ${result.limit}. Nothing was written. Replace something already in the file with a shorter version of itself to make room.`;
    case "find_not_found":
      return "That text appears nowhere in MEMORY.md, and a replacement must match exactly once. Nothing was written. Copy the text from the file as it is written there.";
    case "find_ambiguous":
      return `That text appears ${result.matches} times in MEMORY.md, and a replacement must match exactly once. Nothing was written. Include enough of the surrounding text to name one place.`;
  }
}

export interface MemoryToolDefinition {
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/**
 * The JSON Schemas the model is given, beside the zod parsers that enforce them.
 *
 * Two spellings of one contract, which is a drift hazard — `memory-op.test.ts`
 * closes it by asserting the bounds match, exactly as `builtins.test.ts` does
 * for `search_channel_history`. Generating one from the other would pull a
 * converter into the package every other package imports, to save a test.
 *
 * `additionalProperties: false` mirrors `.strict()`, so a well-behaved model is
 * told the rule rather than only punished for breaking it.
 */
const MEMORY_APPEND_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: MEMORY_OP_MAX_TEXT_CHARS,
      description:
        "The fact to record, as a markdown line or a short block. Appended to the end of the file on its own line."
    }
  },
  required: ["text"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

const MEMORY_REPLACE_SCHEMA = {
  type: "object",
  properties: {
    find: {
      type: "string",
      minLength: 1,
      maxLength: MEMORY_OP_MAX_TEXT_CHARS,
      description:
        "Literal text copied out of the file, whitespace and all. Not a pattern. It must appear exactly once."
    },
    replace: {
      type: "string",
      maxLength: MEMORY_OP_MAX_TEXT_CHARS,
      description: "What goes in its place. The empty string deletes the text that was found."
    }
  },
  required: ["find", "replace"],
  additionalProperties: false
} as const satisfies ToolInputSchema;

/**
 * Both operations, by name.
 *
 * A `Record` over `MemoryToolName` rather than a `Map`, so adding a member to
 * the enum without describing it here is a type error.
 *
 * ## This text enters a model's context on every curation turn
 *
 * It is ours, it cannot change without a commit, and there is no tool-poisoning
 * surface — so, as with the built-ins, it is bounded by review in the diff
 * rather than at runtime. What it has to be is *accurate*, because a description
 * is the only thing standing between a model and an operation it will get wrong.
 * Between them these say five things a model would otherwise assume the other
 * way: appending does not deduplicate, `find` is literal rather than a pattern,
 * it must match exactly once, a failed operation writes nothing at all, and
 * there is no argument naming a file — because the alternative to saying so is
 * a curation turn that spends itself discovering each one.
 */
export const MEMORY_TOOLS: Record<MemoryToolName, MemoryToolDefinition> = {
  memory_append: {
    description:
      "Add a durable fact to this channel's MEMORY.md. " +
      "The text is appended to the end of the file on its own line, otherwise exactly as " +
      "written, and nothing is " +
      "deduplicated, so read the file before adding something it may already say. " +
      "MEMORY.md is freeform markdown that the team can read and edit, and there is one " +
      "per channel — no argument names a file, a path, or a channel. " +
      "Both this text and the file as a whole are size-capped: an operation past either " +
      "cap is refused and nothing is written, rather than being silently shortened. " +
      "Record only what will still be true next week — decisions, names, conventions, " +
      "standing preferences. Not the answer you have just given.",
    inputSchema: MEMORY_APPEND_SCHEMA
  },
  memory_replace: {
    description:
      "Rewrite or delete part of this channel's MEMORY.md. " +
      "`find` is literal text, not a pattern and not a regular expression: copy it out of " +
      "the file, whitespace and all. It must match exactly once — matching nothing and " +
      "matching more than once are both failures that write nothing and leave the file " +
      "unchanged, so include enough of the surrounding text to name one place. " +
      "`replace` is what goes in its place; the empty string deletes what was found, " +
      "which is how a stale fact is retired and how the file is made smaller when it is " +
      "full. There is no operation that rewrites the whole file. " +
      "Both fields are capped, and an operation past the cap is refused rather than " +
      "truncated.",
    inputSchema: MEMORY_REPLACE_SCHEMA
  }
};

// **There is no module-load guard on these descriptions, unlike the built-ins'**
// — `packages/proxy/src/builtins.ts` throws at load if one exceeds
// `MAX_TOOL_DESCRIPTION`, and the reason it does is a failure mode these tools do
// not have. That bound is what `PermittedTool.description` parses against, so an
// over-long built-in description makes a whole `ToolListing` fail on the agent's
// side and ends a task with "the tool proxy could not be reached". These tools
// never travel in a listing: they are offered directly to the curation turn and
// never published by the proxy, so nothing parses them against that constant and
// an over-long one would cost context rather than a task. `memory-op.test.ts`
// holds them to it anyway, because the cost argument stands on its own — a
// description is re-sent on every turn — and a test is where that belongs when
// the alternative is the runtime import edge the header rules out.
