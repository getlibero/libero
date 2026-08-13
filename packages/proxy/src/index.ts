export { createProxyServer, MAX_BODY_BYTES } from "./server.js";
export type { ProxyServerOptions, RequestContext, RouteHandler, RouteResponse } from "./server.js";

export {
  assertServableComposition,
  createToolDispatcher,
  createUnavailableBuiltinDispatcher,
  createUnavailableCatalog,
  createUnavailableDispatcher,
  markProvisional
} from "./dispatch.js";
export type {
  BuiltinDispatcher,
  Dispatch,
  McpToolDispatcher,
  SpendMeter,
  SpendReader,
  SpendRecord,
  TokenRecorder,
  ToolCallRecorder,
  ToolCatalog,
  ToolDispatcher,
  UpstreamToolDescription
} from "./dispatch.js";

// The built-in tools (#64). The definitions are constants and the executor
// reads a channel's message store; both are here because `apps/proxy-server`
// composes them, and the listing route is separately forbidden the second.
export { BUILTIN_TOOLS, DEFAULT_SEARCH_LIMIT } from "./builtins.js";
export type { BuiltinDefinition } from "./builtins.js";
export { createBuiltinDispatcher } from "./builtin-dispatcher.js";
export type { BuiltinDispatcherOptions } from "./builtin-dispatcher.js";

// The budget meter. Real, and required by any composition that also has a real
// dispatcher — see `assertServableComposition`.
export { NO_SPEND, openBudgetDb, utcDay, BUDGET_SCHEMA_VERSION } from "./budget-db.js";
export type { BudgetDb, BudgetDbOptions, DailySpend, ModelSpend, TurnTokens } from "./budget-db.js";
export { TURN_RETENTION_MS, createSqliteSpendMeter, openSpendMeter } from "./budget-meter.js";
export type { SpendMeterOptions } from "./budget-meter.js";

// The price table (#62). Read at every decision so a corrected price re-prices
// today's spend on the next call; absent is legal and prices nothing, which is
// the fail-closed answer for a channel capped in dollars. Nothing consults it
// yet — `budget.daily_usd` parses and is not enforced in this build.
export { NO_PRICES, openPriceTableStore } from "./price-table-store.js";
export type { PriceLookup, PriceTableStore, PriceTableStoreOptions } from "./price-table-store.js";

// The operator's paths on the meter, exported for the budget CLI and reached by
// nothing in the server. See the header of ./budget-admin.ts.
export { channelDays, pruneTurnReports, readChannelSpend, resetChannel } from "./budget-admin.js";

// The audit log. Append-only, and required by every composition — see the
// `audit` field on `ProxyServerOptions`. `AuditDb` can close the file and
// `AuditWriter` cannot, which is the whole reason both exist.
export { AUDIT_SCHEMA_VERSION, openAuditDb } from "./audit-db.js";
export type { AuditDb, AuditDbOptions } from "./audit-db.js";
export { canonicalJson, createSqliteAuditWriter, hashArguments, openAuditWriter } from "./audit-log.js";
export type { AuditWriter, AuditWriterOptions } from "./audit-log.js";

// The audit log's read path, exported for the audit CLI and reached by nothing
// in the server — the same shape `budget-admin` has above, enforced the same
// way: an ESLint rule bans this name by `importNames` in the serving
// composition root. Reading the log is an operator concern; the serving path
// writes.
export { openAuditReader } from "./audit-db.js";
export type { AuditEntry, AuditQuery, AuditReader, AuditReaderOptions } from "./audit-db.js";

export { createHttpDispatcher } from "./http-dispatcher.js";
export type { HttpDispatcher, HttpDispatcherOptions } from "./http-dispatcher.js";

// The MCP client and its pool are deliberately **not** exported, for the reason
// `credentialHeader` and `injectCredential` are not: a client is a thing that
// sends a credential-bearing request. The only way to obtain one is through a
// pool, and the only thing that holds a pool is the dispatcher that resolved
// the credential against the vault. An exported client — or an exported pool
// factory — would be a second way to open an authenticated connection to an
// upstream, outside the one place that knows whether a sheet authorized it, and
// `server.ts` is careful never to hold such an object. Their tests import them
// from ./mcp-client.js and ./mcp-pool.js directly.
//
// `ToolCatalog` does not weaken that. It is a method on the object the
// dispatcher factory built — still the only thing holding a `Vault` and a pool
// — rather than a second way to obtain a client, and the interface has no
// method that opens anything. `createMcpCatalog` is not exported either, for
// the same reason `createSpendRoute` is not: it takes a lease on a client, and
// a composition root that could build its own would be one that could hand it
// something wider.
//
// **No protocol constant leaves this package, because none is ours to publish.**
// The revision is the SDK's since #188, and a re-exported version string would
// be a second place for it to be true — which is how a proxy comes to claim one
// revision in a log line and speak another on the wire.

