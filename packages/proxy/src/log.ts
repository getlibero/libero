// Structured logging for the proxy.
//
// The field set is closed, and that is the point. The proxy is the process
// that holds every credential, so a logger taking free-form text is a standing
// invitation for a secret to be interpolated into a log line by some future
// call site. There is no `message` field and no metadata bag: if something new
// needs logging, it gets a named field here and a reviewer looks at it.
//
// One JSON object per line on stdout — the shape a container log collector
// wants, and greppable without a parser.

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  /** Fixed vocabulary, e.g. "listening", "request", "identity_rejected". */
  event: string;
  requestId?: string;
  /** The channel id. An id, never a credential, and safe to log. */
  channel?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Why an identity or a request was rejected. A code, not prose. */
  reason?: string;
  /** The certificate subject of a rejected connection. Never in a response. */
  commonName?: string;
  host?: string;
  port?: number;
  /**
   * A path on disk. Separate from `path`, which is a request path — one field
   * carrying both would make either one ambiguous to grep for.
   */
  file?: string;
  /**
   * Validation failures in a team sheet, as `path: code` — the schema's own
   * field names and zod's issue codes. Both closed vocabularies; neither
   * carries a value out of the file. See `parseTeamSheet`.
   */
  issues?: string[];
  /** Position of a TOML syntax error. */
  line?: number;
  column?: number;
  /** What a rejected team sheet left in force. A code, not prose. */
  effect?: "previous_sheet_retained" | "no_sheet_in_force";
  /**
   * The MCP server and tool a call named. Both are `ResourceName`s out of the
   * team sheet — names, never a URL and never a credential. A call for a server
   * the sheet does not list is logged with the name it asked for, which is how
   * an operator sees what an agent is reaching for.
   */
  server?: string;
  tool?: string;
  /**
   * What the proxy did with a tool call. The wire vocabulary, so a log line and
   * the response the client got say the same word.
   */
  outcome?: "ran" | "held" | "refused" | "unavailable";
  /**
   * A `CredentialName` — out of a team sheet, or out of a vault operation. A
   * name, in the same sense `server` and `tool` are names.
   *
   * There is no field on this interface a credential *value* has a home in, and
   * adding one is not a change a reviewer should accept. That includes a hash
   * or a fingerprint of a value: a hash of a low-entropy secret is crackable,
   * and such a field would immediately attract "just log the fingerprint".
   */
  credential?: string;
  /** Which team-sheet state a request resolved against. */
  sheet?: "active" | "absent" | "unusable";
  /** How many tools a listing returned. A count, not the list. */
  count?: number;
}

export interface Logger {
  log(level: LogLevel, fields: LogFields): void;
}

/**
 * The default logger. `write` is injected so tests can capture lines and
 * assert on what the proxy does and does not emit.
 */
export function createJsonLogger(write: (line: string) => void = line => process.stdout.write(line)): Logger {
  return {
    log(level: LogLevel, fields: LogFields): void {
      write(`${JSON.stringify({ ts: new Date().toISOString(), level, ...fields })}\n`);
    }
  };
}

/** Drops everything. For tests that are not asserting on log output. */
export function createSilentLogger(): Logger {
  return { log: () => {} };
}
