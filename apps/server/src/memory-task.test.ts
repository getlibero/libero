// Layer 2, end to end: a mention is answered, the curation turn writes a fact
// into a real `MEMORY.md`, and the next mention's transcript carries it back.
// Everything between the stub socket and the file is the production wiring —
// `createServer` from compose.ts, the same call index.ts makes.
//
// This is #227's acceptance suite. The pieces are tested alone — the store in
// `packages/memory`, the turn in `packages/agent`, the opener in
// session/memory.test.ts — and what only this file can catch is a seam that
// drops the baton: a router that never enqueues the turn, a sheet field that
// never reaches it, a file opened under one root and read from another.
//
// **The second mention is what waits for the first one's curation, and that is
// the ordering under test rather than a trick to make the test pass.** The turn
// is enqueued on the session's mutex, so a task that arrives after it queues
// behind it. A test that polled or slept would be asserting a timing accident.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse } from "@getlibero/agent";
import { CURATION_SYSTEM_PROMPT, DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { ProxyRequest, ProxyResponse, ProxyTransport } from "@getlibero/agent";
import type { LogFields, LogLevel } from "@getlibero/gateway";
import { createGateway, createStubSlack } from "@getlibero/gateway";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import {
  DEFAULT_FOLLOW_UP_WINDOW_MS,
  DEFAULT_HISTORY_BOUNDS,
  DEFAULT_AMBIENT_SETTINGS,
  DEFAULT_SKILL_SETTINGS,
  createMemoryFileOpener,
  createMessageStoreOpener,
  createServer
} from "./compose.js";
import type { MemorySettings } from "./compose.js";

const TEAM = "T024BE7LD";
const CHANNEL = "C024BE91L";
const CURATING: MemorySettings = { enabled: true, maxFileChars: 8_192, summarize: false, summarizeAfterIdleMs: 60 * 60_000 };

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

/** A curation call is the one carrying the curation prompt. */
const isCuration = (request: CompletionRequest): boolean =>
  request.system === CURATION_SYSTEM_PROMPT;

/** The channel's memory as it is on disk, or null when it was never written. */
function memoryOnDisk(channel = CHANNEL): string | null {
  const file = join(storeRoot, channel, "MEMORY.md");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

interface RigOptions {
  readonly memory?: MemorySettings;
  /** What the curation turn answers. Records a fact unless a test says otherwise. */
  readonly curationReply?: () => Promise<CompletionResponse>;
  /** Omits the opener entirely — the process as it behaved before phase 2. */
  readonly withoutOpener?: boolean;
}

/** The production composition over the stubs, with a real store and a real file. */
function rig(options: RigOptions = {}) {
  const slack = createStubSlack({ users: { U0SAM: "Sam" } });
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  const logger = { log: (level: LogLevel, fields: LogFields) => lines.push({ level, ...fields }) };
  /** Every request the model saw, in order. */
  const asked: CompletionRequest[] = [];

  const answer = (): Promise<CompletionResponse> =>
    Promise.resolve({
      text: "Thursdays, after standup.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 }
    });

  // Records once and then finds nothing worth recording, which is both the
  // realistic shape — most tasks produce nothing durable — and what makes the
  // file's contents a fixed string rather than a count of how many curation
  // turns happened to have drained by the time a test looked.
  let curations = 0;
  const curate =
    options.curationReply ??
    ((): Promise<CompletionResponse> => {
      curations += 1;
      return Promise.resolve({
        text: curations === 1 ? "" : "Nothing worth recording.",
        toolCalls:
          curations === 1
            ? [
                {
                  id: "op-1",
                  name: "memory_append",
                  arguments: { text: "- Deploys go out Thursdays, after standup." }
                }
              ]
            : [],
        stopReason: curations === 1 ? "tool_use" : "end_turn",
        usage: { inputTokens: 40, outputTokens: 20 }
      });
    });

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
        return isCuration(request) ? curate() : answer();
      }
    },
    transport,
    sheets: () =>
      Promise.resolve({
        model: "test-model",
        description: "",
        caps: { ...DEFAULT_AGENT_LOOP_CAPS },
        history: { ...DEFAULT_HISTORY_BOUNDS },
        followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
        memory: options.memory ?? CURATING,
        skills: { ...DEFAULT_SKILL_SETTINGS },
        ambient: { ...DEFAULT_AMBIENT_SETTINGS }
      }),
    store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
    ...(options.withoutOpener === true
      ? {}
      : { memory: createMemoryFileOpener({ storeRoot, channelsRoot, logger }) }),
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
  const tasks = asked.filter(request => !isCuration(request));
  const seed = tasks[index]?.messages[0];
  if (seed === undefined || seed.role !== "user") throw new Error("expected a user message");
  return seed.content;
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "libero-memory-sheets-"));
  storeRoot = mkdtempSync(join(tmpdir(), "libero-memory-store-"));
  mentions = 0;
  provision(CHANNEL);
});

