import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { TeamSheet } from "./team-sheet.js";

// channels/example/channel.toml is the documented starter sheet and must stay
// in sync with this schema. This test is the mechanical form of that rule.
const examplePath = new URL("../../../channels/example/channel.toml", import.meta.url);

describe("the example team sheet", () => {
  const sheet = TeamSheet.parse(parse(readFileSync(examplePath, "utf8")));

  it("validates against the schema", () => {
    expect(sheet.channel.name).toBe("engineering");
    expect(sheet.budget).toEqual({
      daily_tokens: 2_000_000,
      daily_tool_calls: 400,
      cache_read_weight: 0.1,
      cache_write_weight: 1.25,
    });
  });

  it("carries all four per-task caps", () => {
    expect(sheet.llm).toEqual({
      model: "claude-sonnet-4-6",
      max_tool_calls_per_task: 25,
      max_task_seconds: 300,
      max_tokens_per_task: 60_000,
      max_tokens_per_turn: 8_192,
    });
  });

  it("carries the documented tool allowlist and approval mode", () => {
    const github = sheet.mcp_server[0];
    expect(github?.name).toBe("github");
    expect(github?.credential).toBe("github_service_account");
    expect(github?.tool.map((t) => t.name)).toEqual(["list_prs", "trigger_workflow"]);
    expect(github?.tool[1]?.approval).toBe("required");
  });
});

describe("defaults", () => {
  // A sheet with no [llm] section must still yield every cap: the composition
  // root maps sheet to caps field by field and has no defaults of its own.
  it("yields all four per-task caps when the llm section is absent", () => {
    const sheet = TeamSheet.parse({ channel: { name: "ops" } });
    expect(sheet.llm).toEqual({
      max_tool_calls_per_task: 25,
      max_task_seconds: 300,
      max_tokens_per_task: 200_000,
      max_tokens_per_turn: 8_192,
    });
  });

  it("fills each cap the section omits", () => {
    const sheet = TeamSheet.parse({ channel: { name: "ops" }, llm: { max_task_seconds: 60 } });
    expect(sheet.llm.max_task_seconds).toBe(60);
    expect(sheet.llm.max_tokens_per_task).toBe(200_000);
  });

  it("fills every optional section from a minimal sheet", () => {
    const sheet = TeamSheet.parse({ channel: { name: "ops" } });
    expect(sheet.budget).toEqual({
      daily_tokens: 1_000_000,
      daily_tool_calls: 200,
      cache_read_weight: 0.1,
      cache_write_weight: 1.25,
    });
    expect(sheet.mcp_server).toEqual([]);
    expect(sheet.egress.allow).toEqual([]);
    expect(sheet.ambient.enabled).toBe(false);
  });

  // A weight is a price ratio, not a count: fractional is the normal case, and
  // zero is a deliberate setting meaning a cache read costs nothing here.
  it("accepts a fractional or zero cache weight and rejects a negative one", () => {
    const weighted = (budget: Record<string, unknown>) =>
      TeamSheet.safeParse({ channel: { name: "ops" }, budget });

    expect(weighted({ cache_read_weight: 0 }).success).toBe(true);
    expect(weighted({ cache_read_weight: 0.25, cache_write_weight: 2 }).success).toBe(true);
    expect(weighted({ cache_read_weight: -0.1 }).success).toBe(false);
    expect(weighted({ cache_write_weight: 101 }).success).toBe(false);
  });
});

// The two shapes that used to parse and then fail at dispatch. What is asserted
// here is the issue *path*: the loader logs `path: code`, so the path is what
// sends an operator to the block to fix, and a rejection that named no field
// would meet the letter of "invalid sheets are rejected" and none of its point.
describe("an mcp_server's transport decides its url", () => {
  const serverSheet = (server: Record<string, unknown>) => ({
    channel: { name: "ops" },
    mcp_server: [server],
  });

  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`);
  };

  it("accepts http with a url", () => {
    expect(paths(serverSheet({ name: "github", transport: "http", url: "http://mcp:3001" }))).toBeNull();
  });

  it("accepts stdio without one", () => {
    expect(paths(serverSheet({ name: "github", transport: "stdio" }))).toBeNull();
  });

  it("rejects http with no url, naming the field", () => {
    expect(paths(serverSheet({ name: "github", transport: "http" }))).toEqual([
      "mcp_server.0.url: invalid_type",
    ]);
  });

  // Not "ignores it": a field an operator wrote and then trusts is worse than
  // one they are told is wrong.
  it("rejects stdio with a url, naming the field", () => {
    expect(paths(serverSheet({ name: "github", transport: "stdio", url: "http://mcp:3001" }))).toEqual([
      "mcp_server.0.url: invalid_type",
    ]);
  });
});

describe("rejections", () => {
  it("rejects an unknown transport", () => {
    const result = TeamSheet.safeParse({
      channel: { name: "ops" },
      mcp_server: [{ name: "github", transport: "websocket" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing channel name", () => {
    expect(TeamSheet.safeParse({ channel: {} }).success).toBe(false);
    expect(TeamSheet.safeParse({ channel: { name: "" } }).success).toBe(false);
  });

  it("rejects a non-positive budget", () => {
    const result = TeamSheet.safeParse({
      channel: { name: "ops" },
      budget: { daily_tokens: 0 },
    });
    expect(result.success).toBe(false);
  });

  // A cap of zero or below is not a tighter cap, it is a channel that can never
  // run a task. A fractional one is a typo.
  it("rejects a non-positive per-task cap", () => {
    for (const llm of [
      { max_tool_calls_per_task: 0 },
      { max_task_seconds: -1 },
      { max_tokens_per_task: 0 },
      { max_tokens_per_turn: -8192 },
    ]) {
      expect(TeamSheet.safeParse({ channel: { name: "ops" }, llm }).success).toBe(false);
    }
  });

  it("rejects a fractional per-task cap", () => {
    const result = TeamSheet.safeParse({
      channel: { name: "ops" },
      llm: { max_task_seconds: 1.5 },
    });
    expect(result.success).toBe(false);
  });
});
