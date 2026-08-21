import { mkdtemp, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { type LogFields, type LogLevel, createSilentLogger } from "./log.js";
import { SHEET_FILENAME, TeamSheetStore } from "./team-sheet-store.js";

// Required of every sheet since #79, and read by the identity gate rather than
// by this store. The store's job is to say which sheet is in force; a fixture
// carries the line so that it parses at all.
const PIN = `certificate_sha256 = ["${"AB".repeat(32)}"]`;

const VALID = `
[channel]
name = "engineering"
${PIN}

[budget]
daily_tokens = 500000

[[mcp_server]]
name = "github"
transport = "http"
url = "http://mcp-github:3001"
credential = "github_service_account"

  [[mcp_server.tool]]
  name = "list_prs"
`;

const WIDER = `
[channel]
name = "engineering"
${PIN}

[[mcp_server]]
name = "github"
transport = "http"
url = "http://mcp-github:3001"

  [[mcp_server.tool]]
  name = "list_prs"

  [[mcp_server.tool]]
  name = "merge_pr"
`;

/** Valid TOML, invalid sheet: "websocket" is not a transport. */
const SCHEMA_INVALID = `
[channel]
name = "engineering"
${PIN}

[[mcp_server]]
name = "github"
transport = "websocket"
`;

/** Not TOML at all. */
const TOML_INVALID = `
[channel
name = "engineering"
`;

interface Line {
  level: LogLevel;
  fields: LogFields;
}

function recordingLogger(): { logger: { log: (l: LogLevel, f: LogFields) => void }; lines: Line[] } {
  const lines: Line[] = [];
  return { logger: { log: (level, fields) => void lines.push({ level, fields }) }, lines };
}

/**
 * The complaint describing the sheet as the test left it.
 *
 * `writeSheet` truncates before it writes and the watcher is live during that
 * window, so a save can log an earlier `team_sheet_invalid` about a file that
 * was momentarily empty — `channel: invalid_type`, since `[channel]` is the
 * only unconditionally-required top level. The store is meant to do that: the
 * read caches the fingerprint it stat'ed, so the settled file looks different
 * and is read again, which is the header comment's #137 lesson.
 *
 * The last complaint is the one that survives that. A resolve arriving after
 * the write re-reads, because the fingerprint moved; one that shares the
 * watcher's in-flight read is answered by a stat taken after the write landed,
 * because `inFlightStated` will not share a read that has already looked; and a
 * re-resolve of an unchanged file takes the `sameFile` path and logs nothing.
 * Taking the first instead is what flaked on CI (#340).
 */
const lastComplaint = (lines: Line[]): Line | undefined =>
  lines.filter(l => l.fields.event === "team_sheet_invalid").at(-1);

let root: string;
let store: TeamSheetStore | null = null;

const sheetPath = (channel: string): string => join(root, channel, SHEET_FILENAME);

async function writeSheet(channel: string, body: string): Promise<void> {
  await mkdir(join(root, channel), { recursive: true });
  await writeFile(sheetPath(channel), body, "utf8");
}

/**
 * Advances the clock past the filesystem's mtime granularity.
 *
 * Two writes inside the same millisecond at the same size are invisible to a
 * stat, which is the gap the watcher covers. The tests that are about the read
 * path use this so they are testing what they claim to; the tests that are
 * about the watcher deliberately do not.
 */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 12));

/**
 * Waits for a condition the watcher will bring about, without a fixed sleep.
 *
 * `ms` defaults to 3000. The two save-time watcher tests use a longer window
 * because FSEvents can buffer notifications for 3+ seconds under concurrent
 * test load — not a bug in the watcher, just platform event-delivery latency.
 */
async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  ms = 3000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "libero-sheets-"));
});

afterEach(async () => {
  store?.close();
  store = null;
  await rm(root, { recursive: true, force: true });
});

