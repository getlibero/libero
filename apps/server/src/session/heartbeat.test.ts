// The heartbeat, against a real store.
//
// `./summarize.test.ts`'s reason and one of its own: half of what the pregate
// does is expressed in SQL that lives in `packages/memory` — which threads count
// as idle, and how the watermark rules one out — so a fake store would let both
// sides of that agree with each other and with nothing.
//
// The model and the poster are faked at their seams. The poster is the more
// interesting fake, because most of this file is about the turn **not** running:
// almost every case asserts that the model was never asked, and the reason
// differs each time.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompletedTurn, CompletionClient, CompletionRequest } from "@getlibero/agent";
import { AMBIENT_FINDING_TOOL } from "@getlibero/schema";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore, StoredMessage } from "@getlibero/memory";
import { openMessageStore } from "@getlibero/memory";
import { MAX_HEARTBEAT_MESSAGES, createAmbientHeartbeat } from "./heartbeat.js";
import type { HeartbeatOptions, HeartbeatSettings } from "./heartbeat.js";
import { toSlackTs } from "./summarize.js";
import type { ProactivePost, ProactivePoster } from "../proactive/proactive.js";

const CHANNEL = "C0ENGINEERING";

const NOW = 1_749_998_700_000;
const MINUTE = 60_000;

const SETTINGS: HeartbeatSettings = {
  enabled: true,
  answerAfterIdleMs: 60 * MINUTE,
  model: "test-model",
  maxTokens: 1024
};

let root: string;
let store: MessageStore;

function at(msAgo: number, text: string, thread: string | null = null): StoredMessage {
  return {
    ts: toSlackTs(NOW - msAgo),
    threadTs: thread,
    userId: "U0ALICE",
    displayName: "alice",
    text,
    at: NOW - msAgo
  };
}

/** A model that answers with a finding, or with silence, and counts its calls. */
function model(finding: string | null): {
  completion: CompletionClient;
  calls: () => number;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    calls: () => requests.length,
    completion: {
      complete(request) {
        requests.push(request);
        return Promise.resolve({
          text: "",
          toolCalls:
            finding === null
              ? []
              : [{ id: "c1", name: AMBIENT_FINDING_TOOL, arguments: { text: finding } }],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 200, outputTokens: 20 },
          model: "served-model"
        });
      }
    }
  };
}

