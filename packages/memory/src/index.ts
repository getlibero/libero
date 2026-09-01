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
// deciding for itself what a memory operation means. `planSkillOp` is absent for
// exactly that reason too. `replaceFileAtomically` is absent for a related
// reason and by a shorter route since #272: it is not this package's to
// re-export — it belongs to `@getlibero/atomic-write`, which this package
// depends on and does not pass through. The claim is the same one it always
// was. A caller reaching a channel's directory through this barrel would be a
// caller writing into it itself, which is the one thing these openers exist to
// be the only way to do; a caller that wants the recipe can name the package
// that owns it, and will not be handed a channel by doing so.
//
// `loadVec` is absent for `assertFts5`'s reason exactly: both openers already
// run it, and a caller holding it would be a caller loading a native extension
// into a connection of its own.
//
// `openSkillDirectory` in ./skill-dir.ts is absent, and it is the one whose
// absence is about writing rather than about a caller deciding something for
// itself. It is the read half two openers share, and what makes
// `openSharedSkillFiles` a read-only handle is that it composes that half and
// nothing else. A caller holding the helper could point it at a channel's own
// `skills/` and get a reader of it that no team sheet gated, which is a second
// route to a directory these openers exist to be the only route to.

export {
  MAX_EMBEDDING_DIMS,
  MESSAGE_STORE_SCHEMA_VERSION,
  READ_MAX_LIMIT,
  SEARCH_MAX_TERMS,
  openMessageReader,
  openMessageStore
} from "./store-db.js";
export type {
  EmbeddingHit,
  EmbeddingSource,
  SkillClock,
  SkillMergePair,
  SkillPairKey,
  SkillEntry,
  SkillFingerprint,
  SkillOrigin,
  SkillReconcileResult,
  SkillReconciliation,
  SkillStatusStamp,
  IdleThread,
  StaleThread,
  StoredSkill,
  MessageReader,
  MessageReaderOptions,
  MessageStore,
  MessageStoreOptions,
  SearchOptions,
  StoredEmbedding,
  StoredMessage,
  ThreadMessage,
  ScheduledTaskOutcome,
  CancelledScheduledTask,
  StoredScheduledTask,
  StoredThreadSummary
} from "./store-db.js";

export { openMemoryFile } from "./memory-file.js";
export type { MemoryFile, MemoryFileOptions } from "./memory-file.js";

export { openSkillFiles } from "./skill-file.js";
export { openSharedSkillFiles } from "./shared-skill-file.js";
export type { SharedSkillFiles, SharedSkillFilesOptions } from "./shared-skill-file.js";
export { PROPOSALS_DIRNAME, openSkillProposals, skillProposalFilename } from "./skill-proposal.js";
export type { SkillMergeProposal, SkillProposals, SkillProposalsOptions } from "./skill-proposal.js";
export type { SkillFiles, SkillFilesOptions, SkillStatusResult } from "./skill-file.js";

export { reconcileSharedSkillIndex, reconcileSkillIndex } from "./skill-store.js";
export type { SharedSkillReconcileOptions, SkillReconcileOptions } from "./skill-store.js";

export { createSilentLogger } from "./log.js";
export type { LogFields, LogLevel, Logger } from "./log.js";