describe("resolving a channel", () => {
  it("loads a valid sheet", async () => {
    await writeSheet("engineering", VALID);
    store = new TeamSheetStore({ root });

    const state = await store.resolve("engineering");
    expect(state.status).toBe("active");
    if (state.status !== "active") return;
    expect(state.sheet.channel.name).toBe("engineering");
    expect(state.sheet.budget.daily_tokens).toBe(500_000);
    expect(state.stale).toBe(false);
  });

  // The issue asks this to be a definite answer rather than a crash, and not an
  // empty sheet standing in for a missing one. It is its own status, distinct
  // from a sheet that exists and does not parse: same denial, different fix.
  it("answers absent for a channel with no sheet", async () => {
    store = new TeamSheetStore({ root });
    expect(await store.resolve("engineering")).toEqual({ status: "absent" });
  });

  it("answers unusable for a sheet that has never parsed", async () => {
    await writeSheet("engineering", SCHEMA_INVALID);
    store = new TeamSheetStore({ root });
    expect(await store.resolve("engineering")).toEqual({ status: "unusable" });
  });

  it("serves one channel without touching another", async () => {
    await writeSheet("engineering", VALID);
    await writeSheet("finance", SCHEMA_INVALID);
    store = new TeamSheetStore({ root });

    expect((await store.resolve("engineering")).status).toBe("active");
    expect((await store.resolve("finance")).status).toBe("unusable");
  });

  it("refuses a channel id that is not a safe path segment", async () => {
    store = new TeamSheetStore({ root });
    for (const channel of ["..", "../../etc", "a/b", ".hidden", ""]) {
      await expect(store.resolve(channel)).rejects.toThrow(/valid channel id/);
    }
  });

  it("collapses concurrent resolves onto one read", async () => {
    await writeSheet("engineering", VALID);
    store = new TeamSheetStore({ root });
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });

    const states = await Promise.all([
      store.resolve("engineering"),
      store.resolve("engineering"),
      store.resolve("engineering")
    ]);

    expect(states.every(s => s.status === "active")).toBe(true);
    expect(lines.filter(l => l.fields.event === "team_sheet_loaded")).toHaveLength(1);
  });
});

describe("picking up edits without a restart", () => {
  it("sees a valid edit", async () => {
    await writeSheet("engineering", VALID);
    store = new TeamSheetStore({ root });

    const before = await store.resolve("engineering");
    expect(before.status === "active" && before.sheet.mcp_server[0]?.tool).toHaveLength(1);

    await tick();
    await writeSheet("engineering", WIDER);

    const after = await store.resolve("engineering");
    expect(after.status).toBe("active");
    if (after.status !== "active") return;
    expect(after.sheet.mcp_server[0]?.tool.map(t => t.name)).toEqual(["list_prs", "merge_pr"]);
    // Names the other way this can fail. When it flaked on CI (#137) the
    // answer was the previous sheet retained behind a read of a half-written
    // file, which is the stale flag's whole job to say.
    expect(after.stale).toBe(false);
  });

  it("sees a sheet that appears after the channel was first asked about", async () => {
    store = new TeamSheetStore({ root });
    expect((await store.resolve("engineering")).status).toBe("absent");

    await writeSheet("engineering", VALID);
    expect((await store.resolve("engineering")).status).toBe("active");
  });

  // Write to a temp name, rename over the target. This is what editors and
  // deployment tooling actually do, and it is why the watcher is on the
  // directory rather than on the file.
  it("sees an atomic replace", async () => {
    await writeSheet("engineering", VALID);
    store = new TeamSheetStore({ root });
    await store.resolve("engineering");

    await tick();
    const staged = join(root, "engineering", ".channel.toml.tmp");
    await writeFile(staged, WIDER, "utf8");
    await rename(staged, sheetPath("engineering"));

    const after = await store.resolve("engineering");
    expect(after.status === "active" && after.sheet.mcp_server[0]?.tool).toHaveLength(2);
  });
});

