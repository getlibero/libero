export { createProxyServer, MAX_BODY_BYTES } from "./server.js";
export type { ProxyServerOptions, RequestContext, RouteResponse } from "./server.js";

export {
  assertServableComposition,
  createUnavailableDispatcher,
  createUnmeteredSpend
} from "./dispatch.js";
export type { Dispatch, SpendMeter, ToolDispatcher } from "./dispatch.js";

// Credential injection. `createHttpDispatcher` is a *real* dispatcher, so
// pairing it with `createUnmeteredSpend()` is a startup error until #38 lands
// a meter — see `assertServableComposition`.
export { createHttpDispatcher, toolRequestBody } from "./http-dispatcher.js";
export type { HttpDispatcherOptions } from "./http-dispatcher.js";

// `credentialHeader` and `injectCredential` are deliberately **not** exported.
// They take a revealed credential value, and exporting them would make it
// possible to attach one to a request without going through `callUpstream` —
// which is also the function that redacts the response. Keeping them module-
// private is what makes "everything that sends a credential also scrubs the
// reply" true by construction rather than by convention. Their tests import
// them from ./outbound.js directly.
export { DEFAULT_UPSTREAM_TIMEOUT_MS, UpstreamError, callUpstream, destinationHost } from "./outbound.js";
export type { AuthScheme, UpstreamFailure, UpstreamRequest, UpstreamResponse } from "./outbound.js";

export { RedactionError, redactSecrets, redactionMarker } from "./redact.js";
export type { RedactionFailure, SecretValue } from "./redact.js";

export { loadTlsOptions } from "./tls.js";
export type { ProxyTlsPaths } from "./tls.js";

export { CHANNEL_CN_PREFIX, channelFromCommonName, resolveChannel } from "./identity.js";
export type { ChannelIdentity, IdentityRejection } from "./identity.js";

export {
  DESTRUCTIVE_VERBS,
  decide,
  decideFromState,
  isDestructiveName,
  permittedTools,
  permittedToolsFromState,
  resolveApproval
} from "./enforce.js";
export type { BudgetSpend, Decision, EnforcementInput } from "./enforce.js";

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
