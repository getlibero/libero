import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
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

const PROVIDER = "openai-compatible";

/**
 * Endpoints that speak the OpenAI chat-completions wire format. Pointing the
 * adapter at one of these is the whole configuration — there is no per-vendor
 * code. Anything not listed works too, including a self-hosted gateway.
 */
export const OPENAI_COMPATIBLE_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  baseten: "https://inference.baseten.co/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  ollama: "http://localhost:11434/v1"
} as const;

export interface OpenAICompatibleCompletionOptions {
  apiKey: string;
  /** Defaults to OpenAI itself. See OPENAI_COMPATIBLE_BASE_URLS. */
  baseUrl?: string;
  /** Injected transport. Tests pass a stub; nothing here reaches the network. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Completions against any OpenAI-compatible endpoint. Uses chat-completions
 * rather than the Responses API because chat-completions is what the compatible
 * endpoints actually implement.
 */
export function createOpenAICompatibleCompletionClient(
  options: OpenAICompatibleCompletionOptions
): CompletionClient {
  let client: OpenAI | undefined;

  const openai = (): OpenAI => {
    client ??= new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    });
    return client;
  };

  return {
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      let completion: ChatCompletion;
      try {
        completion = await openai().chat.completions.create(
          {
            model: request.model,
            // max_tokens, not max_completion_tokens: the compatible endpoints
            // implement the older field, and this adapter exists for them.
            max_tokens: request.maxTokens,
            messages: toOpenAIMessages(request.system, request.messages),
            ...(request.tools !== undefined
              ? {
                  tools: request.tools.map((tool) => ({
                    type: "function" as const,
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema
                    }
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

      return fromOpenAICompletion(completion);
    }
  };
}

function toOpenAIMessages(
  system: string | undefined,
  messages: CompletionMessage[]
): ChatCompletionMessageParam[] {
  const converted: ChatCompletionMessageParam[] = [];
  if (system !== undefined) converted.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "tool") {
      // This wire format has no error flag on a tool result; the loop marks
      // failures in the content it passes down.
      converted.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
      });
      continue;
    }

    converted.push({
      role: "assistant",
      content: message.content,
      ...(message.toolCalls !== undefined && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }))
          }
        : {})
    });
  }

  return converted;
}

function fromOpenAICompletion(completion: ChatCompletion): CompletionResponse {
  const choice = completion.choices[0];
  if (choice === undefined) {
    throw new CompletionError("response contained no choices", PROVIDER);
  }

  const toolCalls: ToolCall[] = [];
  for (const call of choice.message.tool_calls ?? []) {
    // Custom (non-function) tool calls are not something the agent requests.
    if (call.type !== "function") continue;
    toolCalls.push({
      id: call.id,
      name: call.function.name,
      arguments: parseArguments(call.function.arguments, call.function.name)
    });
  }

  return {
    text: choice.message.content ?? "",
    toolCalls,
    stopReason: toStopReason(choice.finish_reason),
    usage: toUsage(completion.usage)
  };
}

function toStopReason(reason: ChatCompletion.Choice["finish_reason"]): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      // function_call is the deprecated path, and servers send reasons of their own.
      return "other";
  }
}

function toUsage(usage: ChatCompletion["usage"]): TokenUsage {
  // The budget meter is authoritative for the channel, so a server that reports
  // no usage is a failure rather than a call metered as zero.
  if (usage === undefined) {
    throw new CompletionError("response reported no token usage", PROVIDER);
  }

  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(typeof cached === "number" ? { cacheReadInputTokens: cached } : {})
  };
}

function parseArguments(raw: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CompletionError(`tool call ${toolName} had unparseable arguments`, PROVIDER, {
      cause
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CompletionError(`tool call ${toolName} returned non-object arguments`, PROVIDER);
  }
  return parsed as Record<string, unknown>;
}
