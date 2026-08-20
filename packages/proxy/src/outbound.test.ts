import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPSTREAM_RESPONSE_BYTES,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_CONTROL_BODY_BYTES,
  UpstreamError,
  callUpstream,
  constantCredential,
  createGuardedFetch,
  discoverAuthorizationServer,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  readSessionId,
  credentialHeader,
  destinationHost,
  injectCredential
} from "./outbound.js";
import { RedactionError, redactionMarker } from "./redact.js";
import type { Secret } from "./vault.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const VALUE = "ghp_live_token_do_not_log";

/** A stand-in with the same discipline as the real one: only `reveal` yields it. */
function secretOf(value: string): Secret {
  const secret = {
    reveal: () => value,
    toJSON: () => "[redacted]",
    toString: () => "[redacted]"
  };
  return Object.freeze(secret) as Secret;
}

/** A `fetch` that records what it was called with and answers 200. */
function recordingFetch(body = "{}", status = 200, responseHeaders?: Record<string, string>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, ...(responseHeaders ? { headers: responseHeaders } : {}) });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

/** The headers a recorded call actually put on the wire. */
function sentHeaders(calls: { init: RequestInit }[]): Record<string, string> {
  return (calls[0]?.init.headers ?? {}) as Record<string, string>;
}

describe("injecting the credential", () => {
  it("puts the value in an Authorization: Bearer header", () => {
    expect(credentialHeader("bearer", VALUE)).toEqual(["authorization", `Bearer ${VALUE}`]);
  });

  it("returns a fresh object rather than mutating the caller's headers", () => {
    const original = Object.freeze({ accept: "application/json" });
    const injected = injectCredential(original, "bearer", VALUE);
    expect(injected).not.toBe(original);
    expect(original).toEqual({ accept: "application/json" });
    expect(injected.authorization).toBe(`Bearer ${VALUE}`);
  });

  // An MCP server on the private network may legitimately need no credential.
  // The branch is ordinary, so it is tested rather than left to the happy path.
  it("adds no header when the upstream needs no credential", () => {
    const injected = injectCredential({ accept: "application/json" }, "bearer", undefined);
    expect(injected).toEqual({ accept: "application/json" });
    expect("authorization" in injected).toBe(false);
  });
});

