// Phase 3's read half, end to end: a skill file on disk reaches a task's opening
// context, and one the team edits or deletes follows the file. Everything
// between the stub socket and the directory is the production wiring —
// `createServer` from compose.ts, the same call index.ts makes.
//
// This is #292's acceptance suite, on `memory-task.test.ts`'s pattern. The
// pieces are tested alone — the directory and the index in `packages/memory`,
// the fusion and the bounds in session/skill-recall.test.ts, the opener in
// session/skills.test.ts — and what only this file can catch is a seam that
// drops the baton: a router that never calls the retriever, a sheet field that
// never reaches it, a directory opened under one root and read from another.
//
// **The skills here are hand-written**, and that is the realistic case rather
// than a stand-in for one. Nothing writes a skill yet: the author turn is #291.
// #290's whole design is that a file somebody added with an editor and a file
// written through `apply` reach the index by the same road, so a team's own
// playbook is what a deployment has on the day this lands.
//
// **No embedding provider is wired**, so retrieval runs on full text alone. That
// is the team sheet's stated behaviour rather than a gap in the rig, and it is
// what a deployment without `AGENT_EMBEDDING_*` does. The vector leg has its own
// coverage in session/skill-recall.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import type { LogFields, LogLevel } from "@getlibero/gateway";
import { createGateway, createStubSlack } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  createMessageStoreOpener,
  createServer,
  createSkillFilesOpener,
  createSkillRecall
} from "./compose.js";
import type { SkillSettings } from "./compose.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";

/** Skills on, at the schema's own figures — what a sheet that parsed resolves to. */
const LOADING: SkillSettings = { enabled: true, topK: 3, maxSkillChars: 8_192, maxSkills: 100 };

let channelsRoot: string;
let storeRoot: string;

const transport: ProxyTransport = {
  request(options: ProxyRequest): Promise<ProxyResponse> {
    if (options.path === "/v1/tools") return Promise.resolve({ status: 200, body: { tools: [] } });
    return Promise.resolve({ status: 200, body: { outcome: "recorded" } });
  }
};

function provision(channel: string): void {
  mkdirSync(join(channelsRoot, channel), { recursive: true });
  writeFileSync(join(channelsRoot, channel, "channel.toml"), '[channel]\nid = "x"\n');
}

/** A playbook, written the way a team member with an editor writes one. */
function writeSkill(name: string, description: string, body: string): void {
  mkdirSync(join(storeRoot, CHANNEL, "skills"), { recursive: true });
  writeFileSync(
    join(storeRoot, CHANNEL, "skills", `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ncreated: 2026-08-01\nstatus: active\n---\n\n${body}\n`
  );
}

function deleteSkill(name: string): void {
  rmSync(join(storeRoot, CHANNEL, "skills", `${name}.md`));
}

interface RigOptions {
  readonly skills?: SkillSettings;
  /** Omits the opener and the retriever — the process as it behaved before phase 3. */
  readonly withoutSkills?: boolean;
}

/** The production composition over the stubs, with a real store and a real directory. */
function rig(options: RigOptions = {}) {
  const slack = createStubSlack({ users: { U0SAM: "Sam" } });
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  const logger = { log: (level: LogLevel, fields: LogFields) => lines.push({ level, ...fields }) };
  /** Every request the model saw, in order. */
  const asked: CompletionRequest[] = [];

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
        return Promise.resolve({
          text: "Thursdays, after standup.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 }
        });
      }
    },
    transport,
    sheets: () =>
      Promise.resolve({
        model: "test-model",
        caps: { ...DEFAULT_AGENT_LOOP_CAPS },
        history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
        // Curation off throughout: what this file is about is the read half, and
        // a curation turn would put a second completion request in `asked`.
        memory: { ...DEFAULT_MEMORY_SETTINGS },
        skills: options.skills ?? LOADING
      }),
    store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
    ...(options.withoutSkills === true
      ? {}
      : {
          skills: createSkillFilesOpener({ storeRoot, channelsRoot, logger }),
          skillRecall: createSkillRecall({ logger })
        }),
    logger
  });

  return { slack, gateway, asked, lines };
}

let mentions = 0;

/** One mention, in its own thread so each task is a fresh conversation. */
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

