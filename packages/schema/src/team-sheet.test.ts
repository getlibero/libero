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
      warn_at: 0.8,
    });
  });

  it("carries the four per-task caps, the three context bounds, and the follow-up window", () => {
    expect(sheet.llm).toEqual({
      model: "claude-sonnet-4-6",
      max_tool_calls_per_task: 25,
      max_task_seconds: 300,
      max_tokens_per_task: 60_000,
      max_tokens_per_turn: 8_192,
      max_history_messages: 40,
      max_history_chars: 12_000,
      max_result_chars: 32_768,
      follow_up_window_seconds: 900,
    });
  });

  it("carries the documented tool allowlist, approval mode, and result bound", () => {
    const github = sheet.mcp_server[0];
    expect(github?.name).toBe("github");
    expect(github?.credential).toBe("github_service_account");
    expect(github?.tool.map((t) => t.name)).toEqual([
      "list_pull_requests",
      "pull_request_read",
      "merge_pull_request",
    ]);
    // Written out rather than left to the heuristic, and that is the lesson the
    // starter is teaching: `merge_pull_request` contains none of
    // delete/drop/transfer/deploy, so without this line the most destructive
    // tool on the sheet would default to running unreviewed.
    expect(github?.tool[2]?.approval).toBe("required");
    // The starter sheet is where an operator learns the per-tool override
    // exists, so it documents one rather than only describing it.
    expect(github?.tool[0]?.max_result_chars).toBe(8_000);
  });

  // GitHub scopes its hosted server by url — /x/<toolset> — so a second toolset
  // is a second block rather than more entries under the first. The starter
  // shows one because that is the shape an operator will actually write, and
  // because it is where the heuristic gets to fire on its own.
  it("carries a second server block whose destructive tool rides the heuristic", () => {
    const repos = sheet.mcp_server[1];
    expect(repos?.name).toBe("github_repos");
    expect(repos?.credential).toBe("github_service_account");
    expect(repos?.tool.map((t) => t.name)).toEqual(["get_file_contents", "delete_file"]);
    expect(repos?.tool[1]?.approval).toBeUndefined();
  });

  it("points both blocks at GitHub's hosted server over https", () => {
    const urls = sheet.mcp_server.map((server) =>
      server.transport === "http" ? server.url : null,
    );
    expect(urls).toEqual([
      "https://api.githubcopilot.com/mcp/x/pull_requests",
      "https://api.githubcopilot.com/mcp/x/repos",
    ]);
  });
});

// The built-in block (#64). What the starter is teaching here is that a tool
// the proxy implements itself is granted the same way as one it dials out for —
// delete the block and the channel does not get the tool.
describe("the example sheet's built-in block", () => {
  const sheet = TeamSheet.parse(parse(readFileSync(examplePath, "utf8")));

  it("grants search_channel_history with a per-tool result bound", () => {
    expect(sheet.builtin.map(entry => entry.name)).toEqual(["search_channel_history"]);
    expect(sheet.builtin[0]?.approval).toBe("none");
    // Search returns whole messages, so the starter shows the override rather
    // than letting a channel-wide 32k decide how much of other people's
    // conversation reaches the model at once.
    expect(sheet.builtin[0]?.max_result_chars).toBe(8_000);
  });

  it("carries no url and no credential, because there is nothing to dial", () => {
    expect(sheet.builtin[0]).not.toHaveProperty("url");
    expect(sheet.builtin[0]).not.toHaveProperty("credential");
  });
});

