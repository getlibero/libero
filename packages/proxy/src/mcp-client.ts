// One upstream's MCP client: version negotiation, then `tools/call`.
//
// Holds a `Secret` and passes it to `callUpstream`, which is still the only
// function that reveals one and still the only function that redacts a reply.
// Nothing here unwraps a secret; it is carried as a handle and handed down. The
// grep test in ./outbound.test.ts is what keeps that true, and it matches on
// the literal call — which is why this paragraph describes it rather than
// spelling it.
//
// **Stateless, because `2026-07-28` is.** That revision removed protocol-level
// sessions, the `Mcp-Session-Id` header, and the
// `initialize`/`notifications/initialized` handshake; a request carries its own
// protocol version and capabilities in `_meta`. So this client holds one piece
// of per-upstream state — the negotiated version — and no connection at all.
// "Reconnect" is not a concept here; a server that predates the revision needs
// the handshake instead, which is #150.
//
// **Nothing is ever retried.** `2026-07-28` also removed `Last-Event-ID`
// resumability: a broken response stream must be re-issued as a new request.
// Re-issuing a `tools/call` is the replay that turns one write into two, so a
// broken stream is a failure the model sees rather than something this client
// quietly does twice.

import type { ToolResult } from "@getlibero/schema";
import {
  METHOD_NOT_FOUND,
  UNSUPPORTED_PROTOCOL_VERSION,
  discoverRequest,
  isInputRequired,
  negotiatedVersion,
  parseRpcResponse,
  requestHeaders,
  toolResultText,
  toolsCallRequest
} from "./mcp-protocol.js";
import { type AuthScheme, type UpstreamFailure, UpstreamError, callUpstream } from "./outbound.js";
import type { Secret } from "./vault.js";

/**
 * Why a call did not produce a tool's answer.
 *
 * A closed set, extending `UpstreamFailure` for the same reason that one is
 * closed: this is the path that holds a secret, so what a caller reports is
 * chosen from a list rather than read off a thrown value.
 */
export type McpFailure =
  | UpstreamFailure
  | "http_error"
  | "rpc_error"
  | "protocol_error"
  | "unsupported_protocol"
  | "input_required"
  | "closed";

/**
 * What a client did with a call.
 *
 * **`connect_failed` has no `detail` member, and that is the type doing the
 * work.** A discovery failure must never relay upstream bytes: the response to
 * a failed handshake is as likely to be an auth proxy's error page as anything
 * MCP, and an error page is exactly where a reflected credential lives. Making
 * the absence structural means a later edit cannot add one by accident — there
 * is no field to fill in.
 */
export type McpOutcome =
  | { readonly outcome: "called"; readonly result: ToolResult }
  | { readonly outcome: "connect_failed"; readonly failure: McpFailure }
  | {
      readonly outcome: "call_failed";
      readonly failure: McpFailure;
      readonly status?: number;
      readonly code?: number;
      readonly detail?: string;
    };

export interface McpClient {
  callTool(tool: string, args: Readonly<Record<string, unknown>>): Promise<McpOutcome>;
}

export interface McpClientOptions {
  readonly url: string;
  readonly scheme: AuthScheme;
  readonly secret: Secret | undefined;
  readonly credentialName?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

type Discovery = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly failure: McpFailure };

