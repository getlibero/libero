// The harness, as one import.
//
// A case should reach for `startRig` and the assertion helpers and nothing
// else; the modules below are separate because they hold separate arguments,
// not because a case is meant to compose them by hand.

export { CANARY, CANARY_CREDENTIAL, expectNoCanary, surface } from "./canary.js";
export type { Surface } from "./canary.js";

export { createCleanup, guarded } from "./cleanup.js";
export type { Cleanup, Disposer } from "./cleanup.js";

export { mintCerts } from "./certs.js";
export type { Certs, MintOptions } from "./certs.js";

export { tempChannelsRoot } from "./channels.js";
export type { ChannelsRoot, SheetSpec, SheetTool } from "./channels.js";

export { calls, says, scriptedModel } from "./model.js";
export type { ScriptedModel } from "./model.js";

export { spawnProxy } from "./proxy-process.js";
export type { ProxyEnv, ProxyProcess } from "./proxy-process.js";

export { startAgent } from "./agent.js";
export type { AgentOptions, AgentSide } from "./agent.js";

export { authorizationsSeen, startUpstream } from "./upstream.js";
export type { UpstreamOptions } from "./upstream.js";

export { auditRows, lastAuditId, spendFor } from "./records.js";
export type { AuditRow } from "./records.js";

export { writeVault } from "./vault.js";
export type { PlantedVault } from "./vault.js";

export { CHANNEL, OTHER_CHANNEL, startRig } from "./rig.js";
export type { Rig, RigOptions, SheetInput } from "./rig.js";
