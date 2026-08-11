// The message store: one SQLite file per channel, with an FTS5 index over it.
//
// `toMatchQuery` is deliberately absent. It is exported from ./store-db.ts so
// its own test can reach it, but a caller holding it would be a caller building
// its own FTS5 MATCH expression — and the reason `search` takes text is that
// nothing outside that module should. `assertFts5` is absent for the same kind
// of reason: it is a startup check this module already runs.

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

export { createSilentLogger } from "./log.js";
export type { LogFields, LogLevel, Logger } from "./log.js";
