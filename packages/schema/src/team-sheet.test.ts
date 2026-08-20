import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { MEMORY_OP_MAX_TEXT_CHARS } from "./memory-op.js";
import { SKILL_BODY_MAX_CHARS } from "./skill.js";
import { TeamSheet } from "./team-sheet.js";

// channels/example/channel.toml is the documented starter sheet and must stay
// in sync with this schema. This test is the mechanical form of that rule.
const examplePath = new URL("../../../channels/example/channel.toml", import.meta.url);

/** A syntactically valid fingerprint. It matches no certificate anyone holds. */
const PIN = "AB".repeat(32);

/**
 * The smallest `[channel]` block that parses, in one place.
 *
 * Every case below whose subject is some *other* section builds its channel
 * through this, so the next required field is one line here rather than a
 * change to twenty-odd literals — which is what #79 cost when it added the
 * first one.
 */
const minimalChannel = (extra: Record<string, unknown> = {}) => ({
  name: "ops",
  certificate_sha256: [PIN],
  ...extra,
});

describe("the channel description", () => {
  // Appended to the system prompt of every task (#369), so the cap is what
  // keeps a sheet from taxing every task's token budget with a wiki page. A
  // parse failure rather than a truncation: the operator hears "too long" at
  // edit time instead of the model being quietly briefed on half a sentence.
  it("accepts up to 500 characters and rejects past it", () => {
    const at = TeamSheet.safeParse({ channel: minimalChannel({ description: "x".repeat(500) }) });
    expect(at.success).toBe(true);

    const past = TeamSheet.safeParse({ channel: minimalChannel({ description: "x".repeat(501) }) });
    expect(past.success).toBe(false);
  });
});

