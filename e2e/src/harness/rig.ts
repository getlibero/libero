// Both halves, composed.
//
// One call stands up: a certificate authority and per-channel client
// certificates, a recording MCP upstream, a temporary channels root holding
// real team sheets, a vault with a planted canary, empty audit and budget
// databases, the proxy as a spawned process over real mutual TLS, and the
// production agent composition in this process driving a stub Slack and a
// scripted model.
//
// **The order below is load-bearing.** A sheet names the upstream's url, and
// the url is not known until the upstream has bound a port; the proxy reads
// both the sheets and the vault. So: certificates, upstream, sheets, vault,
// proxy, agent. Nothing here can be reordered for tidiness.
//
// **One string appears in three places** and they must all agree: the channel
// id is the client certificate's subject and filename, the directory holding
// that channel's sheet, and the `channelId` on the mention the stub delivers.
// Only the certificate is authoritative — the proxy reads the channel off the
// peer certificate and will read it from nowhere else — so a mismatch shows up
// as `no_team_sheet` rather than as anything that names the real cause.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeCatalogTool, FakeMcpServer } from "@getlibero/proxy";
import type { Scheduler } from "@getlibero/gateway";
import { CANARY, CANARY_CREDENTIAL, surface } from "./canary.js";
import type { Surface } from "./canary.js";
import { createCleanup, guarded } from "./cleanup.js";
import type { Cleanup } from "./cleanup.js";
import { mintCerts } from "./certs.js";
import type { Certs } from "./certs.js";
import { tempChannelsRoot } from "./channels.js";
import type { ChannelsRoot, SheetSpec } from "./channels.js";
import { scriptedModel } from "./model.js";
import type { ModelTurnHook, ScriptTurn, ScriptedModel } from "./model.js";
import { spawnProxy } from "./proxy-process.js";
import type { ProxyProcess } from "./proxy-process.js";
import { startAgent } from "./agent.js";
import type { AgentSide } from "./agent.js";
import { startUpstream } from "./upstream.js";
import type { UpstreamOptions } from "./upstream.js";
import { replayingSpendReports, withoutSpendReports } from "./transport.js";
import { writeVault } from "./vault.js";

/** The channel every case uses unless it needs a second. Slack-shaped, as production is. */
export const CHANNEL = "C024BE91L";
/** A second channel, for the cases that need one with a different sheet or none. */
export const OTHER_CHANNEL = "C7ZZZ9999";

export interface RigOptions {
  /** Channel ids to mint certificates for. Defaults to the two above. */
  readonly channels?: readonly string[];
  /** Extra `label=CN` certificates, for the stolen-identity cases. */
  readonly rawCns?: readonly string[];
  /**
   * Sheets to write before the proxy starts, by channel id.
   *
   * The upstream's url is filled in by the rig, so a spec omits it — see
   * `SheetInput`. A channel with a certificate and no entry here has no sheet,
   * which is exactly the "revoked channel" case.
   */
  readonly sheets?: Readonly<Record<string, SheetInput>>;
  /** What the upstream publishes from `tools/list`. Shorthand for `upstream.catalog`. */
  readonly catalog?: readonly FakeCatalogTool[];
  /**
   * The fake upstream's own options — `echoHeaders`, `hangOn`, `pageSize`, and
   * the rest of `FakeMcpServerOptions`. `catalog` above wins if both set it.
   */
  readonly upstream?: UpstreamOptions;
  /**
   * Extra arguments for the spawned proxy's `node`, before the entrypoint.
   *
   * The seam a mutation case needs: `["--import", hook]` registers a module
   * loader hook inside the proxy process, which is the only way to break one of
   * its passes from out here — the proxy is a separate process and its imports
   * are ESM bindings, so nothing in this process can reach them.
   */
  readonly nodeArgs?: readonly string[];
  /**
   * The model's turns, in order. Running past the end throws.
   *
   * An entry is usually a constant — `calls`, `says` — and may be a function of
   * the request when the answer depends on what the model was handed, which is
   * what `relays` is.
   */
  readonly script?: readonly ScriptTurn[];
  /**
   * Fired as the model is asked for each turn, with the 1-based turn number.
   *
   * The ordering seam: the loop lists tools before its first turn, so a hook
   * on turn 1 lands between the listing and the call the answer provokes. That
   * is how a case rewrites a team sheet after the listing carried a tool and
   * before the proxy judges the call — see `ModelTurnHook`.
   */
  readonly onModelTurn?: ModelTurnHook;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  /**
   * How the agent reports token spend to the proxy.
   *
   * Both departures from `"sent"` are compromised agents rather than
   * configurations — they interfere with the wire, see harness/transport.ts.
   * `"dropped"` swallows `/v1/spend`, which makes the narrow claim testable:
   * `daily_tool_calls` is the proxy's own count and must still bite when
   * `daily_tokens` never moves. `"replayed"` sends each report twice, which is
   * the opposite failure — the turn id is the idempotency key, so the second
   * copy must move no counter.
   */
  readonly spendReports?: "sent" | "dropped" | "replayed";
  /**
   * Whether this front-end has anywhere to put an approval card.
   *
   * `"none"` composes with no prompter — the documented degraded mode, where a
   * held call is relayed to the model as a refusal and nothing runs.
   */
  readonly approvals?: "cards" | "none";
}

/** A sheet spec with the url left to the rig, since only it knows one. */
export type SheetInput = Omit<SheetSpec, "url"> & { readonly url?: string };

