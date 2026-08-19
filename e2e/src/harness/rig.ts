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
// the sheets, the vault, and the token store beside it. So: certificates,
// upstream, sheets, vault, grants, proxy, agent. Grants land before the spawn
// so the proxy's startup line is `token_store_opened` and the first mint finds
// one. Nothing here can be reordered for tidiness.
//
// **One string appears in three places** and they must all agree: the channel
// id is the client certificate's subject and filename, the directory holding
// that channel's sheet, and the `channelId` on the mention the stub delivers.
// Only the certificate is authoritative — the proxy reads the channel off the
// peer certificate and will read it from nowhere else — so a mismatch shows up
// as `no_team_sheet` rather than as anything that names the real cause.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeCatalogTool, FakeMcpServer } from "@getlibero/proxy";
import type { ProxyTransport } from "@getlibero/agent";
import type { Scheduler } from "@getlibero/gateway";
import { CANARY, CANARY_CREDENTIAL, surface } from "./canary.js";
import type { Surface } from "./canary.js";
import { createCleanup, guarded } from "./cleanup.js";
import type { Cleanup } from "./cleanup.js";
import { constantEmbeddings } from "./embedding.js";
import type { ConstantEmbeddings } from "./embedding.js";
import type { BackgroundPass } from "./passes.js";
import { mintCerts } from "./certs.js";
import type { Certs } from "./certs.js";
import { tempChannelsRoot } from "./channels.js";
import type { ChannelsRoot, SheetSpec } from "./channels.js";
import { scriptedModel } from "./model.js";
import type { ModelTurnHook, ScriptTurn, ScriptedModel } from "./model.js";
import { plantGrants } from "./grant.js";
import type { GrantSpec } from "./grant.js";
import { spawnProxy } from "./proxy-process.js";
import type { ProxyEnv, ProxyProcess } from "./proxy-process.js";
import { startAgent } from "./agent.js";
import type { AgentSide } from "./agent.js";
import { startUpstream } from "./upstream.js";
import type { UpstreamOptions } from "./upstream.js";
import {
  mutatingResubmission,
  replayingSpendReports,
  unmodelledSpendReports,
  withoutSpendReports
} from "./transport.js";
import { writeVault } from "./vault.js";

/** The channel every case uses unless it needs a second. Slack-shaped, as production is. */
export const CHANNEL = "C024BE91L";
/** A second channel, for the cases that need one with a different sheet or none. */
export const OTHER_CHANNEL = "C7ZZZ9999";

/**
 * A price table, from dollars per million *input* tokens.
 *
 * The other three tiers are derived at the example table's ratios rather than
 * taken as arguments, because no case here is about the ratios — the one that is
 * about tiers asserts on cache reads specifically and reads the ratio from this
 * comment. Output at 5x input, cache write at 1.25x, cache read at 0.1x.
 *
 * Dollars in, micro-USD out: the file wants integers, and writing `3` reads as
 * the price it is where `3_000_000` reads as an amount of something.
 */
function priceTableToml(prices: Readonly<Record<string, number>>): string {
  return Object.entries(prices)
    .map(([id, usdPerMtok]) => {
      const micro = Math.round(usdPerMtok * 1_000_000);
      return [
        `[[model]]`,
        `id = "${id}"`,
        `input = ${micro}`,
        `output = ${micro * 5}`,
        `cache_write = ${Math.round(micro * 1.25)}`,
        `cache_read = ${Math.round(micro * 0.1)}`,
        ``
      ].join("\n");
    })
    .join("\n");
}