describe("the example team sheet", () => {
  const sheet = TeamSheet.parse(parse(readFileSync(examplePath, "utf8")));

  it("validates against the schema", () => {
    expect(sheet.channel.name).toBe("engineering");
    // The starter has to carry a pin, because the field is required — and the
    // one it carries has to be a placeholder no certificate could match, since
    // a real fingerprint copied out of a starter sheet would be a channel
    // authorizing a key its operator never minted.
    expect(sheet.channel.certificate_sha256).toEqual([`00:`.repeat(31) + "00"]);
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

  it("curates memory by default, with the file cap the block documents", () => {
    expect(sheet.memory).toEqual({
      enabled: true,
      max_file_chars: 32_768,
      summarize: true,
      summarize_after_idle_minutes: 60
    });
  });

  it("authors skills by default, with the figures the block documents", () => {
    expect(sheet.skills).toEqual({
      enabled: true,
      curate: true,
      author_after_tool_calls: 5,
      top_k: 3,
      max_skill_chars: 8_192,
      max_skills: 100,
      stale_after_days: 30,
      archive_after_days: 90
    });
  });

  // The starter had no assertion at all on this block until #316, which is how
  // it kept shipping `schedule = "0 9 * * 1-5"` — a cron expression nothing
  // validated and nothing read. It is off, and the two figures it documents are
  // the schema's own defaults, so the sheet an operator copies asks for nothing
  // they did not already have.
  it("does not post proactively, and documents the schema's own figures", () => {
    expect(sheet.ambient).toEqual({
      enabled: false,
      heartbeat_every_minutes: 15,
      answer_after_idle_minutes: 60
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

  it("points the GitHub blocks at the hosted server over https", () => {
    const urls = sheet.mcp_server.map((server) =>
      server.transport === "http" ? server.url : null,
    );
    expect(urls).toEqual([
      "https://api.githubcopilot.com/mcp/x/pull_requests",
      "https://api.githubcopilot.com/mcp/x/repos",
      "https://mcp.notion.example/mcp",
    ]);
  });

  // The OAuth block (#255). What the starter is teaching: the auth block is
  // declarations only — issuer and scopes, no token, no lifetime, no endpoint —
  // and the credential is still a name, keying a grant in the token store
  // rather than a vault entry.
  it("carries an OAuth upstream whose auth block holds no secret", () => {
    const notion = sheet.mcp_server[2];
    expect(notion?.name).toBe("notion");
    expect(notion?.credential).toBe("notion_grant");
    expect(notion?.auth).toEqual({
      scheme: "oauth",
      issuer: "https://auth.notion.example",
      scopes: ["mcp.read"],
    });
  });
});

// The built-in block (#64). What the starter is teaching here is that a tool
// the proxy implements itself is granted the same way as one it dials out for —
// delete the block and the channel does not get the tool.
describe("the example sheet's built-in block", () => {
  const sheet = TeamSheet.parse(parse(readFileSync(examplePath, "utf8")));

  it("grants search_channel_history with a per-tool result bound", () => {
    expect(sheet.builtin.map(entry => entry.name)).toEqual([
      "search_channel_history",
      "schedule_task"
    ]);
    expect(sheet.builtin[0]?.approval).toBe("none");
    // Search returns whole messages, so the starter shows the override rather
    // than letting a channel-wide 32k decide how much of other people's
    // conversation reaches the model at once.
    expect(sheet.builtin[0]?.max_result_chars).toBe(8_000);
  });

  // The starter has to *show* the default hold rather than write it, or it
  // teaches the wrong lesson: a sheet that spells `approval = "required"` reads
  // as though forgetting the line would have been fine. #322's acceptance is this
  // absence, and `BUILTIN_APPROVAL_DEFAULT` is what makes it a hold.
  it("lists schedule_task with no approval line at all", () => {
    const entry = sheet.builtin[1];
    expect(entry?.name).toBe("schedule_task");
    expect(entry?.approval).toBeUndefined();
  });

  // Both switches, and the starter leaves the second one off. A create against
  // this sheet as written is refused `ambient_disabled` — which is the posture
  // the file argues for everywhere else and should not quietly change because a
  // second built-in wanted a working example.
  it("leaves ambient off, so the create it lists is refused", () => {
    expect(sheet.ambient.enabled).toBe(false);
  });

  it("carries no url and no credential, because there is nothing to dial", () => {
    expect(sheet.builtin[0]).not.toHaveProperty("url");
    expect(sheet.builtin[0]).not.toHaveProperty("credential");
  });
});

// #79. The field that makes a leaked key revocable without retiring the
// channel, so what is asserted here is mostly what a sheet CANNOT say.
describe("the channel's pinned certificates", () => {
  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`);
  };

  it("is required, so a sheet naming no certificate does not parse", () => {
    expect(paths({ channel: { name: "ops" } })).toEqual(["channel.certificate_sha256: invalid_type"]);
  });

  // The load-bearing one. An empty list is not "this channel pins nothing" — it
  // is unsayable, so no code downstream can ever read it as "any certificate
  // this CA signed", which is the behaviour the field exists to end.
  it("cannot be empty", () => {
    expect(paths({ channel: { name: "ops", certificate_sha256: [] } })).toEqual([
      "channel.certificate_sha256: too_small",
    ]);
  });

  it("holds two, which is what a rotation in progress looks like", () => {
    const sheet = TeamSheet.parse({
      channel: minimalChannel({ certificate_sha256: [PIN, "CD".repeat(32)] }),
    });
    expect(sheet.channel.certificate_sha256).toHaveLength(2);
  });

  // Not a limit on rotations: a rotation needs two. Five is an operator who
  // stopped dropping the old fingerprint, which is the state this field exists
  // to keep a deployment out of.
  it("refuses a list long enough to be a pile of unretired keys", () => {
    expect(
      paths({ channel: minimalChannel({ certificate_sha256: Array(5).fill(PIN) }) }),
    ).toEqual(["channel.certificate_sha256: too_big"]);
  });

  it("names the entry that is not a fingerprint", () => {
    expect(
      paths({ channel: minimalChannel({ certificate_sha256: [PIN, "not-a-digest"] }) }),
    ).toEqual(["channel.certificate_sha256.1: invalid_format"]);
  });
});

describe("the built-in block", () => {
  const builtinSheet = (builtin: unknown) => ({ channel: minimalChannel(), builtin });

  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`);
  };

  it("defaults to empty, so a sheet that says nothing grants nothing", () => {
    expect(TeamSheet.parse({ channel: minimalChannel() }).builtin).toEqual([]);
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
        channel: minimalChannel(),
        mcp_server: [{ name: "libero", transport: "http", url: "https://evil.example.com/mcp" }],
      })
    ).toEqual(["mcp_server.0.name: custom"]);
  });

  it("names the offending block when it is not the first", () => {
    expect(
      paths({
        channel: minimalChannel(),
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
        channel: minimalChannel(),
        mcp_server: [{ name: "libero_tools", transport: "stdio" }],
      })
    ).toBeNull();
  });
});

describe("the memory block", () => {
  const memorySheet = (memory: unknown) => ({ channel: minimalChannel(), memory });

  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`);
  };

  // The one block on this sheet that is on when it is absent, unlike [ambient]
  // and unlike [[builtin]]. Curation is the agent remembering something it was
  // already asked about, into a capped file the team can edit; ambient is the
  // agent starting work nobody asked for.
  it("curates by default when the block is absent", () => {
    expect(TeamSheet.parse({ channel: minimalChannel() }).memory.enabled).toBe(true);
  });

  it("accepts a channel that opts out, and keeps its figures", () => {
    const sheet = TeamSheet.parse(memorySheet({ enabled: false, max_file_chars: 8_192 }));
    expect(sheet.memory).toEqual({
      enabled: false,
      max_file_chars: 8_192,
      summarize: true,
      summarize_after_idle_minutes: 60
    });
  });

  // A file cap below one operation's ceiling is a channel where a legal
  // operation is unwritable by construction — the "parses, then cannot serve a
  // call" class the McpServer union refuses at parse for the same reason. The
  // issue lands on the field an operator has to edit, which is why this is a
  // bound on the field rather than a check on the block.
  it("refuses a file cap smaller than one operation, naming the field", () => {
    expect(paths(memorySheet({ max_file_chars: MEMORY_OP_MAX_TEXT_CHARS - 1 }))).toEqual([
      "memory.max_file_chars: too_small",
    ]);
  });

  it("accepts a file cap of exactly one operation", () => {
    expect(paths(memorySheet({ max_file_chars: MEMORY_OP_MAX_TEXT_CHARS }))).toBeNull();
  });

  it("refuses a cap past the sanity bound", () => {
    expect(paths(memorySheet({ max_file_chars: 262_145 }))).toEqual([
      "memory.max_file_chars: too_big",
    ]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 8_192.5],
    ["a string", "32768"],
  ])("refuses %s as a file cap", (_label, max_file_chars) => {
    expect(TeamSheet.safeParse(memorySheet({ max_file_chars })).success).toBe(false);
  });

  it("refuses a non-boolean switch", () => {
    expect(paths(memorySheet({ enabled: "yes" }))).toEqual(["memory.enabled: invalid_type"]);
  });

  // Summarization (#231). On by default for `enabled`'s reason, and it is the
  // first thing on this sheet that spends model tokens without anyone having
  // addressed the agent — so the default being `true` is a decision, and
  // asserting it is how it stays one rather than becoming an accident.
  it("summarizes threads by default, an hour after they go quiet", () => {
    const sheet = TeamSheet.parse(memorySheet({}));

    expect(sheet.memory.summarize).toBe(true);
    expect(sheet.memory.summarize_after_idle_minutes).toBe(60);
  });

  // Two switches rather than one, because they authorize different things: a
  // channel may want the agent to remember what it was asked and not to read
  // conversations it was never in.
  it("lets a channel turn summarization off while keeping curation on", () => {
    const sheet = TeamSheet.parse(memorySheet({ summarize: false }));

    expect(sheet.memory.summarize).toBe(false);
    expect(sheet.memory.enabled).toBe(true);
  });

  // A threshold this low summarizes a conversation still in progress, which
  // stores a conclusion the team had not reached.
  it("refuses an idle threshold below five minutes", () => {
    expect(paths(memorySheet({ summarize_after_idle_minutes: 4 }))).toEqual([
      "memory.summarize_after_idle_minutes: too_small"
    ]);
    expect(paths(memorySheet({ summarize_after_idle_minutes: 0 }))).toEqual([
      "memory.summarize_after_idle_minutes: too_small"
    ]);
    expect(paths(memorySheet({ summarize_after_idle_minutes: 5 }))).toBeNull();
  });

  // Past a week the thread has not gone quiet, the channel has.
  it("refuses an idle threshold beyond a week", () => {
    expect(paths(memorySheet({ summarize_after_idle_minutes: 10_081 }))).toEqual([
      "memory.summarize_after_idle_minutes: too_big"
    ]);
    expect(paths(memorySheet({ summarize_after_idle_minutes: 10_080 }))).toBeNull();
  });

  it.each([
    ["a fraction", 30.5],
    ["a string", "60"],
    ["null", null]
  ])("refuses %s as an idle threshold", (_label, summarize_after_idle_minutes) => {
    expect(TeamSheet.safeParse(memorySheet({ summarize_after_idle_minutes })).success).toBe(false);
  });
});

describe("the skills block", () => {
  const skillsSheet = (skills: unknown) => ({ channel: minimalChannel(), skills });

  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`);
  };

  // On when absent, like [memory] and unlike [ambient], on the same test: a
  // skill comes out of a task somebody asked for, into capped text the team can
  // read and edit, on a metered turn. Asserting the default is how it stays a
  // decision rather than becoming an accident — and flipping it later would be
  // a behaviour change for every sheet that never mentioned the block.
  it("authors skills by default when the block is absent", () => {
    expect(TeamSheet.parse({ channel: minimalChannel() }).skills.enabled).toBe(true);
  });

  it("accepts a channel that opts out, and keeps its figures", () => {
    const sheet = TeamSheet.parse(skillsSheet({ enabled: false, top_k: 5 }));
    expect(sheet.skills).toEqual({
      enabled: false,
      curate: true,
      author_after_tool_calls: 5,
      top_k: 5,
      max_skill_chars: 8_192,
      max_skills: 100,
      stale_after_days: 30,
      archive_after_days: 90
    });
  });

  it("refuses a non-boolean switch", () => {
    expect(paths(skillsSheet({ enabled: "yes" }))).toEqual(["skills.enabled: invalid_type"]);
  });

  // The second thing on the sheet that spends with nobody waiting, and the
  // second switch on a block whose others are numbers. On by default for
  // `summarize`'s reason; independent of `enabled` so a channel can keep its
  // playbooks and decline to be asked about them.
  it("curates by default, and takes an opt-out that leaves the rest alone", () => {
    expect(TeamSheet.parse({ channel: minimalChannel() }).skills.curate).toBe(true);

    const sheet = TeamSheet.parse(skillsSheet({ curate: false }));
    expect(sheet.skills.curate).toBe(false);
    expect(sheet.skills.enabled).toBe(true);
  });

  it("refuses a non-boolean curate switch", () => {
    expect(paths(skillsSheet({ curate: "yes" }))).toEqual(["skills.curate: invalid_type"]);
  });

  // The relationship to `SKILL_BODY_MAX_CHARS` is a floor, not a roof, and it is
  // the one number on this block most likely to be inverted by someone reading
  // it quickly. A cap below the constant would publish a JSON Schema promising
  // the model a length this channel refuses — a per-channel lie inside a module
  // constant. The issue lands on the field an operator edits, which is why this
  // is a bound rather than a check on the block.
  it("refuses a skill cap smaller than one operation, naming the field", () => {
    expect(paths(skillsSheet({ max_skill_chars: SKILL_BODY_MAX_CHARS - 1 }))).toEqual([
      "skills.max_skill_chars: too_small"
    ]);
  });

  it("accepts a skill cap of exactly one operation", () => {
    expect(paths(skillsSheet({ max_skill_chars: SKILL_BODY_MAX_CHARS }))).toBeNull();
  });

  it("refuses a skill cap past the sanity bound", () => {
    expect(paths(skillsSheet({ max_skill_chars: 65_537 }))).toEqual([
      "skills.max_skill_chars: too_big"
    ]);
    expect(paths(skillsSheet({ max_skill_chars: 65_536 }))).toBeNull();
  });

  // Zero is `enabled = false` said a second way, and one switch with two
  // spellings is one of them going untested.
  it("refuses a top_k of zero", () => {
    expect(paths(skillsSheet({ top_k: 0 }))).toEqual(["skills.top_k: too_small"]);
    expect(paths(skillsSheet({ top_k: 1 }))).toBeNull();
  });

  it("refuses a top_k past the bound", () => {
    expect(paths(skillsSheet({ top_k: 11 }))).toEqual(["skills.top_k: too_big"]);
    expect(paths(skillsSheet({ top_k: 10 }))).toBeNull();
  });

  // Zero would author after a task with no tool calls at all, which is a
  // different feature and not this one.
  it("refuses an author threshold of zero", () => {
    expect(paths(skillsSheet({ author_after_tool_calls: 0 }))).toEqual([
      "skills.author_after_tool_calls: too_small"
    ]);
    expect(paths(skillsSheet({ author_after_tool_calls: 1 }))).toBeNull();
  });

  // No roof, matching `max_tool_calls_per_task`. A channel that sets it above
  // its own tool cap has turned authoring off the long way round, which is legal
  // and does no harm — and refusing the combination would refuse a sheet
  // mid-edit, while one is being lowered before the other is raised.
  it("accepts an author threshold above the channel's own tool cap", () => {
    expect(
      paths({
        channel: minimalChannel(),
        llm: { max_tool_calls_per_task: 5 },
        skills: { author_after_tool_calls: 50 }
      })
    ).toBeNull();
  });

  it("refuses a library cap of zero, and one past the bound", () => {
    expect(paths(skillsSheet({ max_skills: 0 }))).toEqual(["skills.max_skills: too_small"]);
    expect(paths(skillsSheet({ max_skills: 1_001 }))).toEqual(["skills.max_skills: too_big"]);
    expect(paths(skillsSheet({ max_skills: 1_000 }))).toBeNull();
  });

  it.each([
    ["a fraction", 3.5],
    ["a string", "3"],
    ["null", null],
    ["negative", -1]
  ])("refuses %s as a top_k", (_label, top_k) => {
    expect(TeamSheet.safeParse(skillsSheet({ top_k })).success).toBe(false);
  });

  // The two clocks (#294). The spec's figures, and the claim the block made
  // before they existed: adding them was a new optional field either way, so a
  // sheet written against the old schema still parses to the same behaviour.
  it("runs the spec's clocks by default", () => {
    const sheet = TeamSheet.parse({ channel: minimalChannel() });
    expect(sheet.skills.stale_after_days).toBe(30);
    expect(sheet.skills.archive_after_days).toBe(90);
  });

  it("takes a channel's own clocks", () => {
    const sheet = TeamSheet.parse(skillsSheet({ stale_after_days: 7, archive_after_days: 14 }));
    expect(sheet.skills.stale_after_days).toBe(7);
    expect(sheet.skills.archive_after_days).toBe(14);
  });

  // Not a policy anybody meant: it makes `stale` unreachable, so the waypoint a
  // team is supposed to see in git never appears.
  it("refuses a sheet that would archive before it goes stale", () => {
    expect(paths(skillsSheet({ stale_after_days: 60, archive_after_days: 30 }))).toEqual([
      "skills.archive_after_days: custom"
    ]);
  });

  // The case the message has to read well for: only one field was set, and the
  // other is the default it now contradicts.
  it("refuses a stale threshold set past the default archive one", () => {
    expect(paths(skillsSheet({ stale_after_days: 120 }))).toEqual([
      "skills.archive_after_days: custom"
    ]);
  });

  it("accepts the two set equal", () => {
    expect(paths(skillsSheet({ stale_after_days: 30, archive_after_days: 30 }))).toBeNull();
  });

  // Zero is the clocks turned off said a second way, which is `top_k`'s call.
  it.each([["stale_after_days"], ["archive_after_days"]])("refuses a %s of zero", field => {
    expect(paths(skillsSheet({ [field]: 0 }))).toContain(`skills.${field}: too_small`);
  });

  it("refuses a clock past the sanity bound", () => {
    expect(paths(skillsSheet({ stale_after_days: 3_651, archive_after_days: 3_651 }))).toEqual([
      "skills.stale_after_days: too_big",
      "skills.archive_after_days: too_big"
    ]);
    expect(paths(skillsSheet({ stale_after_days: 3_650, archive_after_days: 3_650 }))).toBeNull();
  });
});