describe("the outbound call", () => {
  it("sends the real secret to the upstream", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({
      url: "http://mcp-github:3001",
      body: JSON.stringify({ tool: "list_prs", arguments: {} }),
      scheme: "bearer",
      secret: secretOf(VALUE),
      fetch
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${VALUE}`);
    expect(calls[0]?.init.method).toBe("POST");
  });

  // The verb decides whether a body is written, rather than whether `body`
  // happens to be set: `JSON.stringify(undefined)` is `undefined`, so keying
  // off the value would send a bodiless POST silently instead of not compiling.
  it("sends a DELETE with no body and no content type", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({
      url: "http://u:1",
      method: "DELETE",
      headers: { "mcp-session-id": "session-1" },
      scheme: "bearer",
      secret: secretOf(VALUE),
      fetch
    });

    expect(calls[0]?.init.method).toBe("DELETE");
    expect("body" in (calls[0]?.init ?? {})).toBe(false);
    expect("content-type" in sentHeaders(calls)).toBe(false);
    // Still credentialed, and still through the one function that redacts.
    expect(sentHeaders(calls).authorization).toBe(`Bearer ${VALUE}`);
    expect(sentHeaders(calls)["mcp-session-id"]).toBe("session-1");
  });

  it("returns the upstream's status and body", async () => {
    const { fetch } = recordingFetch('{"prs":[]}', 200);
    const response = await callUpstream({
      url: "http://mcp-github:3001",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      fetch
    });
    expect(response).toMatchObject({ status: 200, body: '{"prs":[]}' });
  });

  it("carries the caller's extra headers", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({
      url: "http://u:1",
      body: "{}",
      headers: { "mcp-method": "tools/call", "mcp-name": "list_prs" },
      scheme: "bearer",
      secret: undefined,
      fetch
    });
    expect(sentHeaders(calls)).toMatchObject({
      "mcp-method": "tools/call",
      "mcp-name": "list_prs",
      "content-type": "application/json"
    });
  });

  // Undici sends both spellings of a name it is given twice, and the upstream
  // picks. Lowercasing here means the caller's map has one entry per header.
  it("lowercases the caller's header names", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({
      url: "http://u:1",
      body: "{}",
      headers: { "MCP-Method": "tools/call" },
      scheme: "bearer",
      secret: undefined,
      fetch
    });
    const headers = sentHeaders(calls);
    expect(headers["mcp-method"]).toBe("tools/call");
    expect("MCP-Method" in headers).toBe(false);
  });

  // The credential is attached last and `authorization` is stripped from the
  // caller's map, so there is no way to send one except through `secret` — which
  // is also the path that scrubs the reply.
  it("will not let a caller header forge or displace the credential", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({
      url: "http://u:1",
      body: "{}",
      headers: { authorization: "Bearer forged", Authorization: "Bearer also-forged" },
      scheme: "bearer",
      secret: secretOf(VALUE),
      fetch
    });
    expect(sentHeaders(calls).authorization).toBe(`Bearer ${VALUE}`);
  });

  it("sends no credential at all when a caller header is the only one offered", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({
      url: "http://u:1",
      body: "{}",
      headers: { authorization: "Bearer forged" },
      scheme: "bearer",
      secret: undefined,
      fetch
    });
    expect("authorization" in sentHeaders(calls)).toBe(false);
  });

  it("returns the allowlisted response headers and nothing else", async () => {
    const { fetch } = recordingFetch("{}", 200, {
      "content-type": "text/event-stream",
      "x-debug-echo": "something the caller may not read"
    });
    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      fetch
    });
    expect(response.headers).toEqual({ "content-type": "text/event-stream" });
  });

  // A response header is an echo surface like any other. Scrubbing the body
  // while handing back a header holding the value would be a hole in the same
  // guarantee, one field over.
  it("redacts the credential out of a response header", async () => {
    const { fetch } = recordingFetch("{}", 200, { "content-type": `application/json; echo=${VALUE}` });
    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "github_token",
      fetch
    });
    expect(response.headers["content-type"]).toBe("application/json; echo=[redacted:github_token]");
    expect(response.headers["content-type"]).not.toContain(VALUE);
  });

  // A bodiless 202 is the shape an MCP server answers a notification with, and
  // it carries no content-type. Absent rather than empty, so a caller can tell
  // "the upstream said nothing" from "the upstream said the empty string".
  it("omits a header the upstream did not send", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 })) as unknown as typeof globalThis.fetch;
    const response = await callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: undefined, fetch });
    expect(response.headers["content-type"]).toBeUndefined();
    expect("content-type" in response.headers).toBe(false);
  });

  // An event stream spends most of a call's life in the body read, so the
  // timeout usually fires there rather than on the headers. Reporting that as
  // `unreachable` would tell an operator the upstream was down when it was slow.
  it("reports a body-read abort as a timeout, not as unreachable", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: par"));
              controller.error(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
            }
          })
        )
    ) as unknown as typeof globalThis.fetch;

    const thrown = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      fetch
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UpstreamError);
    expect((thrown as UpstreamError).failure).toBe("timed_out");
  });

  // A bodiless response has no stream at all, which the bounded read has to
  // answer for explicitly now that it no longer goes through `response.text()`.
  it("reads a bodiless response as the empty string", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    const response = await callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: undefined, fetch });
    expect(response.body).toBe("");
  });

  // A 404 from a tool is a result the model should see, not a transport
  // failure. `ToolResult.isError` draws that line; this must not throw.
  it("returns a non-2xx as an ordinary result", async () => {
    const { fetch } = recordingFetch("no such repo", 404);
    await expect(
      callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: undefined, fetch })
    ).resolves.toMatchObject({ status: 404, body: "no such repo" });
  });

  it("applies a timeout even when the caller names none", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: undefined, fetch });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
  });

  // The SDK cancels through the signal it hands its fetch — its per-request
  // timeout, transport.close(), a session termination racing shutdown. Dropping
  // it would let every such abort settle the caller's promise while the socket
  // runs on to the full default timeout, holding the event loop open past the
  // ten seconds a `docker stop` allows before SIGKILL.
  it("joins the caller's signal with the timeout rather than replacing it", async () => {
    const { calls, fetch } = recordingFetch();
    const controller = new AbortController();
    await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      signal: controller.signal,
      fetch
    });

    const wire = calls[0]?.init.signal;
    // A joined signal, not the caller's own — the timeout still applies.
    expect(wire).toBeInstanceOf(AbortSignal);
    expect(wire).not.toBe(controller.signal);
    expect(wire?.aborted).toBe(false);
    controller.abort();
    expect(wire?.aborted).toBe(true);
  });

  it("reports a timeout as a timeout", async () => {
    const fetch = (async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof globalThis.fetch;
    await expect(
      callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: secretOf(VALUE), fetch })
    ).rejects.toMatchObject({ name: "UpstreamError", failure: "timed_out" });
  });

  it("reports anything else as unreachable", async () => {
    const fetch = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: secretOf(VALUE), fetch })
    ).rejects.toMatchObject({ name: "UpstreamError", failure: "unreachable" });
  });

  // The reason `UpstreamError` carries no `cause`: a fetch/undici error can
  // hold the request, and the request holds the credential. Inspecting the
  // thrown value must not disclose it.
  it("never carries the secret out on a thrown error", async () => {
    const fetch = (async (_url: string, init: RequestInit) => {
      // A realistic hostile case: the transport error quotes the request.
      throw new TypeError(`fetch failed: ${JSON.stringify(init.headers)}`);
    }) as unknown as typeof globalThis.fetch;

    const thrown = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: secretOf(VALUE),
      fetch
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UpstreamError);
    const seen = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))} ${(thrown as Error).stack ?? ""}`;
    expect(seen).not.toContain(VALUE);
    expect(seen).not.toContain("ghp_");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });
});

// Nothing bounded a response body until #151: `response.text()` read to
// completion, so a fifty-megabyte answer was buffered, scanned by every
// redaction needle, and handed on. These test the read itself — the mechanism.
// That an oversized body produces the right *outcome* for a model and for a
// catalog is http-dispatcher.test.ts's and mcp-catalog.test.ts's, over a real
// socket.
describe("the bounded body read", () => {
  /** The bytes, handed over `size` at a time, so sequences straddle boundaries. */
  function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      }
    });
  }

  // The claim the whole cap rests on: under the limit this is `response.text()`,
  // character for character. Asserted against a real `Response` rather than
  // against a literal, so it is the platform's own answer being compared and not
  // one written down by hand — and fed three bytes at a time, so the BOM, the
  // multi-byte character, the surrogate pair and the invalid tail each land
  // across a chunk boundary where a decoder without `{ stream: true }` would
  // corrupt them.
  it("decodes exactly as response.text() does, across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('﻿{"prs":["✓","🚀","é"],"tail":"…"}');
    const ragged = new Uint8Array(bytes.byteLength + 1);
    ragged.set(bytes);
    // A lone continuation byte: invalid UTF-8, which decodes to U+FFFD.
    ragged[bytes.byteLength] = 0x80;

    const expected = await new Response(ragged).text();
    const fetch = vi.fn(async () => new Response(chunked(ragged, 3))) as unknown as typeof globalThis.fetch;

    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      maxBodyBytes: 4096,
      fetch
    });

    expect(response.body).toBe(expected);
  });

  it("keeps a body of exactly the limit", async () => {
    const body = "x".repeat(64);
    const { fetch } = recordingFetch(body);
    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      maxBodyBytes: 64,
      fetch
    });
    expect(response.body).toBe(body);
  });

  it("refuses a body one byte over the limit", async () => {
    const { fetch } = recordingFetch("x".repeat(65));
    const thrown = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      maxBodyBytes: 64,
      fetch
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UpstreamError);
    expect((thrown as UpstreamError).failure).toBe("too_large");
  });

  // The acceptance criterion, asserted as the mechanism rather than as a memory
  // measurement: `process.memoryUsage` appears nowhere in this repo, it is at the
  // mercy of when a collection happens to run, and a green assertion on it would
  // not mean what the criterion says.
  //
  // The stream here is endless. That the test terminates at all is half the
  // claim — a fifty-megabyte body is the case an upstream happened to send, and
  // this is the case no upstream can escape — and the other half is that the
  // source was asked for a number of chunks bounded by the *cap* rather than by
  // the body, and then cancelled.
  it("stops pulling and cancels rather than draining a body over the limit", async () => {
    const CHUNK = 64 * 1024;
    const LIMIT = 256 * 1024;
    let produced = 0;
    let cancelled = false;

    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetch = vi.fn(async () => new Response(endless)) as unknown as typeof globalThis.fetch;

    const thrown = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      maxBodyBytes: LIMIT,
      fetch
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UpstreamError);
    expect((thrown as UpstreamError).failure).toBe("too_large");
    // The transport was told to stop, rather than left to deliver a body into a
    // buffer nobody will read.
    expect(cancelled).toBe(true);
    // Four chunks fill the limit and the fifth crosses it; the default queuing
    // strategy may pull one ahead. The bound is the claim — the slack is for the
    // strategy, not for the cap.
    expect(produced).toBeLessThanOrEqual(8);
  });

  // The body is never decoded, so there is nothing to scrub — which means the
  // one thing that must hold is that nothing of it reaches the error either.
  it("relays nothing of an oversized body, not even in the error", async () => {
    const { fetch } = recordingFetch(`{"leak":"${VALUE}","pad":"${"x".repeat(5000)}"}`);
    const thrown = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: secretOf(VALUE),
      maxBodyBytes: 512,
      fetch
    }).catch((error: unknown) => error);

    expect((thrown as UpstreamError).failure).toBe("too_large");
    const seen = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))} ${(thrown as Error).stack ?? ""}`;
    expect(seen).not.toContain(VALUE);
    expect(seen).not.toContain("ghp_");
  });

  it("falls back to the process default when the caller names no limit", async () => {
    const { fetch } = recordingFetch("{}");
    await expect(
      callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: undefined, fetch })
    ).resolves.toMatchObject({ body: "{}" });
    expect(DEFAULT_UPSTREAM_RESPONSE_BYTES).toBeGreaterThan(0);
  });
});

// A redirect target is the only destination in the system nothing declared: the
// url comes from the team sheet and `[egress]` holds hosts an operator wrote
// down, but a 302 is chosen by the upstream at call time.
describe("a redirecting upstream", () => {
  it("asks the transport not to follow", async () => {
    const { calls, fetch } = recordingFetch();
    await callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: undefined, fetch });
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it.each([301, 302, 303, 307, 308])("refuses a %i rather than following it", async (status) => {
    const { fetch } = recordingFetch("", status);
    await expect(
      callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: secretOf(VALUE), fetch })
    ).rejects.toMatchObject({ name: "UpstreamError", failure: "redirected" });
  });

  // The claim the `"POST" | "DELETE"` union makes: both members take the
  // identical path, so a redirect is refused on either. Cheaper to assert than
  // to argue in a comment, and it is what stops a second verb quietly acquiring
  // a second set of rules on the one function that holds a credential.
  it.each(["POST", "DELETE"] as const)("refuses a redirect on a %s alike", async method => {
    const { fetch } = recordingFetch("", 307);
    await expect(
      callUpstream({ url: "http://u:1", method, body: "{}", scheme: "bearer", secret: secretOf(VALUE), fetch })
    ).rejects.toMatchObject({ name: "UpstreamError", failure: "redirected" });
  });

  // 304 is not a redirect, and the proxy sends nothing conditional that could
  // provoke one. Swept in with the others it would turn a cacheable answer into
  // a transport failure.
  it("does not treat a 304 as a redirect", async () => {
    // Built by hand rather than through `recordingFetch`: 304 is a null-body
    // status, and the Response constructor rejects a body for one.
    const fetch = (async () => new Response(null, { status: 304 })) as unknown as typeof globalThis.fetch;
    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: undefined,
      fetch
    });
    expect(response.status).toBe(304);
  });

  // The claim the stub cannot make: that no second socket is opened. Two real
  // servers, and the one being redirected to must never be asked for anything.
  it("opens no connection to the host it was redirected to", async () => {
    const target = createServer((_request, response) => {
      targetHits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    let targetHits = 0;
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as AddressInfo).port;

    const redirector = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/moved` });
      response.end();
    });
    await new Promise<void>(resolve => redirector.listen(0, "127.0.0.1", resolve));

    try {
      const thrown = await callUpstream({
        url: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`,
        body: "{}",
        scheme: "bearer",
        secret: secretOf(VALUE)
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(UpstreamError);
      expect((thrown as UpstreamError).failure).toBe("redirected");
      expect(targetHits).toBe(0);
    } finally {
      await new Promise<void>(resolve => redirector.close(() => resolve()));
      await new Promise<void>(resolve => target.close(() => resolve()));
    }
  });
});

describe("the secret does not come back", () => {
  // The leak class: an upstream that reflects the header it was given. The
  // fixture echoes the whole request, which is what a debug endpoint does.
  it("scrubs a credential the upstream echoed", async () => {
    const fetch = (async (_url: string, init: RequestInit) =>
      new Response(`upstream saw ${JSON.stringify(init.headers)}`)) as unknown as typeof globalThis.fetch;

    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "github_token",
      fetch
    });

    expect(response.body).not.toContain(VALUE);
    expect(response.body).toContain("[redacted:github_token]");
  });

  it.each([
    ["base64", (s: string) => Buffer.from(s).toString("base64")],
    ["base64url", (s: string) => Buffer.from(s).toString("base64url")],
    ["percent-encoded", (s: string) => encodeURIComponent(s)]
  ])("scrubs it when the upstream re-encoded it as %s", async (_label, encode) => {
    const fetch = (async () => new Response(`echo ${encode(VALUE)}`)) as unknown as typeof globalThis.fetch;

    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "c",
      fetch
    });

    expect(response.body).not.toContain(encode(VALUE));
    expect(response.body).toContain("[redacted:c]");
  });

  // The argument for admitting `mcp-session-id` to the readable allowlist: the
  // legacy handshake has nowhere else to learn a session, and every member of
  // that list goes through the same needles as the body before the one return.
  // So a server that answers with the credential as its session id hands back a
  // marker, and the marker is what the client would go on to replay.
  it("scrubs the session header with the same needles as the body", async () => {
    const fetch = (async () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "mcp-session-id": VALUE }
      })) as unknown as typeof globalThis.fetch;

    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "github_token",
      fetch
    });

    expect(response.headers["mcp-session-id"]).toBe("[redacted:github_token]");
    expect(JSON.stringify(response)).not.toContain(VALUE);
  });

  // A DELETE's response is discarded by its one caller, but it must not be able
  // to leave here unscrubbed — the guarantee is the function's, not the
  // caller's.
  it("redacts a DELETE's response exactly as it does a POST's", async () => {
    const fetch = (async () => new Response(`echo ${VALUE}`)) as unknown as typeof globalThis.fetch;

    const response = await callUpstream({
      url: "http://u:1",
      method: "DELETE",
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "c",
      fetch
    });

    expect(response.body).not.toContain(VALUE);
    expect(response.body).toContain("[redacted:c]");
  });

  it("leaves a clean response byte-identical", async () => {
    const fetch = (async () => new Response('{"prs":[]}')) as unknown as typeof globalThis.fetch;
    const response = await callUpstream({
      url: "http://u:1",
      body: "{}",
      scheme: "bearer",
      secret: secretOf(VALUE),
      credentialName: "c",
      fetch
    });
    expect(response.body).toBe('{"prs":[]}');
  });

  it("passes the body through untouched when there is no credential", async () => {
    const fetch = (async () => new Response("anything at all")) as unknown as typeof globalThis.fetch;
    const response = await callUpstream({ url: "http://u:1", body: "{}", scheme: "bearer", secret: undefined, fetch });
    expect(response.body).toBe("anything at all");
  });

  // Fail-closed: the redactor throws on a value it cannot scan for, and
  // callUpstream must not swallow it into a returned body.
  it("throws rather than returning a body it could not scrub", async () => {
    const fetch = (async () => new Response("body")) as unknown as typeof globalThis.fetch;
    await expect(
      callUpstream({
        url: "http://u:1",
        body: "{}",
        scheme: "bearer",
        secret: secretOf(""),
        credentialName: "c",
        fetch
      })
    ).rejects.toBeInstanceOf(RedactionError);
  });
});

describe("the destination host", () => {
  it.each([
    ["http://mcp-github:3001/rpc", "mcp-github"],
    ["https://api.github.com/v3?token=leaked", "api.github.com"],
    ["https://USER:PASS@internal.example.com/x", "internal.example.com"]
  ])("takes the host out of %s", (url, host) => {
    expect(destinationHost(url)).toBe(host);
  });

  // The point of returning the host rather than the URL: a log line must not be
  // where a query-string token or a userinfo password ends up.
  it("drops the path, the query, and any userinfo", () => {
    expect(destinationHost("https://u:hunter2@api.example.com/p?token=abc")).toBe("api.example.com");
  });

  it("answers null for a url that does not parse", () => {
    expect(destinationHost("not a url")).toBeNull();
  });
});

// The property ./vault.ts is written to make checkable: `reveal()` is the
// deliberate act and the only way a value leaves either store. Two sites since
// the token engine (#256), both in this file and each deliberate — the header
// names them: `callUpstream` spends a credential on an upstream and scrubs the
// reply; `exchangeRefreshToken` spends a refresh token at its issuer and
// returns the reply to no caller. A grep, not a mock, because the claim is
// about the whole tree.
describe("the two reveals", () => {
  it("has exactly two reveal() call sites outside tests and the vault itself, both in outbound.ts", () => {
    const found = execFileSync(
      "sh",
      [
        "-c",
        "grep -rn '\\.reveal()' packages/*/src apps/*/src --include='*.ts' | grep -v '\\.test\\.ts' || true"
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    )
      .split("\n")
      .filter(line => line.length > 0)
      // vault.ts defines `reveal`; it does not call it.
      .filter(line => !line.startsWith("packages/proxy/src/vault.ts"));

    expect(found).toHaveLength(2);
    for (const line of found) {
      expect(line).toContain("packages/proxy/src/outbound.ts");
    }
  });

  // The MCP SDK's confinement, checked the same way and for the same reason.
  // ESLint enforces it too, but `no-restricted-imports` is replaced by the last
  // config block that matches a file — so the ban is restated in a dozen places
  // and a thirteenth block added without it would open the hole silently. A
  // grep cannot be routed around by adding a block.
  //
  // It matches the *import* form rather than the package name, which is the
  // lesson the `reveal()` grep above already teaches: a module explaining why
  // the SDK is confined has to be able to name it. ./server.ts does exactly
  // that, in the paragraph stating the dependency rule.
  it("keeps the MCP SDK inside the one module entitled to it", () => {
    const found = execFileSync(
      "sh",
      [
        "-c",
        "grep -rln 'from \"@modelcontextprotocol' packages/*/src apps/*/src --include='*.ts' | grep -v '\\.test\\.ts' || true"
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    )
      .split("\n")
      .filter(line => line.length > 0);

    expect(found).toEqual(["packages/proxy/src/mcp-client.ts"]);
  });

  // The companion property: no module outside outbound.ts and the vault should
  // even be able to reach a value, so nothing else imports `Secret` to unwrap.
  it("keeps the credential value out of every other source file", () => {
    const roots = [join(REPO_ROOT, "packages/proxy/src"), join(REPO_ROOT, "apps/proxy-server/src")];
    for (const root of roots) {
      for (const name of readdirSync(root)) {
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        if (name === "outbound.ts" || name === "vault.ts") continue;
        expect(readFileSync(join(root, name), "utf8")).not.toContain(".reveal()");
      }
    }
  });
});

// The seam the MCP SDK is given in #188. Everything it asserts is a property
// `callUpstream` already had; what is new is that they survive being worn as a
// `fetch`, which is what makes handing the wire to a library safe rather than a
// leap of faith.
describe("the guarded fetch", () => {
  const guarded = (
    overrides: Partial<Parameters<typeof createGuardedFetch>[0]> & { fetch: typeof globalThis.fetch }
  ) =>
    createGuardedFetch({
      url: "http://mcp-github:3001/mcp",
      source: constantCredential("bearer", secretOf(VALUE), "github_pat"),
      ...overrides
    });

  it("attaches the credential and passes the SDK's body through verbatim", async () => {
    const { calls, fetch } = recordingFetch();
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}';
    await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "POST", body });

    expect(sentHeaders(calls).authorization).toBe(`Bearer ${VALUE}`);
    // Not re-serialized: the SDK already framed this, and stringifying a string
    // would quote and escape it into something no server parses.
    expect(calls[0]?.init.body).toBe(body);
  });

  // The SDK opens a standalone GET event stream to listen for server-initiated
  // messages as soon as a request is answered 202 with no body — which the
  // legacy `notifications/initialized` acknowledgement is. The read below is
  // buffered, so that stream would hold a socket until the timeout. 405 is what
  // a server offering no listen endpoint answers, and the SDK treats it as
  // benign on that path.
  it("answers a listen stream 405 without opening a socket", async () => {
    const { calls, fetch } = recordingFetch();
    const response = await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "GET" });

    expect(response.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it("refuses a destination the sheet did not name, before revealing anything", async () => {
    const { calls, fetch } = recordingFetch();
    await expect(guarded({ fetch })("http://elsewhere.example/mcp", { method: "POST", body: "{}" })).rejects.toThrow(
      UpstreamError
    );
    expect(calls).toHaveLength(0);
  });

  // Structural absence rather than downstream filtering: `www-authenticate` is
  // what the transport would parse to start an OAuth flow, and it is not on the
  // object the SDK receives at all.
  it("exposes only the allowlisted headers, and scrubs them", async () => {
    const { fetch } = recordingFetch("{}", 200, {
      "content-type": "application/json",
      "mcp-session-id": "session-1",
      "www-authenticate": 'Bearer realm="github"',
      "x-echo": VALUE
    });
    const response = await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });

    expect([...response.headers.keys()].sort()).toEqual(["content-type", "mcp-session-id"]);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("drops a session id it will not replay rather than handing it on", async () => {
    const { fetch } = recordingFetch("{}", 200, { "mcp-session-id": "a b" });
    const response = await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });

    // A hostile id would otherwise reach the SDK, which writes it into a
    // `Headers` on the next request — and `Headers.set` throws on a CR, so the
    // cost of not checking is a spurious transport failure rather than a leak.
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("gives a 204 no body, which the Response constructor requires", async () => {
    // Built by hand rather than through `recordingFetch`, because `new
    // Response("", { status: 204 })` throws — which is the whole reason the
    // bodiless statuses are enumerated in the synthesis below.
    const fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof globalThis.fetch;
    const response = await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("scrubs the credential out of a body before the SDK ever parses it", async () => {
    const { fetch } = recordingFetch(JSON.stringify({ echo: VALUE }));
    const response = await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });
    const text = await response.text();

    expect(text).not.toContain(VALUE);
    expect(text).toContain("[redacted:github_pat]");
  });

  // The bound is asked per request and handed the verb, which is the one phase
  // marker the request itself carries: a DELETE is always session termination,
  // whatever phase the connection believes it is in. This is what lets close()
  // bound its DELETE at the control-plane size without flipping shared state
  // under a call still in flight.
  it("asks the bound per request, handing it the verb", async () => {
    const seen: string[] = [];
    const { fetch } = recordingFetch();
    const asked = guarded({
      fetch,
      maxBodyBytes: method => {
        seen.push(method);
        return 1024;
      }
    });
    await asked("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });
    await asked("http://mcp-github:3001/mcp", { method: "DELETE" });

    expect(seen).toEqual(["POST", "DELETE"]);
  });

  it("forwards the SDK's abort signal to the wire", async () => {
    const { calls, fetch } = recordingFetch();
    const controller = new AbortController();
    await guarded({ fetch })("http://mcp-github:3001/mcp", {
      method: "POST",
      body: "{}",
      signal: controller.signal
    });

    const wire = calls[0]?.init.signal;
    expect(wire).toBeInstanceOf(AbortSignal);
    expect(wire?.aborted).toBe(false);
    controller.abort();
    expect(wire?.aborted).toBe(true);
  });

  // The assertion this replaces had the guarded fetch itself reject. That was
  // true of the buffered read and is not a property anything depended on: the
  // bound is a fact about a body, and #156 made the body arrive after the
  // headers, so it cannot be known before the response resolves. What has to
  // hold — and what `http-dispatcher.test.ts` pins end to end — is that the
  // word reaching the channel is still `too_large`.
  it("reports an oversized answer as too_large on the body, not as a transport failure", async () => {
    const { fetch } = recordingFetch("x".repeat(64));
    const response = await guarded({ fetch, maxBodyBytes: 8 })("http://mcp-github:3001/mcp", {
      method: "POST",
      body: "{}"
    });

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({ failure: "too_large" });
  });

  // The half of streaming that is the point: a body is readable before the
  // upstream has finished sending it. Buffered, the first read would block
  // until `close()`.
  it("hands back a body that can be read before the upstream ends it", async () => {
    let push: ((chunk: string) => void) | undefined;
    let finish: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = chunk => controller.enqueue(encoder.encode(chunk));
        finish = () => controller.close();
      }
    });
    const fetch = (async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof globalThis.fetch;

    const response = await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });
    const reader = response.body!.getReader();

    push?.("event: message\ndata: {}\n\n");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("event: message\ndata: {}\n\n");

    // Only now does the upstream end its stream — the read above did not wait
    // for it, which is the whole of what #156 bought.
    finish?.();
    expect((await reader.read()).done).toBe(true);
  });

  it("redacts a credential split across two chunks of a streamed body", async () => {
    let push: ((chunk: string) => void) | undefined;
    let finish: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = chunk => controller.enqueue(encoder.encode(chunk));
        finish = () => controller.close();
      }
    });
    const fetch = (async () => new Response(body, { status: 200 })) as typeof globalThis.fetch;

    const response = await guarded({ fetch })("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });
    // `guarded` spends VALUE under the name `github_pat`; the upstream echoes
    // it back astride a
    // chunk boundary, which is the split a per-chunk scan would miss.
    const half = Math.floor(VALUE.length / 2);
    push?.(`{"echo":"${VALUE.slice(0, half)}`);
    push?.(`${VALUE.slice(half)}"}`);
    finish?.();

    const text = await response.text();
    expect(text).not.toContain(VALUE);
    expect(text).toBe(`{"echo":"${redactionMarker("github_pat")}"}`);
  });
});

