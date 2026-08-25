// The merge curator, against a real store, a real skills directory and a real
// proposals directory.
//
// All three halves are opened for real, which is ./skill-embed.test.ts's and
// ./skill-lifecycle.test.ts's reason: what this module does is almost entirely
// expressed in the things it composes — a nomination query, a directory count and
// a rename — and a fake of any of them would let the sides agree with each other
// and with nothing.
//
// **The completion client is the one seam**, because it is the one thing that is
// not deterministic. It counts its calls, which is what most of the bounding
// cases assert on: the interesting question is usually not what the pass wrote
// but whether it paid for anything at all.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { SKILL_MERGE_SYSTEM_PROMPT } from "@getlibero/agent";
import type { SharedSkillReader } from "./shared-skills.js";
import type { CompletedTurn, CompletionClient, CompletionRequest } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import {
  openMessageStore,
  openSkillFiles,
  openSkillProposals,
  reconcileSkillIndex
} from "@getlibero/memory";
import type { MessageStore, SkillFiles, SkillProposals } from "@getlibero/memory";
import { SKILL_MERGE_TOOL } from "@getlibero/schema";
import {
  CURATE_INTERVAL_MS,
  MAX_OPEN_PROPOSALS,
  createSkillCuratePass
} from "./skill-curate.js";
import type { SkillCuratePassOptions, SkillCurateSettings } from "./skill-curate.js";

const CHANNEL = "C024BE91L";
const MAX_SKILLS = 100;

const SETTINGS: SkillCurateSettings = {
  // No shared skills and no description, which is the channel every case here
  // is about: what #450 wired is that this turn *can* carry a standing region,
  // and `standing.test.ts` is where it does.
  standing: { description: "", sharedSkills: [], maxAlwaysSkills: 2, maxAlwaysChars: 8_192 },
  enabled: true,
  curate: true,
  maxSkills: MAX_SKILLS,
  model: "test-model",
  maxTokens: 2048
};

/** A hand-built space: `a-deploy` and `b-deploys` are each other's nearest. */
const SPACE: Record<string, number[]> = {
  "a-deploy": [1, 0, 0],
  "b-deploys": [1, 0.1, 0],
  "c-oncall": [1, 0.6, 0]
};

const DRAFT = {
  keep: "a-deploy",
  description: "How we ship a release, and how we undo one.",
  body: "1. `make deploy`\n2. If the smoke test fails, `make rollback`."
} as const;

let root: string;
let file: string;
let store: MessageStore;
let files: SkillFiles;
let proposals: SkillProposals;

let clockAt = Date.UTC(2026, 0, 1, 12, 0, 0);
const clock = (): number => clockAt;
const advance = (ms: number): void => {
  clockAt += ms;
};

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

/**
 * A completion client that answers the same thing every time, and counts.
 *
 * `null` is the model declining, which is calling no tool — the ordinary outcome
 * and the one most of these cases want.
 */
function model(answer: Record<string, unknown> | null): {
  client: CompletionClient;
  calls: () => number;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    calls: () => requests.length,
    client: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({
          text: "",
          toolCalls:
            answer === null ? [] : [{ id: "c1", name: SKILL_MERGE_TOOL, arguments: answer }],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 300, outputTokens: 90 },
          model: "served-model"
        });
      }
    }
  };
}

