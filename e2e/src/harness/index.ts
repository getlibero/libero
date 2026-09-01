// The harness, as one import.
//
// A case should reach for `startRig` and the assertion helpers and nothing
// else; the modules below are separate because they hold separate arguments,
// not because a case is meant to compose them by hand.

export {
  CANARY,
  CANARY_CREDENTIAL,
  OAUTH_CREDENTIAL,
  REFRESH_CANARY,
  expectBoundSecretReachedUpstream,
  expectCanaryReachedUpstream,
  expectNoCanary,
  expectNoSecret,
  expectSecretReachedUpstream,
  surface
} from "./canary.js";
export type { Surface } from "./canary.js";

export { createCleanup, guarded } from "./cleanup.js";
export type { Cleanup, Disposer } from "./cleanup.js";

export {
  EGRESS_NETWORK,
  RUNNER_IMAGE,
  SANDBOX_IMAGE,
  dockerSocketPath,
  prepareSandboxFixtures,
  spawnRunner
} from "./runner-process.js";
export type { RunnerEnv, RunnerProcess } from "./runner-process.js";

export { mintCerts } from "./certs.js";
export type { Certs, MintOptions } from "./certs.js";

export { tempChannelsRoot } from "./channels.js";
export type { ChannelsRoot, SheetBuiltin, SheetSpec, SheetTool } from "./channels.js";

export { breakCredentialInjection, breakRedaction } from "./mutate.js";

export { startIssuer } from "./issuer.js";
export type { IssuerOptions } from "./issuer.js";

export { plantGrants } from "./grant.js";
export type { GrantSpec } from "./grant.js";

export { rawClient } from "./client.js";
export type { RawClient, RawRequest, RawResponse } from "./client.js";

export {
  SERVED_MODEL,
  TURN_TOKENS,
  calls,
  openingContexts,
  relays,
  says,
  scriptedModel,
  servedBy,
  withReportedCost,
  withUsage
} from "./model.js";
export type { ModelTurnHook, ScriptTurn, ScriptedModel } from "./model.js";

export { runAuditCli } from "./audit-cli.js";
export type { AuditCliResult } from "./audit-cli.js";

export { runBudgetCli } from "./budget-cli.js";
export type { BudgetCliResult } from "./budget-cli.js";

export { runDriftCli } from "./drift-cli.js";
export type { DriftCliResult } from "./drift-cli.js";

export { spawnProxy } from "./proxy-process.js";
export type { ProxyEnv, ProxyProcess } from "./proxy-process.js";

export { approvalCardOf, startAgent, waitForApprovalCard } from "./agent.js";
export type { AgentOptions, AgentSide } from "./agent.js";

export { authorizationsSeen, startUpstream } from "./upstream.js";
export type { UpstreamOptions } from "./upstream.js";

export { AUDIT_ROW_COLUMNS, auditColumns, auditRows, lastAuditId, spendFor } from "./records.js";
export type { AuditRow } from "./records.js";

export { mutatingResubmission, recording, replayingSpendReports, withoutSpendReports } from "./transport.js";
export type { RecordingTransport } from "./transport.js";

export { EMBED_TOKENS, constantEmbeddings } from "./embedding.js";
export type { ConstantEmbeddings } from "./embedding.js";
export { sharedSkillRoot } from "./shared-skills.js";
export type { SharedSkillFile, SharedSkillRoot } from "./shared-skills.js";

export { backgroundPasses } from "./passes.js";
export type { BackgroundPass, BackgroundPassDeps, BackgroundPassOptions } from "./passes.js";

export { writeVault } from "./vault.js";
export type { PlantedVault } from "./vault.js";

export { CHANNEL, OTHER_CHANNEL, rigOf, startRig } from "./rig.js";
export type { Rig, RigOptions, SheetInput } from "./rig.js";
