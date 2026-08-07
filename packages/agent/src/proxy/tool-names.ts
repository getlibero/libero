// Turning the proxy's permission manifest into names a model can call, and
// turning a name the model called back into the pair the proxy needs.
//
// The proxy speaks (server, tool). Every provider's tool-use API speaks one
// flat name, bounded to `[A-Za-z0-9_-]{1,64}` — so a pair has to become a name
// on the way out, and a name has to become a pair on the way back.
//
// **The way back is a lookup, never a parse.** The name arriving from the model
// is model-authored text, and deriving a server and a tool by splitting it
// would be a rule the model can phrase its way around: `ResourceName` permits
// dots and underscores, so `a.b` + `c` and `a` + `b.c` produce the same string
// under any separator that fits a provider's alphabet. Instead the mapping is
// built here, from what the proxy listed, and decoding is a `Map.get`. A name
// that is not in the map is not a tool — it is not "a tool that failed", and
// there is no pair for it to become.
//
// That is defence in depth rather than the enforcement. A pair the map produced
// is still checked against the channel's team sheet at call time, by the proxy,
// which is what actually holds.

import type { PermittedTool } from "@getlibero/schema";
import type { ToolDefinition } from "../completion/types.js";

/** Every provider bounds a tool name at 64 characters. */
const MAX_NAME_LENGTH = 64;

/**
 * A permitted tool and the name the model knows it by.
 *
 * `approval` rides along because the description says so — a model that knows a
 * call will be held can tell the channel that before it asks, rather than after
 * a refusal comes back.
 */
export interface MappedTool {
  readonly modelName: string;
  readonly server: string;
  readonly tool: string;
  readonly approval: PermittedTool["approval"];
}

/**
 * A `ResourceName` as a provider will accept it.
 *
 * The alphabets differ in exactly one character: `ResourceName` permits a dot
 * and no provider does. Everything else — letters, digits, dash, underscore —
 * is common to both, so this replaces dots and touches nothing else.
 */
function providerSafe(name: string): string {
  return name.replace(/\./g, "_");
}

/**
 * What to call a tool, preferring the shortest name that is unambiguous.
 *
 * The bare tool name when nothing else claims it, which is the common case and
 * the one a model reads best: a channel with one MCP server gets `list_prs`,
 * not `github__list_prs`. Qualified when two servers offer the same tool name,
 * because then the bare name genuinely does not identify a call. A numeric
 * suffix past that, which covers both a collision the qualified form did not
 * resolve and a pair too long to fit in 64 characters.
 *
 * Deterministic given the listing and its order, so the same sheet produces the
 * same names on every session and a model's transcript stays meaningful across
 * turns.
 */
function chooseName(entry: PermittedTool, taken: ReadonlySet<string>): string {
  const candidates = [
    providerSafe(entry.tool),
    `${providerSafe(entry.server)}__${providerSafe(entry.tool)}`
  ];

  for (const candidate of candidates) {
    if (candidate.length <= MAX_NAME_LENGTH && !taken.has(candidate)) return candidate;
  }

  // Both were taken or too long. Truncate to leave room for a suffix and count
  // up — the name stops being readable here, which is the price of a sheet that
  // needed it, and the mapping stays exact because nothing about it is derived.
  const stem = candidates[1]?.slice(0, MAX_NAME_LENGTH - 5) ?? "tool";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The listing as tool definitions, and the map that decodes a call.
 *
 * The definitions are thin because the manifest is thin, and deliberately so:
 * a team sheet lists names and approval and knows nothing about arguments, so
 * there is no input schema to publish and inventing one would describe a
 * contract nobody checked. `{ type: "object" }` with no properties says what is
 * true — the model's arguments are passed through to the tool unmodified, and
 * the tool is what validates them.
 *
 * Real descriptions and real input schemas come from the upstream servers
 * themselves, through the proxy's MCP client pool (#129), intersected with this
 * manifest. Until then a model is told what it may call and not what the
 * arguments are, which is worth being explicit about rather than papering over.
 */
export function mapPermittedTools(tools: readonly PermittedTool[]): {
  definitions: ToolDefinition[];
  byModelName: Map<string, MappedTool>;
} {
  const byModelName = new Map<string, MappedTool>();
  const definitions: ToolDefinition[] = [];

  for (const entry of tools) {
    const modelName = chooseName(entry, new Set(byModelName.keys()));
    byModelName.set(modelName, {
      modelName,
      server: entry.server,
      tool: entry.tool,
      approval: entry.approval
    });
    definitions.push({
      name: modelName,
      description: describe(entry),
      inputSchema: { type: "object", properties: {}, additionalProperties: true }
    });
  }

  return { definitions, byModelName };
}

/**
 * What the model is told a tool is.
 *
 * House voice: name the call, say what is and is not known about it, say
 * whether a human has to say yes. It claims no capability — describing what
 * `list_prs` does would be this process inventing a contract with a server it
 * has never spoken to.
 *
 * Saying so plainly beats saying nothing. A model told only a name will guess
 * at arguments either way; a model told the arguments are unspecified can say
 * so to the channel instead of asserting a signature it made up.
 */
function describe(entry: PermittedTool): string {
  const held =
    entry.approval === "required"
      ? " This call is held for approval from a human before it runs."
      : "";
  return `\`${entry.server}.${entry.tool}\`, called through the Libero tool proxy. Its arguments are not described by this channel's team sheet: they are passed to the server unchanged, and the server validates them.${held}`;
}
