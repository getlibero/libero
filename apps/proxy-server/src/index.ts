// The tool proxy process.
//
// Composition only: read the environment, build the server, listen, stop
// cleanly. Everything it does lives in @getlibero/proxy — and the environment
// rules in env.ts — where they can be tested without a process.

import {
  TeamSheetStore,
  createHttpDispatcher,
  createJsonLogger,
  createProxyServer,
  createSqliteSpendMeter,
  loadTlsOptions,
  openAuditWriter,
  openBudgetDb,
  openVault
} from "@getlibero/proxy";
import {
  auditDbFromEnv,
  budgetDbFromEnv,
  channelsRootFromEnv,
  hostFromEnv,
  portFromEnv,
  requiredEnv,
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
const vault = openVault({
  file: vaultFileFromEnv(process.env),
  key: vaultKeyFromEnv(process.env),
  logger
});
logger.log("info", { event: "vault_opened", count: vault.size });

// Defence in depth, and worth being precise about what it does: it keeps the
// key out of anything that later dumps `process.env`, and out of the
// environment of any child process (compose mounts the Docker socket for the
// sandbox runner). It does *not* change /proc/<pid>/environ on Linux, which
// still reflects the environment the process started with.
delete process.env.PROXY_VAULT_KEY;

// Also before anything binds, and for the same reason as the vault: a budget
// file whose directory is missing or unwritable must be a startup failure. The
// alternative fails *open* — a proxy that cannot record spend is a proxy whose
// hard limits never bite — and it would do so silently.
const budget = openBudgetDb({ file: budgetDbFromEnv(process.env), logger });

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
const dispatcher = createHttpDispatcher({ vault, logger });

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
  dispatcher,
  catalog: dispatcher,
  // The writer, not the handle: the serving process appends and cannot close
  // the file it is being audited into. `auditDb` stays here, where shutdown is.
  audit,
  logger
});

server.listen(listenPort, host, () => {
  logger.log("info", { event: "listening", host, port: listenPort });
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
      void dispatcher.close().finally(() => {
        budget.close();
        auditDb.close();
        process.exit(0);
      });
    });
  });
}
