// The tool client, faked at the transport seam.
//
// TLS is not here: a real handshake, a real certificate, and what the proxy
// makes of one are ./transport.test.ts, against a listener. This file is about
// what the client does with an answer once it has one — which is where the
// refusal path, the name mapping, and the request body live.

import { ToolCall as WireToolCall } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../completion/types.js";
import type { ToolCallAttribution } from "../loop/types.js";
import { createProxyToolClient } from "./tools.js";
import { ProxyClientError, type ProxyRequest, type ProxyResponse, type ProxyTransport } from "./transport.js";

const CHANNEL = "C024BE91L";

const ATTRIBUTION: ToolCallAttribution = {
  requestingUser: "U024BE7LH",
  taskId: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55"
};

const LISTING = {
  tools: [
    { server: "github", tool: "list_prs", approval: "none" },
    { server: "github", tool: "merge_pr", approval: "required" }
  ]
};

function fakeTransport(
  answers: {
    tools?: () => ProxyResponse | Promise<ProxyResponse>;
    call?: (body: unknown) => ProxyResponse | Promise<ProxyResponse>;
  } = {}
): { transport: ProxyTransport; sent: ProxyRequest[] } {
  const sent: ProxyRequest[] = [];
  return {
    sent,
    transport: {
      async request(options: ProxyRequest): Promise<ProxyResponse> {
        sent.push(options);
        if (options.path === "/v1/tools") {
          return (await answers.tools?.()) ?? { status: 200, body: LISTING };
        }
        return (
          (await answers.call?.(options.body)) ?? {
            status: 200,
            body: { outcome: "ran", id: "call-1", result: { content: "upstream said so" } }
          }
        );
      }
    }
  };
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: "call-1",
  name,
  arguments: args
});

/** Listed first, the way the loop does it, so the mapping exists. */
async function ready(
  answers: Parameters<typeof fakeTransport>[0] = {}
): Promise<{ client: ReturnType<typeof createProxyToolClient>; sent: ProxyRequest[] }> {
  const fake = fakeTransport(answers);
  const client = createProxyToolClient({ transport: fake.transport, channel: CHANNEL });
  await client.list();
  return { client, sent: fake.sent };
}

describe("listing the channel's tools", () => {
  it("asks the proxy and returns definitions for what it listed", async () => {
    const fake = fakeTransport();
    const client = createProxyToolClient({ transport: fake.transport, channel: CHANNEL });

    const definitions = await client.list();

    expect(fake.sent[0]).toMatchObject({ channel: CHANNEL, method: "GET", path: "/v1/tools" });
    expect(definitions.map(d => d.name)).toEqual(["list_prs", "merge_pr"]);
  });

  // The proxy already resolved the list against the channel's team sheet. A
  // second opinion here would either be dead code or would let the process
  // running the model decide what that model may reach.
  it("does not filter what the proxy listed", async () => {
    const fake = fakeTransport({
      tools: () => ({
        status: 200,
        body: { tools: [{ server: "github", tool: "force_push", approval: "required" }] }
      })
    });
    const client = createProxyToolClient({ transport: fake.transport, channel: CHANNEL });

    expect(await client.list()).toHaveLength(1);
  });

  it("returns nothing for a channel that permits nothing", async () => {
    const fake = fakeTransport({ tools: () => ({ status: 200, body: { tools: [] } }) });
    const client = createProxyToolClient({ transport: fake.transport, channel: CHANNEL });

    expect(await client.list()).toEqual([]);
  });

  // Throws rather than degrading to an empty list. An agent that answers as
  // though the channel had no tools looks like it worked.
  it("throws rather than pretending the channel has no tools", async () => {
    for (const answer of [
      { status: 500, body: undefined },
      { status: 200, body: { tools: [{ server: "github" }] } },
      { status: 200, body: { unexpected: true } },
      { status: 200, body: "not an object" }
    ]) {
      const fake = fakeTransport({ tools: () => answer });
      const client = createProxyToolClient({ transport: fake.transport, channel: CHANNEL });
      await expect(client.list()).rejects.toBeInstanceOf(ProxyClientError);
    }
  });

  it("relays the proxy's own message when it sent a ProxyError", async () => {
    const fake = fakeTransport({
      tools: () => ({
        status: 401,
        body: {
          error: {
            code: "unauthenticated",
            message: "the connection carries no channel identity",
            requestId: "req-1"
          }
        }
      })
    });
    const client = createProxyToolClient({ transport: fake.transport, channel: CHANNEL });

    await expect(client.list()).rejects.toThrow(/no channel identity/);
  });
});