describe("the session id", () => {
  it("keeps one the server is entitled to assign", () => {
    expect(readSessionId("session-1")).toBe("session-1");
    expect(readSessionId("1868a90c-9f2e-4b71-8c3d-0e5a1f6d2c47")).toBe("1868a90c-9f2e-4b71-8c3d-0e5a1f6d2c47");
  });

  // The value is upstream-authored and its only use is being written back into
  // an outbound request header, on the one path that also carries a credential.
  // A CR or LF in it is request smuggling; the spec's own rule — visible ASCII,
  // 0x21 to 0x7E — is the character set, so nothing here is invented.
  it.each([
    ["nothing at all", null],
    ["an empty string", ""],
    ["a header injection", "a\r\nX-Injected: 1"],
    ["a bare newline", "a\nb"],
    ["an embedded space", "a b"],
    ["a non-ASCII character", "café"],
    ["a NUL", "a\u0000b"],
    ["a DEL", "a\u007Fb"],
    ["more than a header may hold", "s".repeat(513)]
  ])("replays none for %s", (_label, header) => {
    expect(readSessionId(header)).toBeNull();
  });

  it("treats an unusable id as a server that assigned none", () => {
    // Not an error: the handshake still succeeded, and a legacy server that
    // assigns no session is an ordinary one rather than a broken one.
    expect(readSessionId("a b")).toBeNull();
    expect(readSessionId(null)).toBeNull();
  });
});