describe("an invalid edit", () => {
  it("keeps the previous sheet active and marks it stale", async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });
    await store.resolve("engineering");

    await tick();
    await writeSheet("engineering", SCHEMA_INVALID);

    const after = await store.resolve("engineering");
    expect(after.status).toBe("active");
    if (after.status !== "active") return;
    // Still the old sheet — enforcement did not widen and did not go dark.
    expect(after.sheet.mcp_server[0]?.credential).toBe("github_service_account");
    expect(after.stale).toBe(true);

    const complaint = lastComplaint(lines);
    expect(complaint?.level).toBe("error");
    expect(complaint?.fields.file).toBe(sheetPath("engineering"));
    expect(complaint?.fields.reason).toBe("schema_invalid");
    // `invalid_union` rather than `invalid_value` since #89 discriminated
    // McpServer on transport: an unknown transport now fails to select a member
    // rather than failing an enum. The path still lands on the offending field,
    // which is what an operator reads.
    expect(complaint?.fields.issues).toContain("mcp_server.0.transport: invalid_union");
    expect(complaint?.fields.effect).toBe("previous_sheet_retained");
  });

  it("names the position of a TOML syntax error", async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });
    await store.resolve("engineering");

    await tick();
    await writeSheet("engineering", TOML_INVALID);
    await store.resolve("engineering");

    const complaint = lastComplaint(lines);
    expect(complaint?.fields.reason).toBe("toml_syntax");
    expect(complaint?.fields.line).toBeGreaterThan(0);
    expect(complaint?.fields.column).toBeGreaterThan(0);
  });

  it("says so when there is no previous sheet to fall back on", async () => {
    await writeSheet("engineering", SCHEMA_INVALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });

    expect((await store.resolve("engineering")).status).toBe("unusable");
    expect(lastComplaint(lines)?.fields.effect).toBe("no_sheet_in_force");
  });

  // The sequence the issue calls out by name: good, broken, good again. The
  // channel must not be left stale once the operator fixes the file.
  // #342. The complaint an operator gets for a *valid* sheet saved by a slow
  // truncating writer: the watcher reads the file while it is empty, which fails
  // the same way a typo does. It is not suppressed — the header says why, with
  // the measurement — so what has to hold is that the reload retracts it in the
  // log rather than leaving the operator to infer it.
  it("retracts a complaint caused by a torn read when the write settles", { timeout: 15000 }, async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });
    await store.resolve("engineering");

    await tick();
    // The torn write itself, held open long enough that the watcher certainly
    // reads inside it. `writeFile` is too fast to provoke this reliably, which
    // is the point: it takes a writer that is non-atomic *and* slow.
    const handle = await open(sheetPath("engineering"), "r+");
    await handle.truncate(0);
    // 5000 rather than the default, matching the two save-time watcher tests
    // below: FSEvents can buffer notifications for seconds under load.
    await until(
      () => lines.some(l => l.fields.event === "team_sheet_invalid"),
      "the torn read to be complained about",
      5000
    );
    await handle.write(WIDER, 0, "utf8");
    await handle.close();

    await until(
      () => lines.some(l => l.fields.event === "team_sheet_reloaded"),
      "the settled write to be picked up",
      5000
    );

    const complaint = lastComplaint(lines);
    expect(complaint?.level).toBe("error");
    // Empty file: `[channel]` is the only unconditionally-required top level.
    expect(complaint?.fields.issues).toContain("channel: invalid_type");

    // The retraction, which is the whole of what #342 added. Without it the
    // operator sees an error and then an unrelated-looking info line.
    const reload = lines.filter(l => l.fields.event === "team_sheet_reloaded").at(-1);
    expect(reload?.fields.supersedes).toBe("team_sheet_invalid");

    // And the sheet on disk really was fine.
    const settled = await store.resolve("engineering");
    expect(settled.status === "active" && settled.stale).toBe(false);
  });

  // The counterpart, and the reason `supersedes` is worth reading: a reload that
  // follows no complaint does not claim to retract one.
  it("does not claim to supersede anything when nothing was complained about", async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });
    await store.resolve("engineering");

    await tick();
    await writeSheet("engineering", WIDER);
    await store.resolve("engineering");

    const reload = lines.filter(l => l.fields.event === "team_sheet_reloaded").at(-1);
    expect(reload).toBeDefined();
    expect(reload?.fields.supersedes).toBeUndefined();
  });

  it("recovers when the sheet becomes valid again", async () => {
    await writeSheet("engineering", VALID);
    store = new TeamSheetStore({ root, logger: createSilentLogger() });
    await store.resolve("engineering");

    await tick();
    await writeSheet("engineering", TOML_INVALID);
    const broken = await store.resolve("engineering");
    expect(broken.status === "active" && broken.stale).toBe(true);

    await tick();
    await writeSheet("engineering", WIDER);
    const fixed = await store.resolve("engineering");
    expect(fixed.status).toBe("active");
    if (fixed.status !== "active") return;
    expect(fixed.stale).toBe(false);
    expect(fixed.sheet.mcp_server[0]?.tool).toHaveLength(2);
  });
});