export interface Rig {
  readonly channelsRoot: ChannelsRoot;
  readonly upstream: FakeMcpServer;
  readonly proxy: ProxyProcess;
  readonly agent: AgentSide;
  readonly model: ScriptedModel;
  /**
   * The mutual-TLS material, for a case that has to make its own request.
   *
   * Two things the agent's transport cannot do, and both are #133's: it will
   * not send a `channel` field — `ToolCall` is strict, so a body carrying one
   * is refused rather than stripped — and it will not present a certificate
   * whose CN disagrees with the channel it was asked for. A case that needs
   * either builds a `node:https` request against `proxy.url` with these paths,
   * which is the only way to attack identity resolution from outside.
   */
  readonly certs: Certs;
  /** `PROXY_AUDIT_DB` — read it with `auditRows` / `lastAuditId`. */
  readonly auditDb: string;
  /** `PROXY_BUDGET_DB` — read it with `spendFor`. */
  readonly budgetDb: string;
  /**
   * Every surface the canary must not be on, as of now.
   *
   * Called at assertion time rather than held, because three of the five grow
   * as the task runs. Pass the result to `expectNoCanary`.
   */
  surfaces(): Surface[];
  stop(): Promise<void>;
}

/**
 * The rig, or a failure that says the useful thing.
 *
 * `beforeAll` assigns and a case reads, which is a `Rig | undefined` no matter
 * how confident the case is. Left alone, a setup that threw produces a
 * `TypeError: Cannot read properties of undefined` in every case *and* in
 * `afterAll`, three lines below the real cause and looking nothing like it.
 *
 * Pair it with `await rig?.stop()` in `afterAll`, which is the other half:
 * tearing down something that never started is not an error.
 */
export function rigOf(rig: Rig | undefined): Rig {
  if (rig === undefined) {
    throw new Error("e2e: the rig did not start — the setup failure above is the real one");
  }
  return rig;
}

const DEFAULT_SHEET: SheetInput = {
  credential: CANARY_CREDENTIAL,
  tools: [{ name: "list_prs", approval: "none" }]
};

export async function startRig(options: RigOptions = {}): Promise<Rig> {
  // Built before anything is acquired, so a failure half-way through leaves
  // nothing running. `guarded` drains it and rethrows the original cause.
  const cleanup: Cleanup = createCleanup();

  return guarded(cleanup, async () => {
    const channels = options.channels ?? [CHANNEL, OTHER_CHANNEL];
    const certs = mintCerts(cleanup, {
      channels,
      ...(options.rawCns !== undefined ? { rawCns: options.rawCns } : {})
    });

    const upstream = await startUpstream(cleanup, {
      ...options.upstream,
      ...(options.catalog !== undefined ? { catalog: options.catalog } : {})
    });

    const channelsRoot = tempChannelsRoot(cleanup);
    const sheets = options.sheets ?? { [CHANNEL]: DEFAULT_SHEET };
    for (const [channelId, spec] of Object.entries(sheets)) {
      channelsRoot.write(channelId, { ...spec, url: spec.url ?? upstream.url });
    }

    const vault = writeVault(cleanup, { [CANARY_CREDENTIAL]: CANARY });

    const dbDir = mkdtempSync(join(tmpdir(), "libero-e2e-db-"));
    cleanup.add("databases", () => rmSync(dbDir, { recursive: true, force: true }));
    const auditDb = join(dbDir, "audit.db");
    const budgetDb = join(dbDir, "budget.db");

    const proxy = await spawnProxy(cleanup, {
      channelsRoot: channelsRoot.path,
      vaultFile: vault.file,
      vaultKey: vault.keyBase64,
      budgetDb,
      auditDb,
      tlsCert: certs.serverCert,
      tlsKey: certs.serverKey,
      tlsCa: certs.caPath
    }, options.nodeArgs ?? []);

    const model = scriptedModel(options.script ?? [], options.onModelTurn);
    const agent = await startAgent(cleanup, {
      proxyUrl: proxy.url,
      caPath: certs.caPath,
      clientCertDir: certs.clientCertDir,
      channelsRoot: channelsRoot.path,
      completion: model.client,
      ...(options.spendReports === "dropped" ? { wrapTransport: withoutSpendReports } : {}),
      ...(options.spendReports === "replayed" ? { wrapTransport: replayingSpendReports } : {}),
      ...(options.approvals === "none" ? { cards: false } : {}),
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
      ...(options.now !== undefined ? { now: options.now } : {})
    });

    return {
      channelsRoot,
      upstream,
      proxy,
      agent,
      model,
      certs,
      auditDb,
      budgetDb,
      surfaces: (): Surface[] => [
        surface("a thread reply", agent.slack.posted),
        // Cards render the model's own tool arguments, so a credential the model
        // was handed and echoed back would surface here even though nothing in
        // the card path ever touched the vault.
        surface("an approval card", [...agent.slack.cards, ...agent.slack.edits]),
        // The transcript is where a leaked credential actually lands: a tool
        // result carrying one becomes a `tool` message on the very next turn.
        surface("the model's transcript", model.seen),
        surface("an agent log line", agent.log()),
        // Not agent-visible, so not a leak in the same sense — but a credential
        // in the proxy's own output is a LogFields discipline failure, and this
        // is the only place that would catch it.
        surface("the proxy's output", proxy.log())
      ],
      stop: () => cleanup.drain()
    };
  });
}
