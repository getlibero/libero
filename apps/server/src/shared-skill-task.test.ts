// Shared skills end to end: an operator publishes a file into the third root, a
// channel's sheet names it, and it reaches that channel's task and no other's.
// Everything between the stub socket and the three roots is the production
// wiring — `createServer` from compose.ts, the same call index.ts makes.
//
// This is #436's acceptance suite, on `skill-task.test.ts`'s pattern. The pieces
// are tested alone — the pool in session/skill-pool.test.ts, the fusion and the
// bounds in session/skill-recall.test.ts, the pass in session/skill-embed.test.ts,
// the reconciliation in `packages/memory` — and what only this file can catch is
// a seam that drops the baton: a router that opens no pool, a sheet field that
// never reaches one, a skill indexed under one root and read from another.
//
// **A separate file rather than more cases in `skill-task.test.ts`**, because
// that file's header states "no embedding provider is wired" as its design and
// this one has to wire one twice: once as the query embedder in front of a task,
// and once as the sweep's client, which is what gives a shared skill a vector at
// all. Sharing a rig would mean one of the two files lying about what it runs.
//
// The embedding space is `skill-embed.test.ts`'s discipline: the question and the
// description that answers it **share not one token**, so a case that passes on
// the vector leg cannot be passing on the lexical one. Where a case is about the
// lexical leg it says so and uses words in common on purpose.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse, EmbeddingClient } from "@getlibero/agent";
import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import type { LogFields, LogLevel } from "@getlibero/gateway";
import { createGateway, createStubSlack } from "@getlibero/gateway";
import type { SharedSkillEntry } from "@getlibero/schema";
import { afterEach, beforeEach, describe, it } from "node:test";
import { waitFor } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_AMBIENT_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  createMessageStoreOpener,
  createQueryEmbedder,
  createServer,
  createSharedSkillPoolOpener,
  createSharedSkillReader,
  createSkillEmbedSweep,
  createSkillFilesOpener,
  createSkillRecall
} from "./compose.js";
import type { SkillSettings } from "./compose.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";
const MODEL = "test-embedding-model";

/** Skills on, at the schema's own figures. */
const LOADING: SkillSettings = {
  enabled: true,
  curate: false,
  authorAfterToolCalls: 5,
  topK: 3,
  maxAlwaysSkills: DEFAULT_SKILL_SETTINGS.maxAlwaysSkills,
  maxAlwaysChars: DEFAULT_SKILL_SETTINGS.maxAlwaysChars,
  maxSkillChars: 8_192,
  maxSkills: 100,
  staleAfterMs: 30 * 86_400_000,
  archiveAfterMs: 90 * 86_400_000
};

/** The question a task asks, and the description that answers it by vector alone. */
const QUESTION = "how do we roll a new key for a channel";
const CREDENTIALS = "Swapping client credentials before they expire.";
/** Far from it, so a channel that should not get a skill is asked something else. */
const CONTAINERS = "When somebody asks which base image the containers use.";

/**
 * The question as the router embeds it, which is the mention verbatim.
 *
 * `request.text` reaches `createQueryEmbedder` with the bot token still on the
 * front — nothing strips it before retrieval — so the space is keyed on what is
 * actually sent. Spelled out rather than matched loosely, because a fixture that
 * fell back to a nearest key would answer for a text it was never given and the
 * "a text it does not know is a bug" rule would stop meaning anything.
 */
const ASKED = `<@U0BOT> ${QUESTION}`;

const EMBEDDINGS: Record<string, number[]> = {
  [QUESTION]: [1, 0, 0],
  [ASKED]: [1, 0, 0],
  [CREDENTIALS]: [0.98, 0.02, 0],
  [CONTAINERS]: [0, 0.98, 0.02]
};

/**
 * An embedding client over the hand-built space. A text it does not know is a bug
 * in the fixture rather than a case, which is `skill-embed.test.ts`'s rule.
 */