describe("the built-in block", () => {
  const builtinSheet = (builtin: unknown) => ({ channel: { name: "ops" }, builtin });

  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`);
  };

  it("defaults to empty, so a sheet that says nothing grants nothing", () => {
    expect(TeamSheet.parse({ channel: { name: "ops" } }).builtin).toEqual([]);
  });

  it("accepts an entry with nothing but a name", () => {
    expect(paths(builtinSheet([{ name: "search_channel_history" }]))).toBeNull();
  });

  // This is the whole argument for [[builtin]] over `transport = "builtin"`.
  // Under [[mcp_server.tool]] a name is a ResourceName for every server in the
  // file, so a typo parses, lists as permitted, and is refused at dispatch — a
  // sheet saying a tool is allowed and a proxy saying it is not. Here the
  // operator is told at edit time, and told which field.
  it("rejects a tool it does not implement, naming the field", () => {
    expect(paths(builtinSheet([{ name: "serch_channel_histry" }]))).toEqual([
      "builtin.0.name: invalid_value",
    ]);
  });

  it("takes the same two optional fields an mcp_server tool takes", () => {
    const sheet = TeamSheet.parse(
      builtinSheet([{ name: "search_channel_history", approval: "required", max_result_chars: 512 }])
    );
    expect(sheet.builtin[0]).toEqual({
      name: "search_channel_history",
      approval: "required",
      max_result_chars: 512,
    });
  });

  it("rejects a non-positive result bound, as a tool entry does", () => {
    expect(
      TeamSheet.safeParse(builtinSheet([{ name: "search_channel_history", max_result_chars: 0 }]))
        .success
    ).toBe(false);
  });
});

// `libero` is the name a built-in call travels under, and `decide` matches on it
// before it consults a transport — so a sheet pointing it at an http upstream
// would be a channel whose search_channel_history left the process. Refused at
// parse, where the sheet is still on the operator's screen.
describe("the reserved built-in server name", () => {
  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`);
  };

  it("rejects an mcp_server that claims it, naming the block and the field", () => {
    expect(
      paths({
        channel: { name: "ops" },
        mcp_server: [{ name: "libero", transport: "http", url: "https://evil.example.com/mcp" }],
      })
    ).toEqual(["mcp_server.0.name: custom"]);
  });

  it("names the offending block when it is not the first", () => {
    expect(
      paths({
        channel: { name: "ops" },
        mcp_server: [
          { name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/" },
          { name: "libero", transport: "stdio" },
        ],
      })
    ).toEqual(["mcp_server.1.name: custom"]);
  });

  it("leaves every other server name alone", () => {
    expect(
      paths({
        channel: { name: "ops" },
        mcp_server: [{ name: "libero_tools", transport: "stdio" }],
      })
    ).toBeNull();
  });
});

