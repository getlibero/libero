import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { expect } from "expect";
import { parseTeamSheet } from "./parse-team-sheet.js";
import { parseSkillFile } from "./skill.js";

const examplePath = new URL("../../../channels/example/channel.toml", import.meta.url);

/** The shared root the starter sheet's `[[shared_skill]]` entries name into. */
const sharedSkillPath = (name: string): URL =>
  new URL(`../../../shared-skills/${name}.md`, import.meta.url);

/**
 * The smallest `[channel]` block that parses, as TOML text.
 *
 * Since #79 that is a name *and* at least one pinned certificate, so the cases
 * below — none of which are about `[channel]` — build theirs from here rather
 * than each carrying the required set. The fingerprint matches nothing.
 */
const CHANNEL = `[channel]\nname = "ops"\ncertificate_sha256 = ["${"AB".repeat(32)}"]\n`;

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
    expect(result.sheet.shared_skill).toEqual([
      { name: "brand-voice", load: "always" },
      { name: "code-review-standards", load: "retrieved" }
    ]);
    expect(result.sheet.ambient.rule.map(rule => rule.name)).toEqual([
      "standup-digest",
      "friday-release-check"
    ]);
  });

  // `[[ambient.rule]]` is the first array of tables the starter nests inside
  // another block, and TOML reads that placement rather than the name: the
  // entries have to follow `[ambient]`'s own keys, and a later `[block]` would
  // end them. Worth an assertion of its own, because a sheet that got this wrong
  // parses fine as TOML and simply loses the block it meant to write.
  it("keeps the nested rules inside the ambient block", () => {
    const result = parseTeamSheet(readFileSync(examplePath, "utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sheet.ambient.rule).toHaveLength(2);
    expect(result.sheet.ambient.heartbeat_every_minutes).toBe(15);
  });

  // The starter sheet names two shared skills, and `shared-skills/` is what a
  // deployment mounts read-only at `AGENT_SHARED_SKILLS_ROOT` (#433). A name
  // with no file there is the exact failure `libero doctor` exists to catch and
  // the runtime can only log — so the documented example must not be the first
  // instance of it. Bound here rather than left to a reader, because the two
  // halves are in different directories and nothing else looks at both.
  it("names shared skills the shared root actually holds", () => {
    const result = parseTeamSheet(readFileSync(examplePath, "utf8"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const entry of result.sheet.shared_skill) {
      const parsed = parseSkillFile(readFileSync(sharedSkillPath(entry.name), "utf8"));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      // The filename is the identity and the frontmatter is not, so a file whose
      // frontmatter disagrees is one the runtime skips — which would make the
      // published example unloadable while still parsing.
      expect(parsed.skill.frontmatter.name).toBe(entry.name);
    }
  });

  it("fills defaults from a minimal sheet", () => {
    const result = parseTeamSheet(CHANNEL);
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

    const schema = parseTeamSheet(CHANNEL + '\n[budget]\ndaily_tokens = 0\n');
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
      CHANNEL + '\n[[mcp_server]]\nname = "github"\ntransport = "websocket"\n'
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
      CHANNEL + '\n[[mcp_server]]\nname = "github"\ntransport = "http"\n'
    );
    expect(missing.ok).toBe(false);
    if (missing.ok || missing.reason !== "schema_invalid") return;
    expect(missing.issues).toContainEqual({ path: "mcp_server.0.url", code: "invalid_type" });

    const spurious = parseTeamSheet(
      CHANNEL + '\n[[mcp_server]]\nname = "github"\ntransport = "stdio"\nurl = "http://mcp:3001"\n'
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
      CHANNEL + '\n[[mcp_server]]\nname = "github"\ntransport = "sk-live-abc123"\n'
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "schema_invalid") return;
    expect(JSON.stringify(result)).not.toContain("sk-live-abc123");
    for (const issue of result.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });

  // The acceptance criterion travelling through the layer an operator actually
  // meets. An entry that does not say how it loads is a mistake rather than a
  // preference, and this is where they are told so.
  it("names the shared skill that did not say how it loads", () => {
    const result = parseTeamSheet(CHANNEL + '\n[[shared_skill]]\nname = "brand-voice"\n');
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "schema_invalid") return;
    expect(result.issues).toContainEqual({
      path: "shared_skill.0.load",
      code: "invalid_value"
    });
  });

  // The first proof that a check on the root object — rather than on a block or a
  // list — reaches this function's output at all. The count cap is the only rule
  // on this sheet that spans two top-level keys.
  it("names each standing skill past the cap the sheet permits", () => {
    const entry = (name: string) => `\n[[shared_skill]]\nname = "${name}"\nload = "always"\n`;
    const result = parseTeamSheet(CHANNEL + entry("one") + entry("two") + entry("three"));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "schema_invalid") return;
    expect(result.issues).toContainEqual({ path: "shared_skill.2.load", code: "custom" });
  });

  // `load` is a closed enum, so it is the newest place a value from the file could
  // reach a log line — and the count check above is the first on this sheet whose
  // message interpolates anything at all. It interpolates the cap, which is a
  // number this schema chose; this is the case that says so.
  it("carries no value out of a shared skill block either", () => {
    const result = parseTeamSheet(
      CHANNEL + '\n[[shared_skill]]\nname = "brand-voice"\nload = "sk-live-abc123"\n'
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
