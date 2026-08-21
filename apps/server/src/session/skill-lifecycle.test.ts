// The lifecycle clocks, against a real directory and a real store.
//
// Both halves are opened for real, which is `skill-embed.test.ts`'s and
// `skill-store.test.ts`'s reason: what this module does is almost entirely
// expressed in the two things it composes — a `stat`-driven reconciliation on one
// side and a rename-then-stamp on the other — and a fake of either would let both
// sides agree with each other and with nothing.
//
// **There is no model fake here and there is nothing to fake.** The pass takes no
// completion client, no embedding client and no spend reporter, so every case
// below is decided by dates, a directory and SQL. That is the acceptance
// criterion "deterministic, no model call" expressed as a test file with no seam
// where a provider could go.
//
// The clock is injected and mutable, because thirty and ninety days is not
// something a test waits for.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { openMessageStore, openSkillFiles } from "@getlibero/memory";
import type { MessageStore, SkillClock, SkillFiles } from "@getlibero/memory";
import {
  LIFECYCLE_INTERVAL_MS,
  MAX_SKILL_STATUS_WRITES_PER_PASS,
  createSkillLifecyclePass,
  planSkillLifecycle
} from "./skill-lifecycle.js";
import type { SkillLifecycleOptions, SkillLifecycleSettings } from "./skill-lifecycle.js";

const CHANNEL = "C024BE91L";
const MAX_SKILLS = 100;
const DAY = 86_400_000;

/** The spec's figures, which are also the sheet's defaults. */
const SETTINGS: SkillLifecycleSettings = {
  enabled: true,
  maxSkills: MAX_SKILLS,
  staleAfterMs: 30 * DAY,
  archiveAfterMs: 90 * DAY
};

let root: string;
let file: string;
let store: MessageStore;
let files: SkillFiles;

/** Mutable, because thirty days is not something a test waits for. */
let clockAt = Date.UTC(2026, 0, 1, 12, 0, 0);
const clock = (): number => clockAt;
const advance = (ms: number): void => {
  clockAt += ms;
};

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

/** Writes a skill the way the author turn does — through the checked path. */
function skill(name: string, body = "Step one. Step two."): void {
  const result = files.apply({
    op: "skill_create",
    name,
    description: `When ${name} is needed.`,
    body
  });
  if (result.outcome !== "written") {
    throw new Error(`the fixture could not write ${name}: ${result.reason}`);
  }
}