afterEach(() => {
  rmSync(channelsRoot, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe("a fact curated in one task", () => {
  // Acceptance criterion 1, and the whole point of the phase.
  it("is in the next task's starting context", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");

    expect(memoryOnDisk()).toBe("- Deploys go out Thursdays, after standup.\n");
    expect(seedOf(asked, 0)).not.toContain("<channel-memory>");
    expect(seedOf(asked, 1)).toContain("<channel-memory>");
    expect(seedOf(asked, 1)).toContain("- Deploys go out Thursdays, after standup.");
  });

  // The order the assembler puts them in, asserted where it is observable: the
  // durable frame, then what was said lately, then the question.
  it("sits above the channel history and below nothing", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await slack.deliverMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      userId: "U0SAM",
      text: "still wondering",
      ts: "1758000099.000100"
    });
    await mention(slack, "and who signs off?");

    const seed = seedOf(asked, 1);
    expect(seed.indexOf("<channel-memory>")).toBeLessThan(seed.indexOf("<channel-history>"));
    expect(seed.indexOf("<channel-history>")).toBeLessThan(seed.indexOf("asks:"));
  });

  it("is what the curation turn is shown next time, so it can replace it", async () => {
    const { slack, gateway, asked } = rig();
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");

    const curations = asked.filter(isCuration);
    expect(curations[0]?.messages.at(-1)?.content).toContain("no MEMORY.md yet");
    expect(curations[1]?.messages.at(-1)?.content).toContain(
      "- Deploys go out Thursdays, after standup."
    );
  });
});

describe("a channel whose sheet disables curation", () => {
  // Acceptance criterion 2.
  it("runs no curation turn and writes no file", async () => {
    const { slack, gateway, asked } = rig({ memory: { enabled: false, maxFileChars: 8_192, summarize: false, summarizeAfterIdleMs: 60 * 60_000 } });
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");

    expect(asked.filter(isCuration)).toEqual([]);
    expect(memoryOnDisk()).toBeNull();
  });

  // The read half goes with the write half. A task that could see a file nothing
  // may update would be showing the model something nobody can correct.
  it("reads no memory into its context either", async () => {
    const { slack, gateway, asked } = rig({ memory: { enabled: false, maxFileChars: 8_192, summarize: false, summarizeAfterIdleMs: 60 * 60_000 } });
    await gateway.start();

    // Written by hand, as a team member's editor would.
    mkdirSync(join(storeRoot, CHANNEL), { recursive: true });
    writeFileSync(join(storeRoot, CHANNEL, "MEMORY.md"), "- A fact nobody asked for.\n");

    await mention(slack, "when do we deploy?");

    expect(seedOf(asked, 0)).not.toContain("<channel-memory>");
  });
});

describe("a deployment with no memory opener", () => {
  it("answers exactly as it did before phase 2", async () => {
    const { slack, gateway, asked } = rig({ withoutOpener: true });
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");

    expect(asked.filter(isCuration)).toEqual([]);
    expect(memoryOnDisk()).toBeNull();
    expect(seedOf(asked, 1)).not.toContain("<channel-memory>");
  });
});

