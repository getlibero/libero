import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
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
  // Moved for #394, which added `run_code` — the sandbox (#368). This assertion
  // is a deliberate tripwire rather than a description: it exists so that adding
  // a member is a diff somebody reads, because a built-in's name is a
  // compatibility surface a team sheet writes and an audit row records.
  it("is a closed set", () => {
    expect(BuiltinToolName.options).toEqual([
      "search_channel_history",
      "schedule_task",
      "run_code"
    ]);
  });

  // The reason this block exists rather than `transport = "builtin"` under
  // [[mcp_server]]: there, a tool name is the same ResourceName field as every
  // other server's, so a typo parses and is refused three layers later.
  it("refuses a name it does not implement", () => {
    expect(BuiltinToolName.safeParse("serch_channel_histry").success).toBe(false);
  });

  // Every member needs a ResourceName spelling too, for the same round trip the
  // server name makes.
  each(BuiltinToolName.options)("parses %s as a ResourceName", name => {
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

  // #394. Stated as its own case rather than folded into the pinned pair above,
  // because the reason is different: scheduling defaults to the hold because it
  // creates unbidden future work, and this one does because it executes
  // arbitrary code. Either could change without the other.
  it("holds code execution", () => {
    expect(BUILTIN_APPROVAL_DEFAULT.run_code).toBe("required");
  });

  // The property, not the value — and the one the destructive-verb heuristic
  // would get wrong if it were ever allowed to answer for a built-in. "run" is
  // not a destructive verb, so a guess from the name would return `"none"` for
  // the only member of this enum that runs arbitrary code.
  it("makes forgetting the line the safe direction for code execution", () => {
    expect(BUILTIN_APPROVAL_DEFAULT.run_code).not.toBe("none");
  });
});
