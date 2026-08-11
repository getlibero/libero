// Structured logging for the message store.
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
   * Fixed vocabulary: "store_opened" when the gateway opens a store to write,
   * "store_reader_opened" when the proxy opens one to search. Two words rather
   * than one because which process opened a channel's file, and whether it can
   * write to it, is the first thing an operator reading these lines wants.
   */
  event: string;
  /** The channel this store belongs to. An id — the same one the team sheet is keyed on. */
  channel?: string;
  /**
   * The store file. A path, and its only variable segment is the channel id,
   * which is why it carries no content: `<root>/<channel>/store.db`.
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
