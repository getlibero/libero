import { describe, expect, it } from "vitest";
import { BUILTIN_SERVER, BuiltinToolName } from "./builtin.js";
import { ResourceName } from "./names.js";

describe("the built-in server name", () => {
  // It travels as `ToolCall.server`, which is a ResourceName. The two live in
  // different files, so only this keeps them in step — and the failure it
  // guards against is silent on the sheet side and loud only at the wire.
  it("parses as a ResourceName", () => {
    expect(ResourceName.safeParse(BUILTIN_SERVER).success).toBe(true);
  });
});

describe("the built-in tool names", () => {
  it("is a closed set", () => {
    expect(BuiltinToolName.options).toEqual(["search_channel_history"]);
  });

  // The reason this block exists rather than `transport = "builtin"` under
  // [[mcp_server]]: there, a tool name is the same ResourceName field as every
  // other server's, so a typo parses and is refused three layers later.
  it("refuses a name it does not implement", () => {
    expect(BuiltinToolName.safeParse("serch_channel_histry").success).toBe(false);
  });

  // Every member needs a ResourceName spelling too, for the same round trip the
  // server name makes.
  it.each(BuiltinToolName.options)("parses %s as a ResourceName", name => {
    expect(ResourceName.safeParse(name).success).toBe(true);
  });
});