// The fake upstream, exported for the e2e suite on the argument stub-slack.ts
// makes: one recording upstream that the client's own tests already keep honest
// beats a second one written against the same spec. It is the exception to the
// paragraph above rather than a hole in it — a server, holding no vault, no
// pool, and no client, which is what that rule is about.
export { completeListResult, completeResult, startFakeMcpServer } from "./mcp-fake-server.js";
export type {
  FakeCatalogTool,
  FakeMcpServer,
  FakeMcpServerOptions,
  FakeReply,
  FakeRequest
} from "./mcp-fake-server.js";

// `credentialHeader` and `injectCredential` are deliberately **not** exported.
// They take a revealed credential value, and exporting them would make it
// possible to attach one to a request without going through `callUpstream` —
// which is also the function that redacts the response. Keeping them module-
// private is what makes "everything that sends a credential also scrubs the
// reply" true by construction rather than by convention. Their tests import
// them from ./outbound.js directly.
export {
  DEFAULT_UPSTREAM_RESPONSE_BYTES,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  UpstreamError,
  callUpstream,
  destinationHost
} from "./outbound.js";
export type { AuthScheme, UpstreamFailure, UpstreamRequest, UpstreamResponse } from "./outbound.js";

export { RedactionError, redactSecrets, redactionMarker } from "./redact.js";
export type { RedactionFailure, SecretValue } from "./redact.js";

export { loadTlsOptions } from "./tls.js";
export type { ProxyTlsPaths } from "./tls.js";

export { CHANNEL_CN_PREFIX, channelFromCommonName, matchesPin, resolveChannel } from "./identity.js";
export type { ChannelIdentity, CommonNameIdentity, IdentityRejection } from "./identity.js";

export {
  DESTRUCTIVE_VERBS,
  decide,
  decideFromState,
  isDestructiveName,
  permittedToolSources,
  permittedToolSourcesFromState,
  permittedTools,
  permittedToolsFromState,
  resolveApproval,
  upstreamKey
} from "./enforce.js";
export type { BudgetSpend, CallLimits, Decision, EnforcementInput, PermittedToolSource } from "./enforce.js";

// The approval broker's ticket store. `createApprovalsRoute` is deliberately
// **not** exported, as `createSpendRoute` is not: both are composed inside
// `createProxyServer`, and a composition root that could build its own would be
// one that could hand it a wider store than `ApprovalDecider`.
export {
  APPROVAL_TTL_MS,
  MAX_TICKETS_PER_CHANNEL,
  TICKET_RETENTION_MS,
  createApprovalStore
} from "./approvals.js";
export type {
  ApprovalDecider,
  ApprovalMinter,
  ApprovalRedeemer,
  ApprovalStore,
  ApprovalStoreOptions,
  ApprovalTicketRecord,
  DecideResult,
  RedeemResult
} from "./approvals.js";

export { SHEET_FILENAME, TeamSheetStore } from "./team-sheet-store.js";
export type { SheetState, TeamSheetStoreOptions } from "./team-sheet-store.js";

export { createJsonLogger, createSilentLogger } from "./log.js";
export type { LogFields, Logger, LogLevel } from "./log.js";

export {
  MAX_VAULT_BYTES,
  VAULT_KEY_BYTES,
  VaultError,
  openVault,
  parseVaultKey
} from "./vault.js";
export type { CredentialLookup, Secret, Vault, VaultFailure, VaultKey, VaultKeyParse, VaultOptions } from "./vault.js";

// The write path is exported for the operator's CLI and reached by nothing in
// the server. See the header of ./vault-file.ts.
export {
  MAX_SECRET_BYTES,
  VaultEntryError,
  readVaultEntries,
  removeEntry,
  setEntry,
  writeVaultEntries
} from "./vault-file.js";
export type { EntryRejection, VaultEntries } from "./vault-file.js";