/** A poster whose window a case opens and shuts by hand. */
function poster(open = true): { post: ProactivePoster; sent: ProactivePost[]; asked: () => number } {
  const sent: ProactivePost[] = [];
  let asks = 0;
  return {
    sent,
    asked: () => asks,
    post: {
      mayPost(): boolean {
        asks += 1;
        return open;
      },
      post(request): Promise<boolean> {
        sent.push(request);
        return Promise.resolve(true);
      }
    }
  };
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

function heartbeatWith(overrides: Partial<HeartbeatOptions> = {}) {
  const reported: Array<CompletedTurn & { id: string }> = [];
  const surface = poster();
  const base: HeartbeatOptions = {
    completion: model("Priya's question has had no reply.").completion,
    post: surface.post,
    settings: () => Promise.resolve(SETTINGS),
    reportTurn: (_channel, turn) => {
      reported.push(turn);
      return Promise.resolve();
    },
    maySpend: () => Promise.resolve(true),
    now: () => NOW,
    ...overrides
  };
  return { heartbeat: createAmbientHeartbeat(base), reported, surface };
}

/** A question asked long enough ago to be past the idle threshold. */
function plantIdleQuestion(text = "why is staging refusing certs?"): void {
  store.append(at(90 * MINUTE, text));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-heartbeat-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a heartbeat with something to say", () => {
  it("evaluates, posts once, and meters the turn", async () => {
    plantIdleQuestion();
    const answering = model("Priya's question has had no reply since Friday.");
    const surface = poster();
    const { heartbeat, reported } = heartbeatWith({
      completion: answering.completion,
      post: surface.post
    });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(1);
    expect(surface.sent).toEqual([
      {
        channel: CHANNEL,
        text: "Priya's question has had no reply since Friday.",
        source: "heartbeat"
      }
    ]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it("shows the model the channel's recent activity, attributed and capped", async () => {
    plantIdleQuestion();
    for (let i = 0; i < MAX_HEARTBEAT_MESSAGES + 10; i += 1) {
      store.append(at(80 * MINUTE - i, `chatter ${String(i)}`));
    }
    const answering = model(null);
    const { heartbeat } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);

    const content = answering.requests[0]?.messages[0]?.content ?? "";
    expect(content).toContain("alice: ");
    expect(content.split("\n").filter(line => line.startsWith("alice: "))).toHaveLength(
      MAX_HEARTBEAT_MESSAGES
    );
  });

  it("posts nothing when the model says nothing, and still pays for the turn", async () => {
    plantIdleQuestion();
    const silent = model(null);
    const surface = poster();
    const { heartbeat, reported } = heartbeatWith({
      completion: silent.completion,
      post: surface.post
    });

    await heartbeat(CHANNEL, store);

    expect(silent.calls()).toBe(1);
    expect(surface.sent).toEqual([]);
    // The meter still hears about it. Almost every heartbeat is silent, so a
    // pass that reported only when it spoke would under-count ambient by
    // roughly everything.
    expect(reported).toHaveLength(1);
  });
});

describe("the pregate, in the order it runs", () => {
  it("spends nothing for a channel whose sheet has ambient off", async () => {
    plantIdleQuestion();
    const answering = model("something");
    const surface = poster();
    const { heartbeat, reported } = heartbeatWith({
      completion: answering.completion,
      post: surface.post,
      settings: () => Promise.resolve({ ...SETTINGS, enabled: false })
    });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(0);
    expect(reported).toEqual([]);
    // Not even the window is consulted: the sheet is the first question.
    expect(surface.asked()).toBe(0);
  });

  it("spends nothing for a channel with no sheet at all", async () => {
    plantIdleQuestion();
    const answering = model("something");
    const { heartbeat } = heartbeatWith({
      completion: answering.completion,
      settings: () => Promise.resolve(null)
    });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(0);
  });

  it("spends nothing when nothing has gone quiet yet", async () => {
    // The threshold is what makes "unanswered" a fact rather than a sample. A
    // question asked a minute ago looks exactly like one ignored for an hour.
    store.append(at(1 * MINUTE, "why is staging refusing certs?"));
    const answering = model("something");
    const { heartbeat, reported } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(0);
    expect(reported).toEqual([]);
  });

  it("evaluates the same question once it has sat", async () => {
    // The other half of the case above, on one clock: the difference is the age
    // of the message and nothing else.
    store.append(at(90 * MINUTE, "why is staging refusing certs?"));
    const answering = model("something");
    const { heartbeat } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(1);
  });

  it("spends nothing in an empty channel", async () => {
    const answering = model("something");
    const { heartbeat } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(0);
  });

  it("asks about the budget last, and only when it is about to spend", async () => {
    // Everything above it is free; this one is a round trip. A channel that was
    // never going to evaluate must not pay for a question about its budget.
    let asked = 0;
    const gate = (): Promise<boolean> => {
      asked += 1;
      return Promise.resolve(true);
    };

    const quiet = heartbeatWith({ maySpend: gate });
    await quiet.heartbeat(CHANNEL, store);
    expect(asked).toBe(0);

    plantIdleQuestion();
    const live = heartbeatWith({ maySpend: gate });
    await live.heartbeat(CHANNEL, store);
    expect(asked).toBe(1);
  });

  it("spends nothing for a channel over its caps", async () => {
    plantIdleQuestion();
    const answering = model("something");
    const surface = poster();
    const { heartbeat, reported } = heartbeatWith({
      completion: answering.completion,
      post: surface.post,
      maySpend: () => Promise.resolve(false)
    });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(0);
    expect(reported).toEqual([]);
    expect(surface.sent).toEqual([]);
  });
});

describe("the rate window, consulted before anything is spent", () => {
  it("evaluates nothing when the window is shut", async () => {
    plantIdleQuestion();
    const answering = model("something");
    const shut = poster(false);
    const { heartbeat, reported } = heartbeatWith({
      completion: answering.completion,
      post: shut.post
    });

    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(0);
    expect(reported).toEqual([]);
    expect(shut.sent).toEqual([]);
  });

  // The decision #318 left to this issue, as a test: a shut window defers a
  // finding rather than losing it, because the evaluation that would have moved
  // the watermark never ran.
  it("weighs the same material again once the window opens", async () => {
    plantIdleQuestion();
    let open = false;
    const answering = model("Priya's question has had no reply.");
    const sent: ProactivePost[] = [];
    const surface: ProactivePoster = {
      mayPost: () => open,
      post: request => {
        sent.push(request);
        return Promise.resolve(true);
      }
    };
    const { heartbeat } = heartbeatWith({ completion: answering.completion, post: surface });

    await heartbeat(CHANNEL, store);
    expect(answering.calls()).toBe(0);

    open = true;
    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("the watermark", () => {
  it("does not weigh the same silence twice", async () => {
    // The agent's own replies are not in the store, so nothing records that it
    // already spoke about a thread. Without this, a question it had raised would
    // look unanswered forever and be raised again every window.
    plantIdleQuestion();
    const answering = model("Priya's question has had no reply.");
    const { heartbeat, surface } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);
    await heartbeat(CHANNEL, store);
    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(1);
    expect(surface.sent).toHaveLength(1);
  });

  it("advances on silence too, so a quiet thread is not re-asked forever", async () => {
    plantIdleQuestion();
    const silent = model(null);
    const { heartbeat } = heartbeatWith({ completion: silent.completion });

    await heartbeat(CHANNEL, store);
    await heartbeat(CHANNEL, store);

    expect(silent.calls()).toBe(1);
  });

  it("weighs a thread again once it has said something new and gone quiet", async () => {
    // Say-once is per silence, not forever.
    plantIdleQuestion();
    const answering = model("still nothing on Priya's question.");
    const { heartbeat, surface } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);
    expect(answering.calls()).toBe(1);

    store.append(at(80 * MINUTE, "any update on this?"));
    await heartbeat(CHANNEL, store);

    expect(answering.calls()).toBe(2);
    expect(surface.sent).toHaveLength(2);
  });

  it("does not advance when a provider fails, so nothing is skipped over", async () => {
    plantIdleQuestion();
    let attempts = 0;
    const failing: CompletionClient = {
      complete() {
        attempts += 1;
        return Promise.reject(new Error("provider is down"));
      }
    };
    const { lines, logger } = capturingLogger();
    const { heartbeat } = heartbeatWith({ completion: failing, logger });

    await heartbeat(CHANNEL, store);
    await heartbeat(CHANNEL, store);

    expect(attempts).toBe(2);
    expect(lines.map(line => line.event)).toEqual(["heartbeat_failed", "heartbeat_failed"]);
  });
});

describe("what it does with an answer it cannot use", () => {
  it("posts nothing, and says so apart from silence", async () => {
    plantIdleQuestion();
    const broken: CompletionClient = {
      complete: () =>
        Promise.resolve({
          text: "",
          toolCalls: [{ id: "c1", name: AMBIENT_FINDING_TOOL, arguments: { text: 42 } }],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 200, outputTokens: 20 }
        })
    };
    const { lines, logger } = capturingLogger();
    const surface = poster();
    const { heartbeat, reported } = heartbeatWith({
      completion: broken,
      post: surface.post,
      logger
    });

    await heartbeat(CHANNEL, store);

    expect(surface.sent).toEqual([]);
    // Paid for, and logged as its own thing — a broken prompt must not hide
    // inside the silence that is the expected outcome.
    expect(reported).toHaveLength(1);
    expect(lines.map(line => line.event)).toContain("heartbeat_unusable");
  });

  it("never rejects, whatever fails", async () => {
    plantIdleQuestion();
    const failing: CompletionClient = {
      complete: () => Promise.reject(new Error("provider is down"))
    };
    const { heartbeat } = heartbeatWith({ completion: failing });

    await expect(heartbeat(CHANNEL, store)).resolves.toBeUndefined();
  });
});

describe("what it costs", () => {
  it("names the channel and the position it evaluated, so a crash retry is one charge", async () => {
    plantIdleQuestion();
    const answering = model("something");
    const { heartbeat, reported } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);

    expect(reported[0]?.id).toBe(`ambient-${CHANNEL}-${toSlackTs(NOW - 90 * MINUTE)}`);
  });

  it("gives a later evaluation a different id", async () => {
    plantIdleQuestion();
    const answering = model("something");
    const { heartbeat, reported } = heartbeatWith({ completion: answering.completion });

    await heartbeat(CHANNEL, store);
    store.append(at(80 * MINUTE, "any update?"));
    await heartbeat(CHANNEL, store);

    expect(reported).toHaveLength(2);
    expect(reported[0]?.id).not.toBe(reported[1]?.id);
  });
});
