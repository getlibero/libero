// Structured logging for this package's per-channel files.
//
// A third copy of an interface the proxy and the gateway each already have, and
// the duplication is the point rather than a cost not yet paid.
//
// `packages/gateway/src/log.ts` argues it one way — a shared logger would need
// the union of both vocabularies, which is exactly what a closed vocabulary
// exists to prevent. This package has a second reason, and it is structural.
// **The store has to be a leaf.** Both services open these files: the gateway
// writes every inbound message, and since #64 the tool proxy reads them to
// answer `search_channel_history`. So this package is imported from either side
// and may name neither. A `Logger` imported from the gateway would put the Slack
// SDK into the proxy's image through a transitive edge no import in the proxy
// names — an edge that exists today rather than one that might, which is what
// changed when #64 chose the direct read over a callback. An ESLint block on
// `packages/memory/**` enforces it rather than this comment asking for it.
//
// The interface is structurally identical to both siblings, so a caller passes
// its own logger straight in and nothing imports anything.
//
// One rule for a reviewer, and it is the gateway's second rule made absolute:
// **no field may hold message text, a user id, or a display name.** The gateway
// holds messages in flight; this package holds an entire channel's conversation
// on disk, so it is the one place where a careless log line is not a leak of one
// message but a tap on the whole history. A channel's members are who that
// history belongs to and stdout is not on the path they read it through. The
// channel id and the file path are ids, not content, and are what an operator
// needs to tell one store from another.

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  /**
   * Fixed vocabulary. Five of these say a channel's file was opened —
   * "store_opened" when the gateway opens a store to write,
   * "store_reader_opened" when the proxy opens one to search,
   * "memory_file_opened" when the agent opens a channel's `MEMORY.md`,
   * "skills_opened" when it opens the channel's `skills/` directory, and
   * "proposals_opened" when it opens the merge curator's `proposals/` beside it.
   * Five words rather than one because which process opened which of a channel's
   * files, and whether it can write to it, is the first thing an operator reading
   * these lines wants.
   *
   * Two more say a skill file in that directory was **skipped** —
   * "skill_file_unusable" for one that does not parse, "skill_file_misnamed" for
   * one whose frontmatter names a different skill. Kept apart because the fix is
   * different, and they exist at all because a skipped file is otherwise
   * indistinguishable from a file nobody wrote.
   *
   * **There is deliberately no per-operation event.** What a memory or skill
   * operation did is a result its caller already holds, and the only fields this
   * shape could carry it in would be fields that hold a channel's own text. A
   * curation or authoring turn's outcome belongs in the log of whoever ran the
   * turn.
   */
  event: string;
  /** The channel this file belongs to. An id — the same one the team sheet is keyed on. */
  channel?: string;
  /**
   * A file under the state root. A path, and every variable segment of it is an
   * id rather than content: `<root>/<channel>/store.db`,
   * `<root>/<channel>/MEMORY.md`, `<root>/<channel>/skills/<name>.md`, or
   * `<root>/<channel>/proposals/<name>--<name>.md`.
   *
   * **A skill's name is the second variable segment, and it is model-authored**,
   * so it is worth saying why it is admitted here. `SkillName` bounds it to a
   * short lowercase-and-dashes identifier, which is the same class of value as a
   * tool or credential name — those are bounded precisely so that a nonsense one
   * is a parse failure at the edge rather than arbitrary text echoed into a log.
   * A name that reached this field has already passed that parse. Nothing else
   * from inside a skill may: not its description, not a line of its body. A
   * proposal's segment is two such names joined by a separator neither can
   * contain, which is the same admission twice rather than a new one.
   */
  file?: string;
}

export interface Logger {
  log(level: LogLevel, fields: LogFields): void;
}

/** Drops everything. For tests that are not asserting on log output. */
export function createSilentLogger(): Logger {
  return { log: () => {} };
}
