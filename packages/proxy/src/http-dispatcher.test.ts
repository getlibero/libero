import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer, ResolvedToolCall } from "@getlibero/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpDispatcher, toolRequestBody } from "./http-dispatcher.js";
import { createJsonLogger } from "./log.js";
import { RedactionError } from "./redact.js";
import type { CredentialLookup, Secret, Vault } from "./vault.js";

// A real socket rather than a stubbed `fetch`, because the claim under test is
// that the credential arrives at the far end of one. Loopback, port 0, and no
// dependency — the same shape server.test.ts uses.

const SECRET = "ghp_live_token_do_not_leak";
const CRED = "github_service_account";

/** What the mock upstream saw, per request. */
interface Received {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

let upstream: Server;
let received: Received[] = [];
let origin = "";
/** Set per-test to control what the mock answers. */
let respond: (body: string) => { status: number; body: string } = () => ({ status: 200, body: "{}" });
/** When true the mock reflects its request headers into the response body. */
let upstreamEchoesHeaders = false;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ authorization: req.headers.authorization, body, headers: req.headers });
      const answer = respond(body);
      res.writeHead(answer.status, { "content-type": "application/json" });
      // The echoing upstream: reflects every header it received, the way a
      // debug endpoint or a verbose error handler does.
      res.end(upstreamEchoesHeaders ? `${answer.body} ${JSON.stringify(req.headers)}` : answer.body);
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => upstream.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  respond = () => ({ status: 200, body: "{}" });
  upstreamEchoesHeaders = false;
});

function secretOf(value: string): Secret {
  return Object.freeze({ reveal: () => value, toJSON: () => "[redacted]", toString: () => "[redacted]" }) as Secret;
}

/** A vault holding one entry, with the real one's API and no listing. */
function vaultOf(entries: Record<string, string>): Vault {
  return {
    lookup(name: string): CredentialLookup {
      const value = Object.hasOwn(entries, name) ? entries[name] : undefined;
      return value === undefined ? { status: "missing" } : { status: "found", secret: secretOf(value) };
    },
    get size() {
      return Object.keys(entries).length;
    }
  };
}

function callTo(tool = "list_prs"): ResolvedToolCall {
  return {
    id: "toolu_01",
    server: "github",
    tool,
    arguments: { state: "open" },
    requestingUser: "U0ASKER",
    task: "b9d5a2f0-0000-4000-8000-000000000001",
    channel: "C0ENGINEERING"
  };
}

/**
 * An http upstream. `url` is required by the type, not by convention — the
 * schema discriminates on transport (#89), so an http block with no address is
 * rejected at load and there is no such value to build here.
 */
function serverAt(
  url: string,
  overrides: Partial<Pick<McpServer, "name" | "credential" | "tool">> = {}
): McpServer {
  return {
    name: "github",
    transport: "http",
    url,
    credential: CRED,
    tool: [{ name: "list_prs" }],
    ...overrides
  };
}

/** A stdio upstream: a process, so no address at all. */
function stdioServer(): McpServer {
  return { name: "github", transport: "stdio", credential: CRED, tool: [{ name: "list_prs" }] };
}

/** Captures every log line the dispatcher writes, for the leak assertions. */
function capturingLogger(): { lines: string[]; logger: ReturnType<typeof createJsonLogger> } {
  const lines: string[] = [];
  return { lines, logger: createJsonLogger(line => lines.push(line)) };
}

describe("serving a call", () => {
  it("delivers the real secret to the upstream", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(origin));

    expect(result).toEqual({ outcome: "ran", result: { content: "{}", isError: false } });
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("sends the tool and its arguments, and no channel or attribution", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    await dispatcher.dispatch(callTo(), serverAt(origin));

    expect(JSON.parse(received[0]?.body ?? "{}")).toEqual({ tool: "list_prs", arguments: { state: "open" } });
    expect(received[0]?.body).not.toContain("C0ENGINEERING");
    // Who asked and which task is ours to audit, not a third party's to learn.
    // The upstream is somebody else's service and its logs are somebody else's
    // logs; a Slack user id landing in them is a leak with no upside (#95).
    expect(received[0]?.body).not.toContain("U0ASKER");
    expect(received[0]?.body).not.toContain("b9d5a2f0");
  });

  it("builds the body from the call and nothing else", () => {
    expect(toolRequestBody(callTo("get_issue"))).toEqual({ tool: "get_issue", arguments: { state: "open" } });
  });

  it("omits the header entirely for an upstream with no credential", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}) });
    const upstreamWithoutCredential: McpServer = {
      name: "internal",
      transport: "http",
      url: origin,
      tool: [{ name: "list_prs" }]
    };
    const result = await dispatcher.dispatch(callTo(), upstreamWithoutCredential);

    expect(result.outcome).toBe("ran");
    expect(received[0]?.authorization).toBeUndefined();
  });

  // A 404 from a tool is a result the model may recover from, not a refusal
  // (nothing was denied) and not a proxy error (nothing broke).
  it("passes a non-2xx back as an error result, not a refusal", async () => {
    respond = () => ({ status: 404, body: "no such repo" });
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), serverAt(origin))).toEqual({
      outcome: "ran",
      result: { content: "no such repo", isError: true }
    });
  });
});