export function createMcpClient(options: McpClientOptions): McpClient {
  let nextId = 1;
  let discovered: Discovery | undefined;
  let opening: Promise<Discovery> | undefined;

  /**
   * The one `callUpstream` call site in this module.
   *
   * The `exactOptionalPropertyTypes` spreads live here and nowhere else, so
   * adding a request does not mean copying four conditionals.
   */
  const send = async (
    method: string,
    body: unknown,
    name?: string
  ): Promise<{ status: number; body: string; headers: Readonly<Record<string, string>> }> =>
    callUpstream({
      url: options.url,
      body,
      headers: requestHeaders(method, name),
      scheme: options.scheme,
      secret: options.secret,
      ...(options.credentialName !== undefined ? { credentialName: options.credentialName } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });

  const discover = async (): Promise<Discovery> => {
    const id = nextId++;
    let response;
    try {
      response = await send("server/discover", discoverRequest(id));
    } catch (error) {
      // `UpstreamError` only. A `RedactionError` — the proxy unable to
      // guarantee its own boundary — propagates past here to the server's
      // handler, which answers a constant 500 rather than serving anything.
      if (!(error instanceof UpstreamError)) throw error;
      return { ok: false, failure: error.failure };
    }

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, failure: "http_error" };
    }

    const parsed = parseRpcResponse(response.headers["content-type"], response.body, id);
    if (parsed.kind === "malformed") return { ok: false, failure: "protocol_error" };
    if (parsed.kind === "error") {
      // A server that does not implement `server/discover` predates the
      // revision this client speaks. Failing closed here is deliberate rather
      // than pessimistic: the alternative is guessing at a handshake, and the
      // handshake is a second protocol implementation. This is the seam #150
      // attaches its fallback to.
      const legacy = parsed.code === METHOD_NOT_FOUND || parsed.code === UNSUPPORTED_PROTOCOL_VERSION;
      return { ok: false, failure: legacy ? "unsupported_protocol" : "rpc_error" };
    }

    const version = negotiatedVersion(parsed.result);
    if (version === null) return { ok: false, failure: "unsupported_protocol" };
    return { ok: true, version };
  };

  /**
   * Discovery, at most once at a time.
   *
   * Single-flight so N concurrent first calls probe once rather than N times.
   * **Success is cached; failure is not.** A version both ends agreed on does
   * not change under a running process, but a timeout is a moment rather than a
   * property of the upstream — caching one would disable a server for the
   * process lifetime because it was briefly slow.
   *
   * `opening` is cleared on rejection as well as fulfilment. A discovery that
   * threw — a `RedactionError` from an empty vault value is the realistic
   * case — must not leave a permanently rejected promise for every later call
   * to await.
   */
  const ensureDiscovered = async (): Promise<Discovery> => {
    if (discovered?.ok === true) return discovered;
    if (opening === undefined) {
      opening = discover().finally(() => {
        opening = undefined;
      });
    }
    const result = await opening;
    if (result.ok) discovered = result;
    return result;
  };

  return {
    async callTool(tool, args) {
      const ready = await ensureDiscovered();
      if (!ready.ok) return { outcome: "connect_failed", failure: ready.failure };

      const id = nextId++;
      let response;
      try {
        response = await send("tools/call", toolsCallRequest(id, tool, args), tool);
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        return { outcome: "call_failed", failure: error.failure };
      }

      if (response.status < 200 || response.status >= 300) {
        // The body is safe to relay: `callUpstream` already scrubbed it, and a
        // tool endpoint's error text is often the only thing that tells the
        // model what it did wrong.
        return { outcome: "call_failed", failure: "http_error", status: response.status, detail: response.body };
      }

      const parsed = parseRpcResponse(response.headers["content-type"], response.body, id);
      if (parsed.kind === "malformed") {
        return { outcome: "call_failed", failure: "protocol_error", detail: parsed.reason };
      }
      if (parsed.kind === "error") {
        return { outcome: "call_failed", failure: "rpc_error", code: parsed.code, detail: parsed.message };
      }

      // An upstream asking for more input is asking the proxy to speak for a
      // channel: to answer a sampling request out of the channel's model
      // budget, or an elicitation with something no one was asked. There is no
      // sheet entry and no click behind either, so the answer is no — and no
      // retry, since retrying is how the round trip would be completed.
      if (isInputRequired(parsed.result)) {
        return { outcome: "call_failed", failure: "input_required" };
      }

      const mapped = toolResultText(parsed.result);
      if (mapped === null) {
        return { outcome: "call_failed", failure: "protocol_error", detail: "bad_result" };
      }

      return { outcome: "called", result: mapped };
    }
  };
}
