import { describe, expect, it } from "vitest";
import { BUILTIN_APPROVAL_DEFAULT, BUILTIN_SERVER, BuiltinToolName } from "./builtin.js";
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
    expect(BuiltinToolName.options).toEqual(["search_channel_history", "schedule_task"]);
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

describe("the default approval mode", () => {
  it("decides for every built-in", () => {
    expect(Object.keys(BUILTIN_APPROVAL_DEFAULT).sort()).toEqual([...BuiltinToolName.options].sort());
  });

  // Pinned by name rather than derived, because deriving it is what this record
  // exists to stop. The two values are the decision.
  it("holds a create and does not hold a search", () => {
    expect(BUILTIN_APPROVAL_DEFAULT.schedule_task).toBe("required");
    expect(BUILTIN_APPROVAL_DEFAULT.search_channel_history).toBe("none");
  });

  // The property #322 asks for, stated as a property rather than as a value: a
  // sheet has to write `approval = "none"` to loosen scheduling, and forgetting
  // the line gets the hold. A future built-in that creates work must not be able
  // to default the other way without this failing.
  it("makes forgetting the line the safe direction for scheduling", () => {
    expect(BUILTIN_APPROVAL_DEFAULT.schedule_task).not.toBe("none");
  });
});
