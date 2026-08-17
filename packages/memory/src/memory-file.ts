// One channel's curated memory on disk: `MEMORY.md`, and every rule about what
// may be written to it.
//
// Layer 2 of the architecture's *Memory* section. `./store-db.ts` holds layer 1
// — the messages the channel actually sent — and the two are neighbours in a
// directory rather than relatives: one is a SQLite database with six prepared
// statements, the other is a markdown file a person can open. What they share is
// the boundary below.
//
// ## The isolation invariant, in the same strict form
//
//   - There is no `channel` column, because there is no schema at all. The file
//     *is* the channel.
//   - No operation below takes a channel id. `openMemoryFile` closed over one
//     path when it was called, so writing into another channel's memory is not
//     something `MemoryFile` can express. That is a shape the type system has
//     rather than a rule a reviewer applies.
//
// A caller-supplied `root` does not undo that, for `./store-db.ts`'s reason: the
// last two segments are fixed — `<channel>/MEMORY.md` — and `channel` is
// validated as a single safe path segment by `ChannelId`, whose character class
// admits no separator and whose leading-character rule rejects `.` and `..`. So
// there is no `root` for which one channel's join resolves to another's file.
//
// ## No mkdir
//
// Unchanged from ./store-db.ts, and for the same reason: the channel's directory
// existing is the operator's statement that the channel exists, and
// `apps/server/src/session/store.ts` is where the team sheet is checked before
// one is created. This module creates the *file* on a first successful write —
// that is the channel remembering something — and never the directory.
//
// ## No lock, and what replaces it
//
// The architecture doc used to say these writes were locked. They are not, and
// the reason is not expedience.
//
// A lock file that outlives a killed process is a worse failure than the one it
// would prevent — the proxy's vault and token store both reject one on exactly
// that ground, and nothing about this file argues differently. What replaces it
// is two properties that between them cover what a lock would have:
//
//   - **Every write lands by rename.** `@getlibero/atomic-write` writes a whole
//     temporary file and renames it over the target, so a reader holds either
//     the old file or the new one. No reader ever sees a torn file, and no
//     writer's bytes ever land inside another's.
//   - **Nothing here interleaves.** `apply` is synchronous from the read to the
//     rename. In a single-threaded runtime a function that never awaits has no
//     point at which a second operation could run, so two writers in one process
//     serialize because there is nowhere for them to overlap. This is the whole
//     reason the module is sync: `packages/proxy/src/token-store.ts` needs a
//     promise-chain mutex for the same read-modify-write, because its interface
//     is async and a caller can hold a stale view across an `await`. A sync
//     interface never opens that window, and a mutex here would be a mechanism
//     implying it guards a hazard it cannot reach.
//
// **What that leaves is a lost update, not a torn file, and only across
// processes.** Two OS processes writing this file can each read, compute, and
// rename, and the second rename wins — the first write is gone rather than
// mangled. The deployment has exactly one writer (one `apps/server` container,
// no clustering, and the proxy opens no such file), and within it the session
// queue already serializes a channel's tasks. That is a deployment property
// stated rather than a code property enforced, and the README says so.
//
// ## Refuse, never truncate — and the one thing that must still be possible
//
// An operation that would take the file past its cap is refused and nothing is
// written. Nothing is shortened and nothing is dropped from the front, because a
// silently truncated memory is a fact the team believes it recorded and there is
// no way to tell from reading the file afterwards.
//
// The cap is checked once, on the whole prospective file, and it has one
// deliberate relaxation argued at `planMemoryOp` below: a file already over the
// cap must still be compactable, or the channel is stuck.
//
// ## A result is for the model; an exception is for the operator
//
// `MemoryOpResult` is the vocabulary of things a model did or could fix — it hit
// the cap, its `find` matched nothing, it matched twice. Anything else throws.
// A full disk is not something a model can fix by rewording its operation, and a
// result member for one would put "the disk is full" into a model's context and
// invite it to retry the operation that filled it. That is why #224 shipped no
// `store_unavailable` member and why this module does not ask for one.
//
// The exception to that is absence: a file that is not there yet reads as empty,
// because a provisioned channel nobody has curated is the ordinary state of a
// new channel. **Only `ENOENT`.** Every other read error throws, and that
// distinction is load-bearing rather than fastidious — the read is what a write
// is computed from, so answering "empty" to a file we could not read would
// replace the whole of a channel's memory with one appended line. `EACCES` is
// the live case; `EISDIR`, `ELOOP` and `EIO` are the others.
//
// ## Characters, not bytes
//
// The cap counts `String.length` — UTF-16 code units — because that is what
// `[memory] max_file_chars` means in the sheet and what `z.string().max()`
// counts in `@getlibero/schema`. The file on disk is UTF-8, so a file at the cap
// can be larger than the cap in bytes. Nothing downstream depends on the byte
// figure: the cap exists to bound what a task's opening context costs, which is
// tokens, and tokens are closer to characters than to bytes. Do not "fix" this
// to `Buffer.byteLength` — it would quietly change every channel's effective
// cap.
//
// ## Every operation re-reads the file
//
// There is no cached content, no watcher, and no `close`. A team member editing
// `MEMORY.md` in a text editor is a first-class writer here, and the next
// operation sees their edit because it reads the file rather than something it
// remembered. That is also what makes a `find` from a `read()` this module
// returned still meaningful a moment later.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelId, MEMORY_OP_MAX_TEXT_CHARS } from "@getlibero/schema";
import type { MemoryOp, MemoryOpResult } from "@getlibero/schema";
import { replaceFileAtomically } from "@getlibero/atomic-write";
import type { Logger } from "./log.js";