// The 401 path the CredentialSource seam adds (#256). It sits below the SDK so
// a connect-time rejection and a mid-call one take the identical path, and it
// is safe because a 401 means the upstream refused authentication and executed
// nothing.
describe("the one retry on a 401", () => {
  const sourceOf = (
    refresh: (rejected: number) => Promise<{ secret: Secret; generation: number } | null>
  ) => ({
    scheme: "oauth" as const,
    name: "notion_grant",
    acquire: () => Promise.resolve({ secret: secretOf("at_stale"), generation: 1 }),
    refresh
  });

  const fetch401Then200 = () => {
    const calls: { init: RequestInit }[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init ?? {} });
      return calls.length === 1 ? new Response("{}", { status: 401 }) : new Response("{}", { status: 200 });
    });
    return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
  };

  it("retries once with the successor and succeeds", async () => {
    const { calls, fetch } = fetch401Then200();
    const refreshed: number[] = [];
    const guarded = createGuardedFetch({
      url: "http://mcp-github:3001/mcp",
      source: sourceOf(rejected => {
        refreshed.push(rejected);
        return Promise.resolve({ secret: secretOf("at_fresh"), generation: 2 });
      }),
      fetch
    });

    const response = await guarded("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    // The rejected generation is what refresh is told, which is how a source
    // distinguishes a straggler from a fresh failure.
    expect(refreshed).toEqual([1]);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer at_stale");
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBe("Bearer at_fresh");
  });

  it("lets the 401 stand when the source has no successor", async () => {
    const { calls, fetch } = fetch401Then200();
    const guarded = createGuardedFetch({
      url: "http://mcp-github:3001/mcp",
      source: sourceOf(() => Promise.resolve(null)),
      fetch
    });

    const response = await guarded("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("never retries for a bearer source, whose refresh is null by construction", async () => {
    const { calls, fetch } = fetch401Then200();
    const guarded = createGuardedFetch({
      url: "http://mcp-github:3001/mcp",
      source: constantCredential("bearer", secretOf(VALUE), "github_pat"),
      fetch
    });

    const response = await guarded("http://mcp-github:3001/mcp", { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
  });
});

// The exchange (#256): the second reveal site, and the outbound call with the
// guard inverted — the reply is the credential, so it is returned to no
// caller. The issuer here is a loopback-shaped constant and the transport is a
// stub; the socket-level cases live in token-engine.test.ts against the fake
// issuer.
describe("the refresh-token exchange", () => {
  const ISSUER = "http://as.example";
  const REFRESH = "rt_live_do_not_log";

  const metadataResponse = (over: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({ issuer: ISSUER, token_endpoint: `${ISSUER}/token`, ...over }),
      { status: 200 }
    );
  const tokenResponse = (over: Record<string, unknown> = {}, status = 200) =>
    new Response(
      JSON.stringify({ access_token: "at_minted", token_type: "Bearer", expires_in: 3600, ...over }),
      { status }
    );

  /** A fetch answering discovery first, then the token endpoint. */
  const fetchSequence = (...responses: (() => Response)[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const answer = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (answer === undefined) throw new Error("fetch sequence exhausted");
      return answer();
    });
    return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
  };

  const requestOf = (
    fetch: typeof globalThis.fetch,
    over: Partial<Parameters<typeof exchangeRefreshToken>[0]> = {}
  ) => ({
    issuer: ISSUER,
    clientId: "https://getlibero.com/client.json",
    refreshToken: secretOf(REFRESH),
    credentialName: "notion_grant",
    persistRotation: async () => undefined,
    fetch,
    ...over
  });

  it("discovers at the well-known path and spends the refresh token at the token endpoint", async () => {
    const { calls, fetch } = fetchSequence(metadataResponse, () => tokenResponse());
    const minted = await exchangeRefreshToken(requestOf(fetch));

    expect(calls[0]?.url).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(calls[1]?.url).toBe(`${ISSUER}/token`);
    const form = new URLSearchParams(String(calls[1]?.init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH);
    expect(form.get("client_id")).toBe("https://getlibero.com/client.json");
    // Grant-time facts: the record's scopes are not re-asked at the exchange.
    expect(form.has("scope")).toBe(false);
    expect(minted.accessToken.reveal()).toBe("at_minted");
    expect(minted.expiresInSeconds).toBe(3600);
    expect(minted.rotated).toBe(false);
  });

  it("inserts the well-known path between host and path, per RFC 8414", async () => {
    const issuer = "http://as.example/tenant";
    const { calls, fetch } = fetchSequence(
      () => new Response(JSON.stringify({ issuer, token_endpoint: `${issuer}/token` }), { status: 200 }),
      () => tokenResponse()
    );
    await exchangeRefreshToken(requestOf(fetch, { issuer }));

    expect(calls[0]?.url).toBe("http://as.example/.well-known/oauth-authorization-server/tenant");
  });

  it("persists a rotation before the access token exists to be used", async () => {
    const order: string[] = [];
    const { fetch } = fetchSequence(metadataResponse, () => tokenResponse({ refresh_token: "rt_successor" }));
    const minted = await exchangeRefreshToken(
      requestOf(fetch, {
        persistRotation: async rotated => {
          order.push(`persisted:${rotated}`);
        }
      })
    );
    order.push("returned");

    expect(order).toEqual(["persisted:rt_successor", "returned"]);
    expect(minted.rotated).toBe(true);
  });

  it("fails the exchange when the rotation cannot be persisted", async () => {
    const { fetch } = fetchSequence(metadataResponse, () => tokenResponse({ refresh_token: "rt_successor" }));
    await expect(
      exchangeRefreshToken(
        requestOf(fetch, {
          persistRotation: () => Promise.reject(new Error("disk full"))
        })
      )
    ).rejects.toMatchObject({ failure: "rotation_unpersisted" });
  });

  // The issuer binding, both halves: metadata claiming another identity, and
  // metadata pointing the token endpoint off the issuer's origin. Either way
  // the refresh token goes nowhere — one fetch, not two.
  it("treats the grant as absent when discovery names a different issuer", async () => {
    const { calls, fetch } = fetchSequence(() => metadataResponse({ issuer: "http://other.example" }));
    await expect(exchangeRefreshToken(requestOf(fetch))).rejects.toMatchObject({ failure: "issuer_mismatch" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a token endpoint on another origin", async () => {
    const { calls, fetch } = fetchSequence(() =>
      metadataResponse({ token_endpoint: "http://elsewhere.example/token" })
    );
    await expect(exchangeRefreshToken(requestOf(fetch))).rejects.toMatchObject({ failure: "issuer_mismatch" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirected token request unread", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      new Response(null, { status: 302, headers: { location: "http://elsewhere.example/token" } })
    );
    await expect(exchangeRefreshToken(requestOf(fetch))).rejects.toMatchObject({ failure: "redirected" });
  });

  it("maps invalid_grant to its own failure, reading nothing else off the body", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: `leak ${REFRESH}` }), { status: 400 })
    );
    await expect(exchangeRefreshToken(requestOf(fetch))).rejects.toMatchObject({ failure: "invalid_grant" });
  });

  it("carries no byte of a failed exchange's body in what it throws", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      new Response(`boom ${REFRESH} at_secret_thing`, { status: 500 })
    );
    let thrown: unknown;
    try {
      await exchangeRefreshToken(requestOf(fetch));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ failure: "exchange_failed" });
    const seen = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))} ${(thrown as Error).stack ?? ""}`;
    expect(seen).not.toContain("boom");
    expect(seen).not.toContain(REFRESH);
  });

  it("refuses a token response missing its access token or mis-typing its lifetime", async () => {
    for (const body of [
      {},
      { access_token: "" },
      { access_token: "at", token_type: "mac" },
      { access_token: "at", token_type: "Bearer", expires_in: "soon" }
    ]) {
      const { fetch } = fetchSequence(metadataResponse, () => new Response(JSON.stringify(body), { status: 200 }));
      await expect(exchangeRefreshToken(requestOf(fetch))).rejects.toMatchObject({
        failure: "malformed_token_response"
      });
    }
  });

  it("bounds a token response at the control-plane cap", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      new Response("x".repeat(MAX_CONTROL_BODY_BYTES + 1), { status: 200 })
    );
    await expect(exchangeRefreshToken(requestOf(fetch))).rejects.toMatchObject({ failure: "too_large" });
  });
});

// The third exchange (#257): the grant flow's half, spending a single-use
// authorization code rather than a refresh token. Deliberately not a third
// reveal site — see the header — so nothing here wraps or opens a Secret.
describe("the authorization-code exchange", () => {
  const ISSUER = "http://as.example";
  const CODE = "code_pasted_do_not_log";
  const VERIFIER = "verifier_local_do_not_log";

  const metadataResponse = (over: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ issuer: ISSUER, token_endpoint: `${ISSUER}/token`, ...over }), { status: 200 });
  const tokenResponse = (over: Record<string, unknown> = {}, status = 200) =>
    new Response(
      JSON.stringify({
        access_token: "at_minted",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rt_granted",
        ...over
      }),
      { status }
    );

  const fetchSequence = (...responses: (() => Response)[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const answer = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (answer === undefined) throw new Error("fetch sequence exhausted");
      return answer();
    });
    return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
  };

  const requestOf = (
    fetch: typeof globalThis.fetch,
    over: Partial<Parameters<typeof exchangeAuthorizationCode>[0]> = {}
  ) => ({
    issuer: ISSUER,
    clientId: "https://getlibero.com/client.json",
    redirectUri: "http://127.0.0.1/callback",
    code: CODE,
    codeVerifier: VERIFIER,
    fetch,
    ...over
  });

  it("sends exactly the five code-exchange fields, no scope among them", async () => {
    const { calls, fetch } = fetchSequence(metadataResponse, () => tokenResponse());
    const granted = await exchangeAuthorizationCode(requestOf(fetch));

    expect(calls[0]?.url).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(calls[1]?.url).toBe(`${ISSUER}/token`);
    const form = new URLSearchParams(String(calls[1]?.init.body));
    expect([...form.keys()].sort()).toEqual(["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE);
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1/callback");
    expect(form.get("client_id")).toBe("https://getlibero.com/client.json");
    expect(form.get("code_verifier")).toBe(VERIFIER);
    expect(granted.refreshToken).toBe("rt_granted");
    expect(granted.grantedScope).toBeUndefined();
  });

  it("passes an absent refresh token and a granted scope through verbatim", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      tokenResponse({ refresh_token: undefined, scope: "read" })
    );
    const granted = await exchangeAuthorizationCode(requestOf(fetch));
    expect(granted.refreshToken).toBeUndefined();
    expect(granted.grantedScope).toBe("read");
  });

  it("treats the grant as absent when discovery names a different issuer, sending nothing", async () => {
    const { calls, fetch } = fetchSequence(() => metadataResponse({ issuer: "http://other.example" }));
    await expect(exchangeAuthorizationCode(requestOf(fetch))).rejects.toMatchObject({ failure: "issuer_mismatch" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a token endpoint on another origin, sending nothing", async () => {
    const { calls, fetch } = fetchSequence(() =>
      metadataResponse({ token_endpoint: "http://elsewhere.example/token" })
    );
    await expect(exchangeAuthorizationCode(requestOf(fetch))).rejects.toMatchObject({ failure: "issuer_mismatch" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirected token request unread", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      new Response(null, { status: 302, headers: { location: "http://elsewhere.example/token" } })
    );
    await expect(exchangeAuthorizationCode(requestOf(fetch))).rejects.toMatchObject({ failure: "redirected" });
  });

  it("maps invalid_grant to its own failure and everything else to exchange_failed", async () => {
    for (const [body, failure] of [
      [{ error: "invalid_grant" }, "invalid_grant"],
      [{ error: "invalid_client" }, "exchange_failed"]
    ] as const) {
      const { fetch } = fetchSequence(metadataResponse, () => new Response(JSON.stringify(body), { status: 400 }));
      await expect(exchangeAuthorizationCode(requestOf(fetch))).rejects.toMatchObject({ failure });
    }
  });

  it("carries no byte of a failed exchange's body in what it throws", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      new Response(`boom ${CODE} ${VERIFIER}`, { status: 500 })
    );
    let thrown: unknown;
    try {
      await exchangeAuthorizationCode(requestOf(fetch));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ failure: "exchange_failed" });
    const seen = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))} ${(thrown as Error).stack ?? ""}`;
    expect(seen).not.toContain("boom");
    expect(seen).not.toContain(CODE);
    expect(seen).not.toContain(VERIFIER);
  });

  it("refuses a malformed token response, a mis-typed refresh token or scope included", async () => {
    for (const body of [
      {},
      { access_token: "" },
      { access_token: "at", token_type: "mac" },
      { access_token: "at", token_type: "Bearer", expires_in: "soon" },
      { access_token: "at", token_type: "Bearer", refresh_token: 7 },
      { access_token: "at", token_type: "Bearer", scope: ["read"] }
    ]) {
      const { fetch } = fetchSequence(metadataResponse, () => new Response(JSON.stringify(body), { status: 200 }));
      await expect(exchangeAuthorizationCode(requestOf(fetch))).rejects.toMatchObject({
        failure: "malformed_token_response"
      });
    }
  });

  it("bounds a token response at the control-plane cap", async () => {
    const { fetch } = fetchSequence(metadataResponse, () =>
      new Response("x".repeat(MAX_CONTROL_BODY_BYTES + 1), { status: 200 })
    );
    await expect(exchangeAuthorizationCode(requestOf(fetch))).rejects.toMatchObject({ failure: "too_large" });
  });
});