describe("when curation fails", () => {
  // Acceptance criterion 3. The reply has already been produced and posted; a
  // curation failure is a log line and nothing else.
  it("leaves the posted reply alone and says so in the log", async () => {
    const { slack, gateway, lines } = rig({
      curationReply: () => Promise.reject(new Error("provider is down"))
    });
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");

    expect(slack.posted.map(post => post.text)).toEqual([
      "Thursdays, after standup.",
      "Thursdays, after standup."
    ]);
    expect(lines.find(line => line.event === "curation_failed")).toMatchObject({
      level: "error",
      channel: CHANNEL
    });
  });

  it("leaves the session able to answer the next mention", async () => {
    const { slack, gateway, asked } = rig({
      curationReply: () => Promise.reject(new Error("provider is down"))
    });
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");
    await mention(slack, "one more");

    expect(asked.filter(request => !isCuration(request))).toHaveLength(3);
    expect(slack.posted).toHaveLength(3);
  });

  // A refusal is not a failure: the store answered, the model was wrong, and the
  // turn is over. The file is unchanged and the log says curation ran.
  it("records the turn as run when the store refused every operation", async () => {
    const { slack, gateway, lines } = rig({
      curationReply: () =>
        Promise.resolve({
          text: "",
          toolCalls: [
            {
              id: "op-1",
              name: "memory_replace",
              arguments: { find: "nothing in the file", replace: "x" }
            }
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 40, outputTokens: 20 }
        })
    });
    await gateway.start();

    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");

    expect(memoryOnDisk()).toBeNull();
    expect(lines.find(line => line.event === "curated")).toMatchObject({ ops: 1 });
    expect(lines.find(line => line.event === "curation_failed")).toBeUndefined();
  });
});

describe("what the curation turn is metered as", () => {
  // The turn is charged to the channel like any other, under the task it
  // followed, so the proxy's meter is authoritative over curation too.
  it("continues the task's own turn numbering", async () => {
    const spent: string[] = [];
    const metering: ProxyTransport = {
      request(options: ProxyRequest): Promise<ProxyResponse> {
        if (options.path === "/v1/tools") {
          return Promise.resolve({ status: 200, body: { tools: [] } });
        }
        const body = options.body as { turn?: string } | undefined;
        if (body?.turn !== undefined) spent.push(body.turn);
        return Promise.resolve({ status: 200, body: { outcome: "recorded" } });
      }
    };

    const slack = createStubSlack({ users: { U0SAM: "Sam" } });
    const asked: CompletionRequest[] = [];
    const { gateway } = createServer({
      slack: ({ handler, onDecision, onMessage }) => ({
        gateway: createGateway({ source: slack.source, poster: slack.poster, handler, onDecision, onMessage }),
        cards: slack.poster,
        users: slack.users
      }),
      completion: {
        complete: (request: CompletionRequest): Promise<CompletionResponse> => {
          asked.push(request);
          return Promise.resolve(
            isCuration(request)
              ? {
                  text: "",
                  toolCalls: [
                    { id: "op-1", name: "memory_append", arguments: { text: "- A fact." } }
                  ],
                  stopReason: "tool_use",
                  usage: { inputTokens: 40, outputTokens: 20 }
                }
              : {
                  text: "Thursdays.",
                  toolCalls: [],
                  stopReason: "end_turn",
                  usage: { inputTokens: 10, outputTokens: 5 }
                }
          );
        }
      },
      transport: metering,
      sheets: () =>
        Promise.resolve({
          model: "test-model",
          description: "",
          caps: { ...DEFAULT_AGENT_LOOP_CAPS },
          history: { ...DEFAULT_HISTORY_BOUNDS },
          followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
          memory: CURATING,
          skills: { ...DEFAULT_SKILL_SETTINGS },
        ambient: { ...DEFAULT_AMBIENT_SETTINGS }
        }),
      store: createMessageStoreOpener({ storeRoot, channelsRoot }),
      memory: createMemoryFileOpener({ storeRoot, channelsRoot })
    });

    await gateway.start();
    await mention(slack, "when do we deploy?");
    await mention(slack, "and who signs off?");

    // One task turn then one curation turn, under the same task id, numbered
    // without a gap — which is what keeps each report its own idempotency key.
    const [first, second] = spent;
    expect(first?.endsWith(".1")).toBe(true);
    expect(second?.endsWith(".2")).toBe(true);
    expect(first?.split(".")[0]).toBe(second?.split(".")[0]);
  });
});
