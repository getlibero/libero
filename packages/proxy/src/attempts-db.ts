// The attempt store: what a blocked call tried to do (#364).
//
// The audit row for a refused, held, denied or expired call carries a hash of
// the arguments and nothing else. A call that ran has its record at the
// upstream that served it; a blocked call reached nothing, the agent's own
// replies are not in the channel store, so what was *attempted* was knowable
// nowhere — and an attempted-but-blocked action is exactly what an incident
// review wants to read. This store is that record.
//
// ## Off-chain, bound by the hash already in the row
//
// Argument capture in the audit log itself was designed and declined (#122):
// a blocked call's arguments are the most likely to have been shaped by an
// injected model, a chained row is permanent, and incomplete redaction on a
// durable row is worse than storing nothing. This store threads those
// constraints instead of arguing with them:
//
//   - **It stores raw and claims no redaction.** A scan for a value only finds
//     the value, and the adversary transforms it (./redact.ts's own header).
//     Everything in here is model-authored, treated as hostile, and may
//     contain anything the model saw. Nobody believes a redacted column,
//     because there is not one.
//   - **It is not chained, so it is deletable.** Removing a record degrades
//     the audit row it belongs to back to today's status quo — hash only —
//     without touching the chain. `audit verify` stays green. That is what
//     makes the permanence rule survivable: a secret that lands in an attempt
//     record is removed by deleting the record, not by rotating the log.
//   - **It is tamper-evident by reference.** The key is the audit row's own
//     `arguments_sha256`, and the stored bytes are exactly what that digest
//     covers, so the read path re-verifies content against key and an altered
//     record no longer matches the chained row that names it.
//   - **Nothing on this path resolves a credential.** The store needs no value
//     and asks for none, so a refusal causes no token-endpoint mint — the
//     ordering `server.ts` establishes (decision before resolution) is
//     unchanged by capture.
//
// ## Its own file, beside the audit log
//
// Not a second table in audit.db, because the two write disciplines are
// opposites: the audit log is append-only and refuses DELETE from any
// connection, where this file is deletable by design. One file per discipline
// keeps each file's rule checkable by reading the module that opens it.
//
// **No channel column, and that is not the message store's rule at work.** The
// store is content-addressed: two calls with identical arguments — same
// channel or not — are one record, because the record *is* the bytes the hash
// covers. Which channel attempted it, when, against which tool and with what
// outcome are the audit row's facts; this file answers only "what were the
// arguments behind this hash". It is operator-facing, like the audit log and
// the meter, and is read through the proxy's own entrypoint.
//
// **No retention command, and unlike the audit log it needs none designed:**
// deletion is an ordinary, supported operation here, one record at a time,
// because deleting is the remedy the whole design leans on.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "./audit-log.js";
import type { Logger } from "./log.js";
import { createSilentLogger } from "./log.js";

/**
 * The most bytes one record may hold, as UTF-8 of the canonical JSON.
 *
 * Equal to the listener's `MAX_BODY_BYTES` on purpose: the arguments arrived
 * inside a request body that bound already applies to, so a larger value
 * would never bind and a smaller one would reintroduce the partial-capture
 * exception clause #122 named as the same failure as partial redaction. The
 * guard here is defence in depth for a caller that did not come through the
 * listener; hitting it is a bug, not an input.
 */
export const MAX_ATTEMPT_BYTES = 1_048_576;

/**
 * One attempt record, read back.
 *
 * `verified` is the read path recomputing SHA-256 over the stored bytes and
 * comparing it to the key — the audit row's own hash. `false` means the file
 * was altered: the record no longer says what the chained row committed to,
 * and a reader must say so rather than present the bytes as the attempt.
 */
export interface StoredAttempt {
  readonly argumentsSha256: string;
  /** The canonical JSON the digest covers. Model-authored; treat as hostile. */
  readonly argumentsJson: string;
  /** When this content was first captured, in milliseconds. */
  readonly firstSeenAt: number;
  readonly verified: boolean;
}

export interface AttemptStore {
  /**
   * Capture one blocked call's arguments. Returns the digest they are keyed
   * under, which is byte-for-byte the audit row's `arguments_sha256` — both
   * are SHA-256 over the same `canonicalJson`.
   *
   * Idempotent by content: the same arguments capture once, stamped with the
   * first sight. There is nothing a second write could add — identical bytes
   * are identical bytes — and keeping the first stamp keeps "when was this
   * first attempted" a fact rather than a latest-write.
   */
  record(args: Record<string, unknown>, at: number): string;
  read(argumentsSha256: string): StoredAttempt | undefined;
  /** Forget one record. The chained row it belonged to is untouched. */
  delete(argumentsSha256: string): boolean;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempt (
  -- SHA-256 over the canonical JSON below, lowercase hex: the same digest, by
  -- the same function, as the audit row's arguments_sha256. The join between
  -- the two files, and the read path's verification key.
  arguments_sha256 TEXT PRIMARY KEY,
  -- The exact bytes the digest covers. Raw, model-authored, no redaction
  -- claimed or performed; see the file header.
  arguments        TEXT NOT NULL,
  first_seen       INTEGER NOT NULL
);
`;

/** SHA-256 over canonical JSON, lowercase hex — `hashArguments`, restated here
 * so this module's verification cannot drift from its own writes. */
function digestOf(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

export interface AttemptStoreOptions {
  readonly file: string;
  readonly logger?: Logger;
}

export function openAttemptStore(options: AttemptStoreOptions): AttemptStore {
  const logger = options.logger ?? createSilentLogger();
  const db = new DatabaseSync(options.file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const statements = {
    record: db.prepare(
      `INSERT INTO attempt (arguments_sha256, arguments, first_seen)
            VALUES (?, ?, ?)
       ON CONFLICT (arguments_sha256) DO NOTHING`
    ),
    read: db.prepare(
      `SELECT arguments_sha256, arguments, first_seen FROM attempt WHERE arguments_sha256 = ?`
    ),
    delete: db.prepare(`DELETE FROM attempt WHERE arguments_sha256 = ?`)
  };

  logger.log("info", { event: "attempt_store_opened", file: options.file });

  return {
    record(args, at) {
      const json = canonicalJson(args);
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > MAX_ATTEMPT_BYTES) {
        // Unreachable through the listener, whose body cap is the same
        // number; reachable only by a caller that bypassed it, which is a bug
        // to surface rather than a record to truncate — a truncated record
        // would fail its own verification forever.
        throw new Error(`attempt store: record of ${String(bytes)} bytes exceeds the cap`);
      }
      const digest = digestOf(json);
      statements.record.run(digest, json, at);
      return digest;
    },

    read(argumentsSha256) {
      const row = statements.read.get(argumentsSha256) as
        | { arguments_sha256: string; arguments: string; first_seen: number }
        | undefined;
      if (row === undefined) return undefined;
      return {
        argumentsSha256: row.arguments_sha256,
        argumentsJson: row.arguments,
        firstSeenAt: row.first_seen,
        verified: digestOf(row.arguments) === row.arguments_sha256
      };
    },

    delete(argumentsSha256) {
      return statements.delete.run(argumentsSha256).changes > 0;
    },

    close() {
      db.close();
    }
  };
}