/**
 * The file's name inside the channel's directory.
 *
 * Module-private, and there is deliberately no exported helper that builds the
 * path — `STORE_FILENAME`'s reason in ./store-db.ts: a test that computes
 * `join(root, channel, "MEMORY.md")` itself is asserting the layout, and one
 * that called our own helper would assert nothing.
 *
 * Capitalised because this name is the operator-facing part of the feature. A
 * person opening a channel's state directory should meet it before `store.db`.
 */
const MEMORY_FILENAME = "MEMORY.md";

export interface MemoryFileOptions {
  /**
   * The channel this file belongs to. Validated as a `ChannelId`, which is what
   * makes it safe as a path segment.
   */
  readonly channel: string;
  /**
   * The directory holding the per-channel state directories. The file is
   * `<root>/<channel>/MEMORY.md`, and `<root>/<channel>` must already exist —
   * see the header on why this does not create it.
   */
  readonly root: string;
  /**
   * This channel's `[memory] max_file_chars`, in characters.
   *
   * Required, and deliberately not defaulted. A default here would be a second
   * copy of the schema's figure living in a package that cannot see a team
   * sheet, and the two would disagree the first time an operator's number moved.
   * A caller that has not consulted the sheet cannot open the file.
   */
  readonly maxFileChars: number;
  readonly logger?: Logger;
}

/**
 * One channel's `MEMORY.md`, as two named operations rather than a handle.
 *
 * **No method takes a channel id, and none returns one.** The factory closed
 * over exactly one path, so writing into another channel is not something this
 * interface can express — the acceptance criterion in structural form, the same
 * one `MessageStore` states.
 *
 * **There is no `close`, and that is not an oversight.** `MessageStore` has one
 * because it holds a `DatabaseSync` for the object's life; this holds a path
 * string and a number, and every descriptor it opens is closed inside the
 * operation that opened it. A no-op `close` would be a method whose omission no
 * test could detect, and a false signal of a lifecycle — which is an invitation
 * to the next reader to cache the file behind it.
 */
