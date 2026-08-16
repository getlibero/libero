// Phase 3's write half, end to end: a tool-heavy task leaves a playbook in a
// real `skills/` directory, and a light one leaves nothing. Everything between
// the stub socket and the file is the production wiring — `createServer` from
// compose.ts, the same call index.ts makes.
//
// This is #291's acceptance suite, on `memory-task.test.ts`'s pattern. The turn
// itself is tested alone in `packages/agent`, the directory in
// `packages/memory`, the opener in session/skills.test.ts — and what only this
// file can catch is a seam that drops the baton: a threshold counting the wrong
// number, a sheet field that never reaches the turn, neighbours that never
// arrive, a turn id that collides with curation's.
//
// **The threshold is the reason this rig serves real tool calls.** A test that
// faked the count would be asserting against the fake, and the count is exactly
// what #291 gets wrong if it reads `AgentTaskResult.toolCalls`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse } from "@getlibero/agent";
import {
  CURATION_SYSTEM_PROMPT,
  DEFAULT_AGENT_LOOP_CAPS,
  SKILL_AUTHOR_SYSTEM_PROMPT
} from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import type { LogFields, LogLevel } from "@getlibero/gateway";
import { createGateway, createStubSlack } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  createMemoryFileOpener,
  createMessageStoreOpener,
  createServer,
  createSkillFilesOpener,
  createSkillRecall
} from "./compose.js";
import type { MemorySettings, SkillSettings } from "./compose.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";

/** Skills on at the schema's own figures: author above five served calls. */
const AUTHORING: SkillSettings = {
  enabled: true,
  authorAfterToolCalls: 5,
  topK: 3,
  maxSkillChars: 8_192,
  maxSkills: 100
};

const CURATING: MemorySettings = {
  enabled: true,
  maxFileChars: 8_192,
  summarize: false,
  summarizeAfterIdleMs: 60 * 60_000
};

let channelsRoot: string;
let storeRoot: string;

/**
 * Serves `ok` for every tool but `merge_pr`, which it refuses.
 *
 * The refusal is the point of the second tool: a refused call is one the loop
 * counts and the threshold must not, so a rig without one could not tell the two
 * numbers apart.
 */
const transport: ProxyTransport = {
  request(options: ProxyRequest): Promise<ProxyResponse> {
    if (options.path === "/v1/tools") {
      return Promise.resolve({
        status: 200,
        body: {
          tools: [
            { server: "github", tool: "list_pull_requests", approval: "none" },
            { server: "github", tool: "merge_pr", approval: "none" }
          ]
        }
      });
    }
    if (options.path === "/v1/spend") {
      return Promise.resolve({ status: 200, body: { outcome: "recorded" } });
    }
    const body = options.body as { id: string; tool: string };
    if (body.tool === "merge_pr") {
      return Promise.resolve({
        status: 200,
        body: { outcome: "refused", id: body.id, reason: "tool_not_permitted" }
      });
    }
    return Promise.resolve({
      status: 200,
      body: { outcome: "ran", id: body.id, result: { content: "ok" } }
    });
  }
};

function provision(channel: string): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, "channel.toml"), '[channel]\nid = "x"\n');
}

