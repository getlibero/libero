// A client of the proxy that is not the agent's.
//
// The agent's transport is deliberately unable to make the requests the
// identity cases need. It sends no `channel` field and cannot be made to —
// `ToolCall` is strict, so a body carrying one is refused rather than stripped
// — and it presents only the certificate matching the channel it was asked
// for. Both are correct, and both mean that "the certificate wins over the
// header, the query string, and the body" cannot be attacked from behind them.
//
// So this is the attacker's client: a certificate of its choosing, a path and
// query of its choosing, headers of its choosing, and a body serialized
// verbatim. It is a compromised agent process, which is the threat model the
// proxy is built against — not a second implementation of the supported one.
// Nothing here parses, validates, or is typed by @getlibero/schema, on purpose:
// a client that could only send well-formed calls could not attack the parser.
//
// **The trust anchor is not a knob.** The certificate authority the *server* is
// verified against is always the rig's, whichever client certificate is being
// presented. A case that swaps both ends up failing at its own end of the
// handshake and proving nothing about the proxy.

import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { Certs } from "./certs.js";

/** Long enough for a spawned proxy under load; short enough to fail a hang. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface RawResponse {
  readonly status: number;
  /**
   * Through `JSON.parse` and nothing else — `undefined` for an empty body, and
   * the raw text for anything that is not JSON. The case asserts the shape.
   */
  readonly body: unknown;
}

export interface RawRequest {
  readonly method: "GET" | "POST";
  /**
   * Path *and* query string, verbatim.
   *
   * One case exists to put a `?channel=` in disagreement with a certificate, so
   * the query is not built from a record here — it is written out in the case,
   * where the reader can see the attack.
   */
  readonly path: string;
  /**
   * Which client certificate to present, by the name `dev-certs.sh` wrote it
   * under: a channel id from `startRig({ channels })`, or the label half of a
   * `startRig({ rawCns })` entry.
   */
  readonly as: string;
  /**
   * Serialized verbatim, and typed `unknown` for the reason above: a case has
   * to be able to send a field `ToolCall` forbids.
   */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RawClient {
  /**
   * Resolves once the proxy answers, whatever it answers.
   *
   * A refusal is an answer — the proxy serves those with a 200 and a body — so
   * a rejection here means the request never became one: a handshake the proxy
   * would not complete, or a socket that went away.
   */
  send(request: RawRequest): Promise<RawResponse>;
}

export function rawClient(options: { url: string; certs: Certs }): RawClient {
  const base = new URL(options.url);
  const ca = readFileSync(options.certs.caPath);

  return {
    send({ method, path, as, body, headers }: RawRequest): Promise<RawResponse> {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");

      return new Promise<RawResponse>((resolve, reject) => {
        const req = httpsRequest(
          {
            ca,
            cert: readFileSync(join(options.certs.clientCertDir, `client-${as}.pem`)),
            key: readFileSync(join(options.certs.clientCertDir, `client-${as}.key`)),
            minVersion: "TLSv1.3",
            host: base.hostname,
            port: Number(base.port),
            path,
            method,
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
              accept: "application/json",
              ...(payload !== undefined
                ? { "content-type": "application/json", "content-length": payload.byteLength }
                : {}),
              // Last, so a case can override even the two above — the point of
              // this client is that nothing about the request is fixed here.
              ...headers
            }
          },
          res => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf8");
              let parsed: unknown = raw;
              try {
                parsed = raw.length === 0 ? undefined : JSON.parse(raw);
              } catch {
                // Left as text. A body that is not JSON is a finding, not an
                // error to swallow, and the case gets to say so.
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
          }
        );

        req.on("timeout", () => {
          req.destroy(new Error(`e2e: the proxy did not answer within ${REQUEST_TIMEOUT_MS}ms`));
        });
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      });
    }
  };
}