// The widened discovery (#257): same binding rules as ever, plus the two
// members the grant flow reads — surfaced when well-typed, absent otherwise,
// never guessed at.
describe("the widened discovery", () => {
  const ISSUER = "http://as.example";

  const discoveryFetch = (body: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;

  it("surfaces the authorization endpoint and the challenge methods", async () => {
    const metadata = await discoverAuthorizationServer(
      discoveryFetch({
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/token`,
        authorization_endpoint: `${ISSUER}/authorize`,
        code_challenge_methods_supported: ["S256", "plain"]
      }),
      ISSUER,
      ISSUER,
      AbortSignal.timeout(1000)
    );
    expect(metadata.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(metadata.authorizationEndpoint).toBe(`${ISSUER}/authorize`);
    expect(metadata.codeChallengeMethodsSupported).toEqual(["S256", "plain"]);
  });

  it("reads an absent or mis-typed optional member as absent", async () => {
    for (const over of [
      {},
      { authorization_endpoint: 7, code_challenge_methods_supported: "S256" },
      { code_challenge_methods_supported: ["S256", 7] }
    ]) {
      const metadata = await discoverAuthorizationServer(
        discoveryFetch({ issuer: ISSUER, token_endpoint: `${ISSUER}/token`, ...over }),
        ISSUER,
        ISSUER,
        AbortSignal.timeout(1000)
      );
      expect(metadata.authorizationEndpoint).toBeUndefined();
      expect(metadata.codeChallengeMethodsSupported).toBeUndefined();
    }
  });
});
