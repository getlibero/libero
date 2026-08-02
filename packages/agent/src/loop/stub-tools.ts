// Stand-ins for the tool proxy service, so the loop is runnable before the
// service exists. Neither reaches the network and neither holds a credential.

import type { ToolDefinition } from "../completion/types.js";
import type { ToolExecutor, ToolResult, ToolSource } from "./types.js";

/**
 * A fixed tool list. The default is empty — a model given no tools, which is
 * what a hello-world agent needs. Passing definitions lets a demo or a test
 * hand the model a tool without a running tool proxy service; it grants no
 * ability to call one.
 */
export function createStubToolSource(definitions: ToolDefinition[] = []): ToolSource {
  const frozen = [...definitions];
  return {
    list: () => Promise.resolve([...frozen])
  };
}

/**
 * Refuses every call. Pairs with a tool source that lists tools no executor is
 * wired to yet.
 *
 * It returns an error result rather than throwing: a refusal is the shape the
 * real path uses when the tool proxy service declines a call, so the model
 * gets to relay it and a misconfigured deployment answers instead of dropping
 * the task.
 */
export function createUnavailableToolExecutor(): ToolExecutor {
  return {
    execute: (): Promise<ToolResult> =>
      Promise.resolve({ content: "tool execution is not configured", isError: true })
  };
}
