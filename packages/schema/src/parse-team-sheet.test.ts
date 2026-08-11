import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTeamSheet } from "./parse-team-sheet.js";

const examplePath = new URL("../../../channels/example/channel.toml", import.meta.url);

describe("parsing a team sheet", () => {
  it("parses the documented starter sheet", () => {
    const result = parseTeamSheet(readFileSync(examplePath, "utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheet.channel.name).toBe("engineering");
    expect(result.sheet.mcp_server[0]?.tool.map(t => t.name)).toEqual([
      "list_pull_requests",
      "pull_request_read",
      "merge_pull_request"
    ]);
  });

  it("fills defaults from a minimal sheet", () => {
    const result = parseTeamSheet('[channel]\nname = "ops"\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheet.budget.daily_tokens).toBe(1_000_000);
    expect(result.sheet.llm.max_task_seconds).toBe(300);
  });
});

describe("reporting why a sheet did not parse", () => {
  // Malformed TOML and a well-formed file that breaks the schema are different
  // mistakes with different fixes, so they are different reasons.
  it("separates a syntax error from a schema violation", () => {
    const syntax = parseTeamSheet('[channel\nname = "ops"\n');
    expect(syntax.ok).toBe(false);
    if (syntax.ok) return;
    expect(syntax.reason).toBe("toml_syntax");

    const schema = parseTeamSheet('[channel]\nname = "ops"\n\n[budget]\ndaily_tokens = 0\n');
    expect(schema.ok).toBe(false);
    if (schema.ok) return;
    expect(schema.reason).toBe("schema_invalid");
  });

  it("gives a position for a syntax error", () => {
    const result = parseTeamSheet('[channel]\nname = "ops"\nbroken = [1,\n');
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "toml_syntax") return;
    expect(result.line).toBeGreaterThan(0);
    expect(result.column).toBeGreaterThan(0);
  });

  it("names the field that failed and how", () => {
    const result = parseTeamSheet(
      '[channel]\nname = "ops"\n\n[[mcp_server]]\nname = "github"\ntransport = "websocket"\n'
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "schema_invalid") return;
    // `invalid_union`, not `invalid_value`: McpServer is discriminated on
    // transport, so an unknown one fails to select a member rather than failing
    // an enum. The path is the part that matters and it still names the field.
    expect(result.issues).toContainEqual({ path: "mcp_server.0.transport", code: "invalid_union" });
  });

  // The two shapes #89 made unrepresentable, through the loader's own reporting
  // rather than the schema's: this is the line an operator reads.
  it("names the url when a transport and its address disagree", () => {
    const missing = parseTeamSheet(
      '[channel]\nname = "ops"\n\n[[mcp_server]]\nname = "github"\ntransport = "http"\n'
    );
    expect(missing.ok).toBe(false);
    if (missing.ok || missing.reason !== "schema_invalid") return;
    expect(missing.issues).toContainEqual({ path: "mcp_server.0.url", code: "invalid_type" });

    const spurious = parseTeamSheet(
      '[channel]\nname = "ops"\n\n[[mcp_server]]\nname = "github"\ntransport = "stdio"\nurl = "http://mcp:3001"\n'
    );
    expect(spurious.ok).toBe(false);
    if (spurious.ok || spurious.reason !== "schema_invalid") return;
    expect(spurious.issues).toContainEqual({ path: "mcp_server.0.url", code: "invalid_type" });
  });

  it("reports every failure, not just the first", () => {
    const result = parseTeamSheet(
      '[channel]\nname = ""\n\n[budget]\ndaily_tokens = 0\ndaily_tool_calls = -1\n'
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "schema_invalid") return;
    expect(result.issues.length).toBeGreaterThan(1);
  });

  // The proxy's logger takes a closed field set so that no call site can
  // interpolate a value into a log line. A parser handing it prose would route
  // around that, so the failure side carries paths and codes only.
  it("carries no free-form message and no value out of the file", () => {
    const result = parseTeamSheet(
      '[channel]\nname = "ops"\n\n[[mcp_server]]\nname = "github"\ntransport = "sk-live-abc123"\n'
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "schema_invalid") return;
    expect(JSON.stringify(result)).not.toContain("sk-live-abc123");
    for (const issue of result.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });

  it("does not throw on any of these", () => {
    for (const text of ["", "\0", "[[[", 'x = "y"', "[channel]", "= 1"]) {
      expect(() => parseTeamSheet(text)).not.toThrow();
    }
  });
});