/** The same, straight to disk, the way a team member with an editor would. */
function handWritten(name: string, status: string, body = "Step one. Step two."): void {
  mkdirSync(join(root, CHANNEL, "skills"), { recursive: true });
  const frontmatter = [
    `name: ${name}`,
    `description: When ${name} is needed.`,
    "created: 2025-01-01",
    `status: ${status}`
  ].join("\n");
  writeFileSync(join(root, CHANNEL, "skills", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** The file exactly as a second process would read it. */
const onDisk = (name: string): string =>
  readFileSync(join(root, CHANNEL, "skills", `${name}.md`), "utf8");

const statusOf = (name: string): string | undefined => files.read(name)?.frontmatter.status;

/**
 * The job's own record, read past the store's API.
 *
 * `skillClocks` would answer through the mapping under test's own dependency;
 * the row is the mechanism, so the row is what is asserted. Read-only, so nothing
 * here can write what it is checking.
 */
function record(name: string): {
  first_seen_at: number;
  last_used_at: number | null;
  status_by_job: string | null;
  status_by_job_at: number | null;
} {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT first_seen_at, last_used_at, status_by_job, status_by_job_at FROM skill_use WHERE name = ?"
      )
      .get(name) as never;
  } finally {
    db.close();
  }
}

function passWith(overrides: Partial<SkillLifecycleOptions> = {}) {
  const base: SkillLifecycleOptions = {
    files: () => files,
    settings: () => Promise.resolve(SETTINGS),
    now: clock,
    ...overrides
  };
  return createSkillLifecyclePass(base);
}

/** Runs a pass past the interval, which is what every case but the interval's wants. */
const runPast = async (
  pass: (channel: string, store: MessageStore) => Promise<number>
): Promise<number> => {
  advance(LIFECYCLE_INTERVAL_MS);
  return pass(CHANNEL, store);
};

beforeEach(() => {
  clockAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  root = mkdtempSync(join(tmpdir(), "libero-skill-lifecycle-"));
  mkdirSync(join(root, CHANNEL));
  file = join(root, CHANNEL, "store.db");
  store = openMessageStore({ channel: CHANNEL, root });
  files = openSkillFiles({ channel: CHANNEL, root, maxSkills: MAX_SKILLS });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

// The arbitration alone, with no disk and no store. Every threshold case is here
// because a table is what a clock wants, and the cases below are about what the
// pass does with the answer.
describe("planSkillLifecycle", () => {
  const clockRow = (over: Partial<SkillClock> = {}): SkillClock => ({
    name: "rotate-a-cert",
    status: "active",
    firstSeenAt: 0,
    lastUsedAt: null,
    statusByJob: "active",
    statusByJobAt: 0,
    ...over
  });

  each([
    ["under the stale threshold", 29 * DAY, null],
    ["at the stale threshold", 30 * DAY, "stale"],
    ["under the archive threshold", 89 * DAY, "stale"],
    ["at the archive threshold", 90 * DAY, "archived"]
  ])("moves a skill idle %s", (_label, idle, target) => {
    const plan = planSkillLifecycle([clockRow()], SETTINGS, idle);
    expect(plan.move).toEqual(target === null ? [] : [{ name: "rotate-a-cert", status: target }]);
  });

  // A target is absolute rather than a step. `stale` is a waypoint a team sees
  // when the clock passes through it in real time, not a turnstile the job has to
  // be present for — a channel whose process was down for a month should not need
  // two passes to reach the state its own dates already imply.
  it("moves straight to archived without an intervening stale", () => {
    const plan = planSkillLifecycle([clockRow()], SETTINGS, 200 * DAY);
    expect(plan.move).toEqual([{ name: "rotate-a-cert", status: "archived" }]);
  });

  it("clocks a never-used skill from when the index first saw it", () => {
    const plan = planSkillLifecycle(
      [clockRow({ firstSeenAt: 100 * DAY, statusByJobAt: 100 * DAY })],
      SETTINGS,
      131 * DAY
    );
    expect(plan.move).toEqual([{ name: "rotate-a-cert", status: "stale" }]);
  });

  it("clocks a used skill from its last use rather than from first sight", () => {
    const plan = planSkillLifecycle(
      [clockRow({ firstSeenAt: 0, lastUsedAt: 100 * DAY })],
      SETTINGS,
      120 * DAY
    );
    expect(plan.move).toEqual([]);
  });

  // The two ways somebody else's word reaches the job: it has never spoken here,
  // or what it last said is not what the file says now.
  each([
    ["a skill it has never spoken about", { statusByJob: null, statusByJobAt: null }],
    ["a status somebody else wrote", { status: "stale" as const, statusByJob: "active" as const }]
  ])("adopts rather than moves for %s", (_label, over) => {
    const plan = planSkillLifecycle([clockRow(over)], SETTINGS, 200 * DAY);

    expect(plan.move).toEqual([]);
    expect(plan.adopt).toHaveLength(1);
  });

  // The only backwards move the clock can reach: a use, and nothing else.
  it("returns a used skill to active", () => {
    const plan = planSkillLifecycle(
      [clockRow({ status: "stale", statusByJob: "stale", lastUsedAt: 100 * DAY })],
      SETTINGS,
      101 * DAY
    );
    expect(plan.move).toEqual([{ name: "rotate-a-cert", status: "active" }]);
  });

  // Ageing needs only time; freshening needs a use. "Not idle" is evidence of
  // nothing — a skill archived by hand this morning is not idle, and reading that
  // as freshness would un-archive it.
  each([
    ["never used", { lastUsedAt: null }],
    ["not used since the job last heard from anyone", { lastUsedAt: 1 * DAY }]
  ])("does not freshen a skill %s", (_label, over) => {
    const plan = planSkillLifecycle(
      [
        clockRow({
          status: "archived",
          statusByJob: "archived",
          statusByJobAt: 100 * DAY,
          ...over
        })
      ],
      SETTINGS,
      101 * DAY
    );
    expect(plan.move).toEqual([]);
  });

  // Archived is terminal by way of retrieval rather than by a rule here: an
  // archived skill is excluded from both legs, so it can never record the use
  // that is the only road back.
  it("leaves an archived skill archived however long it has been there", () => {
    const plan = planSkillLifecycle(
      [clockRow({ status: "archived", statusByJob: "archived", lastUsedAt: 0 })],
      SETTINGS,
      1_000 * DAY
    );
    expect(plan.move).toEqual([]);
  });

  it("bounds what one pass will rewrite", () => {
    const many = Array.from({ length: MAX_SKILL_STATUS_WRITES_PER_PASS + 5 }, (_unused, index) =>
      clockRow({ name: `skill-${String(index).padStart(2, "0")}` })
    );

    const plan = planSkillLifecycle(many, SETTINGS, 200 * DAY);

    expect(plan.move).toHaveLength(MAX_SKILL_STATUS_WRITES_PER_PASS);
    // Name order, which the clock read already answers in, so which ones wait is
    // deterministic rather than whatever the query planner returned.
    expect(plan.move[0]?.name).toBe("skill-00");
    // Adoption is unbounded: it writes no file.
    expect(planSkillLifecycle(many.map(c => ({ ...c, statusByJob: null })), SETTINGS, 200 * DAY).adopt)
      .toHaveLength(MAX_SKILL_STATUS_WRITES_PER_PASS + 5);
  });

  // A restored backup or a clock nudged backwards. `idle` goes negative, the
  // target becomes `active`, and the only reachable move is un-staling — the
  // harmless direction, which is why there is no guard for it.
  it("un-stales rather than archiving when the clock has moved backwards", () => {
    const plan = planSkillLifecycle(
      [clockRow({ status: "stale", statusByJob: "stale", lastUsedAt: 500 * DAY })],
      SETTINGS,
      100 * DAY
    );
    expect(plan.move).toEqual([{ name: "rotate-a-cert", status: "active" }]);
  });
});

describe("createSkillLifecyclePass", () => {
  // Acceptance 1: thirty days goes stale, ninety archives — with the run that
  // first meets the skill moving nothing, which is what the first-sight rule
  // buys.
  it("marks a skill stale at thirty days and archives it at ninety", async () => {
    skill("rotate-a-cert");
    const pass = passWith();

    expect(await runPast(pass)).toBe(0);
    expect(statusOf("rotate-a-cert")).toBe("active");

    advance(30 * DAY);
    expect(await pass(CHANNEL, store)).toBe(1);
    expect(statusOf("rotate-a-cert")).toBe("stale");

    advance(60 * DAY);
    expect(await pass(CHANNEL, store)).toBe(1);
    expect(statusOf("rotate-a-cert")).toBe("archived");
  });

  it("records what it wrote, so it does not decide the same skill again", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);
    advance(30 * DAY);
    await pass(CHANNEL, store);

    expect(record("rotate-a-cert").status_by_job).toBe("stale");

    advance(LIFECYCLE_INTERVAL_MS);
    expect(await pass(CHANNEL, store)).toBe(0);
  });

  // The load-bearing asymmetry. If the job restamped its own move, the archive
  // clock would start again at the stale one and this skill would archive at day
  // 120 rather than day 90 — which the case above would then fail.
  it("does not restart the clock when it moves a skill itself", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    const adopted = await (async () => {
      await runPast(pass);
      return record("rotate-a-cert").status_by_job_at;
    })();

    advance(30 * DAY);
    await pass(CHANNEL, store);

    expect(record("rotate-a-cert").status_by_job_at).toBe(adopted);
  });

  it("takes the channel's own thresholds rather than the spec's", async () => {
    skill("rotate-a-cert");
    const pass = passWith({
      settings: () => Promise.resolve({ ...SETTINGS, staleAfterMs: DAY, archiveAfterMs: 2 * DAY })
    });
    await runPast(pass);

    advance(DAY);
    await pass(CHANNEL, store);
    expect(statusOf("rotate-a-cert")).toBe("stale");
  });

  it("does not run twice inside one interval", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);
    advance(30 * DAY);
    await pass(CHANNEL, store);

    // Inside the interval, so nothing is re-decided even though the file has
    // moved underneath.
    files.setStatus("rotate-a-cert", "active");
    advance(LIFECYCLE_INTERVAL_MS - 1);
    expect(await pass(CHANNEL, store)).toBe(0);
    expect(record("rotate-a-cert").status_by_job).toBe("stale");
  });

  // Acceptance 2: use resets the clocks.
  it("leaves a skill used inside the window alone", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);

    advance(29 * DAY);
    store.recordSkillUse(["rotate-a-cert"], clock());

    advance(20 * DAY);
    expect(await pass(CHANNEL, store)).toBe(0);
    expect(statusOf("rotate-a-cert")).toBe("active");
  });

  it("returns a stale skill to active once a task loads it", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);
    advance(30 * DAY);
    await pass(CHANNEL, store);
    expect(statusOf("rotate-a-cert")).toBe("stale");

    advance(DAY);
    store.recordSkillUse(["rotate-a-cert"], clock());

    advance(LIFECYCLE_INTERVAL_MS);
    expect(await pass(CHANNEL, store)).toBe(1);
    expect(statusOf("rotate-a-cert")).toBe("active");
  });

  it("does not reset a skill's observations by rewriting its file", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);
    store.recordSkillUse(["rotate-a-cert"], clock());
    const before = record("rotate-a-cert");

    advance(90 * DAY);
    await pass(CHANNEL, store);

    const after = record("rotate-a-cert");
    expect(after.first_seen_at).toBe(before.first_seen_at);
    expect(after.last_used_at).toBe(before.last_used_at);
  });

  // Acceptance 3: it never deletes a file, and what it does write is one line.
  it("moves one line and leaves every other byte alone", async () => {
    skill("rotate-a-cert", "Run the thing.\n\nThen run the other thing.");
    const pass = passWith();
    await runPast(pass);
    const before = onDisk("rotate-a-cert").split("\n");

    advance(90 * DAY);
    await pass(CHANNEL, store);

    const after = onDisk("rotate-a-cert").split("\n");
    expect(after.filter((line, index) => line !== before[index])).toEqual(["status: archived"]);
    expect(before.filter((line, index) => line !== after[index])).toEqual(["status: active"]);
  });

  it("deletes nothing, however old the library", async () => {
    for (const name of ["deploy", "rollback", "rotate-a-cert"]) skill(name);
    const pass = passWith();
    await runPast(pass);

    advance(1_000 * DAY);
    await pass(CHANNEL, store);

    expect(files.list()).toEqual(["deploy", "rollback", "rotate-a-cert"]);
    expect(files.read("deploy")?.body).toBe("Step one. Step two.");
  });

  // Archived is a status, and both sides of that are asserted: retrieval cannot
  // reach it, and the file is still there for a person to un-archive.
  it("takes an archived skill out of retrieval and leaves it on disk", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);

    advance(90 * DAY);
    await pass(CHANNEL, store);

    expect(store.searchSkills("when rotate a cert is needed", 5)).toEqual([]);
    expect(store.skillsNeedingEmbedding(5)).toEqual([]);
    expect(files.read("rotate-a-cert")?.frontmatter.name).toBe("rotate-a-cert");
  });

  // Acceptance 4: a hand-set status is input the job respects.
  it("leaves a hand-set status alone and takes it as its baseline", async () => {
    handWritten("rotate-a-cert", "archived");
    const pass = passWith();
    const before = onDisk("rotate-a-cert");

    await runPast(pass);

    expect(onDisk("rotate-a-cert")).toBe(before);
    expect(record("rotate-a-cert")).toMatchObject({
      status_by_job: "archived",
      status_by_job_at: clock()
    });

    advance(LIFECYCLE_INTERVAL_MS);
    expect(await pass(CHANNEL, store)).toBe(0);
    expect(onDisk("rotate-a-cert")).toBe(before);
  });

  // The decision this issue records: adopting restarts the clock, so a team
  // un-archiving a long-unused playbook gets a full stale window rather than
  // watching the job archive it back on the next run.
  it("gives a hand edit a full stale window before the clock speaks again", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);
    advance(200 * DAY);
    await pass(CHANNEL, store);
    expect(statusOf("rotate-a-cert")).toBe("archived");

    // The team disagrees.
    files.setStatus("rotate-a-cert", "active");

    advance(LIFECYCLE_INTERVAL_MS);
    expect(await pass(CHANNEL, store)).toBe(0);
    expect(statusOf("rotate-a-cert")).toBe("active");

    advance(29 * DAY);
    expect(await pass(CHANNEL, store)).toBe(0);
    expect(statusOf("rotate-a-cert")).toBe("active");

    advance(2 * DAY);
    expect(await pass(CHANNEL, store)).toBe(1);
    expect(statusOf("rotate-a-cert")).toBe("stale");
  });

  // The test that fails if reconcile-first is ever removed. Without it the job
  // reads `stale` — its own last word — back out of the index, agrees with
  // itself, and archives a skill somebody had just reactivated by hand.
  it("sees a hand edit the index has not read yet", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);
    advance(30 * DAY);
    await pass(CHANNEL, store);
    expect(statusOf("rotate-a-cert")).toBe("stale");

    advance(61 * DAY);
    handWritten("rotate-a-cert", "active");

    expect(await pass(CHANNEL, store)).toBe(0);
    expect(statusOf("rotate-a-cert")).toBe("active");
  });

  // A lost index. Nothing is archived on the first run over a directory the job
  // has never seen, and nothing for a full stale window after it — which is what
  // "one full stale window" costs and why it is the better failure.
  it("moves nothing on the first run over an old library", async () => {
    for (const name of ["deploy", "rollback"]) handWritten(name, "active");
    const pass = passWith();

    expect(await runPast(pass)).toBe(0);
    expect(statusOf("deploy")).toBe("active");

    advance(29 * DAY);
    expect(await pass(CHANNEL, store)).toBe(0);

    advance(2 * DAY);
    expect(await pass(CHANNEL, store)).toBe(2);
    expect(statusOf("deploy")).toBe("stale");
  });

  it("rewrites at most one pass's worth, in name order", async () => {
    const names = Array.from({ length: MAX_SKILL_STATUS_WRITES_PER_PASS + 5 }, (_unused, index) =>
      `skill-${String(index).padStart(2, "0")}`
    );
    for (const name of names) skill(name);
    const pass = passWith();
    await runPast(pass);

    advance(30 * DAY);
    expect(await pass(CHANNEL, store)).toBe(MAX_SKILL_STATUS_WRITES_PER_PASS);
    expect(statusOf("skill-00")).toBe("stale");
    expect(statusOf(names[names.length - 1] ?? "")).toBe("active");

    advance(LIFECYCLE_INTERVAL_MS);
    expect(await pass(CHANNEL, store)).toBe(5);
  });

  // A half-saved edit. The job may decide the skill has aged — reconciliation
  // keeps its last good row — and `setStatus` refuses the write because it could
  // not read the file.
  it("never rewrites a file it could not parse, and records nothing about it", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);

    mkdirSync(join(root, CHANNEL, "skills"), { recursive: true });
    writeFileSync(join(root, CHANNEL, "skills", "rotate-a-cert.md"), "half a save");

    advance(90 * DAY);
    expect(await pass(CHANNEL, store)).toBe(0);
    expect(onDisk("rotate-a-cert")).toBe("half a save");
    expect(record("rotate-a-cert").status_by_job).toBe("active");
  });

  // The job's write costs no embedding: only a moved *description* invalidates a
  // vector, and a status is not one.
  it("costs no vector when it ages a skill", async () => {
    skill("rotate-a-cert");
    const pass = passWith();
    await runPast(pass);
    store.putEmbedding({
      source: { kind: "skill", ref: "rotate-a-cert" },
      vector: Float32Array.from([1, 0, 0]),
      model: "test-embedding-model",
      at: clock()
    });

    advance(30 * DAY);
    await pass(CHANNEL, store);

    expect(store.skillsNeedingEmbedding(5)).toEqual([]);
  });

  it("logs the outcome it had, with counts and never names", async () => {
    skill("rotate-a-cert");
    const { lines, logger } = capturingLogger();
    const pass = passWith({ logger });

    await runPast(pass);
    expect(lines.map(line => line.event)).toContain("skills_adopted");

    advance(30 * DAY);
    await pass(CHANNEL, store);
    const stale = lines.find(line => line.event === "skills_marked_stale");
    expect(stale).toMatchObject({ channel: CHANNEL, totalTokens: 1 });
    expect(JSON.stringify(lines)).not.toContain("rotate-a-cert");

    advance(60 * DAY);
    await pass(CHANNEL, store);
    expect(lines.map(line => line.event)).toContain("skills_archived");
  });

  // A channel that turned skills off has its statuses frozen rather than
  // rewritten by a feature it does not run — and the pass asks the directory
  // nothing.
  it("does nothing at all for a channel with skills disabled", async () => {
    skill("rotate-a-cert");
    const pass = passWith({
      settings: () => Promise.resolve({ ...SETTINGS, enabled: false }),
      files: () => {
        throw new Error("the opener should never be reached");
      }
    });

    advance(200 * DAY);
    expect(await runPast(pass)).toBe(0);
    expect(statusOf("rotate-a-cert")).toBe("active");
  });

  it("does nothing for a channel whose directory cannot be opened", async () => {
    expect(await runPast(passWith({ files: () => null }))).toBe(0);
  });

  each([
    [
      "the sheet cannot be read",
      { settings: () => Promise.reject(new Error("EACCES")) } as Partial<SkillLifecycleOptions>
    ],
    [
      "the directory cannot be listed",
      {
        files: () =>
          ({
            ...files,
            fingerprints: () => {
              throw new Error("EACCES");
            }
          }) as SkillFiles
      } as Partial<SkillLifecycleOptions>
    ],
    [
      "a file cannot be written",
      {
        files: () =>
          ({
            ...files,
            setStatus: () => {
              throw new Error("EACCES");
            }
          }) as SkillFiles
      } as Partial<SkillLifecycleOptions>
    ]
  ])("answers zero rather than throwing when %s", async (_label, overrides) => {
    skill("rotate-a-cert");
    const pass = passWith(overrides);
    advance(200 * DAY);

    await expect(runPast(pass)).resolves.toBe(0);
  });

  it("stops rewriting when the process is stopping", async () => {
    for (const name of ["deploy", "rollback"]) skill(name);
    const controller = new AbortController();
    const pass = passWith({ signal: controller.signal });
    await runPast(pass);

    controller.abort();
    advance(90 * DAY);

    expect(await pass(CHANNEL, store)).toBe(0);
    expect(statusOf("deploy")).toBe("active");
  });
});
