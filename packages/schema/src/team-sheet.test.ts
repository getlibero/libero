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
    expect(sheet.budget).toEqual({ daily_tokens: 2_000_000, daily_tool_calls: 400 });
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
  it("fills every optional section from a minimal sheet", () => {
    const sheet = TeamSheet.parse({ channel: { name: "ops" } });
    expect(sheet.budget).toEqual({ daily_tokens: 1_000_000, daily_tool_calls: 200 });
    expect(sheet.mcp_server).toEqual([]);
    expect(sheet.egress.allow).toEqual([]);
    expect(sheet.ambient.enabled).toBe(false);
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
});
