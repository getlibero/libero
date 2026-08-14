// The tool proxy process.
//
// Composition only: read the environment, build the server, listen, stop
// cleanly. Everything it does lives in @getlibero/proxy — and the environment
// rules in env.ts — where they can be tested without a process.

import {
  TeamSheetStore,
  createBuiltinDispatcher,
  createHttpDispatcher,
  createJsonLogger,
  createProxyServer,
  createSqliteSpendMeter,
  createToolDispatcher,
  loadTlsOptions,
  openAuditWriter,
  openBudgetDb,
  openPriceTableStore,
  openTokenStore,
  openVault
} from "@getlibero/proxy";
import {
  auditDbFromEnv,
  budgetDbFromEnv,
  channelsRootFromEnv,
  hostFromEnv,
  maxResponseBytesFromEnv,
  maxUpstreamConcurrencyFromEnv,
  portFromEnv,
  priceTableFromEnv,
  requiredEnv,
  storeRootFromEnv,
  upstreamTimeoutMsFromEnv,
  vaultFileFromEnv,
  vaultKeyFromEnv
} from "./env.js";

const logger = createJsonLogger();
const host = hostFromEnv(process.env);
const listenPort = portFromEnv(process.env);
const sheets = new TeamSheetStore({ root: channelsRootFromEnv(process.env), logger });

// Before anything binds. Nothing consumes a credential yet — that is #51, and
// the vault reaches the dispatcher rather than the server — but opening it here
// is what proves the operator's key and file are right at `docker compose up`
// instead of at the far end of a Slack thread once tool calls run.
const vaultFile = vaultFileFromEnv(process.env);
const vaultKey = vaultKeyFromEnv(process.env);
const vault = openVault({ file: vaultFile, key: vaultKey, logger });
logger.log("info", { event: "vault_opened", count: vault.size });

// The token store beside it (#254), under the same master key. Unlike the
// vault the key outlives this line: a rotation writes under a fresh salt, so
// the store retains the parsed key — the same buffer, zeroed on shutdown —
// which is the heap-dump concession vault.ts already makes, held longer.
// Absent is a deployment with no OAuth upstream; wrong key or corruption
// fails here, before anything binds.
const tokens = openTokenStore({ vaultFile, key: vaultKey, logger });

// Defence in depth, and worth being precise about what it does: it keeps the
// key out of anything that later dumps `process.env`, and out of the
// environment of any child process this one comes to spawn — #154's stdio
// transport is the first that would. It does *not* change /proc/<pid>/environ
// on Linux, which still reflects the environment the process started with.
delete process.env.PROXY_VAULT_KEY;

// Also before anything binds, and for the same reason as the vault: a budget
// file whose directory is missing or unwritable must be a startup failure. The
// alternative fails *open* — a proxy that cannot record spend is a proxy whose
// hard limits never bite — and it would do so silently.
const budget = openBudgetDb({ file: budgetDbFromEnv(process.env), logger });

// The price table, if this deployment has one (#62). Opened here so the digest
// is in the startup log and an operator can tie a running proxy's prices to a
// commit in whatever repository they keep the file in.
//
// **Absent is not a startup failure**, unlike the three files above, because a
// workspace that caps only tokens and tool calls legitimately has no prices —
// and unlike them, absent fails closed rather than open: every model is unpriced
// and a channel with `budget.daily_usd` set is refused. See `priceTableFromEnv`.
//
// Read once per decision rather than at startup, so a corrected price re-prices
// today's spend on a channel's next call — the same freshness a team sheet edit
// already has, and the reason the meter stores raw counts rather than a total.
const prices = openPriceTableStore({ file: priceTableFromEnv(process.env), logger });

// And the audit log, before anything binds, for a reason the route depends on:
// a failed audit write refuses the call it could not record. Opening the file
// here turns a missing directory, a read-only mount and a schema from the future
// into startup failures, which is where nearly all of that risk lives — leaving
// the route to handle only the disk that fills while it is serving.
const { writer: audit, db: auditDb } = openAuditWriter({ file: auditDbFromEnv(process.env), logger });

// Hoisted out of the composition below because shutdown needs a handle on it.
// The dispatcher owns the MCP client pool; `createProxyServer` takes the narrow
// `ToolDispatcher` and never learns there is one.
//
// It also fills `ToolCatalog`, which is why it appears twice below. One object,
// two seams, on purpose: the listing route closes over the interface that can
// only describe, and the gate over the one that can run — so a route that asks
// an upstream what it offers has no method that calls anything. Passing the
// same object to both is what keeps the credential path single, since this is
// still the only thing in the process holding a vault and a client pool.
//
// `maxResponseBytes` is read here rather than resolved per call, because it is
// the deployment's rather than a channel's: it bounds this process's heap, which
// every channel shares. The channel's own bound on a result rides on each
// decision instead. See `maxResponseBytesFromEnv`.
//
// `maxUpstreamConcurrency` is read here for that reason and one more: it bounds
// what this process spends against a single upstream, which no channel owns and
// several may name at once (#159).
//
// `timeoutMs` is spread in only when set: `undefined` and "absent" are two
// different statements to `exactOptionalPropertyTypes`, and absent is the one
// that means "the package's default applies". See `upstreamTimeoutMsFromEnv`.
const upstreamTimeoutMs = upstreamTimeoutMsFromEnv(process.env);
const mcp = createHttpDispatcher({
  vault,
  tokens,
  logger,
  maxResponseBytes: maxResponseBytesFromEnv(process.env),
  maxUpstreamConcurrency: maxUpstreamConcurrencyFromEnv(process.env),
  ...(upstreamTimeoutMs === undefined ? {} : { timeoutMs: upstreamTimeoutMs })
});