/** Writes a skill straight to disk, the way a team member with an editor would. */
function skill(name: string, description: string, body = "Step one. Step two."): void {
  mkdirSync(join(root, CHANNEL, "skills"), { recursive: true });
  const frontmatter = [
    `name: ${name}`,
    `description: ${description}`,
    "created: 2025-06-01",
    "status: active"
  ].join("\n");
  writeFileSync(join(root, CHANNEL, "skills", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** Indexes what is on disk and gives each skill its vector. */
function indexAndEmbed(names: readonly string[] = Object.keys(SPACE)): void {
  reconcileSkillIndex({ files, store, maxSkills: MAX_SKILLS, at: clock() });
  for (const name of names) {
    const vector = SPACE[name];
    if (vector === undefined) continue;
    store.putEmbedding({
      source: { kind: "skill", ref: name },
      vector: Float32Array.from(vector),
      model: "test-embedding-model",
      at: clock()
    });
  }
}

/** The three skills of `SPACE`, on disk and indexed. */
function library(): void {
  skill("a-deploy", "How we ship a release.");
  skill("b-deploys", "How we ship releases.");
  skill("c-oncall", "Who to wake at 3am.");
  indexAndEmbed();
}

const proposalsDirectory = (): string => join(root, CHANNEL, "proposals");

const waiting = (): string[] =>
  existsSync(proposalsDirectory()) ? readdirSync(proposalsDirectory()).sort() : [];

const skillsOnDisk = (): Record<string, string> => {
  const directory = join(root, CHANNEL, "skills");
  if (!existsSync(directory)) return {};
  return Object.fromEntries(
    readdirSync(directory).map(name => [name, readFileSync(join(directory, name), "utf8")])
  );
};

/** The considered pairs, read past the store's own API. */
function considered(): Array<{ skill_a: string; skill_b: string }> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT skill_a, skill_b FROM skill_merge_proposal ORDER BY skill_a")
      .all() as Array<{ skill_a: string; skill_b: string }>;
  } finally {
    db.close();
  }
}

function passWith(overrides: Partial<SkillCuratePassOptions> = {}) {
  const reported: Array<CompletedTurn & { id: string }> = [];
  const base: SkillCuratePassOptions = {
    completion: model(null).client,
    files: () => files,
    proposals: () => proposals,
    settings: () => Promise.resolve(SETTINGS),
    reportTurn: (_channel, turn) => {
      reported.push(turn);
      return Promise.resolve();
    },
    // The channel is under its caps unless a case says otherwise (#335).
    maySpend: () => Promise.resolve(true),
    now: clock,
    ...overrides
  };
  return { pass: createSkillCuratePass(base), reported };
}

/** Runs a pass past the interval, which is what every case but the interval's wants. */
const runPast = async (
  pass: (channel: string, store: MessageStore) => Promise<number>
): Promise<number> => {
  advance(CURATE_INTERVAL_MS);
  return pass(CHANNEL, store);
};

beforeEach(() => {
  clockAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  root = mkdtempSync(join(tmpdir(), "libero-skill-curate-"));
  mkdirSync(join(root, CHANNEL));
  file = join(root, CHANNEL, "store.db");
  store = openMessageStore({ channel: CHANNEL, root });
  files = openSkillFiles({ channel: CHANNEL, root, maxSkills: MAX_SKILLS });
  proposals = openSkillProposals({ channel: CHANNEL, root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("createSkillCuratePass", () => {
  it("proposes a merge of the two closest playbooks", async () => {
    library();
    const answering = model({ ...DRAFT });
    const { pass } = passWith({ completion: answering.client });

    expect(await runPast(pass)).toBe(1);

    expect(waiting()).toEqual(["a-deploy--b-deploys.md"]);
    expect(answering.calls()).toBe(1);
    const text = readFileSync(join(proposalsDirectory(), "a-deploy--b-deploys.md"), "utf8");
    expect(text).toContain("# Proposed merge: `a-deploy` + `b-deploys`");
    expect(text).toContain(DRAFT.body);
    // Both originals are quoted, so a person reads old → new.
    expect(text).toContain("How we ship a release.");
    expect(text).toContain("How we ship releases.");
  });

  // The centrepiece of "the curator writes no skill file": every byte under
  // `skills/` is what it was, and the directory gained nothing.
  it("changes no skill file, byte for byte", async () => {
    library();
    const before = skillsOnDisk();
    const { pass } = passWith({ completion: model({ ...DRAFT }).client });

    await runPast(pass);

    expect(skillsOnDisk()).toEqual(before);
    expect(files.list()).toEqual(["a-deploy", "b-deploys", "c-oncall"]);
  });

  // The ordinary outcome. The pair was the closest two, not two anybody judged
  // similar, so most of the time this is what happens.
  it("writes nothing when the model declines, and records that it asked", async () => {
    library();
    const { lines, logger } = capturingLogger();
    const { pass } = passWith({ logger });

    expect(await runPast(pass)).toBe(0);

    expect(waiting()).toEqual([]);
    expect(existsSync(proposalsDirectory())).toBe(false);
    expect(considered()).toEqual([{ skill_a: "a-deploy", skill_b: "b-deploys" }]);
    expect(lines.map(line => line.event)).toContain("skill_merge_none");
  });

  it("asks nothing at all of a library with no overlap to nominate", async () => {
    skill("only-one", "The only playbook here.");
    indexAndEmbed(["a-deploy"]);
    const answering = model({ ...DRAFT });
    const { pass } = passWith({ completion: answering.client });

    expect(await runPast(pass)).toBe(0);
    expect(answering.calls()).toBe(0);
  });

  // The behaviour difference from retrieval, which degrades to full text: there
  // is no lexical answer to "are these two near each other".
  it("proposes nothing, and asks nothing, with no embedding provider", async () => {
    skill("a-deploy", "How we ship a release.");
    skill("b-deploys", "How we ship releases.");
      reconcileSkillIndex({ files, store, maxSkills: MAX_SKILLS, at: clock() });
    const answering = model({ ...DRAFT });
    const { pass } = passWith({ completion: answering.client });

    await expect(runPast(pass)).resolves.toBe(0);
    expect(answering.calls()).toBe(0);
  });
});

describe("what bounds it", () => {
  // #335, and the placement is the assertion, as it is in ./skill-embed.test.ts:
  // reconciliation and proposal pruning run above the gate because the next task
  // reads what they leave behind. What stops is the model call.
  it("still reconciles for a channel over its caps, and proposes nothing", async () => {
    library();
    const answering = model({ ...DRAFT });
    const { pass, reported } = passWith({
      completion: answering.client,
      maySpend: () => Promise.resolve(false)
    });

    expect(await runPast(pass)).toBe(0);

    expect(answering.calls()).toBe(0);
    expect(reported).toEqual([]);
    expect(proposals.count()).toBe(0);
    // The library is still indexed, which is what a task at the head of the next
    // mention will read.
    expect(store.listSkills("channel").length).toBeGreaterThan(0);
  });

  // And it does not record the pair as considered, so the question comes back
  // once the channel can afford it. A gate that stamped on the way past would
  // lose a merge to a day the channel happened to be over.
  it("leaves the pair to be asked again once the channel can afford it", async () => {
    library();
    const answering = model({ ...DRAFT });
    const { pass } = passWith({
      completion: answering.client,
      maySpend: () => Promise.resolve(false)
    });
    await runPast(pass);

    expect(considered()).toEqual([]);

    const affording = model({ ...DRAFT });
    const second = passWith({ completion: affording.client });
    expect(await runPast(second.pass)).toBe(1);
    expect(affording.calls()).toBe(1);
  });

  it("does not run twice inside one interval", async () => {
    library();
    const answering = model(null);
    const { pass } = passWith({ completion: answering.client });
    await runPast(pass);

    advance(CURATE_INTERVAL_MS - 1);
    expect(await pass(CHANNEL, store)).toBe(0);
    expect(answering.calls()).toBe(1);
  });

  // The hash rule. Two due runs over a library nobody touched cost one call, not
  // two — which is what makes the steady state free.
  it("asks about a pair once, however many times it is due", async () => {
    library();
    const answering = model(null);
    const { pass } = passWith({ completion: answering.client });

    await runPast(pass);
    await runPast(pass);
    await runPast(pass);

    expect(answering.calls()).toBe(1);
  });

  // Deleting the file is the decline, and nothing observes it — so ignoring and
  // declining come to the same thing.
  it("does not propose again when the team deletes the proposal", async () => {
    library();
    const answering = model({ ...DRAFT });
    const { pass } = passWith({ completion: answering.client });
    await runPast(pass);
    expect(waiting()).toHaveLength(1);

    proposals.remove({ a: "a-deploy", b: "b-deploys" });

    expect(await runPast(pass)).toBe(0);
    expect(answering.calls()).toBe(1);
    expect(waiting()).toEqual([]);
  });

  // And what un-bounds it: an edit to a description, which is new evidence.
  it("proposes again once a description moves, replacing the file", async () => {
    library();
    const answering = model({ ...DRAFT });
    const { pass } = passWith({ completion: answering.client });
    await runPast(pass);

    skill("a-deploy", "How we ship a release, rewritten.");
    indexAndEmbed();

    expect(await runPast(pass)).toBe(1);
    expect(answering.calls()).toBe(2);
    // Replaced rather than duplicated: a person reading a stale draft would
    // silently revert whatever moved underneath it.
    expect(waiting()).toEqual(["a-deploy--b-deploys.md"]);
  });

  // The bound that answers a team who never opens the directory.
  it("stops asking once proposals are piling up unread", async () => {
    library();
    const answering = model({ ...DRAFT });
    const { lines, logger } = capturingLogger();
    const { pass } = passWith({ completion: answering.client, logger });

    for (let index = 0; index < MAX_OPEN_PROPOSALS; index += 1) {
      proposals.write({
        draft: { keep: `pair-${String(index)}`, drop: "other-one", description: "d", body: "b" },
        keepBefore: {
          frontmatter: {
            name: `pair-${String(index)}`,
            description: "d",
            created: "2026-01-01",
            status: "active"
          },
          body: "b"
        },
        dropBefore: {
          frontmatter: {
            name: "other-one",
            description: "d",
            created: "2026-01-01",
            status: "active"
          },
          body: "b"
        },
        after: {
          frontmatter: {
            name: `pair-${String(index)}`,
            description: "d",
            created: "2026-01-01",
            status: "active"
          },
          body: "b"
        },
        at: clock()
      });
    }

    expect(await runPast(pass)).toBe(0);
    // Never asked — the cap is checked before the nomination, so a backlog costs
    // nothing rather than costing a call whose answer is thrown away.
    expect(answering.calls()).toBe(0);
    expect(lines.map(line => line.event)).toContain("skill_merge_backlog");
  });

  each([
    ["skills are disabled", { ...SETTINGS, enabled: false }],
    ["curation is disabled", { ...SETTINGS, curate: false }]
  ])("does nothing at all when %s", async (_label, settings) => {
    library();
    const answering = model({ ...DRAFT });
    const { pass } = passWith({
      completion: answering.client,
      settings: () => Promise.resolve(settings)
    });

    expect(await runPast(pass)).toBe(0);
    expect(answering.calls()).toBe(0);
    expect(existsSync(proposalsDirectory())).toBe(false);
  });
});

describe("cleaning up after a merge somebody applied", () => {
  const applied = async (): Promise<void> => {
    library();
    const { pass } = passWith({ completion: model({ ...DRAFT }).client });
    await runPast(pass);
    expect(waiting()).toHaveLength(1);

    // The human act: the merged skill replaces one file and the other goes.
    skill("a-deploy", DRAFT.description, DRAFT.body);
    unlinkSync(join(root, CHANNEL, "skills", "b-deploys.md"));
  };

  it("removes the proposal and forgets the pair", async () => {
    await applied();
    const { lines, logger } = capturingLogger();
    const { pass } = passWith({ logger });

    await runPast(pass);

    expect(waiting()).toEqual([]);
    expect(considered().map(row => row.skill_a)).not.toContain("a-deploy");
    expect(lines.map(line => line.event)).toContain("skill_merge_pruned");
  });

  // The prune runs before the cap check, so the slot a person freed by applying a
  // proposal is usable on the same run rather than a day later.
  it("frees the slot it cleaned up, on the same run", async () => {
    library();
    const answering = model({ ...DRAFT });
    const { pass } = passWith({ completion: answering.client });
    await runPast(pass);

    // Two more waiting, so the directory is at the cap.
    for (const name of ["x-one", "y-two"]) {
      proposals.write({
        draft: { keep: name, drop: "z-three", description: "d", body: "b" },
        keepBefore: {
          frontmatter: { name, description: "d", created: "2026-01-01", status: "active" },
          body: "b"
        },
        dropBefore: {
          frontmatter: { name: "z-three", description: "d", created: "2026-01-01", status: "active" },
          body: "b"
        },
        after: {
          frontmatter: { name, description: "d", created: "2026-01-01", status: "active" },
          body: "b"
        },
        at: clock()
      });
    }
    expect(waiting()).toHaveLength(MAX_OPEN_PROPOSALS);

    // The team applies the curator's one, leaving two unread.
    skill("a-deploy", DRAFT.description, DRAFT.body);
    unlinkSync(join(root, CHANNEL, "skills", "b-deploys.md"));

    await runPast(pass);

    expect(waiting()).toEqual(["x-one--z-three.md", "y-two--z-three.md"]);
  });
});

describe("what it costs", () => {
  it("meters the turn on an id the meter can dedupe", async () => {
    library();
    const { pass, reported } = passWith({ completion: model({ ...DRAFT }).client });

    await runPast(pass);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      usage: { inputTokens: 300, outputTokens: 90 },
      turn: 0,
      model: "served-model"
    });
    expect(reported[0]?.id).toMatch(/^skills-merge-[0-9a-f]{16}$/);
  });

  // The same pair at the same two texts is the same work, so a crash-retry is
  // counted once. `skill-embed.ts`'s property, reached the same way.
  it("uses the same id for the same pair at the same texts", async () => {
    library();
    const first = passWith({ completion: model(null).client });
    await runPast(first.pass);

    // A fresh pass with no memory of having run, against an index that has
    // forgotten the pair — which is what a crash between the file and the row
    // looks like from here.
    store.forgetSkillMergeProposal({ a: "a-deploy", b: "b-deploys" });
    const second = passWith({ completion: model(null).client });
    await runPast(second.pass);

    expect(second.reported[0]?.id).toBe(first.reported[0]?.id);
  });

  it("uses a different id once a description moves", async () => {
    library();
    const { pass, reported } = passWith({ completion: model(null).client });
    await runPast(pass);

    skill("a-deploy", "How we ship a release, rewritten.");
    indexAndEmbed();
    await runPast(pass);

    expect(reported).toHaveLength(2);
    expect(reported[0]?.id).not.toBe(reported[1]?.id);
  });

  // A turn that was paid for is counted even when what it produced is unusable,
  // and the pair is recorded so the same failure is not bought again tomorrow.
  it("meters and records a call that did not fit the schema", async () => {
    library();
    const { lines, logger } = capturingLogger();
    const answering = model({ ...DRAFT, keep: "not-either-of-them" });
    const { pass, reported } = passWith({ completion: answering.client, logger });

    expect(await runPast(pass)).toBe(0);

    expect(reported).toHaveLength(1);
    expect(waiting()).toEqual([]);
    expect(considered()).toEqual([{ skill_a: "a-deploy", skill_b: "b-deploys" }]);
    expect(lines.find(line => line.event === "skill_merge_unusable")).toMatchObject({
      level: "warn",
      reason: "keep_not_nominated"
    });

    await runPast(pass);
    expect(answering.calls()).toBe(1);
  });

  // A provider outage is not an answer, so nothing is recorded and the pair comes
  // back next run.
  it("records nothing when the provider fails, so a later run asks again", async () => {
    library();
    const { lines, logger } = capturingLogger();
    const { pass } = passWith({
      logger,
      completion: {
        complete: () => Promise.reject(new Error("upstream is down"))
      }
    });

    await expect(runPast(pass)).resolves.toBe(0);
    expect(considered()).toEqual([]);
    expect(lines.map(line => line.event)).toContain("skill_merge_failed");
  });

  each([
    ["the sheet cannot be read", { settings: () => Promise.reject(new Error("EACCES")) }],
    ["the directory cannot be opened", { files: () => null }],
    ["the proposals directory cannot be opened", { proposals: () => null }]
  ])("answers zero rather than throwing when %s", async (_label, overrides) => {
    library();
    await expect(
      runPast(passWith(overrides as Partial<SkillCuratePassOptions>).pass)
    ).resolves.toBe(0);
  });

  it("logs a count and never a playbook's name", async () => {
    library();
    const { lines, logger } = capturingLogger();
    const { pass } = passWith({ completion: model({ ...DRAFT }).client, logger });

    await runPast(pass);

    expect(lines.map(line => line.event)).toContain("skill_merge_proposed");
    expect(JSON.stringify(lines)).not.toContain("a-deploy");
    expect(JSON.stringify(lines)).not.toContain("How we ship");
  });
});

/**
 * A shared-skill reader answering one published playbook (#450).
 *
 * The operator's half of the standing region, faked at the seam the composition
 * passes in — `./shared-skills.ts` has its own coverage against a real root.
 */
const publishes = (): SharedSkillReader => () => [
  { name: "shared/brand-voice", description: "How this company writes.", body: "Say it plainly." }
];

// #450. A merge draft is a playbook the team will keep, so an operator's house
// rules about how one should read bear on it exactly as they do on the author
// turn — the difference is who applies it, not what is being composed.
describe("the operator's standing region", () => {
  it("reaches the merge turn's system prompt", async () => {
    library();
    const asked = model({ ...DRAFT });
    const { pass } = passWith({
      completion: asked.client,
      sharedSkills: publishes(),
      settings: () =>
        Promise.resolve({
          ...SETTINGS,
          standing: { ...SETTINGS.standing, description: "we ship on Fridays" }
        })
    });

    await runPast(pass);

    const system = asked.requests[0]?.system ?? "";
    expect(system).toContain("<shared-skills>");
    expect(system).toContain("## shared/brand-voice");
    expect(system).toContain("we ship on Fridays");
    expect(system).toContain(SKILL_MERGE_SYSTEM_PROMPT.slice(0, 40));
  });

  it("composes none where no reader was wired", async () => {
    library();
    const asked = model({ ...DRAFT });
    const { pass } = passWith({ completion: asked.client });

    await runPast(pass);

    expect(asked.requests[0]?.system).toBe(SKILL_MERGE_SYSTEM_PROMPT);
  });
});