function spaced(): EmbeddingClient {
  return {
    embed: ({ texts }) =>
      Promise.resolve({
        vectors: texts.map(text => {
          const point = EMBEDDINGS[text];
          if (point === undefined) throw new Error(`the fixture has no embedding for: ${text}`);
          return Float32Array.from(point);
        }),
        model: MODEL,
        usage: { inputTokens: 10 }
      })
  };
}

let channelsRoot: string;
let storeRoot: string;
let sharedRoot: string;

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

/** The operator's act: a file lands in the third root, from outside this process. */
function publish(name: string, description: string, body: string): void {
  writeFileSync(
    join(sharedRoot, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ncreated: 2026-08-01\nstatus: active\n---\n\n${body}\n`
  );
}

/** A playbook of the channel's own, written the way a team member writes one. */
function writeSkill(name: string, description: string, body: string): void {
  mkdirSync(join(storeRoot, CHANNEL, "skills"), { recursive: true });
  writeFileSync(
    join(storeRoot, CHANNEL, "skills", `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\ncreated: 2026-08-01\nstatus: active\n---\n\n${body}\n`
  );
}

const retrieved = (...names: string[]): SharedSkillEntry[] =>
  names.map(name => ({ name, load: "retrieved" as const }));

interface RigOptions {
  readonly skills?: SkillSettings;
  /** The sheet's `[[shared_skill]]` entries, both modes. */
  readonly sharedSkills?: readonly SharedSkillEntry[];
  /** Omits the third root entirely — a deployment that mounted none. */
  readonly withoutSharedRoot?: boolean;
}

/** The production composition over the stubs, with all three roots real. */
function rig(options: RigOptions = {}) {
  const slack = createStubSlack({ users: { U0SAM: "Sam" } });
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  const logger = { log: (level: LogLevel, fields: LogFields) => lines.push({ level, ...fields }) };
  const asked: CompletionRequest[] = [];
  const root = options.withoutSharedRoot === true ? null : sharedRoot;
  const embedding = spaced();
  const reportTurn = (): Promise<void> => Promise.resolve();

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
          text: "Rotate it with --rotate, then --promote.",
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
        description: "",
        sharedSkills: options.sharedSkills ?? [],
        caps: { ...DEFAULT_AGENT_LOOP_CAPS },
        history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
        memory: { ...DEFAULT_MEMORY_SETTINGS },
        skills: options.skills ?? LOADING,
        ambient: { ...DEFAULT_AMBIENT_SETTINGS }
      }),
    store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
    skills: createSkillFilesOpener({ storeRoot, channelsRoot, logger }),
    skillRecall: createSkillRecall({ logger }),
    sharedSkills: createSharedSkillReader({ root, logger }),
    sharedSkillPool: createSharedSkillPoolOpener({ root, logger }),
    embed: createQueryEmbedder({ embedding, embeddingModel: MODEL, reportTurn, logger }),
    // The pass that gives a skill a vector at all. It runs on channel activity
    // rather than at task head, which is why the cases below send an ordinary
    // message and wait for it before asking a question.
    embedSkills: createSkillEmbedSweep({
      embedding,
      embeddingModel: MODEL,
      files: createSkillFilesOpener({ storeRoot, channelsRoot, logger }),
      sharedPool: createSharedSkillPoolOpener({ root, logger }),
      settings: () =>
        Promise.resolve({
          enabled: (options.skills ?? LOADING).enabled,
          maxSkills: (options.skills ?? LOADING).maxSkills,
          sharedSkills: options.sharedSkills ?? []
        }),
      reportTurn,
      maySpend: () => Promise.resolve(true),
      logger
    }),
    logger
  });

  return { slack, gateway, asked, lines };
}

let sent = 0;

/** One mention, in its own thread so each task is a fresh conversation. */
async function mention(slack: ReturnType<typeof createStubSlack>, text: string): Promise<void> {
  sent += 1;
  const ts = `17580000${String(sent).padStart(2, "0")}.000100`;
  await slack.deliverMention({
    teamId: TEAM,
    channelId: CHANNEL,
    userId: "U0SAM",
    text: `<@U0BOT> ${text}`,
    ts,
    threadTs: ts,
    eventId: `Ev${sent}`
  });
}

/**
 * An ordinary message, which is what fires the embedding pass.
 *
 * A mention does not: the pass is queued from the ingest path on the session
 * mutex. Waited on by its own log line rather than by a timer.
 */
async function activity(
  slack: ReturnType<typeof createStubSlack>,
  lines: Array<{ level: LogLevel } & LogFields>
): Promise<void> {
  sent += 1;
  const before = lines.filter(line => line.event === "skills_embedded").length;
  await slack.deliverMessage({
    teamId: TEAM,
    channelId: CHANNEL,
    userId: "U0SAM",
    text: "carry on",
    ts: `17580000${String(sent).padStart(2, "0")}.000100`,
    eventId: `Ev${sent}`
  });
  await waitFor(() => {
    expect(lines.filter(line => line.event === "skills_embedded").length).toBeGreaterThan(before);
  }, { timeout: 2_000 });
}

/** The seed the model was asked with on the given task's first turn. */
function seedOf(asked: CompletionRequest[], index: number): string {
  const seed = asked[index]?.messages[0];
  if (seed === undefined || seed.role !== "user") throw new Error("expected a user message");
  return seed.content;
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-shared-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-shared-store-"));
  sharedRoot = mkdtempSync(join(tmpdir(), "libero-shared-skills-"));
  sent = 0;
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
  rmSync(sharedRoot, { recursive: true, force: true });
});

describe("a shared skill this channel's sheet names", () => {
  // #436's first acceptance criterion, through the production wiring and on the
  // vector leg: the question and the description share not one token.
  it("reaches a task whose question is near it", async () => {
    publish("rotate-a-cert", CREDENTIALS, "Run --rotate, then --promote.");
    const { slack, gateway, asked, lines } = rig({ sharedSkills: retrieved("rotate-a-cert") });
    await gateway.start();
    await activity(slack, lines);

    await mention(slack, QUESTION);

    const seed = seedOf(asked, 0);
    expect(seed).toContain("<shared-skills>");
    expect(seed).toContain("## shared/rotate-a-cert");
    expect(seed).toContain("Run --rotate, then --promote.");
  });

  // The lexical leg, said so out loud: this one shares words on purpose, and it
  // is the case that holds on a deployment with no embedding provider.
  it("reaches one on words alone", async () => {
    publish("rotate-a-cert", "How this company rolls a certificate.", "Run --rotate.");
    const { slack, gateway, asked } = rig({ sharedSkills: retrieved("rotate-a-cert") });
    await gateway.start();

    await mention(slack, "how do we roll a certificate here");

    expect(seedOf(asked, 0)).toContain("## shared/rotate-a-cert");
  });

  it("is rendered apart from the channel's own", async () => {
    publish("rotate-a-cert", "How this company rolls a certificate.", "Run --rotate.");
    writeSkill("cut-a-release", "How this team rolls a release.", "1. Tag.");
    const { slack, gateway, asked } = rig({ sharedSkills: retrieved("rotate-a-cert") });
    await gateway.start();
    await mention(slack, "hello");

    await mention(slack, "how do we roll a certificate or a release");

    const seed = seedOf(asked, 1);
    expect(seed).toContain("## shared/rotate-a-cert");
    expect(seed).toContain("## cut-a-release");
    expect(seed.indexOf("<shared-skills>")).toBeLessThan(seed.indexOf("<channel-skills>"));
  });
});

// The criterion #436 names by name. The file is in the root and the root is
// mounted; what decides is the sheet, and nothing else.
describe("a published skill this sheet does not name", () => {
  it("never reaches the channel, even on the question it answers", async () => {
    // On words this time, because the pass that would give it a vector has
    // nothing to embed on a sheet that named nothing — and the case is stronger
    // for it: the question and the description share every word that matters.
    publish("rotate-a-cert", "How this company rolls a certificate.", "Run --rotate.");
    const { slack, gateway, asked } = rig({ sharedSkills: [] });
    await gateway.start();

    await mention(slack, "how do we roll a certificate");

    const seed = seedOf(asked, 0);
    expect(seed).not.toContain("shared-skills");
    expect(seed).not.toContain("rotate-a-cert");
  });

  // Two published files, one named: the sheet selects rather than the directory.
  // **This is the case above's positive control** — the same root, the same
  // mount, one file arriving and one not — so "the skill did not reach the
  // channel" cannot be read as "nothing published ever reaches it".
  it("is not pulled in beside the one that is named", async () => {
    publish("rotate-a-cert", "How this company rolls a certificate.", "Run --rotate.");
    publish("brand-voice", "How this company writes a certificate.", "Say it plainly.");
    const { slack, gateway, asked } = rig({ sharedSkills: retrieved("rotate-a-cert") });
    await gateway.start();

    await mention(slack, "how do we roll a certificate");

    const seed = seedOf(asked, 0);
    expect(seed).toContain("## shared/rotate-a-cert");
    expect(seed).not.toContain("brand-voice");
  });
});

// The team sheet's promise, through the wiring: the switch gates the channel leg
// of the pool and never the pool.
describe("a channel whose own skills are switched off", () => {
  const OFF: SkillSettings = { ...LOADING, enabled: false };

  it("still gets the shared skills its sheet named", async () => {
    publish("rotate-a-cert", "How this company rolls a certificate.", "Run --rotate.");
    writeSkill("cut-a-release", "How this team rolls a certificate.", "1. Tag.");
    const { slack, gateway, asked } = rig({
      skills: OFF,
      sharedSkills: retrieved("rotate-a-cert")
    });
    await gateway.start();

    await mention(slack, "how do we roll a certificate");

    const seed = seedOf(asked, 0);
    expect(seed).toContain("## shared/rotate-a-cert");
    // And the switch still holds over the channel's own half.
    expect(seed).not.toContain("channel-skills");
    expect(seed).not.toContain("cut-a-release");
  });

  it("gets them on the vector leg too, so the embedding pass ran for it", async () => {
    publish("rotate-a-cert", CREDENTIALS, "Run --rotate, then --promote.");
    const { slack, gateway, asked, lines } = rig({
      skills: OFF,
      sharedSkills: retrieved("rotate-a-cert")
    });
    await gateway.start();
    await activity(slack, lines);

    await mention(slack, QUESTION);

    expect(seedOf(asked, 0)).toContain("## shared/rotate-a-cert");
  });
});

// The two modes are two regions, and a skill is in one of them.
describe("the two load modes", () => {
  it("puts an always entry in the system prompt and not in the seed", async () => {
    publish("brand-voice", "How this company writes.", "Say it plainly.");
    const { slack, gateway, asked } = rig({
      sharedSkills: [{ name: "brand-voice", load: "always" }]
    });
    await gateway.start();

    await mention(slack, "how do we roll a certificate");

    expect(asked[0]?.system).toContain("## shared/brand-voice");
    expect(seedOf(asked, 0)).not.toContain("shared-skills");
  });

  it("puts a retrieved entry in the seed and not in the system prompt", async () => {
    publish("rotate-a-cert", "How this company rolls a certificate.", "Run --rotate.");
    const { slack, gateway, asked } = rig({ sharedSkills: retrieved("rotate-a-cert") });
    await gateway.start();

    await mention(slack, "how do we roll a certificate");

    expect(seedOf(asked, 0)).toContain("## shared/rotate-a-cert");
    expect(asked[0]?.system ?? "").not.toContain("shared-skills");
  });
});

// A deployment that mounted no third root is a supported one: every channel's
// own skills work exactly as before, and a sheet that names one says so in the
// operator's log rather than in the channel.
describe("a deployment with no shared root", () => {
  it("answers the task without the skill, and names the reason", async () => {
    const { slack, gateway, asked, lines } = rig({
      sharedSkills: retrieved("rotate-a-cert"),
      withoutSharedRoot: true
    });
    await gateway.start();

    await mention(slack, "how do we roll a certificate");

    expect(seedOf(asked, 0)).not.toContain("shared-skills");
    expect(lines.filter(line => line.event === "shared_skills_unavailable")).toMatchObject([
      { level: "warn", channel: CHANNEL, reason: "shared_skills_root_unset" }
    ]);
  });
});