/** A playbook already on disk, the way a team member with an editor writes one. */
function writeSkill(name: string, description: string, body: string): void {
  mkdirSync(join(storeRoot, CHANNEL, "skills"), { recursive: true });
  writeFileSync(
    join(storeRoot, CHANNEL, "skills", `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ncreated: 2026-08-01\nstatus: active\n---\n\n${body}\n`
  );
}

/** A skill as it is on disk, or null when it was never written. */
function skillOnDisk(name: string): string | null {
  const file = join(storeRoot, CHANNEL, "skills", `${name}.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const isAuthoring = (request: CompletionRequest): boolean =>
  request.system === SKILL_AUTHOR_SYSTEM_PROMPT;
const isCuration = (request: CompletionRequest): boolean =>
  request.system === CURATION_SYSTEM_PROMPT;

interface RigOptions {
  readonly skills?: SkillSettings;
  readonly memory?: MemorySettings;
  /** What the author turn answers. Writes one skill unless a test says otherwise. */
  readonly authorReply?: () => Promise<CompletionResponse>;
}

/**
 * The production composition, with a model that calls `perTurn[i]` on turn i and
 * then answers.
 */
function rig(perTurn: string[], options: RigOptions = {}) {
  const slack = createStubSlack({ users: { U0SAM: "Sam" } });
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  const logger = { log: (level: LogLevel, fields: LogFields) => lines.push({ level, ...fields }) };
  const asked: CompletionRequest[] = [];

  let turn = 0;
  const task = (): Promise<CompletionResponse> => {
    const name = perTurn[turn];
    turn += 1;
    if (name === undefined) {
      return Promise.resolve({
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 }
      });
    }
    return Promise.resolve({
      text: "",
      toolCalls: [{ id: `call-${String(turn)}`, name, arguments: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 }
    });
  };

  const author =
    options.authorReply ??
    ((): Promise<CompletionResponse> =>
      Promise.resolve({
        text: "",
        toolCalls: [
          {
            id: "op-1",
            name: "skill_create",
            arguments: {
              name: "cut-a-release",
              description: "When somebody asks how a release is cut.",
              body: "1. List the open PRs.\n2. Merge needs a human click."
            }
          }
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 400, outputTokens: 90 }
      }));

  const { gateway } = createServer({
    slack: ({ handler, onDecision, onMessage }) => ({
      gateway: createGateway({
        source: slack.source,
        poster: slack.poster,
        handler,
        onDecision,
        onMessage,
        logger
      }),
      cards: slack.poster,
      users: slack.users
    }),
    completion: {
      complete: (request: CompletionRequest): Promise<CompletionResponse> => {
        asked.push(request);
        if (isAuthoring(request)) return author();
        if (isCuration(request)) {
          return Promise.resolve({
            text: "Nothing worth recording.",
            toolCalls: [],
            stopReason: "end_turn",
            usage: { inputTokens: 40, outputTokens: 20 }
          });
        }
        return task();
      }
    },
    transport,
    sheets: () =>
      Promise.resolve({
        model: "test-model",
        caps: { ...DEFAULT_AGENT_LOOP_CAPS },
        history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
        memory: options.memory ?? { ...DEFAULT_MEMORY_SETTINGS },
        skills: options.skills ?? AUTHORING
      }),
    store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
    memory: createMemoryFileOpener({ storeRoot, channelsRoot, logger }),
    skills: createSkillFilesOpener({ storeRoot, channelsRoot, logger }),
    skillRecall: createSkillRecall({ logger }),
    logger
  });

  return { slack, gateway, asked, lines };
}

let mentions = 0;

async function mention(slack: ReturnType<typeof createStubSlack>, text: string): Promise<void> {
  mentions += 1;
  const ts = `17580000${String(mentions).padStart(2, "0")}.000100`;
  await slack.deliverMention({
    teamId: TEAM,
    channelId: CHANNEL,
    userId: "U0SAM",
    text: `<@U0BOT> ${text}`,
    ts,
    threadTs: ts,
    eventId: `Ev${mentions}`
  });
}

/**
 * One mention, then a second that cannot begin until the first task's post-reply
 * work has finished.
 *
 * **Every assertion in this file needs this, and the ones asserting that
 * authoring did *not* happen need it most.** `afterReply` is enqueued on the
 * session's mutex and deliberately not awaited, so a mention resolves before it
 * has run — which means a test that asserted straight afterwards would be
 * reading a race, and "no author turn was made" would pass on a rig where one
 * was simply still queued. The mutex is FIFO, so a second mention is a barrier
 * rather than a sleep: it cannot start until the thunk ahead of it is done.
 * `memory-task.test.ts` makes the same move for the same reason.
 *
 * The second mention makes no tool calls, so it never authors anything of its
 * own and never appears in what these tests filter for.
 */
async function settle(slack: ReturnType<typeof createStubSlack>, text: string): Promise<void> {
  await mention(slack, text);
  await mention(slack, "thanks");
}

/** Six calls the proxy serves, which is one more than the threshold. */
const SIX_SERVED = Array.from({ length: 6 }, () => "list_pull_requests");

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-authoring-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-authoring-store-"));
  mentions = 0;
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("when the author turn runs", () => {
  // #291's first acceptance criterion, and the whole point of the phase's write
  // half: a task over the threshold leaves a playbook on disk.
  it("writes a skill after a task over the threshold", async () => {
    const { slack, gateway, asked } = rig(SIX_SERVED);
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(asked.filter(isAuthoring)).toHaveLength(1);
    expect(skillOnDisk("cut-a-release")).toContain("2. Merge needs a human click.");
  });

  // Strictly greater, which the schema pins rather than leaving two
  // implementations to discover it.
  it("does not run for a task exactly at the threshold", async () => {
    const { slack, gateway, asked } = rig(SIX_SERVED.slice(0, 5));
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(asked.filter(isAuthoring)).toEqual([]);
    expect(skillOnDisk("cut-a-release")).toBeNull();
  });

  it("does not run for a task with no tool calls at all", async () => {
    const { slack, gateway, asked } = rig([]);
    await gateway.start();

    await settle(slack, "when do we deploy?");

    expect(asked.filter(isAuthoring)).toEqual([]);
  });

  // **The distinction #291's issue text gets wrong.** The loop counts a call the
  // moment it dispatches one, so six refused calls are six in
  // `AgentTaskResult.toolCalls` — and the sheet says the threshold counts calls
  // the proxy *served*. A task whose calls were all refused learned that this
  // channel's sheet does not grant those tools, and a playbook written from it
  // would be a playbook about tools that do not work here.
  it("does not count a refused call toward the threshold", async () => {
    const { slack, gateway, asked } = rig([
      ...SIX_SERVED.slice(0, 3),
      "merge_pr",
      "merge_pr",
      "merge_pr"
    ]);
    await gateway.start();

    await settle(slack, "cut a release please");

    // Six calls dispatched, three of them served. Three is not over five.
    expect(asked.filter(isAuthoring)).toEqual([]);
  });

  // A name this channel's sheet never published is refused by the tool client
  // before the proxy is asked, so it is a dispatched call with no served result.
  it("does not count a tool the channel was never given", async () => {
    const { slack, gateway, asked } = rig([
      ...SIX_SERVED.slice(0, 3),
      "delete_everything",
      "delete_everything",
      "delete_everything"
    ]);
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(asked.filter(isAuthoring)).toEqual([]);
  });

  it("does not run for a channel whose sheet turns skills off", async () => {
    const { slack, gateway, asked } = rig(SIX_SERVED, {
      skills: { ...DEFAULT_SKILL_SETTINGS }
    });
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(asked.filter(isAuthoring)).toEqual([]);
    expect(skillOnDisk("cut-a-release")).toBeNull();
  });
});

describe("what the turn is handed", () => {
  // The advisory half, end to end. These are the skills retrieval loaded at the
  // head of *this* task (#292), not a second search — which is what makes a
  // `skill_revise` a revision rather than a blind overwrite.
  it("shows the turn the skills this task opened with", async () => {
    writeSkill(
      "cut-a-release",
      "When somebody asks how a release is cut.",
      "1. Tag it.\n2. Watch the workflow."
    );
    const { slack, gateway, asked } = rig(SIX_SERVED);
    await gateway.start();

    await settle(slack, "how is a release cut around here?");

    const authoring = asked.filter(isAuthoring)[0];
    const question = authoring?.messages.at(-1);
    expect(question?.content).toContain("## cut-a-release");
    expect(question?.content).toContain("2. Watch the workflow.");
  });

  it("says the channel has none when retrieval found none", async () => {
    const { slack, gateway, asked } = rig(SIX_SERVED);
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(asked.filter(isAuthoring)[0]?.messages.at(-1)?.content).toContain(
      "no skills on this subject yet"
    );
  });

  // The inversion of curation's transcript, asserted where it is observable: the
  // author turn sees what the task *did*, and the curation turn does not.
  it("shows the turn the task's tool calls, where curation sees none", async () => {
    const { slack, gateway, asked } = rig(SIX_SERVED, { memory: CURATING });
    await gateway.start();

    await settle(slack, "cut a release please");

    const authoring = JSON.stringify(asked.filter(isAuthoring)[0]?.messages);
    const curation = JSON.stringify(asked.filter(isCuration)[0]?.messages);
    expect(authoring).toContain("called list_pull_requests");
    expect(curation).not.toContain("called list_pull_requests");
  });

  it("tells the turn how full the library is", async () => {
    writeSkill("roll-back-a-release", "When a release has to be undone.", "1. Revert.");
    const { slack, gateway, asked } = rig(SIX_SERVED);
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(asked.filter(isAuthoring)[0]?.messages.at(-1)?.content).toContain(
      "holds 1 skills and may hold 100"
    );
  });
});

describe("the two post-reply turns share one counter", () => {
  /**
   * The turn numbers reported for the first task, once its post-reply work is
   * certainly over.
   *
   * **The second mention is the barrier, and it is the ordering under test
   * rather than a trick to make the test pass** — `memory-task.test.ts` makes
   * the same move for the same reason. `afterReply` is enqueued on the session's
   * mutex and deliberately not awaited, so the first mention resolves before it
   * has run; a second mention queues behind it and cannot start until it is
   * done. A test that polled or slept would be asserting a timing accident.
   *
   * Filtered by task id, because the second mention reports turns of its own.
   */
  async function turnsOfFirstTask(
    slack: ReturnType<typeof createStubSlack>,
    lines: Array<{ level: LogLevel } & LogFields>
  ): Promise<Array<number | undefined>> {
    await settle(slack, "cut a release please");
    const first = lines.find(line => line.event === "task")?.task;
    await mention(slack, "thanks");

    return lines
      .filter(line => line.event === "spend_reported" && line.task === first)
      .map(line => line.turns);
  }

  // **The reason `afterReply` is one thunk (#291).** A turn id is the spend
  // meter's idempotency key, so a collision is a lost turn and a gap is a
  // promise `CurationTurnOptions.turn` makes and would be breaking.
  it("numbers curation and authoring consecutively after the task's own turns", async () => {
    const { slack, gateway, lines } = rig(SIX_SERVED, { memory: CURATING });
    await gateway.start();

    // Seven task turns — six tool-calling and the answer — then curation, then
    // authoring, with nothing repeated and nothing skipped.
    expect(await turnsOfFirstTask(slack, lines)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // The gap a sibling thunk would have left, asserted from the other side: with
  // curation off, authoring takes the number curation would have had.
  it("gives authoring the next number when curation does not run", async () => {
    const { slack, gateway, lines } = rig(SIX_SERVED);
    await gateway.start();

    expect(await turnsOfFirstTask(slack, lines)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("runs curation before authoring", async () => {
    const { slack, gateway, asked } = rig(SIX_SERVED, { memory: CURATING });
    await gateway.start();

    await settle(slack, "cut a release please");

    const curation = asked.findIndex(isCuration);
    const authoring = asked.findIndex(isAuthoring);
    expect(curation).toBeGreaterThan(-1);
    expect(curation).toBeLessThan(authoring);
  });
});

describe("what a failure costs", () => {
  // The reply has already posted, so an authoring failure is a log line and
  // nothing else. A rejection here would be an unhandled one at the process
  // level.
  it("logs and carries on when the provider rejects", async () => {
    const { slack, gateway, lines } = rig(SIX_SERVED, {
      authorReply: () => Promise.reject(new Error("upstream down"))
    });
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(lines.map(line => line.event)).toContain("authoring_failed");
    expect(lines.map(line => line.event)).toContain("replied");
  });

  // A model that finds nothing reusable is the ordinary outcome above the
  // threshold, not a failure, and there is no operation to say it with.
  it("writes nothing when the turn declines", async () => {
    const { slack, gateway, lines } = rig(SIX_SERVED, {
      authorReply: () =>
        Promise.resolve({
          text: "Nothing reusable here.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 400, outputTokens: 20 }
        })
    });
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(skillOnDisk("cut-a-release")).toBeNull();
    expect(lines.find(line => line.event === "authored")?.ops).toBe(0);
  });

  // The write goes through the store's checked path, so a name that is not a
  // name never becomes a path segment. `packages/memory` proves that against a
  // filesystem; this proves the production wiring actually goes through it.
  it("writes nothing outside the skills directory for a traversal name", async () => {
    const { slack, gateway } = rig(SIX_SERVED, {
      authorReply: () =>
        Promise.resolve({
          text: "",
          toolCalls: [
            {
              id: "op-1",
              name: "skill_create",
              arguments: {
                name: "../../../etc/passwd",
                description: "A playbook.",
                body: "Steps."
              }
            }
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 400, outputTokens: 90 }
        })
    });
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(existsSync(join(storeRoot, CHANNEL, "skills"))).toBe(false);
    expect(existsSync(join(storeRoot, "etc"))).toBe(false);
  });

  it("logs a count and never the playbook itself", async () => {
    const { slack, gateway, lines } = rig(SIX_SERVED);
    await gateway.start();

    await settle(slack, "cut a release please");

    expect(lines.find(line => line.event === "authored")?.ops).toBe(1);
    expect(JSON.stringify(lines)).not.toContain("Merge needs a human click");
  });
});
