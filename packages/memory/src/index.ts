// One channel's files: a SQLite store of its messages with an FTS5 index over
// it, and the `MEMORY.md` the agent curates beside it.
//
// `toMatchQuery` is deliberately absent. It is exported from ./store-db.ts so
// its own test can reach it, but a caller holding it would be a caller building
// its own FTS5 MATCH expression — and the reason `search` takes text is that
// nothing outside that module should. `assertFts5` is absent for the same kind
// of reason: it is a startup check this module already runs.
//
// `planMemoryOp` is absent on the same principle: it is exported from
// ./memory-file.ts for its own test, and a caller holding it would be a caller
// deciding for itself what a memory operation means. `replaceFileAtomically` is
// absent because a caller holding it would be a caller writing into a channel's
// directory itself, which is the one thing these openers exist to be the only
// way to do.

export {
  MESSAGE_STORE_SCHEMA_VERSION,
  READ_MAX_LIMIT,
  SEARCH_MAX_TERMS,
  openMessageReader,
  openMessageStore
} from "./store-db.js";
export type {
  MessageReader,
  MessageReaderOptions,
  MessageStore,
  MessageStoreOptions,
  StoredMessage
} from "./store-db.js";

export { openMemoryFile } from "./memory-file.js";
export type { MemoryFile, MemoryFileOptions } from "./memory-file.js";

export { createSilentLogger } from "./log.js";
export type { LogFields, LogLevel, Logger } from "./log.js";