export interface RigOptions {
  /** Channel ids to mint certificates for. Defaults to the two above. */
  readonly channels?: readonly string[];
  /** Extra `label=CN` certificates, for the stolen-identity cases. */
  readonly rawCns?: readonly string[];
  /**
   * Extra vault entries, beside the canary, by credential name.
   *
   * There is exactly one caller and it is `github-live.test.ts`, which plants a
   * real GitHub token so a sheet can point at `api.githubcopilot.com` instead of
   * at the loopback fake. Every other case should plant the canary and nothing
   * else — see canary.ts on why a leak scan with no positive control is
   * vacuous. The live case has a control of its own: GitHub answers 401 without
   * the token, so a result carrying real repository data is proof the vault
   * resolved.
   *
   * The canary is always present and cannot be displaced by a name collision,
   * because it is merged last.
   */
  readonly credentials?: Readonly<Record<string, string>>;
  /**
   * OAuth grants to plant in the token store beside the vault, by credential
   * name. The refresh token planted should be `REFRESH_CANARY`, under
   * `credentials`' rule — it is a secret the suite then proves reaches only
   * the issuer's token endpoint. The issuer's url is not the rig's to know
   * (a test starts the fake issuer first, because the sheet's `auth.issuer`
   * needs the same string), so unlike sheets there is nothing here to fill in.
   */
  readonly grants?: Readonly<Record<string, GrantSpec>>;
  /**
   * Sheets to write before the proxy starts, by channel id.
   *
   * The upstream's url is filled in by the rig, so a spec omits it — see
   * `SheetInput`. A channel with a certificate and no entry here has no sheet,
   * which is exactly the "retired channel" case. Revoking one leaked key while
   * the channel keeps working is `SheetSpec.pins` (#79).
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
   * `PROXY_UPSTREAM_TIMEOUT_MS` for the spawned proxy. Set only by the case
   * about a hanging token endpoint, whose claim — `unavailable` within the
   * call's budget — is about this number; left absent everywhere else so the
   * suite's other fixtures keep the deployment default.
   */
  readonly upstreamTimeoutMs?: number;
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
   * Which background passes this rig composes (#308).
   *
   * Absent everywhere else, and that absence is why every other file in this
   * suite still passes: the four fire from the message ingest on an ordinary
   * `deliverMessage`, two of them are model turns, and a rig that quietly had
   * them would consume script entries in four files written before any of them
   * existed. Turning one on is what a case about that pass does — `dailyUsd`'s
   * rule, with a louder failure if it is broken.
   *
   * **Name only the pass under test.** They queue on one session mutex in the
   * order `ingest.ts` fires them, so a rig with all four is a rig where a case's
   * assertion sits behind three other writers to the same directory.
   */
  readonly passes?: readonly BackgroundPass[];
  /**
   * The clock those passes read, and nothing else reads (#308).
   *
   * A third clock beside `now`, which reaches the approval prompter: a pass
   * clock pinned to a fixed instant would freeze a card's expiry with it.
   *
   * **Not a fake timer, and it must not become one.** The loop's deadline is a
   * real `AbortSignal.timeout` and everything here still runs on real time. What
   * this moves is the passes' interval maps and the two date comparisons the
   * lifecycle job makes; nothing is scheduled off it.
   *
   * **Start it at `Date.now()` and only ever add.** The store's other writers
   * are on the real clock — the ingest stamps `at`, retrieval stamps
   * `last_used_at` — and a pass clock set to a fiction would compare a lifecycle
   * threshold against a stamp from the future.
   */
  readonly passClock?: () => number;
  /**
   * Whether this rig composes the ambient clock and the heartbeat (#321).
   *
   * Off by default, on `passes`' terms and for a sharper reason: what ambient
   * does is *speak in a channel nobody addressed*, so a rig that acquired one by
   * accident would be a suite whose cases post messages they never asked for and
   * consume script entries written before ambient existed.
   *
   * It is one switch rather than a list because there is one thing to compose.
   * A channel still needs `[ambient] enabled = true` on its sheet — the two
   * together are what make "a channel that never opted in sees nothing"
   * assertable, since only a rig with the wiring present can show the sheet is
   * what withheld it.
   *
   * `passClock` reaches the heartbeat when both are set, which is deliberate:
   * the heartbeat's idle threshold is a comparison against the same clock the
   * quiescence sweep's is, and a case driving one is driving the other.
   */
  readonly ambient?: boolean;
  /**
   * How this rig embeds, or absent for the deployment that configured nothing.
   *
   * `"constant"` is the one fake there is: the same vector for every text, so it
   * ranks nothing and cannot be mistaken for a demonstration that retrieval
   * found the right skill. See harness/embedding.ts for the rule that comes with
   * it and for the one claim it exists to make.
   *
   * A string union rather than a boolean, matching `approvals` and
   * `spendReports`, because a case wanting a different fake shape should name it
   * rather than negotiate with a boolean. Absent is today's behaviour and a
   * deployment the team sheet documents.
   */
  readonly embedding?: "constant";
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
  readonly spendReports?: "sent" | "dropped" | "replayed" | "unmodelled";
  /**
   * The price table this rig's proxy runs with (#62), as `{ model: dollars per
   * million input tokens }` — the one tier the dollar cases need, with the
   * others derived from it at the ratios the example table uses.
   *
   * Absent means `PROXY_PRICE_TABLE` is unset, which is the deployment that has
   * no prices. That is the default on purpose: every case in this suite that is
   * not about a dollar cap keeps the behaviour it had before prices existed, and
   * a rig that quietly had a table would hide a sheet accidentally gaining a
   * `daily_usd`.
   */
  readonly prices?: Readonly<Record<string, number>>;
  /**
   * Whether this front-end has anywhere to put an approval card.
   *
   * `"none"` composes with no prompter — the documented degraded mode, where a
   * held call is relayed to the model as a refusal and nothing runs.
   */
  readonly approvals?: "cards" | "none";
  /**
   * The workspace's directory, as ids to names, for the assembled transcript.
   *
   * Left unset by every case that is not about attribution: an author with no
   * entry renders as their id, which is a readable transcript and a real state
   * — a user who has left the workspace.
   */
  readonly users?: Record<string, string>;
  /**
   * What the agent re-submits once a held call has been decided.
   *
   * The client re-sends the identical body plus the ticket, so anything else is
   * a compromised agent and lives on the wire — see harness/transport.ts. Given
   * `{ arguments }`, the re-submission carries those instead, which is the
   * approve-then-mutate attack: a human looked at one call and the agent sent
   * another.
   */
  readonly resubmission?: "identical" | { readonly arguments: Record<string, unknown> };
}

/** A sheet spec with the url left to the rig, since only it knows one. */
export type SheetInput = Omit<SheetSpec, "url"> & { readonly url?: string };

export interface Rig {
  readonly channelsRoot: ChannelsRoot;
  readonly upstream: FakeMcpServer;
  /** The live process — after `restartProxy` this is the successor, so read it fresh rather than destructuring once across a restart. */
  readonly proxy: ProxyProcess;
  /**
   * Kills the proxy and spawns a successor on the same port, against the same
   * sheets, vault, token store and databases.
   *
   * The port is pinned rather than re-picked because the agent's transport
   * captured `proxy.url` at composition; everything durable — the rotated
   * refresh token in `tokens.enc` above all — is what a case calls this to
   * prove survived a real process death.
   */
  restartProxy(): Promise<void>;
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
   * `AGENT_STORE_ROOT` — one `<channel>/store.db` per channel that has a sheet.
   *
   * Read it with a `node:sqlite` handle of your own. There is deliberately no
   * helper: the store is the agent side's and reading it through
   * `@getlibero/memory` would prove the writer and the reader agree rather than
   * that a row is in the file.
   */
  readonly storeRoot: string;
  /**
   * The fake embedding provider, when this rig composed one (#308).
   *
   * `null` when `RigOptions.embedding` was absent, which is the deployment that
   * configured none. `texts()` is a leak surface — what reaches an embedding
   * provider has left this process — and it is the only place a skill *body*
   * could appear if the embedding pass ever stopped sending only descriptions.
   */
  readonly embeddings: ConstantEmbeddings | null;
  /**
   * Every surface the canary must not be on, as of now.
   *
   * Called at assertion time rather than held, because three of the five grow
   * as the task runs. Pass the result to `expectNoCanary`.
   */
  surfaces(): Surface[];
  /**
   * Fires exactly one heartbeat over every enabled channel, at `at`.
   *
   * Two scans, not one, and that is the scheduler's rule showing through rather
   * than this helper being clever: **first sight never fires**, so a channel
   * newly seen enabled is scheduled at `now + cadence` and the scan that saw it
   * does nothing. The first call here is that sighting; the second is `at`
   * itself, which must be past the channel's cadence for the deadline to have
   * come due.
   *
   * Answers how many channels fired, so a case asserting "nothing was due" reads
   * as that rather than as an absence of log lines.
   *
   * A case wanting a *second* heartbeat calls this again at a later instant; the
   * schedule is already seeded by then, so the extra sighting scan is a no-op.
   */
  heartbeat(at: number): Promise<number>;
  /**
   * Runs every check due at `at`, and answers how many ran (#324).
   *
   * **One scan, not two, and that is the difference from `heartbeat` above.**
   * That one scans twice because the scheduler's first sight of a channel
   * schedules it and fires nothing — a deadline it invented cannot already have
   * passed. A ticket's instant is on disk before the scan starts, so the first
   * scan past it fires, and a sighting scan would only give a case a second
   * chance to be wrong about when.
   *
   * At most one per channel per scan, earliest first. A case with several due
   * together calls this again.
   */
  check(at: number): Promise<number>;
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

/**
 * The wire decorators this rig's options ask for, as one wrapper.
 *
 * Composed rather than chosen, so two knobs set at once both apply — a case
 * that wants an agent which both mutates a re-submission and reports no spend
 * gets an agent that does both, rather than whichever branch happened to be
 * written last. Each is a distinct kind of misbehaviour and none of them knows
 * about the others.
 */
function transportWrapper(options: RigOptions): ((inner: ProxyTransport) => ProxyTransport) | undefined {
  const wrappers: Array<(inner: ProxyTransport) => ProxyTransport> = [];
  if (options.spendReports === "dropped") wrappers.push(withoutSpendReports);
  if (options.spendReports === "replayed") wrappers.push(replayingSpendReports);
  if (options.spendReports === "unmodelled") wrappers.push(unmodelledSpendReports);
  if (options.resubmission !== undefined && options.resubmission !== "identical") {
    wrappers.push(mutatingResubmission(options.resubmission.arguments));
  }
  if (wrappers.length === 0) return undefined;
  return inner => wrappers.reduce((wrapped, wrap) => wrap(wrapped), inner);
}

const DEFAULT_SHEET: SheetInput = {
  credential: CANARY_CREDENTIAL,
  tools: [{ name: "list_prs", approval: "none" }]
};

export async function startRig(options: RigOptions = {}): Promise<Rig> {
  // Built before anything is acquired, so a failure half-way through leaves
  // nothing running. `guarded` drains it and rethrows the original cause.
  const cleanup: Cleanup = createCleanup();

  // A knob that silently does nothing is worse than one that is missing — the
  // premise harness-knobs.test.ts exists on. Both of these reach the background
  // passes and only them, so either without `passes` is a case believing it
  // configured something.
  if (
    options.passClock !== undefined &&
    (options.passes ?? []).length === 0 &&
    options.ambient !== true
  ) {
    throw new Error(
      "e2e: passClock reaches the background passes and the heartbeat, and this rig composes " +
        "neither — see RigOptions.passes and RigOptions.ambient"
    );
  }
  if (options.embedding !== undefined && (options.passes ?? []).length === 0) {
    throw new Error(
      "e2e: embedding reaches the background passes and this rig composes none — see RigOptions.passes"
    );
  }

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

    // Every sheet pins the certificate this rig minted for its own channel, so
    // a case that says nothing about pinning gets the identity it would have
    // had before #79 existed. `channels` is the list that got certificates;
    // anything else named in `sheets` is a channel with no key material, and
    // `defaultPinsFor` gives it a pin that matches nothing rather than one that
    // matches a certificate it does not have.
    const channelsRoot = tempChannelsRoot(cleanup, channelId =>
      channels.includes(channelId) ? [certs.fingerprint(channelId)] : []
    );
    const sheets = options.sheets ?? { [CHANNEL]: DEFAULT_SHEET };
    for (const [channelId, spec] of Object.entries(sheets)) {
      channelsRoot.write(channelId, { ...spec, url: spec.url ?? upstream.url });
    }

    // The canary last, so no caller-supplied name can displace it.
    const vault = writeVault(cleanup, { ...options.credentials, [CANARY_CREDENTIAL]: CANARY });

    // Into `tokens.enc` beside the vault, before the spawn — see the order
    // comment above. The vault directory's disposer removes it.
    if (options.grants !== undefined) {
      await plantGrants(vault, options.grants);
    }

    const dbDir = mkdtempSync(join(tmpdir(), "libero-e2e-db-"));
    cleanup.add("databases", () => rmSync(dbDir, { recursive: true, force: true }));
    const auditDb = join(dbDir, "audit.db");
    const budgetDb = join(dbDir, "budget.db");

    // Its own root, not a subdirectory of the sheets, because that is the
    // production layout: the channels directory is the proxy's authorization
    // source and is read-only to both services, and everything the agent writes
    // goes here. A case can assert nothing appeared on the other side of that
    // line.
    const storeRoot = mkdtempSync(join(tmpdir(), "libero-e2e-store-"));
    cleanup.add("message stores", () => rmSync(storeRoot, { recursive: true, force: true }));

    // Written beside the databases rather than under the channels root: a price
    // table is a deployment's, not a channel's, and putting it where sheets live
    // would suggest otherwise to whoever reads this next.
    const priceTable = options.prices === undefined ? undefined : join(dbDir, "prices.toml");
    if (priceTable !== undefined && options.prices !== undefined) {
      writeFileSync(priceTable, priceTableToml(options.prices));
    }

    // Held apart from the call so `restartProxy` spawns against the same
    // environment rather than a restatement of it.
    const proxyEnv: ProxyEnv = {
      channelsRoot: channelsRoot.path,
      vaultFile: vault.file,
      vaultKey: vault.keyBase64,
      budgetDb,
      auditDb,
      // The same directory `startAgent` gets below. One process writes it and
      // the other reads it, which is the production shape and is what makes a
      // `search_channel_history` case a real two-process claim rather than a
      // module-scope one (#64).
      storeRoot,
      ...(priceTable === undefined ? {} : { priceTable }),
      ...(options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
      tlsCert: certs.serverCert,
      tlsKey: certs.serverKey,
      tlsCa: certs.caPath
    };
    let proxy = await spawnProxy(cleanup, proxyEnv, options.nodeArgs ?? []);

    const wrapper = transportWrapper(options);
    // Built here rather than inside startAgent so a case can read what reached
    // it, and only when asked for: absent leaves every pass on `embedding: null`,
    // which is what three of the four are documented to degrade to and what the
    // fourth returns immediately on.
    const embeddings = options.embedding === undefined ? null : constantEmbeddings();

    const model = scriptedModel(options.script ?? [], options.onModelTurn);
    const agent = await startAgent(cleanup, {
      proxyUrl: proxy.url,
      caPath: certs.caPath,
      clientCertDir: certs.clientCertDir,
      channelsRoot: channelsRoot.path,
      storeRoot,
      completion: model.client,
      ...(wrapper !== undefined ? { wrapTransport: wrapper } : {}),
      ...(options.approvals === "none" ? { cards: false } : {}),
      ...(options.users !== undefined ? { users: options.users } : {}),
      ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.passes !== undefined ? { passes: options.passes } : {}),
      ...(options.ambient !== undefined ? { ambient: options.ambient } : {}),
      ...(options.passClock !== undefined ? { passClock: options.passClock } : {}),
      ...(embeddings === null ? {} : { embedding: embeddings.client })
    });

    return {
      channelsRoot,
      upstream,
      // A getter, not the value: after `restartProxy` the successor is what a
      // case's `rig.proxy.waitForLog` must reach.
      get proxy() {
        return proxy;
      },
      restartProxy: async (): Promise<void> => {
        const port = proxy.port;
        await proxy.stop();
        // The old process's cleanup entry stays on the stack and is harmless —
        // stopping an exited child is a no-op — while the successor registers
        // its own. The pinned port is what keeps the agent's captured url live.
        proxy = await spawnProxy(cleanup, { ...proxyEnv, port }, options.nodeArgs ?? []);
      },
      agent,
      model,
      certs,
      auditDb,
      budgetDb,
      storeRoot,
      embeddings,
      check: (at: number): Promise<number> => agent.check(at),
      heartbeat: async (at: number): Promise<number> => {
        // The sighting scan, whose only job is to put every enabled channel on
        // the schedule. It fires nothing — that is the point — and its instant
        // has to be far enough before `at` that the deadline it sets has come
        // due by then. A day and an hour, because `heartbeat_every_minutes` is
        // capped at 1440 in the schema, so this is past any cadence a sheet can
        // ask for rather than past the ones cases happen to use.
        await agent.heartbeat(at - 25 * 60 * 60 * 1000);
        return agent.heartbeat(at);
      },
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
