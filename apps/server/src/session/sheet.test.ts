// Sheets are written to a temp directory rather than mocked, because the half
// worth testing is the one that touches the filesystem: what happens when the
// file is missing, unreadable, or no longer parses.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { parseTeamSheet } from "@getlibero/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  SHEET_FILENAME,
  createSheetResolver,
  settingsFrom
} from "./sheet.js";

const MODEL = "process-wide-model";
const CHANNEL = "C024BE91L";

const VALID = `
[channel]
name = "engineering"

[llm]
model                   = "sheet-model"
max_tool_calls_per_task = 7
max_task_seconds        = 30
max_tokens_per_task     = 4000
max_tokens_per_turn     = 1024
max_history_messages    = 12
max_history_chars       = 3000
follow_up_window_seconds = 120
`;

const NO_LLM_BLOCK = `
[channel]
name = "engineering"
`;

const NO_MODEL = `
[channel]
name = "engineering"

[llm]
max_task_seconds = 45
`;

const TOML_INVALID = `
[channel
name = "engineering"
`;

const SCHEMA_INVALID = `
[channel]
name = "engineering"

[llm]
max_task_seconds = 0
`;

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

/** The sheet, parsed, for the tests that are about the mapping and not the disk. */
function sheetOf(text: string) {
  const parsed = parseTeamSheet(text);
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.reason}`);
  return parsed.sheet;
}

describe("settingsFrom", () => {
  it("maps the four caps, the two bounds, and the window field for field", () => {
    expect(settingsFrom(sheetOf(VALID), MODEL)).toEqual({
      model: "sheet-model",
      caps: {
        maxToolCalls: 7,
        // One of the two conversions rather than a rename, and the only kind of
        // thing in this mapping that can be wrong without being obviously so.
        maxWallTimeMs: 30_000,
        maxTokens: 4000,
        maxOutputTokensPerTurn: 1024
      },
      history: { maxMessages: 12, maxChars: 3000 },
      // The other one.
      followUpWindowMs: 120_000
    });
  });

  it("yields every cap, bound, and window when the sheet has no [llm] block", () => {
    // The schema prefaults the block, so resolution never has to invent one.
    // Asserting equality with the constants also catches the schema's defaults
    // drifting from DEFAULT_AGENT_LOOP_CAPS, DEFAULT_HISTORY_BOUNDS, and
    // DEFAULT_FOLLOW_UP_WINDOW_MS, all of which are kept in step by hand across
    // a package boundary.
    expect(settingsFrom(sheetOf(NO_LLM_BLOCK), MODEL)).toEqual({
      model: MODEL,
      caps: DEFAULT_AGENT_LOOP_CAPS,
      history: DEFAULT_HISTORY_BOUNDS,
      followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS
    });
  });

  it("maps a zero window to a zero window rather than to the default", () => {
    // `0` is a channel turning follow-ups off, and a mapping that treated it as
    // "unset" would quietly ignore the only way to say so.
    const off = settingsFrom(
      sheetOf(`[channel]\nname = "ops"\n\n[llm]\nfollow_up_window_seconds = 0\n`),
      MODEL
    );

    expect(off.followUpWindowMs).toBe(0);
  });

  it("falls back to the process model when the sheet names none", () => {
    const settings = settingsFrom(sheetOf(NO_MODEL), MODEL);
    expect(settings.model).toBe(MODEL);
    expect(settings.caps.maxWallTimeMs).toBe(45_000);
  });
});

describe("createSheetResolver", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "libero-agent-sheets-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (channel: string, text: string): Promise<void> => {
    await mkdir(join(root, channel), { recursive: true });
    await writeFile(join(root, channel, SHEET_FILENAME), text, "utf8");
  };

  it("gives a channel its own sheet's model and caps", async () => {
    await write(CHANNEL, VALID);
    const resolve = createSheetResolver({ root, model: MODEL });

    await expect(resolve(CHANNEL)).resolves.toEqual({
      model: "sheet-model",
      caps: {
        maxToolCalls: 7,
        maxWallTimeMs: 30_000,
        maxTokens: 4000,
        maxOutputTokensPerTurn: 1024
      },
      history: { maxMessages: 12, maxChars: 3000 },
      followUpWindowMs: 120_000
    });
  });

  it("re-reads the sheet for the next task", async () => {
    // There is no cache, and this is what pins that. An operator's edit lands
    // on the next request rather than when a session happens to be evicted.
    await write(CHANNEL, VALID);
    const resolve = createSheetResolver({ root, model: MODEL });

    expect((await resolve(CHANNEL)).caps.maxToolCalls).toBe(7);

    await write(CHANNEL, VALID.replace("max_tool_calls_per_task = 7", "max_tool_calls_per_task = 3"));

    expect((await resolve(CHANNEL)).caps.maxToolCalls).toBe(3);
  });

  it("falls back silently when the channel has no sheet", async () => {
    // Unprovisioned, not broken: the tool proxy service refuses every call for
    // a channel with no sheet, and a log line per request would say nothing an
    // operator does not already know.
    const captured = capturingLogger();
    const resolve = createSheetResolver({ root, model: MODEL, logger: captured.logger });

    await expect(resolve(CHANNEL)).resolves.toEqual({
      model: MODEL,
      caps: DEFAULT_AGENT_LOOP_CAPS,
      history: DEFAULT_HISTORY_BOUNDS,
      followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS
    });
    expect(captured.lines).toEqual([]);
  });

  it("falls back when the root does not exist at all", async () => {
    const resolve = createSheetResolver({ root: join(root, "nowhere"), model: MODEL });

    await expect(resolve(CHANNEL)).resolves.toEqual({
      model: MODEL,
      caps: DEFAULT_AGENT_LOOP_CAPS,
      history: DEFAULT_HISTORY_BOUNDS,
      followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS
    });
  });

  it.each([
    ["toml that does not parse", TOML_INVALID, "toml_syntax"],
    ["a sheet the schema rejects", SCHEMA_INVALID, "schema_invalid"]
  ])("falls back and names the reason for %s", async (_label, text, reason) => {
    const captured = capturingLogger();
    await write(CHANNEL, text);
    const resolve = createSheetResolver({ root, model: MODEL, logger: captured.logger });

    await expect(resolve(CHANNEL)).resolves.toEqual({
      model: MODEL,
      caps: DEFAULT_AGENT_LOOP_CAPS,
      history: DEFAULT_HISTORY_BOUNDS,
      followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS
    });
    expect(captured.lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "team_sheet_invalid",
        channel: CHANNEL,
        reason
      })
    );
  });

  it("says nothing of what the sheet contained", async () => {
    // A team sheet is not message content, but it is a channel's configuration
    // and the log has no field for it. The reason code is the whole line.
    const captured = capturingLogger();
    await write(CHANNEL, `${SCHEMA_INVALID}\n# secret-looking-note\n`);
    const resolve = createSheetResolver({ root, model: MODEL, logger: captured.logger });

    await resolve(CHANNEL);

    expect(JSON.stringify(captured.lines)).not.toMatch(/secret-looking-note|engineering/);
  });

  it("names the errno when the sheet cannot be read", async () => {
    // A directory where the file should be: the read fails with something that
    // is not ENOENT, which is the arm that has to say so out loud.
    const captured = capturingLogger();
    await mkdir(join(root, CHANNEL, SHEET_FILENAME), { recursive: true });
    const resolve = createSheetResolver({ root, model: MODEL, logger: captured.logger });

    await expect(resolve(CHANNEL)).resolves.toEqual({
      model: MODEL,
      caps: DEFAULT_AGENT_LOOP_CAPS,
      history: DEFAULT_HISTORY_BOUNDS,
      followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS
    });
    expect(captured.lines).toContainEqual(
      expect.objectContaining({ event: "team_sheet_unreadable", channel: CHANNEL })
    );
  });

  it.each(["../../etc", "..", "a/b", ".hidden", ""])(
    "refuses %s as a channel id without touching the filesystem",
    async channel => {
      // The id becomes a path segment. Asserting on the log is not enough on its
      // own, so the root is one that does not exist: a resolver that reached the
      // filesystem at all would take the ENOENT arm and log nothing.
      const captured = capturingLogger();
      const resolve = createSheetResolver({
        root: join(root, "does-not-exist"),
        model: MODEL,
        logger: captured.logger
      });

      await expect(resolve(channel)).resolves.toEqual({
        model: MODEL,
        caps: DEFAULT_AGENT_LOOP_CAPS,
      history: DEFAULT_HISTORY_BOUNDS,
      followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS
      });
      expect(captured.lines).toContainEqual(
        expect.objectContaining({ event: "team_sheet_invalid", reason: "channel_id" })
      );
    }
  );

  it("hands each channel its own settings", async () => {
    await write(CHANNEL, VALID);
    await write("C0OTHER11", NO_LLM_BLOCK);
    const resolve = createSheetResolver({ root, model: MODEL });

    expect((await resolve(CHANNEL)).model).toBe("sheet-model");
    expect((await resolve("C0OTHER11")).model).toBe(MODEL);
  });

  it("does not hand two channels the same caps object", async () => {
    // The default caps are an exported mutable constant, so a resolver handing
    // the same object to every channel is one caller away from one channel's
    // edit becoming every channel's.
    const resolve = createSheetResolver({ root, model: MODEL });

    const first = await resolve(CHANNEL);
    const second = await resolve("C0OTHER11");

    expect(first.caps).not.toBe(second.caps);
    expect(first.caps).not.toBe(DEFAULT_AGENT_LOOP_CAPS);
  });
});