describe("calling a tool", () => {
  it("sends the pair the model's name decodes to, with its arguments", async () => {
    const { client, sent } = await ready();

    await client.execute(call("list_prs", { state: "open" }), ATTRIBUTION);

    expect(sent[1]).toMatchObject({ channel: CHANNEL, method: "POST", path: "/v1/tools/call" });
    expect(sent[1]?.body).toEqual({
      id: "call-1",
      server: "github",
      tool: "list_prs",
      arguments: { state: "open" },
      requestingUser: "U024BE7LH",
      task: "b9d5a2f0-1c4e-4a7f-9b3d-2e6c8a1f0d55"
    });
  });

  // The channel comes from the certificate the transport presents. A field in
  // the body would be a channel the process running the model chose, and the
  // proxy rejects one anyway — `ToolCall` is strict.
  it("puts no channel in the request body", async () => {
    const { client, sent } = await ready();

    await client.execute(call("list_prs"), ATTRIBUTION);

    expect(Object.keys(sent[1]?.body as object)).not.toContain("channel");
    expect(JSON.stringify(sent[1]?.body)).not.toContain(CHANNEL);
  });

  it("returns what the tool produced", async () => {
    const { client } = await ready();

    await expect(client.execute(call("list_prs"), ATTRIBUTION)).resolves.toEqual({
      content: "upstream said so",
      isError: false
    });
  });

  it("passes an upstream failure back as an error result the model can see", async () => {
    const { client } = await ready({
      call: () => ({
        status: 200,
        body: { outcome: "ran", id: "call-1", result: { content: "404 no such repo", isError: true } }
      })
    });

    await expect(client.execute(call("list_prs"), ATTRIBUTION)).resolves.toEqual({
      content: "404 no such repo",
      isError: true
    });
  });
});

// A refusal is a served request and a normal result. The task carries on and
// the model relays it — that is the whole reason `ToolCallResponse` is not a
// `ProxyError`.
describe("a call the proxy would not run", () => {
  const answer = (outcome: "refused" | "held", refusal: unknown): ProxyResponse => ({
    status: 200,
    body: { outcome, id: "call-1", refusal }
  });

  it("relays a refusal as error content rather than throwing", async () => {
    const { client } = await ready({
      call: () => answer("refused", { reason: "tool_not_allowed", server: "github", tool: "force_push" })
    });

    const result = await client.execute(call("list_prs"), ATTRIBUTION);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("but not the tool `force_push`");
  });

  it("relays a hold, and says it is held", async () => {
    const { client } = await ready({
      call: () => answer("held", { reason: "approval_required", server: "github", tool: "merge_pr" })
    });

    const result = await client.execute(call("merge_pr"), ATTRIBUTION);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires approval");
    expect(result.content).toContain("The call is held.");
  });

  it("words every refusal from the proxy's reason, never from prose it sent", async () => {
    for (const refusal of [
      { reason: "no_team_sheet" },
      { reason: "budget_exhausted", limit: "daily_tool_calls" },
      { reason: "credential_unresolved", credential: "github_token" },
      { reason: "egress_denied", destination: "api.example.com" }
    ]) {
      const { client } = await ready({ call: () => answer("refused", refusal) });
      const result = await client.execute(call("list_prs"), ATTRIBUTION);
      expect(result.isError).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    }
  });
});