describe("deletion", () => {
  // Asymmetric with an invalid edit, on purpose. A typo leaves the operator's
  // intent unknown, so the last good sheet stays in force. Removing the sheet
  // states the intent, and the architecture defines that as how a channel is
  // revoked — so it must not be the one edit that leaves permissions running.
  it("revokes immediately rather than retaining the last good sheet", async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });
    expect((await store.resolve("engineering")).status).toBe("active");

    await rm(sheetPath("engineering"));

    expect(await store.resolve("engineering")).toEqual({ status: "absent" });
    expect(lines.find(l => l.fields.event === "team_sheet_removed")?.level).toBe("warn");
  });

  it("survives the whole channel directory going away", async () => {
    await writeSheet("engineering", VALID);
    store = new TeamSheetStore({ root });
    await store.resolve("engineering");

    await rm(join(root, "engineering"), { recursive: true });

    expect(await store.resolve("engineering")).toEqual({ status: "absent" });
  });

  it("comes back when the sheet is restored", async () => {
    await writeSheet("engineering", VALID);
    store = new TeamSheetStore({ root });
    await store.resolve("engineering");
    await rm(sheetPath("engineering"));
    expect((await store.resolve("engineering")).status).toBe("absent");

    await writeSheet("engineering", WIDER);
    expect((await store.resolve("engineering")).status).toBe("active");
  });
});

// These are the watcher's own tests: nothing calls resolve() between the edit
// and the assertion, so only a watch event can produce the log line.
describe("the watcher", () => {
  // FSEvents can buffer notifications for several seconds under concurrent load;
  // 5 s gives the event time to arrive without the test reading as broken.
  it("complains about a broken sheet at save time, with no call in between", { timeout: 8000 }, async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });
    await store.resolve("engineering");

    await writeSheet("engineering", SCHEMA_INVALID);

    await until(
      () => lines.some(l => l.fields.event === "team_sheet_invalid"),
      "the watcher to report an invalid sheet",
      5000
    );
    expect(lastComplaint(lines)?.fields.effect).toBe("previous_sheet_retained");
  });

  it("reloads a valid edit without being asked", { timeout: 8000 }, async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    store = new TeamSheetStore({ root, logger });
    await store.resolve("engineering");

    await writeSheet("engineering", WIDER);

    await until(
      () => lines.some(l => l.fields.event === "team_sheet_reloaded"),
      "the watcher to reload the sheet",
      5000
    );
  });

  it("stops watching on close", async () => {
    await writeSheet("engineering", VALID);
    const { logger, lines } = recordingLogger();
    const closing = new TeamSheetStore({ root, logger });
    await closing.resolve("engineering");
    closing.close();

    await writeSheet("engineering", SCHEMA_INVALID);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(lines.some(l => l.fields.event === "team_sheet_invalid")).toBe(false);
  });
});