describe("a credential the vault cannot resolve", () => {
  it("refuses by name", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ other: SECRET }) });

    expect(await dispatcher.dispatch(callTo(), serverAt(origin))).toEqual({
      outcome: "refused",
      refusal: { reason: "credential_unresolved", credential: CRED }
    });
  });

  // The acceptance criterion that matters most here: the refusal happens before
  // anything is opened, so the upstream never learns the call existed.
  it("opens no connection", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({}) });
    await dispatcher.dispatch(callTo(), serverAt(origin));
    expect(received).toEqual([]);
  });

  it("logs the credential by name and never a value", async () => {
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(origin, { credential: "absent_credential" }));

    expect(lines.join("")).toContain("absent_credential");
    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("an upstream that cannot be served", () => {
  it("answers unavailable for a stdio transport, which is not a denial", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    expect(await dispatcher.dispatch(callTo(), stdioServer())).toEqual({ outcome: "unavailable" });
    expect(received).toEqual([]);
  });

  it("resolves no credential for an upstream it cannot serve", async () => {
    let looked = 0;
    const counting: Vault = {
      lookup: () => {
        looked += 1;
        return { status: "missing" };
      },
      size: 0
    };
    await createHttpDispatcher({ vault: counting }).dispatch(callTo(), stdioServer());
    expect(looked).toBe(0);
  });
});

describe("an upstream that does not answer", () => {
  it("reports a timeout as an error result rather than throwing", async () => {
    const hang = createServer(() => {
      /* accept and never respond */
    });
    await new Promise<void>(resolve => hang.listen(0, "127.0.0.1", resolve));
    const hangOrigin = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;

    try {
      const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), timeoutMs: 50 });
      const result = await dispatcher.dispatch(callTo(), serverAt(hangOrigin));

      expect(result.outcome).toBe("ran");
      expect(result.outcome === "ran" && result.result.isError).toBe(true);
      expect(result.outcome === "ran" && result.result.content).toContain("timed_out");
    } finally {
      hang.closeAllConnections();
      await new Promise<void>(resolve => hang.close(() => resolve()));
    }
  });

  it("reports an unreachable upstream without leaking the credential", async () => {
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    // Port 1 on loopback: nothing listens, so the connection is refused.
    const result = await dispatcher.dispatch(callTo(), serverAt("http://127.0.0.1:1"));

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(lines.join("")).toContain("unreachable");
    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("what the proxy writes down", () => {
  it("logs the destination host and the credential name, never the value", async () => {
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(origin));

    const written = lines.join("");
    expect(written).toContain("127.0.0.1");
    expect(written).toContain(CRED);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("ghp_");
    expect(written).not.toContain("Bearer");
  });

  it("keeps an echoing upstream out of the log", async () => {
    respond = body => ({ status: 200, body: `echo ${body} auth was leaked` });
    const { lines, logger } = capturingLogger();
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }), logger });
    await dispatcher.dispatch(callTo(), serverAt(origin));

    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("an upstream that echoes its own auth header", () => {
  // The leak class the redaction pass exists to close. The mock reflects every
  // header it received, which is what a debug endpoint or a verbose error
  // handler does in practice.
  it("does not hand the value back in the result", async () => {
    respond = () => ({ status: 200, body: "" });
    upstreamEchoesHeaders = true;
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(origin));

    expect(result.outcome).toBe("ran");
    const content = result.outcome === "ran" ? result.result.content : "";
    // The upstream really did receive it — otherwise this asserts nothing.
    expect(received[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(content).toContain("[redacted:github_service_account]");
    expect(content).not.toContain(SECRET);
    expect(content).not.toContain("ghp_");
  });

  it("scrubs it out of an error body too", async () => {
    respond = body => ({ status: 500, body: `request failed: ${body}` });
    upstreamEchoesHeaders = true;
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt(origin));

    expect(result.outcome === "ran" && result.result.isError).toBe(true);
    expect(result.outcome === "ran" && result.result.content).not.toContain(SECRET);
  });
});

describe("fail-closed", () => {
  // A redaction that cannot be performed must not be converted into a served
  // result. It has to escape the catch that handles transport failures.
  it("rethrows a redaction failure instead of answering with a result", async () => {
    // An empty stored value: rejected by `vault set`, reachable only from a
    // corrupt or hand-edited vault, and exactly the case where quiet nonsense
    // would be worse than no answer.
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: "" }) });

    await expect(dispatcher.dispatch(callTo(), serverAt(origin))).rejects.toBeInstanceOf(RedactionError);
  });

  it("still converts a transport failure into a result, which is a tool failing", async () => {
    const dispatcher = createHttpDispatcher({ vault: vaultOf({ [CRED]: SECRET }) });
    const result = await dispatcher.dispatch(callTo(), serverAt("http://127.0.0.1:1"));

    expect(result.outcome).toBe("ran");
    expect(result.outcome === "ran" && result.result.isError).toBe(true);
  });
});