// The two ends never meet in this file — the proxy is a package this one may
// not import, and both processes running for real is the e2e suite's job (#41).
// What they do share is @getlibero/schema, and it is the proxy's edge parse. So
// the substitute for standing up the real server is to put the bytes this
// client sends through the exact schema that server parses them with: a body
// that fails here is a 400 there.
describe("the contract the proxy will parse", () => {
  it("sends a body that satisfies the schema the proxy validates against", async () => {
    const { client, sent } = await ready();

    await client.execute(call("merge_pr", { pr: 42, note: "ship it" }), ATTRIBUTION);

    const parsed = WireToolCall.safeParse(sent[1]?.body);
    expect(parsed.success).toBe(true);
  });

  // Strict on the other side, so a field this client adds without thinking is a
  // 400 rather than something silently dropped. This is the test that fails
  // when someone puts the channel in the body.
  it("sends no field the schema does not name", async () => {
    const { client, sent } = await ready();

    await client.execute(call("list_prs"), ATTRIBUTION);

    expect(Object.keys(sent[1]?.body as object).sort()).toEqual([
      "arguments",
      "id",
      "requestingUser",
      "server",
      "task",
      "tool"
    ]);
  });

  it("passes the model's arguments through without reshaping them", async () => {
    const args = { nested: { deep: [1, "two", null] }, count: 3 };
    const { client, sent } = await ready();

    await client.execute(call("list_prs", args), ATTRIBUTION);

    expect(WireToolCall.parse(sent[1]?.body).arguments).toEqual(args);
  });
});

describe("a name the model made up", () => {
  // Decoding is a map lookup, so an unknown name has no pair to become. The
  // proxy is never asked about a tool it did not publish.
  it("is refused here, and no request is sent", async () => {
    const { client, sent } = await ready();

    const result = await client.execute(call("force_push"), ATTRIBUTION);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not a tool this channel permits");
    expect(sent).toHaveLength(1);
  });

  // The names in a listing are the only keys in the map, so a model cannot
  // reach a pair by writing one out — there is no separator to exploit because
  // there is no parse.
  it("cannot be steered into a pair by writing one out", async () => {
    const { client, sent } = await ready();

    for (const invented of ["github.list_prs", "github__list_prs", "github/list_prs", "list_prs "]) {
      const result = await client.execute(call(invented), ATTRIBUTION);
      expect(result.isError).toBe(true);
    }
    expect(sent).toHaveLength(1);
  });

  it("is refused before the client has listed anything", async () => {
    const fake = fakeTransport();
    const client = createProxyToolClient({ transport: fake.transport, channel: CHANNEL });

    const result = await client.execute(call("list_prs"), ATTRIBUTION);

    expect(result.isError).toBe(true);
    expect(fake.sent).toEqual([]);
  });
});

describe("a call the proxy could not answer", () => {
  // Thrown, not returned — and the loop turns it into an error result of its
  // own, so even this does not drop the task.
  it("throws for a non-200 and for an answer that does not parse", async () => {
    for (const answer of [
      { status: 500, body: undefined },
      { status: 200, body: { outcome: "maybe", id: "call-1" } },
      { status: 200, body: { outcome: "ran", id: "call-1" } }
    ]) {
      const { client } = await ready({ call: () => answer });
      await expect(client.execute(call("list_prs"), ATTRIBUTION)).rejects.toBeInstanceOf(
        ProxyClientError
      );
    }
  });

  it("carries no response body into the error it raises", async () => {
    const { client } = await ready({
      call: () => ({ status: 500, body: { secret: "ghp_should_not_appear" } })
    });

    await expect(client.execute(call("list_prs"), ATTRIBUTION)).rejects.toThrow(
      /^proxy client: the tool call failed$/
    );
  });
});