describe("the ambient block", () => {
  const ambientSheet = (ambient: unknown) => ({ channel: minimalChannel(), ambient });

  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.code}`);
  };

  // Off when absent, unlike [memory] and [skills], and this is the block those
  // two argue their own defaults against: ambient is the agent starting work
  // nobody asked for. The figures are the ordinary kind and default beside it.
  it("is off by default, with a cadence and a threshold beside it", () => {
    expect(TeamSheet.parse({ channel: minimalChannel() }).ambient).toEqual({
      enabled: false,
      heartbeat_every_minutes: 15,
      answer_after_idle_minutes: 60
    });
  });

  // The decision #316 landed on: `enabled = true` with nothing else written is a
  // sheet, not an error. The switch is `enabled`; the figures beside it default,
  // as they do on every other block. There is no `.check()` here to trip.
  it("accepts a channel that opts in and writes no figures", () => {
    expect(TeamSheet.parse(ambientSheet({ enabled: true })).ambient).toEqual({
      enabled: true,
      heartbeat_every_minutes: 15,
      answer_after_idle_minutes: 60
    });
  });

  // The other direction, which [memory]'s note relies on staying true: a channel
  // keeping its figures through a temporary opt-out is the ordinary case.
  it("accepts figures set beside an opted-out switch", () => {
    expect(paths(ambientSheet({ enabled: false, heartbeat_every_minutes: 60 }))).toBeNull();
  });

  // Zero is `enabled = false` said a second way, which is the call `top_k` and
  // the skill clocks already made against themselves.
  it("refuses a cadence of zero", () => {
    expect(paths(ambientSheet({ heartbeat_every_minutes: 0 }))).toEqual([
      "ambient.heartbeat_every_minutes: too_small"
    ]);
    expect(paths(ambientSheet({ heartbeat_every_minutes: 1 }))).toBeNull();
  });

  // Past a day the heartbeat is not noticing anything.
  it("refuses a cadence beyond a day", () => {
    expect(paths(ambientSheet({ heartbeat_every_minutes: 1_441 }))).toEqual([
      "ambient.heartbeat_every_minutes: too_big"
    ]);
    expect(paths(ambientSheet({ heartbeat_every_minutes: 1_440 }))).toBeNull();
  });

  // The threshold's bounds are `summarize_after_idle_minutes`', because
  // architecture.md names it that field's sibling. A threshold this low answers a
  // question the team is still in the middle of asking.
  it("refuses an answer threshold below five minutes", () => {
    expect(paths(ambientSheet({ answer_after_idle_minutes: 4 }))).toEqual([
      "ambient.answer_after_idle_minutes: too_small"
    ]);
    expect(paths(ambientSheet({ answer_after_idle_minutes: 5 }))).toBeNull();
  });

  it("refuses an answer threshold beyond a week", () => {
    expect(paths(ambientSheet({ answer_after_idle_minutes: 10_081 }))).toEqual([
      "ambient.answer_after_idle_minutes: too_big"
    ]);
    expect(paths(ambientSheet({ answer_after_idle_minutes: 10_080 }))).toBeNull();
  });

  it.each([
    ["a fraction", 15.5],
    ["a string", "15"],
    ["null", null]
  ])("refuses %s as a cadence", (_label, heartbeat_every_minutes) => {
    expect(TeamSheet.safeParse(ambientSheet({ heartbeat_every_minutes })).success).toBe(false);
  });

  it.each([
    ["a fraction", 60.5],
    ["a string", "60"],
    ["null", null]
  ])("refuses %s as an answer threshold", (_label, answer_after_idle_minutes) => {
    expect(TeamSheet.safeParse(ambientSheet({ answer_after_idle_minutes })).success).toBe(false);
  });

  it("refuses a non-boolean switch", () => {
    expect(paths(ambientSheet({ enabled: "yes" }))).toEqual(["ambient.enabled: invalid_type"]);
  });

  // The field this block carried from the initial commit until #316, when the
  // grammar question was answered by not having one: an interval is a number,
  // and this sheet spells durations as integers with the unit in the name. An
  // unknown key strips rather than failing, so the assertion is that the old
  // spelling reaches nothing rather than that it is rejected.
  it("does not carry a cron schedule", () => {
    const sheet = TeamSheet.parse(ambientSheet({ schedule: "0 9 * * 1-5" }));
    expect(sheet.ambient).not.toHaveProperty("schedule");
  });
});

describe("defaults", () => {
  // A sheet with no [llm] section must still yield every cap: the composition
  // root maps sheet to caps field by field and has no defaults of its own.
  it("yields every cap and bound when the llm section is absent", () => {
    const sheet = TeamSheet.parse({ channel: minimalChannel() });
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
      channel: minimalChannel(),
      llm: { max_history_messages: 0, max_history_chars: 0 },
    });
    expect(sheet.llm.max_history_messages).toBe(0);
    expect(sheet.llm.max_history_chars).toBe(0);
  });

  it("fills each cap the section omits", () => {
    const sheet = TeamSheet.parse({ channel: minimalChannel(), llm: { max_task_seconds: 60 } });
    expect(sheet.llm.max_task_seconds).toBe(60);
    expect(sheet.llm.max_tokens_per_task).toBe(200_000);
  });

  it("fills every optional section from a minimal sheet", () => {
    const sheet = TeamSheet.parse({ channel: minimalChannel() });
    expect(sheet.budget).toEqual({
      daily_tokens: 1_000_000,
      daily_tool_calls: 200,
      cache_read_weight: 0.1,
      cache_write_weight: 1.25,
      warn_at: 0.8,
    });
    expect(sheet.mcp_server).toEqual([]);
    expect(sheet.egress.allow).toEqual([]);
    expect(sheet.ambient).toEqual({
      enabled: false,
      heartbeat_every_minutes: 15,
      answer_after_idle_minutes: 60
    });
    expect(sheet.memory).toEqual({
      enabled: true,
      max_file_chars: 32_768,
      summarize: true,
      summarize_after_idle_minutes: 60
    });
    expect(sheet.skills).toEqual({
      enabled: true,
      curate: true,
      author_after_tool_calls: 5,
      top_k: 3,
      max_skill_chars: 8_192,
      max_skills: 100,
      stale_after_days: 30,
      archive_after_days: 90
    });
  });

  // The one field here with no default, and deliberately (#62). Every other
  // number in this block is a brake and has a figure that is safe to assume; a
  // dollar cap is a bill, and there is none that is right for an operator who
  // has not named one. Absent must therefore stay distinguishable from zero.
  it("leaves daily_usd absent rather than defaulting it", () => {
    const sheet = TeamSheet.parse({ channel: minimalChannel() });
    expect(sheet.budget.daily_usd).toBeUndefined();
    expect("daily_usd" in sheet.budget).toBe(false);
  });

  it("takes a dollar cap beside the token one, and refuses a non-positive figure", () => {
    const capped = (budget: Record<string, unknown>) =>
      TeamSheet.safeParse({ channel: minimalChannel(), budget });

    // Both, which is the case the two limits are written to allow: whichever
    // binds first refuses, and a channel on self-hosted models keeps the token
    // brake with no spend to cap.
    expect(capped({ daily_usd: 25, daily_tokens: 500_000 }).success).toBe(true);
    // A float, unlike every other budget field. It is money.
    expect(capped({ daily_usd: 0.05 }).success).toBe(true);
    expect(capped({ daily_usd: 0 }).success).toBe(false);
    expect(capped({ daily_usd: -1 }).success).toBe(false);

    const refused = capped({ daily_usd: 0 });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["budget", "daily_usd"]);
  });

  // A weight is a price ratio, not a count: fractional is the normal case, and
  // zero is a deliberate setting meaning a cache read costs nothing here.
  it("accepts a fractional or zero cache weight and rejects a negative one", () => {
    const weighted = (budget: Record<string, unknown>) =>
      TeamSheet.safeParse({ channel: minimalChannel(), budget });

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
      TeamSheet.safeParse({ channel: minimalChannel(), budget: { warn_at } });

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
    channel: minimalChannel(),
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

// The auth block (#255). The property every case guards from a different side:
// the sheet can declare that an upstream speaks OAuth, and cannot express a
// secret, a token, a lifetime, or an endpoint while doing it.
describe("an mcp_server's auth block", () => {
  const serverSheet = (server: Record<string, unknown>) => ({
    channel: minimalChannel(),
    mcp_server: [server],
  });

  const paths = (data: unknown) => {
    const result = TeamSheet.safeParse(data);
    if (result.success) return null;
    return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`);
  };

  const oauthServer = (auth: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    serverSheet({
      name: "notion",
      transport: "http",
      url: "http://mcp:3001",
      credential: "notion_grant",
      auth,
      ...extra,
    });

  it("accepts an http upstream declaring an issuer and scopes", () => {
    expect(paths(oauthServer({ scheme: "oauth", issuer: "https://as.example", scopes: ["mcp.read"] }))).toBeNull();
  });

  it("defaults scopes to none", () => {
    const sheet = TeamSheet.parse(oauthServer({ scheme: "oauth", issuer: "https://as.example" }));
    expect(sheet.mcp_server[0]?.auth?.scopes).toEqual([]);
  });

  // A loopback issuer parses, deliberately: the fake authorization server the
  // tests stand up has no certificate, and `url` above takes http for the same
  // reason.
  it("accepts a loopback http issuer", () => {
    expect(paths(oauthServer({ scheme: "oauth", issuer: "http://127.0.0.1:39001" }))).toBeNull();
  });

  // Same treatment as a stdio url, for the same reason: zod strips unknown
  // keys, so an undeclared auth on a stdio block would be dropped in silence
  // and the operator would read the sheet as secured.
  it("rejects a stdio block carrying auth, naming the field", () => {
    expect(
      paths(
        serverSheet({
          name: "runner",
          transport: "stdio",
          credential: "runner_grant",
          auth: { scheme: "oauth", issuer: "https://as.example" },
        }),
      ),
    ).toEqual(["mcp_server.0.auth: invalid_type"]);
  });

  // The name is what the grant flow stored the refresh token under; a block
  // with no name has no grant to key. The issue lands on `credential` because
  // that is the field the operator must add.
  it("rejects an oauth block with no credential, naming that field", () => {
    expect(
      paths(
        serverSheet({
          name: "notion",
          transport: "http",
          url: "http://mcp:3001",
          auth: { scheme: "oauth", issuer: "https://as.example" },
        }),
      ),
    ).toEqual(["mcp_server.0.credential: custom"]);
  });

  // An issuer identifier is compared byte-for-byte, and RFC 8414 gives it no
  // query and no fragment — a place a token could otherwise be written into
  // the one file that holds none.
  it("rejects an issuer carrying a query or a fragment", () => {
    expect(paths(oauthServer({ scheme: "oauth", issuer: "https://as.example/?tenant=1" }))).toEqual([
      "mcp_server.0.auth.issuer: custom",
    ]);
    expect(paths(oauthServer({ scheme: "oauth", issuer: "https://as.example/#frag" }))).toEqual([
      "mcp_server.0.auth.issuer: custom",
    ]);
  });

  it("rejects a scheme it does not know", () => {
    expect(paths(oauthServer({ scheme: "basic", issuer: "https://as.example" }))).toEqual([
      "mcp_server.0.auth.scheme: invalid_value",
    ]);
  });

  it("rejects a scope with a space, a quote, or a backslash", () => {
    for (const scope of ["a b", 'a"b', "a\\b", ""]) {
      expect(paths(oauthServer({ scheme: "oauth", issuer: "https://as.example", scopes: [scope] }))).not.toBeNull();
    }
  });

  it("bounds the scope list and the scope word", () => {
    expect(
      paths(oauthServer({ scheme: "oauth", issuer: "https://as.example", scopes: Array.from({ length: 17 }, (_, i) => `s${i}`) })),
    ).toEqual(["mcp_server.0.auth.scopes: too_big"]);
    expect(
      paths(oauthServer({ scheme: "oauth", issuer: "https://as.example", scopes: ["x".repeat(129)] })),
    ).toEqual(["mcp_server.0.auth.scopes.0: too_big"]);
  });

  // The structural half of "no secret is expressible": the parsed type has
  // exactly three keys, so a token or expiry written into the block is
  // stripped rather than carried, and the assertions above make the stripping
  // loud where it would mislead (stdio). This is the sheet's defining property
  // — it holds no value — surviving the new block.
  it("carries exactly scheme, issuer, and scopes", () => {
    const sheet = TeamSheet.parse(
      oauthServer({
        scheme: "oauth",
        issuer: "https://as.example",
        scopes: [],
        access_token: "leaked",
        expires_in: 3600,
        token_endpoint: "https://elsewhere.example/token",
      }),
    );
    expect(Object.keys(sheet.mcp_server[0]?.auth ?? {}).sort()).toEqual(["issuer", "scheme", "scopes"]);
  });
});

