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