/** The seed the model was asked with on the given task's first turn. */
function seedOf(asked: CompletionRequest[], index: number): string {
  const seed = asked[index]?.messages[0];
  if (seed === undefined || seed.role !== "user") throw new Error("expected a user message");
  return seed.content;
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-skill-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-skill-store-"));
  mentions = 0;
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("a skill this channel holds", () => {
  // #292's first acceptance criterion, through the production wiring.
  it("is in the opening context of a task on its subject", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();
    // The state directory the store's opener makes; a mention creates it, so the
    // skill is written after one has been through.
    await mention(slack, "hello");
    writeSkill(
      "cut-a-release",
      "When somebody asks how a release is cut.",
      "1. Check the open PRs.\n2. Tag.\n3. Watch the workflow."
    );

    await mention(slack, "how do we cut a release?");

    const seed = seedOf(asked, 1);
    expect(seed).toContain("<channel-skills>");
    expect(seed).toContain("## cut-a-release");
    expect(seed).toContain("3. Watch the workflow.");
  });

  // The other half of the same criterion, and the one that makes it mean
  // something: retrieval, not injection of the whole library.
  it("is absent from a task on an unrelated subject", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();
    await mention(slack, "hello");
    writeSkill("cut-a-release", "When somebody asks how a release is cut.", "1. Tag.");

    await mention(slack, "what did the customer say about pricing?");

    expect(seedOf(asked, 1)).not.toContain("channel-skills");
  });

  it("loads nothing at all for a channel whose sheet turns skills off", async () => {
    const { slack, gateway, asked } = rig({ skills: { ...DEFAULT_SKILL_SETTINGS } });
    await gateway.start();
    await mention(slack, "hello");
    writeSkill("cut-a-release", "When somebody asks how a release is cut.", "1. Tag.");

    await mention(slack, "how do we cut a release?");

    expect(seedOf(asked, 1)).not.toContain("channel-skills");
  });

  // The process as it behaved before phase 3, which is a supported deployment
  // rather than a broken one.
  it("loads nothing when the process wired no skill retrieval", async () => {
    const { slack, gateway, asked } = rig({ withoutSkills: true });
    await gateway.start();
    await mention(slack, "hello");
    writeSkill("cut-a-release", "When somebody asks how a release is cut.", "1. Tag.");

    await mention(slack, "how do we cut a release?");

    expect(seedOf(asked, 1)).not.toContain("channel-skills");
  });

  it("bounds the count by the sheet's top_k", async () => {
    const { slack, gateway, asked } = rig({ skills: { ...LOADING, topK: 1 } });
    await gateway.start();
    await mention(slack, "hello");
    writeSkill("cut-a-release", "When somebody asks how a release is cut.", "1. Tag.");
    writeSkill("cut-a-hotfix", "When somebody asks how a hotfix release is cut.", "1. Branch.");

    await mention(slack, "how do we cut a release?");

    const seed = seedOf(asked, 1);
    expect(seed.match(/^## /gmu) ?? []).toHaveLength(1);
  });
});

// The roadmap's definition of done: the files are the source of truth. There is
// no watcher and no second path — reconciliation at the head of a task is the
// whole of how a team's edit takes effect.
describe("the team's own directory", () => {
  it("re-indexes a skill the team edited, so the edit reaches the next task", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();
    await mention(slack, "hello");
    writeSkill("cut-a-release", "When somebody asks how a release is cut.", "1. Tag.");

    await mention(slack, "how do we cut a release?");
    expect(seedOf(asked, 1)).toContain("1. Tag.");

    writeSkill(
      "cut-a-release",
      "When somebody asks how a release is cut.",
      "1. Tag.\n2. Then announce it in #releases."
    );

    await mention(slack, "how do we cut a release?");
    expect(seedOf(asked, 2)).toContain("announce it in #releases");
  });

  it("drops a skill the team deleted", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();
    await mention(slack, "hello");
    writeSkill("cut-a-release", "When somebody asks how a release is cut.", "1. Tag.");

    await mention(slack, "how do we cut a release?");
    expect(seedOf(asked, 1)).toContain("<channel-skills>");

    deleteSkill("cut-a-release");

    await mention(slack, "how do we cut a release?");
    expect(seedOf(asked, 2)).not.toContain("channel-skills");
  });

  // The rule #300 landed: the directory appears on the first write and never on
  // a read. A channel that only ever reads acquires nothing.
  it("creates no skills directory for a channel that has none", async () => {
    const { slack, gateway, lines } = rig();
    await gateway.start();

    await mention(slack, "how do we cut a release?");

    expect(lines.map(line => line.event)).not.toContain("skills_unavailable");
    expect(() => rmSync(join(storeRoot, CHANNEL, "skills"))).toThrow();
  });
});