export interface MemoryFile {
  /**
   * This channel's memory as it is on disk right now.
   *
   * `""` for a file that does not exist and `""` for one that is empty — the
   * same answer, deliberately. The difference between the two is a fact about
   * the filesystem rather than about what the channel remembers, and nothing
   * downstream could act on it.
   *
   * Returned exactly as stored: no trimming, no line-ending rewrite, no BOM
   * handling. A `memory_replace` has to match what this returned, and any
   * normalization would make that round trip a lie.
   */
  read(): string;
  /** Run one operation, and answer what it did. */
  apply(op: MemoryOp): MemoryOpResult;
}

export type MemoryOpPlan =
  | { readonly write: true; readonly next: string; readonly result: MemoryOpResult }
  | { readonly write: false; readonly result: MemoryOpResult };

/**
 * What an operation would do to this content, decided without touching a disk.
 *
 * Every rule about memory lives here, on two strings and a number: the per-op
 * ceiling, how matches are counted, the separator an append adds, and where the
 * cap is checked. That keeps `apply` down to a read, this, and at most one
 * write — and it means there is exactly one call site of the writer, inside
 * `if (plan.write)`, so "an operation that would exceed the cap leaves the file
 * unchanged" is a shape rather than a branch a reviewer has to trace.
 *
 * Exported for its own test and absent from the barrel, the way `toMatchQuery`
 * is: a caller holding this would be a caller deciding for itself what a memory
 * operation means.
 */
export function planMemoryOp(content: string, op: MemoryOp, limit: number): MemoryOpPlan {
  const invalid = precheck(op);
  if (invalid !== null) return { write: false, result: { outcome: "failed", reason: invalid } };

  let next: string;

  if (op.op === "memory_append") {
    // At most two characters the model did not write: one so the text starts on
    // its own line, one so the file ends on a newline and whatever comes next —
    // the following append, or a person's editor — begins on one. Both count
    // against the cap, because the cap is on the file and the figure the result
    // carries has to be the file's actual size.
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    const terminator = op.text.endsWith("\n") ? "" : "\n";
    next = `${content}${separator}${op.text}${terminator}`;
  } else {
    // Literal and non-overlapping. `split` on a string never treats it as a
    // pattern, which is the promise the published tool description makes.
    const matches = content.split(op.find).length - 1;
    if (matches === 0) {
      return { write: false, result: { outcome: "failed", reason: "find_not_found" } };
    }
    if (matches > 1) {
      return { write: false, result: { outcome: "failed", reason: "find_ambiguous", matches } };
    }

    // Spliced by index rather than `String.prototype.replace`, which would read
    // `$&`, `$1` and `$'` in the replacement as substitutions. The model's text
    // is data, and a fact containing `$&` must land as those two characters.
    const at = content.indexOf(op.find);
    next = content.slice(0, at) + op.replace + content.slice(at + op.find.length);

    // No separator and no terminator on this path. An append frames what it
    // adds; a replace does not, because its contract is that the file afterwards
    // holds exactly what was asked for — which is also what makes deleting by
    // replacing with nothing behave the way it reads.
  }

  // An operation may not push the file past its cap. But a file already over the
  // cap — a hand edit, or an operator who lowered the number — must still be
  // compactable, and every intermediate state of a shrinking rewrite is also over
  // the cap, so a bare `next.length > limit` would refuse the only operation that
  // could fix it. What is refused is therefore an operation that leaves the file
  // both over the cap and bigger than it already was.
  //
  // This is not a softening of the cap. It is what makes the sentence the model
  // is already given true: `memoryOpMessage` tells it to "replace something
  // already in the file with a shorter version of itself to make room", and
  // under the bare check that is advice the store would refuse to honour. An
  // append always grows the file, so nothing here lets one through.
  if (next.length > limit && next.length > content.length) {
    return {
      write: false,
      result: { outcome: "failed", reason: "file_cap_exceeded", chars: next.length, limit }
    };
  }

  return { write: true, next, result: { outcome: "written", chars: next.length, limit } };
}