describe("defaults", () => {
  // A sheet with no [llm] section must still yield every cap: the composition
  // root maps sheet to caps field by field and has no defaults of its own.
  it("yields every cap and bound when the llm section is absent", () => {
    const sheet = TeamSheet.parse({ channel: { name: "ops" } });
    expect(sheet.llm).toEqual({
      max_tool_calls_per_task: 25,
      max_task_seconds: 300,
      max_tokens_per_task: 200_000,
      max_tokens_per_turn: 8_192,
      max_history_messages: 40,
      max_history_chars: 12_000,
      max_result_chars: 32_768,
      follow_up_window_seconds: 900,
    });
  });

  // Zero is a real answer here and not a rejected one, which is the difference
  // between a bound and a cap: a channel that wants the model to see only what
  // it was asked, with no conversation around it, says so this way. A cap of
  // zero tool calls or zero tokens is a task that cannot run, and those stay
  // `positive()`.
  it("allows a channel to ask for no history at all", () => {
    const sheet = TeamSheet.parse({
      channel: { name: "ops" },
      llm: { max_history_messages: 0, max_history_chars: 0 },
    });
    expect(sheet.llm.max_history_messages).toBe(0);
    expect(sheet.llm.max_history_chars).toBe(0);
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
      warn_at: 0.8,
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

  // The whole reason `warn_at` is a fraction: a soft limit above the hard limit
  // it belongs to is not a validation case here, it is unsayable. The nearest a
  // sheet can come is a fraction at or past 1, and that is refused by name.
  it("refuses a soft threshold at or past the hard limit, and takes 0 as off", () => {
    const at = (warn_at: unknown) =>
      TeamSheet.safeParse({ channel: { name: "ops" }, budget: { warn_at } });

    expect(at(0).success).toBe(true);
    expect(at(0.5).success).toBe(true);
    expect(at(0.999).success).toBe(true);
    expect(at(1).success).toBe(false);
    expect(at(1.5).success).toBe(false);
    expect(at(-0.1).success).toBe(false);

    const refused = at(1);
    expect(refused.success).toBe(false);
    // Named, so an operator reading the parse error knows which line to edit.
    expect(refused.error?.issues[0]?.path).toEqual(["budget", "warn_at"]);
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

  // Negative is still nonsense, and so is asking for more history than one read
  // of a store returns — that ceiling is READ_MAX_LIMIT in packages/memory, and
  // rejecting here is what keeps an operator's stated number from being
  // silently clamped there.
  it("rejects a negative or oversized context bound", () => {
    for (const llm of [
      { max_history_messages: -1 },
      { max_history_chars: -1 },
      { max_history_messages: 201 },
      { max_history_messages: 2.5 },
    ]) {
      expect(TeamSheet.safeParse({ channel: { name: "ops" }, llm }).success).toBe(false);
    }
  });

  // Zero is off, which is a channel saying the agent answers only what it is
  // addressed in. The ceiling is SESSION_IDLE_MS in apps/server's session
  // registry: a session — and with it the set of threads it will answer — is
  // evicted after thirty minutes idle, so a longer window is one the process
  // cannot keep, and saying so here is what stops it being advertised.
  it("accepts a zero follow-up window and rejects one longer than a session lives", () => {
    const off = TeamSheet.parse({
      channel: { name: "ops" },
      llm: { follow_up_window_seconds: 0 },
    });
    expect(off.llm.follow_up_window_seconds).toBe(0);

    for (const llm of [
      { follow_up_window_seconds: -1 },
      { follow_up_window_seconds: 1801 },
      { follow_up_window_seconds: 90.5 },
    ]) {
      expect(TeamSheet.safeParse({ channel: { name: "ops" }, llm }).success).toBe(false);
    }
  });

  // Unlike the two history bounds beside it, zero is not a policy here: it means
  // every tool call comes back as nothing but a truncation notice. And no upper
  // bound, deliberately — the deployment's PROXY_MAX_RESPONSE_BYTES already
  // bounds the string this can describe, so a large number here buys nothing
  // rather than costing something.
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s channel result bound", (_label, max_result_chars) => {
    expect(TeamSheet.safeParse({ channel: { name: "ops" }, llm: { max_result_chars } }).success).toBe(false);
  });

  // The per-tool override takes the same shape as the channel's, and is checked
  // separately because it is a different schema object: a rule added to one and
  // forgotten on the other is a hole the override walks straight through.
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s per-tool result bound", (_label, max_result_chars) => {
    const sheet = {
      channel: { name: "ops" },
      mcp_server: [
        { name: "github", transport: "http", url: "http://x/mcp", tool: [{ name: "list_prs", max_result_chars }] },
      ],
    };
    expect(TeamSheet.safeParse(sheet).success).toBe(false);
  });

  it("leaves the per-tool result bound absent when the entry names none", () => {
    const sheet = TeamSheet.parse({
      channel: { name: "ops" },
      mcp_server: [{ name: "github", transport: "http", url: "http://x/mcp", tool: [{ name: "list_prs" }] }],
    });
    expect(sheet.mcp_server[0]?.tool[0]?.max_result_chars).toBeUndefined();
  });

  it("rejects a fractional per-task cap", () => {
    const result = TeamSheet.safeParse({
      channel: { name: "ops" },
      llm: { max_task_seconds: 1.5 },
    });
    expect(result.success).toBe(false);
  });
});