describe("rejections", () => {
  it("rejects an unknown transport", () => {
    const result = TeamSheet.safeParse({
      channel: minimalChannel(),
      mcp_server: [{ name: "github", transport: "websocket" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing channel name", () => {
    expect(TeamSheet.safeParse({ channel: { certificate_sha256: [PIN] } }).success).toBe(false);
    expect(TeamSheet.safeParse({ channel: minimalChannel({ name: "" }) }).success).toBe(false);
  });

  it("rejects a non-positive budget", () => {
    const result = TeamSheet.safeParse({
      channel: minimalChannel(),
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
      expect(TeamSheet.safeParse({ channel: minimalChannel(), llm }).success).toBe(false);
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
      expect(TeamSheet.safeParse({ channel: minimalChannel(), llm }).success).toBe(false);
    }
  });

  // Zero is off, which is a channel saying the agent answers only what it is
  // addressed in. The ceiling is SESSION_IDLE_MS in apps/server's session
  // registry: a session — and with it the set of threads it will answer — is
  // evicted after thirty minutes idle, so a longer window is one the process
  // cannot keep, and saying so here is what stops it being advertised.
  it("accepts a zero follow-up window and rejects one longer than a session lives", () => {
    const off = TeamSheet.parse({
      channel: minimalChannel(),
      llm: { follow_up_window_seconds: 0 },
    });
    expect(off.llm.follow_up_window_seconds).toBe(0);

    for (const llm of [
      { follow_up_window_seconds: -1 },
      { follow_up_window_seconds: 1801 },
      { follow_up_window_seconds: 90.5 },
    ]) {
      expect(TeamSheet.safeParse({ channel: minimalChannel(), llm }).success).toBe(false);
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
    expect(TeamSheet.safeParse({ channel: minimalChannel(), llm: { max_result_chars } }).success).toBe(false);
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
      channel: minimalChannel(),
      mcp_server: [
        { name: "github", transport: "http", url: "http://x/mcp", tool: [{ name: "list_prs", max_result_chars }] },
      ],
    };
    expect(TeamSheet.safeParse(sheet).success).toBe(false);
  });

  it("leaves the per-tool result bound absent when the entry names none", () => {
    const sheet = TeamSheet.parse({
      channel: minimalChannel(),
      mcp_server: [{ name: "github", transport: "http", url: "http://x/mcp", tool: [{ name: "list_prs" }] }],
    });
    expect(sheet.mcp_server[0]?.tool[0]?.max_result_chars).toBeUndefined();
  });

  it("rejects a fractional per-task cap", () => {
    const result = TeamSheet.safeParse({
      channel: minimalChannel(),
      llm: { max_task_seconds: 1.5 },
    });
    expect(result.success).toBe(false);
  });
});
