// The `ToolSource` and `ToolExecutor` the loop actually runs against: the
// channel's permitted tools over `GET /v1/tools`, and its calls over
// `POST /v1/tools/call`.
//
// Both halves are one object because they share one thing — the mapping from
// the flat name a model calls to the (server, tool) pair the proxy takes, built
// by `list()` from what the proxy listed and read by `execute()`. A model can
// only call a tool the proxy published, and it can only be decoded to the pair
// that published it. See ./tool-names.ts for why that is a lookup and not a
// parse.
//
// **Pinned to one channel at construction.** The channel is not a parameter on
// `execute`, so there is no call this object can make that a different
// certificate would authenticate. The transport takes a channel per request
// because the process serves many; this does not, because one task serves one.
//
// **The agent does not filter the list.** The proxy has already resolved it
// against the channel's team sheet, and a second opinion here would either
// agree — in which case it is dead code that can drift — or disagree, in which
// case the model's tools are decided by the process running the model. There is
// exactly one enforcement point and it is not this one.

import {
  ToolCallResponse,
  ToolListing,
  refusalMessage,
  type ToolCall as WireToolCall
} from "@getlibero/schema";
import type { ToolCall, ToolDefinition } from "../completion/types.js";
import type { ToolCallAttribution, ToolExecutor, ToolResult, ToolSource } from "../loop/types.js";
import { proxyErrorFrom } from "./errors.js";
import { mapPermittedTools, type MappedTool } from "./tool-names.js";
import { ProxyClientError, type ProxyTransport } from "./transport.js";

export interface ProxyToolClientOptions {
  transport: ProxyTransport;
  /** Whose certificate every request presents. Fixed for the life of this object. */
  channel: string;
}

/** Both halves, so a caller cannot wire one to the proxy and the other to a stub. */
export interface ProxyToolClient extends ToolSource, ToolExecutor {}

export function createProxyToolClient(options: ProxyToolClientOptions): ProxyToolClient {
  const { transport, channel } = options;
  let byModelName = new Map<string, MappedTool>();

  return {
    /**
     * The channel's permitted tools.
     *
     * Throws rather than degrading to an empty list, and the loop propagates it
     * — which ends the task with no reply in the thread. That is the honest
     * outcome: a proxy that cannot be reached is an operator problem, and an
     * agent that answers as though the channel had no tools is a worse failure
     * than one that answers nothing, because it looks like it worked.
     */
    async list(signal?: AbortSignal): Promise<ToolDefinition[]> {
      const response = await transport.request({
        channel,
        method: "GET",
        path: "/v1/tools",
        ...(signal !== undefined ? { signal } : {})
      });

      if (response.status !== 200) throw proxyErrorFrom(response.body, "the tool listing failed");

      // Parsed, not trusted. The proxy is ours, and the reason to parse anyway
      // is that "ours" is an assumption about the network and this is the
      // process on the exposed side of it.
      const parsed = ToolListing.safeParse(response.body);
      if (!parsed.success) {
        throw new ProxyClientError(
          "proxy client: the tool listing was not a valid listing",
          "malformed_response"
        );
      }

      const mapped = mapPermittedTools(parsed.data.tools);
      byModelName = mapped.byModelName;
      return mapped.definitions;
    },

    /**
     * One tool call.
     *
     * Never throws for a refusal, and that is the contract the loop is built
     * on: a refusal is a served request, so it comes back as `isError: true`
     * content the model relays to the channel and the task carries on. What
     * does throw is a request that was not answered — an unreachable proxy, a
     * rejected certificate, a response that does not parse — which the loop
     * turns into an error result of its own, so even that does not drop a task.
     */
    async execute(
      call: ToolCall,
      attribution: ToolCallAttribution,
      signal?: AbortSignal
    ): Promise<ToolResult> {
      const mapped = byModelName.get(call.name);
      if (mapped === undefined) {
        // Not a pair, so there is nothing to send. A model that invented a name
        // — or called one from a listing that has since changed — is told so
        // and may try something else; the proxy is not asked about a tool it
        // never published.
        return {
          content: `\`${call.name}\` is not a tool this channel permits. The call was not made.`,
          isError: true
        };
      }

      const body: WireToolCall = {
        id: call.id,
        server: mapped.server,
        tool: mapped.tool,
        arguments: call.arguments,
        // Attribution, not authentication. The proxy writes it down and decides
        // nothing from it — see the fields' doc comments in @getlibero/schema.
        requestingUser: attribution.requestingUser,
        task: attribution.taskId
      };
      // No `channel` key, and none is possible: `ToolCall` is strict, so a body
      // carrying one is rejected by the proxy rather than having the field
      // dropped. The channel comes from the certificate this request presents.

      const response = await transport.request({
        channel,
        method: "POST",
        path: "/v1/tools/call",
        body,
        ...(signal !== undefined ? { signal } : {})
      });

      if (response.status !== 200) throw proxyErrorFrom(response.body, "the tool call failed");

      const parsed = ToolCallResponse.safeParse(response.body);
      if (!parsed.success) {
        throw new ProxyClientError(
          "proxy client: the tool call answer was not a valid response",
          "malformed_response"
        );
      }

      const answer = parsed.data;
      switch (answer.outcome) {
        case "ran":
          return answer.result;
        // A hold and a refusal both mean the call did not run, and until the
        // approval broker (#37) exists there is nothing to wait on — so both
        // are relayed to the model as what they are. `refusalMessage` words
        // them, so the sentence a channel sees cannot disagree with the reason
        // the proxy gave, and a hold's own sentence says it is held.
        case "held":
        case "refused":
          return { content: refusalMessage(answer.refusal), isError: true };
      }
    }
  };
}