/**
 * The bounds an operation has to clear before its content is even considered.
 *
 * `MEMORY_OP_MAX_TEXT_CHARS` is checked here as well as in `parseMemoryOp`, and
 * the two owners are different rather than redundant. **The parser owns it as
 * the model's contract**: it is the figure the published JSON Schema states, and
 * it turns an over-long argument into a sentence the model can act on before
 * anything opens a file. **This module owns it as a precondition of its own**:
 * it is what makes "one operation cannot spend the file" a property of the file
 * rather than of the parser. `MemoryOp` is a plain type with no zod object — by
 * its own doc's decision — so nothing structurally forces a caller through the
 * parser, and a hand-built operation carrying two hundred thousand characters
 * would otherwise be written. They cannot drift: both import this constant.
 */
function precheck(op: MemoryOp): "malformed_arguments" | "text_too_long" | null {
  const required = op.op === "memory_append" ? op.text : op.find;
  if (required === "") return "malformed_arguments";

  const fields = op.op === "memory_append" ? [op.text] : [op.find, op.replace];
  if (fields.some(field => field.length > MEMORY_OP_MAX_TEXT_CHARS)) return "text_too_long";

  return null;
}

/** True when `error` is a Node system error carrying this errno. */
function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function openMemoryFile(options: MemoryFileOptions): MemoryFile {
  const { channel, root, maxFileChars, logger } = options;

  // `ChannelId` rather than the raw pattern, for ./store-db.ts's reason: anything
  // that *stores* on an id validates with the schema. It is what makes the join
  // below safe — a validated id is one path segment and cannot climb out of
  // `root`.
  if (!ChannelId.safeParse(channel).success) {
    throw new Error(`memory store: ${JSON.stringify(channel)} is not a valid channel id`);
  }

  const directory = join(root, channel);
  const file = join(directory, MEMORY_FILENAME);

  // The floor is re-checked and the roof is not, and the asymmetry is the
  // argument. A cap below one operation's ceiling is a channel where every legal
  // operation is unwritable — the "parses, then cannot serve a call" class the
  // `[memory]` block refuses at parse for the same reason — and it would surface
  // not as an error but as a model retrying an operation that can never succeed.
  // The schema bounds this field when a sheet is parsed, but a caller hands over
  // a raw number and the agent side's mirror is hand-written with its own
  // fallbacks, so this store cannot assume a sheet produced it.
  //
  // An over-large cap breaks no invariant this module holds; the file simply gets
  // big, and what that costs is the context budget of the task that reads it,
  // which belongs to the caller. Restating the schema's roof here would be a
  // constant kept in step by hand for no property.
  if (!Number.isInteger(maxFileChars) || maxFileChars < MEMORY_OP_MAX_TEXT_CHARS) {
    throw new Error(
      `memory store: ${file} was opened with a cap of ${maxFileChars} characters, and one ` +
        `operation may carry ${MEMORY_OP_MAX_TEXT_CHARS}. A cap below one operation's ceiling ` +
        `is a channel where every legal operation is unwritable. Set [memory] max_file_chars ` +
        `to at least ${MEMORY_OP_MAX_TEXT_CHARS} in this channel's team sheet.`
    );
  }

  // No mkdir — see the header. This check is for the operator's sake rather than
  // as a gate: without it the first operation fails naming a temporary file that
  // no longer exists, and with it the message names the directory and who makes
  // one. The directory can still vanish afterwards, and then the write throws,
  // which is the right outcome.
  if (!existsSync(directory)) {
    throw new Error(
      `memory store: ${directory} has no state directory, so this channel has nowhere to ` +
        `remember anything. The agent creates one after checking the channel has a team sheet.`
    );
  }

  /**
   * The file, or `""` when there is none. Read fresh on every operation — the
   * header's last section is why.
   */
  const content = (): string => {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return "";
      throw error;
    }
  };

  logger?.log("info", { event: "memory_file_opened", channel, file });

  return {
    read() {
      return content();
    },

    apply(op) {
      const before = content();
      const plan = planMemoryOp(before, op, maxFileChars);
      if (plan.write) replaceFileAtomically(file, Buffer.from(plan.next, "utf8"));
      return plan.result;
    }
  };
}
