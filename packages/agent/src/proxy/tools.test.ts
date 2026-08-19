// The tool client, faked at the transport seam.
//
// TLS is not here: a real handshake, a real certificate, and what the proxy
// makes of one are ./transport.test.ts, against a listener. This file is about
// what the client does with an answer once it has one — which is where the
// refusal path, the name mapping, and the request body live.

import { ToolCall as WireToolCall, type BudgetWarning } from "@getlibero/schema";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../completion/types.js";
import type { ToolCallAttribution } from "../loop/types.js";
import {
  createProxyToolClient,
  type HeldCallOutcome,
  type HeldCallPrompter,
  type HeldToolCall,
  type UnmappedToolCall
} from "./tools.js";
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
  answers: Parameters<typeof fakeTransport>[0] = {},
  onHeld?: HeldCallPrompter
): Promise<{ client: ReturnType<typeof createProxyToolClient>; sent: ProxyRequest[] }> {
  const fake = fakeTransport(answers);
  const client = createProxyToolClient({
    transport: fake.transport,
    channel: CHANNEL,
    ...(onHeld !== undefined ? { onHeld } : {})
  });
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
  // A hold carries the ticket that makes it answerable; a refusal does not.
  // Without a prompter the client still relays both as error content —
  // abandoning a call a human could have approved, which is the safe default
  // for a composition that gave it nothing to ask a human through.
  const answer = (outcome: "refused" | "held", refusal: unknown): ProxyResponse => ({
    status: 200,
    body: {
      outcome,
      id: "call-1",
      refusal,
      ...(outcome === "held" ? { ticket: { id: "tk-7f3a", expiresAt: Date.UTC(2026, 7, 4, 12, 15) } } : {})
    }
  });

  it("relays a refusal as error content rather than throwing", async () => {
    const { client } = await ready({
      call: () => answer("refused", { reason: "tool_not_allowed", server: "github", tool: "force_push" })
    });

    const result = await client.execute(call("list_prs"), ATTRIBUTION);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("but not the tool `force_push`");
  });

  it("relays a hold as held when no prompter was given", async () => {
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

// The wait, the re-submission, and what the model is finally shown. The
// prompter is a recorded stub here — the card, the click, and the clock live in
// apps/server, on the other side of the `HeldCallPrompter` seam.
describe("a held call with a prompter", () => {
  const TICKET = { id: "tk-7f3a", expiresAt: Date.UTC(2026, 7, 4, 12, 15) };

  const HELD: ProxyResponse = {
    status: 200,
    body: {
      outcome: "held",
      id: "call-1",
      refusal: { reason: "approval_required", server: "github", tool: "merge_pr" },
      ticket: TICKET
    }
  };

  const RAN: ProxyResponse = {
    status: 200,
    body: { outcome: "ran", id: "call-1", result: { content: "merged #42" } }
  };

  const refusedWith = (reason: string): ProxyResponse => ({
    status: 200,
    body: {
      outcome: "refused",
      id: "call-1",
      refusal: { reason, server: "github", tool: "merge_pr" }
    }
  });

  /** Held on the first submission, `second` on the one carrying the ticket. */
  const heldThen =
    (second: ProxyResponse) =>
    (body: unknown): ProxyResponse =>
      (body as { ticket?: string }).ticket === undefined ? HELD : second;

  it("hands the prompter the pair, the arguments, the ticket, and the attribution", async () => {
    const seen: HeldToolCall[] = [];
    const { client } = await ready({ call: heldThen(RAN) }, async held => {
      seen.push(held);
    });

    await client.execute(call("merge_pr", { pr: 42 }), ATTRIBUTION);

    expect(seen).toEqual([
      {
        server: "github",
        tool: "merge_pr",
        arguments: { pr: 42 },
        ticket: TICKET,
        requestingUser: ATTRIBUTION.requestingUser,
        taskId: ATTRIBUTION.taskId
      }
    ]);
  });

  it("does not re-submit until the prompter resolves", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { client, sent } = await ready({ call: heldThen(RAN) }, () => gate);

    const pending = client.execute(call("merge_pr", { pr: 42 }), ATTRIBUTION);
    // The listing and the first submission, and nothing more while the wait is
    // open — the re-submission is what the wait is for.
    await Promise.resolve();
    expect(sent).toHaveLength(2);

    release?.();
    await expect(pending).resolves.toEqual({ content: "merged #42", isError: false });
    expect(sent).toHaveLength(3);
  });

  // Identical is load-bearing: redemption matches server, tool, and the
  // argument hash, so any drift turns an approval into a mismatch refusal.
  it("re-submits the identical body plus the ticket", async () => {
    const { client, sent } = await ready({ call: heldThen(RAN) }, async () => {});

    await client.execute(call("merge_pr", { pr: 42, note: "ship it" }), ATTRIBUTION);

    const first = sent[1]?.body as Record<string, unknown>;
    const second = sent[2]?.body as Record<string, unknown>;
    expect(second).toEqual({ ...first, ticket: TICKET.id });
    expect(WireToolCall.safeParse(second).success).toBe(true);
  });

  it("returns the real result when the re-submission ran", async () => {
    const { client } = await ready({ call: heldThen(RAN) }, async () => {});

    await expect(client.execute(call("merge_pr"), ATTRIBUTION)).resolves.toEqual({
      content: "merged #42",
      isError: false
    });
  });

  // The prompter resolves on a deny and on an expiry too — the re-submission is
  // the authority, and the proxy answers each with its precise refusal.
  it("hands the model the denial the proxy wrote", async () => {
    const { client } = await ready({ call: heldThen(refusedWith("approval_denied")) }, async () => {});

    const result = await client.execute(call("merge_pr"), ATTRIBUTION);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("A human declined `github.merge_pr`");
  });

  it("hands the model the expiry the proxy wrote", async () => {
    const { client } = await ready({ call: heldThen(refusedWith("approval_expired")) }, async () => {});

    const result = await client.execute(call("merge_pr"), ATTRIBUTION);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("expired before the call was made");
  });

  // The model sees one tool result either way, and never the ticket id: the
  // ticket travels in the wire body and the card's button, and a model that
  // could quote one could social-engineer a human about it.
  it("never shows the model the ticket id", async () => {
    for (const second of [RAN, refusedWith("approval_denied"), refusedWith("approval_expired")]) {
      const { client } = await ready({ call: heldThen(second) }, async () => {});
      const result = await client.execute(call("merge_pr"), ATTRIBUTION);
      expect(result.content).not.toContain(TICKET.id);
    }
  });

  // #143's half of the contract: a prompter that asked to be told what its
  // approval produced is told, with the proxy's own answer and nothing derived
  // from it here.
  describe("telling the prompter what the re-submission became", () => {
    it("says `ran` when the call ran", async () => {
      const told: HeldCallOutcome[] = [];
      const { client } = await ready({ call: heldThen(RAN) }, async () => outcome => {
        told.push(outcome);
      });

      await client.execute(call("merge_pr", { pr: 42 }), ATTRIBUTION);

      expect(told).toEqual([{ state: "ran" }]);
    });

    it("relays the refusal verbatim when an approved call was refused anyway", async () => {
      const told: HeldCallOutcome[] = [];
      const { client } = await ready(
        { call: heldThen(refusedWith("tool_not_allowed")) },
        async () => outcome => {
          told.push(outcome);
        }
      );

      await client.execute(call("merge_pr"), ATTRIBUTION);

      expect(told).toEqual([
        { state: "refused", refusal: { reason: "tool_not_allowed", server: "github", tool: "merge_pr" } }
      ]);
    });

    it("is told exactly once, and the model's result is unchanged either way", async () => {
      let calls = 0;
      const { client } = await ready({ call: heldThen(RAN) }, async () => () => {
        calls += 1;
      });

      // The same assertion the no-completion case makes above, which is the
      // acceptance criterion: #143 touches the card and nothing the model sees.
      await expect(client.execute(call("merge_pr"), ATTRIBUTION)).resolves.toEqual({
        content: "merged #42",
        isError: false
      });
      expect(calls).toBe(1);
    });

    // A prompter that returns nothing is #127's, and still what a front-end
    // with nothing to repaint wants.
    it("is optional: a prompter resolving to nothing behaves exactly as before", async () => {
      const { client, sent } = await ready({ call: heldThen(RAN) }, async () => {});

      await expect(client.execute(call("merge_pr"), ATTRIBUTION)).resolves.toEqual({
        content: "merged #42",
        isError: false
      });
      expect(sent).toHaveLength(3);
    });

    // A wait that failed has said it is not waiting for this. Calling a
    // completion it never handed back is not possible, and the re-submission
    // still happens.
    it("is not called when the prompter rejected", async () => {
      let calls = 0;
      const { client, sent } = await ready({ call: heldThen(RAN) }, async () => {
        calls += 1;
        throw new Error("the card could not be posted");
      });

      await client.execute(call("merge_pr"), ATTRIBUTION);

      expect(calls).toBe(1);
      expect(sent).toHaveLength(3);
    });
  });

  // A rejection means the wait ended badly rather than well; either way it
  // ended. The re-submission is still made, and the proxy's answer — not the
  // prompter's error — is the whole of what the model sees.
  it("re-submits after a prompter rejection, and none of its text reaches the model", async () => {
    const { client, sent } = await ready({ call: heldThen(refusedWith("approval_pending")) }, async () => {
      throw new Error("xoxb-nothing-from-here-may-leak");
    });

    const result = await client.execute(call("merge_pr"), ATTRIBUTION);

    expect(sent).toHaveLength(3);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("has not been decided yet");
    expect(result.content).not.toContain("xoxb-nothing-from-here-may-leak");
  });

  // The wait spends the task's wall clock by design, and the deadline composed
  // into the signal is what ends it: the prompter settles, the re-submission
  // carries the aborted signal, and the transport's rejection is what the loop
  // turns into the task's stop reason. The wait itself decides nothing.
  it("rejects as cancelled when the signal aborts during the wait", async () => {
    const aborter = new AbortController();
    const sent: ProxyRequest[] = [];
    const transport: ProxyTransport = {
      async request(options: ProxyRequest): Promise<ProxyResponse> {
        sent.push(options);
        if (options.signal?.aborted) {
          throw new ProxyClientError("proxy client: cancelled", "cancelled");
        }
        if (options.path === "/v1/tools") return { status: 200, body: LISTING };
        return HELD;
      }
    };
    const client = createProxyToolClient({
      transport,
      channel: CHANNEL,
      onHeld: async (_held, signal) => {
        // The prompter's contract on abort: settle — repaint its card, resolve
        // — and let the re-submission say what the abort meant. A listener on
        // an already-aborted signal never fires, so the check comes first.
        if (signal?.aborted) return;
        await new Promise<void>(resolve => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    });
    await client.list();

    const pending = client.execute(call("merge_pr"), ATTRIBUTION, aborter.signal);
    await Promise.resolve();
    aborter.abort();

    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    expect(sent).toHaveLength(3);
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

// Without this the refusal is the one in the system only the model ever sees:
// the proxy never saw the call and writes no audit row for it, correctly. A
// model can otherwise probe fifty names against a task that looks, from the
// audit log, like it made no tool calls at all (#170).
describe("reporting a name the model made up", () => {
  /** As `ready`, plus the reporting seam and what it collected. */
  async function watching(): Promise<{
    client: ReturnType<typeof createProxyToolClient>;
    sent: ProxyRequest[];
    reported: UnmappedToolCall[];
  }> {
    const fake = fakeTransport();
    const reported: UnmappedToolCall[] = [];
    const client = createProxyToolClient({
      transport: fake.transport,
      channel: CHANNEL,
      onUnmappedCall: unmapped => void reported.push(unmapped)
    });
    await client.list();
    return { client, sent: fake.sent, reported };
  }

  it("reports the name and the attribution, once", async () => {
    const { client, reported } = await watching();

    await client.execute(call("force_push", { repo: "libero" }), ATTRIBUTION);

    expect(reported).toEqual([
      {
        name: "force_push",
        requestingUser: ATTRIBUTION.requestingUser,
        taskId: ATTRIBUTION.taskId
      }
    ]);
  });

  // Every probe, not the first one — the shape of the attack is the fiftieth
  // name, so a report that deduplicated would hide exactly what it exists for.
  it("reports every attempt", async () => {
    const { client, reported } = await watching();

    for (const invented of ["github.list_prs", "github__list_prs", "force_push", "force_push"]) {
      await client.execute(call(invented), ATTRIBUTION);
    }

    expect(reported.map(unmapped => unmapped.name)).toEqual([
      "github.list_prs",
      "github__list_prs",
      "force_push",
      "force_push"
    ]);
  });

  // This records what the proxy never saw. A call it did see is its own to
  // audit, and reporting it here would double-count one refusal across two
  // systems that are supposed to be describing different things.
  it("says nothing about a call the proxy answered", async () => {
    const fake = fakeTransport({
      call: () => ({
        status: 200,
        body: {
          outcome: "refused",
          id: "call-1",
          refusal: { reason: "budget_exhausted", limit: "daily_tool_calls" }
        }
      })
    });
    const reported: UnmappedToolCall[] = [];
    const client = createProxyToolClient({
      transport: fake.transport,
      channel: CHANNEL,
      onUnmappedCall: unmapped => void reported.push(unmapped)
    });
    await client.list();

    const ran = await client.execute(call("list_prs"), ATTRIBUTION);
    const refused = await client.execute(call("merge_pr"), ATTRIBUTION);

    expect(ran.isError).toBe(true);
    expect(refused.isError).toBe(true);
    expect(reported).toEqual([]);
  });

  // A front-end with nowhere to put the line is the pre-#170 composition, and
  // it must still refuse identically: this seam records, and never decides.
  it("changes nothing when no one is listening", async () => {
    const { client, sent } = await ready();

    const result = await client.execute(call("force_push"), ATTRIBUTION);

    expect(result).toEqual({
      content: "`force_push` is not a tool this channel permits. The call was not made.",
      isError: true
    });
    expect(sent).toHaveLength(1);
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

// The soft budget warning the proxy hands back on a served call (#99). This
// client's whole share of it is to pass it out: it does not word it, does not
// decide whether it should have arrived, and does not show it to the model.
describe("relaying the soft budget warning", () => {
  const WARNING = { limit: "daily_tool_calls", spent: 320, cap: 400 } as const;

  /** As `ready`, plus the warning seam and what it collected. */
  async function watching(
    answers: Parameters<typeof fakeTransport>[0] = {},
    onHeld?: HeldCallPrompter
  ): Promise<{
    client: ReturnType<typeof createProxyToolClient>;
    warnings: BudgetWarning[];
  }> {
    const fake = fakeTransport(answers);
    const warnings: BudgetWarning[] = [];
    const client = createProxyToolClient({
      transport: fake.transport,
      channel: CHANNEL,
      onBudgetWarning: warning => void warnings.push(warning),
      ...(onHeld !== undefined ? { onHeld } : {})
    });
    await client.list();
    return { client, warnings };
  }

  it("passes on a warning that came back with a result", async () => {
    const { client, warnings } = await watching({
      call: () => ({
        status: 200,
        body: { outcome: "ran", id: "call-1", result: { content: "ok" }, warning: WARNING }
      })
    });

    const result = await client.execute(call("list_prs"), ATTRIBUTION);

    // The result is untouched: a notice is not an error and does not change
    // what the model is handed.
    expect(result).toEqual({ content: "ok", isError: false });
    expect(warnings).toEqual([WARNING]);
  });

  // The ordinary case. Most calls are nowhere near a limit, and a channel that
  // has already been told today is not told again — both arrive here as an
  // answer with no warning on it.
  it("says nothing when the answer carries none", async () => {
    const { client, warnings } = await watching();
    await client.execute(call("list_prs"), ATTRIBUTION);
    expect(warnings).toEqual([]);
  });

  // The proxy decides on the call it serves, and an approved call is served by
  // the re-submission — so that is where its warning arrives.
  it("passes on a warning that came back with an approved call", async () => {
    let asked = 0;
    const { client, warnings } = await watching({
      call: () => {
        asked += 1;
        return asked === 1
          ? {
              status: 200,
              body: {
                outcome: "held",
                id: "call-1",
                refusal: { reason: "approval_required", server: "github", tool: "merge_pr" },
                ticket: { id: "apr_01JQ0000000000000000000000", expiresAt: Date.now() + 60_000 }
              }
            }
          : {
              status: 200,
              body: { outcome: "ran", id: "call-1", result: { content: "merged" }, warning: WARNING }
            };
      }
    },
    // A prompter, so the hold is waited out and re-submitted rather than
    // relayed as a refusal. What it does with the card is ../approvals'.
    async () => {}
    );

    const result = await client.execute(call("merge_pr"), ATTRIBUTION);

    expect(result).toEqual({ content: "merged", isError: false });
    expect(warnings).toEqual([WARNING]);
  });

  // A refusal is an answer about a call that did not happen, and there is no
  // field on one to carry a notice. This client relays whatever it is handed,
  // so what makes that true is the shape: `ToolCallResponse` is strict, and a
  // refusal wearing a warning does not parse at all.
  it("cannot be handed a warning on a refusal", async () => {
    const { client, warnings } = await watching({
      call: () => ({
        status: 200,
        body: {
          outcome: "refused",
          id: "call-1",
          refusal: { reason: "budget_exhausted", limit: "daily_tool_calls" },
          warning: WARNING
        }
      })
    });

    await expect(client.execute(call("list_prs"), ATTRIBUTION)).rejects.toBeInstanceOf(
      ProxyClientError
    );
    expect(warnings).toEqual([]);
  });

  // Nothing wires one in production, and a client without the seam must still
  // serve the call rather than fail on a notice it cannot deliver.
  it("drops the notice when nobody is listening", async () => {
    const { client } = await ready({
      call: () => ({
        status: 200,
        body: { outcome: "ran", id: "call-1", result: { content: "ok" }, warning: WARNING }
      })
    });

    expect(await client.execute(call("list_prs"), ATTRIBUTION)).toEqual({
      content: "ok",
      isError: false
    });
  });
});

// #323. Where a governed create becomes a durable ticket, and what the model is
// told when it does not.
describe("recording a scheduled check", () => {
  const TICKET = JSON.stringify({
    id: "e3f1a2b4-0c5d-4e6f-8a90-1b2c3d4e5f60",
    task: "task-7",
    prompt: "check the release branch",
    dueAt: "2026-08-19T10:30:00Z",
    createdAt: "2026-08-19T09:00:00Z"
  });

  /** A listing with the built-in on it, beside enough MCP tools to matter. */
  const withBuiltin = (extra: Array<Record<string, unknown>> = []) => ({
    tools: [...LISTING.tools, { server: "libero", tool: "schedule_task", approval: "required" }, ...extra]
  });

  async function sinking(
    options: {
      listing?: unknown;
      answers?: Parameters<typeof fakeTransport>[0];
      sink?: ((ticket: string) => boolean) | undefined;
    } = {}
  ): Promise<{ client: ReturnType<typeof createProxyToolClient>; seen: string[] }> {
    const seen: string[] = [];
    const fake = fakeTransport({
      tools: () => ({ status: 200, body: options.listing ?? withBuiltin() }),
      ...options.answers
    });
    const sink = options.sink;
    const client = createProxyToolClient({
      transport: fake.transport,
      channel: CHANNEL,
      ...(sink === undefined
        ? {}
        : {
            onScheduledTask: (ticket: string) => {
              seen.push(ticket);
              return sink(ticket);
            }
          })
    });
    await client.list();
    return { client, seen };
  }

  const served = () => ({
    call: () => ({ status: 200, body: { outcome: "ran", id: "call-1", result: { content: TICKET } } })
  });

  it("hands the ticket to the sink and relays the result unchanged", async () => {
    const { client, seen } = await sinking({ answers: served(), sink: () => true });

    const result = await client.execute(call("schedule_task", { prompt: "x", due_in_minutes: 90 }), ATTRIBUTION);

    expect(seen).toEqual([TICKET]);
    expect(result).toEqual({ content: TICKET, isError: false });
  });

  // The create is held by default, so the ordinary path is the *second*
  // submission — and a hook that only fired on the first would record nothing in
  // every deployment that leaves the hold in place.
  it("fires for a create served after approval", async () => {
    // The create is held by default, so the ordinary path is the *second*
    // submission — and a hook that only fired on the first would record nothing
    // in every deployment that leaves the hold in place.
    let asked = 0;
    const seen: string[] = [];
    const fake = fakeTransport({
      tools: () => ({ status: 200, body: withBuiltin() }),
      call: () => {
        asked += 1;
        return asked === 1
          ? {
              status: 200,
              body: {
                outcome: "held",
                id: "call-1",
                refusal: { reason: "approval_required", server: "libero", tool: "schedule_task" },
                ticket: { id: "t-1", expiresAt: 1_800_000_000_000 }
              }
            }
          : { status: 200, body: { outcome: "ran", id: "call-1", result: { content: TICKET } } };
      }
    });
    const client = createProxyToolClient({
      transport: fake.transport,
      channel: CHANNEL,
      onHeld: async () => undefined,
      onScheduledTask: (ticket: string) => {
        seen.push(ticket);
        return true;
      }
    });
    await client.list();

    const result = await client.execute(
      call("schedule_task", { prompt: "x", due_in_minutes: 90 }),
      ATTRIBUTION
    );

    expect(asked).toBe(2);
    expect(seen).toEqual([TICKET]);
    expect(result).toEqual({ content: TICKET, isError: false });
  });

  // The three ways a check does not get recorded, and the model is told the same
  // thing for all of them — its remedy is identical and none of it is its fault.
  it.each([
    ["a sink that could not write", { sink: () => false }],
    ["no sink at all", { sink: undefined }]
  ])("tells the model the check will not run: %s", async (_label, options) => {
    const { client } = await sinking({ answers: served(), ...options });

    const result = await client.execute(call("schedule_task", { prompt: "x", due_in_minutes: 90 }), ATTRIBUTION);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("will not run");
    expect(result.content).not.toBe(TICKET);
  });

  // The one place the client does not degrade the way `onHeld` does. A hold
  // relayed as a refusal abandons a call, which is safe; a create with no sink
  // would report a scheduled check that nothing will ever run.
  it("does not treat a missing sink as a successful create", async () => {
    const { client, seen } = await sinking({ answers: served(), sink: undefined });
    const result = await client.execute(call("schedule_task", { prompt: "x", due_in_minutes: 90 }), ATTRIBUTION);

    expect(seen).toEqual([]);
    expect(result.isError).toBe(true);
  });

  // An error result from the proxy is a create that did not happen — bad
  // arguments — so there is no ticket to record and the model keeps the message.
  it("does not fire for a create the proxy answered with an error", async () => {
    const { client, seen } = await sinking({
      answers: {
        call: () => ({
          status: 200,
          body: {
            outcome: "ran",
            id: "call-1",
            result: { content: "schedule_task: invalid arguments.", isError: true }
          }
        })
      },
      sink: () => true
    });

    const result = await client.execute(call("schedule_task", { prompt: "x", due_in_minutes: 1 }), ATTRIBUTION);

    expect(seen).toEqual([]);
    expect(result).toEqual({ content: "schedule_task: invalid arguments.", isError: true });
  });

  it("does not fire for an ordinary tool", async () => {
    const { client, seen } = await sinking({
      answers: { call: () => ({ status: 200, body: { outcome: "ran", id: "call-1", result: { content: "ok" } } }) },
      sink: () => true
    });

    await client.execute(call("list_prs"), ATTRIBUTION);
    expect(seen).toEqual([]);
  });

  // The hook is keyed on the (server, tool) pair and never on the flat name.
  // With an upstream `schedule_task` in the listing, `chooseName` qualifies both
  // — so the built-in the model calls is `libero__schedule_task`, and matching
  // the flat name would have routed the upstream's result into the store.
  it("follows the pair when an upstream shares the name", async () => {
    // The upstream is listed first, so it takes the bare `schedule_task` and the
    // built-in is qualified — which is the arrangement a flat-name match gets
    // exactly backwards.
    const { client, seen } = await sinking({
      listing: {
        tools: [
          { server: "github", tool: "schedule_task", approval: "none" },
          { server: "libero", tool: "schedule_task", approval: "required" }
        ]
      },
      answers: served(),
      sink: () => true
    });

    await client.execute(call("schedule_task", { when: "later" }), ATTRIBUTION);
    expect(seen).toEqual([]);

    await client.execute(call("libero__schedule_task", { prompt: "x", due_in_minutes: 90 }), ATTRIBUTION);
    expect(seen).toEqual([TICKET]);
  });
});
