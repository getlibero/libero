import Anthropic from "@anthropic-ai/sdk";
import {
  CompletionError,
  type CompletionClient,
  type CompletionMessage,
  type CompletionRequest,
  type CompletionResponse,
  type StopReason,
  type ToolCall,
  type TokenUsage
} from "./types.js";
import { servedModel } from "./served-model.js";

const PROVIDER = "anthropic";

export interface AnthropicCompletionOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected transport. Tests pass a stub; nothing here reaches the network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Anthropic completions. The client is built on first use, never at import, so
 * loading this module in an environment without credentials is safe.
 */
export function createAnthropicCompletionClient(
  options: AnthropicCompletionOptions
): CompletionClient {
  let client: Anthropic | undefined;

  const anthropic = (): Anthropic => {
    client ??= new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });
    return client;
  };

  return {
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      let message: Anthropic.Message;
      try {
        message = await anthropic().messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            messages: toAnthropicMessages(request.messages),
            ...(request.system !== undefined ? { system: request.system } : {}),
            ...(request.tools !== undefined
              ? {
                  tools: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
                  }))
                }
              : {})
          },
          request.signal !== undefined ? { signal: request.signal } : {}
        );
      } catch (cause) {
        if (cause instanceof CompletionError) throw cause;
        throw new CompletionError("completion request failed", PROVIDER, { cause });
      }

      return fromAnthropicMessage(message);
    }
  };
}

function toAnthropicMessages(messages: CompletionMessage[]): Anthropic.MessageParam[] {
  const converted: Anthropic.MessageParam[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  // Results for a batch of parallel tool calls must arrive as one user turn, so
  // a run of tool messages collapses into a single message rather than one each.
  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    converted.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError === true ? { is_error: true } : {})
      });
      continue;
    }

    flushToolResults();

    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }

    // Reasoning blocks must lead the turn and be replayed byte-identical —
    // their signatures are checked server-side.
    const blocks: Anthropic.ContentBlockParam[] = [...replayableBlocks(message.providerState)];
    if (message.content !== "") blocks.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    converted.push({ role: "assistant", content: blocks });
  }

  flushToolResults();
  return converted;
}

function fromAnthropicMessage(message: Anthropic.Message): CompletionResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const providerState: Anthropic.ContentBlockParam[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: toArguments(block.input, block.name)
      });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      providerState.push(block);
    }
  }

  return {
    text,
    toolCalls,
    stopReason: toStopReason(message.stop_reason),
    usage: toUsage(message.usage),
    ...servedModel(message.model),
    ...(providerState.length > 0 ? { providerState } : {})
  };
}

function toStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      // stop_sequence, pause_turn, model_context_window_exceeded, null.
      return "other";
  }
}

function toUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof usage.cache_read_input_tokens === "number"
      ? { cacheReadInputTokens: usage.cache_read_input_tokens }
      : {}),
    ...(typeof usage.cache_creation_input_tokens === "number"
      ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
      : {})
  };
}

function toArguments(input: unknown, toolName: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CompletionError(`tool call ${toolName} returned non-object arguments`, PROVIDER);
  }
  return input as Record<string, unknown>;
}

function replayableBlocks(state: unknown): Anthropic.ContentBlockParam[] {
  if (!Array.isArray(state)) return [];
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const block of state as unknown[]) {
    if (isReplayableBlock(block)) blocks.push(block);
  }
  return blocks;
}

function isReplayableBlock(
  value: unknown
): value is Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}