// The other arm, and it holds a directory path where the one above holds a
// vault and a client pool (#64). Neither can reach the other's: the composite
// below is what narrows a `Target`, so the arm that dials upstreams is never
// handed a built-in and the arm that reads a channel's messages is never handed
// an upstream.
//
// The store root is the same directory the gateway writes under, mounted into
// this service as well. Every file is opened `readOnly` and per call — see
// `storeRootFromEnv` and `openMessageReader` — so there is nothing here for
// shutdown to close.
const builtin = createBuiltinDispatcher({ storeRoot: storeRootFromEnv(process.env), logger });

const server = createProxyServer({
  tls: loadTlsOptions({
    cert: requiredEnv(process.env, "PROXY_TLS_CERT"),
    key: requiredEnv(process.env, "PROXY_TLS_KEY"),
    ca: requiredEnv(process.env, "PROXY_TLS_CA")
  }),
  sheets,
  // Both real. Enforcement decides, the meter counts, and the dispatcher
  // serves — so a permitted call is answered rather than met with a 501.
  //
  // `assertServableComposition` still runs inside `createProxyServer` and still
  // guards the pairing it always guarded: a dispatcher that really serves calls
  // alongside a meter that can never exhaust a budget. There is no such meter in
  // the tree today, which is exactly why the check is worth keeping — the seams
  // that land next arrive before their implementations do.
  spend: createSqliteSpendMeter({ db: budget, logger }),
  // Consulted only by a channel whose sheet sets `[budget] daily_usd`; every
  // other channel is decided exactly as it was before prices existed.
  prices,
  dispatcher: createToolDispatcher({ mcp, builtin }),
  // The MCP arm, not the composite: `ToolCatalog.describe` asks an *upstream*
  // what it offers, and a built-in has nobody to ask — the listing route reads
  // its definition from `BUILTIN_TOOLS` instead.
  catalog: mcp,
  // The writer, not the handle: the serving process appends and cannot close
  // the file it is being audited into. `auditDb` stays here, where shutdown is.
  audit,
  logger
});

server.listen(listenPort, host, () => {
  // The bound port, not the configured one. They differ whenever PROXY_PORT is
  // 0 — where the whole point is to learn what the OS chose — and a line that
  // reported the request rather than the result would be a log that lies in the
  // one case anybody reads it for.
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : listenPort;
  logger.log("info", { event: "listening", host, port });
});

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) {
      // A second signal is an operator done waiting. Without this, one hung
      // keep-alive socket holds the process open until something sends
      // SIGKILL. It now also covers a session-termination `DELETE` to an
      // upstream that black-holes packets — which the termination budget below
      // already bounds, so this stays the path nobody should need.
      //
      // The budget and audit databases are left unclosed here, and that is safe
      // rather than overlooked: both commit with `synchronous = FULL`, so every
      // count and every row either of them acknowledged is already on disk. The
      // same is true of a SIGKILL or a host crash, which is why that pragma was
      // chosen.
      process.exit(1);
    }
    closing = true;
    logger.log("info", { event: "shutting_down", reason: signal });
    // Releases the per-channel file watchers; without it the process can stay
    // alive on them after the listener has closed.
    sheets.close();
    // Stops accepting connections and waits for in-flight requests — which is
    // what gives a tool call in flight a chance to finish rather than being cut
    // mid-call. Both files close in the callback, after those requests have
    // finished writing to them, and not before.
    server.close(() => {
      // After the in-flight requests, so a call that was mid-flight kept its
      // client. Closing refuses to hand out more of them, and sends one
      // session-termination `DELETE` per legacy upstream — concurrently, each
      // capped at the proxy's own short termination budget, so the whole pass
      // costs one timeout rather than one per upstream. A stateless upstream
      // has nothing to terminate and adds nothing to it.
      //
      // `.finally` rather than `.then`: the two databases close and the process
      // exits whatever the terminations did. `void` marks the floating promise
      // as deliberate — this callback is not async, and making it async would
      // produce the same floating promise with more to read.
      void mcp.close().finally(() => {
        budget.close();
        auditDb.close();
        prices.close();
        // Last, after the pool's sessions are gone: nothing can need a token
        // any more, and this is the line that zeroes the master key.
        tokens.close();
        process.exit(0);
      });
    });
  });
}
