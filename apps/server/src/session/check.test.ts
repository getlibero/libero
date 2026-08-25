// Firing a scheduled check, against a real store.
//
// `./heartbeat.test.ts`'s scaffolding and its reason for using a real file: the
// terminal stamp and the outcome word are what make "one firing, one outcome"
// true, and a fake store would let this file's idea of that agree with itself
// and with nothing.
//
// The weight here is the opposite of the heartbeat's. There, almost every case
// asserts the model was never asked. Here almost every case asserts that
// *something reached the channel* — because the decision this file encodes is
// that a check which could not run says so, so the team can act on the timer.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { CompletedTurn, CompletionClient, CompletionRequest } from "@getlibero/agent";
import { AMBIENT_FINDING_TOOL } from "@getlibero/schema";
import { SCHEDULED_CHECK_SYSTEM_PROMPT } from "@getlibero/agent";
import type { SharedSkillReader } from "./shared-skills.js";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore, StoredMessage, StoredScheduledTask } from "@getlibero/memory";
import { openMessageStore } from "@getlibero/memory";
import { createAmbientTaskFire, renderCheckFailureNotice } from "./check.js";
import type { CheckOptions, CheckSettings } from "./check.js";
import { toSlackTs } from "./summarize.js";
import type { ProactivePost, ProactivePoster } from "../proactive/proactive.js";

const CHANNEL = "C0ENGINEERING";
const NOW = 1_749_998_700_000;

const SETTINGS: CheckSettings = {
  // No shared skills and no description, which is the channel every case here
  // is about: what #450 wired is that this turn *can* carry a standing region,
  // and `standing.test.ts` is where it does.
  standing: { description: "", sharedSkills: [], maxAlwaysSkills: 2, maxAlwaysChars: 8_192 },
  enabled: true,
  model: "test-model",
  maxTokens: 1024
};

const TICKET: StoredScheduledTask = {
  id: "e3f1a2b4-0c5d-4e6f-8a90-1b2c3d4e5f60",
  task: "task-7",
  prompt: "check whether anyone picked up the staging cert renewal",
  dueAt: NOW - 1_000,
  createdAt: NOW - 600_000
};

let root: string;
let store: MessageStore;

function said(text: string): StoredMessage {
  return {
    ts: toSlackTs(NOW - 60_000),
    threadTs: null,
    userId: "U0ALICE",
    displayName: "alice",
    text,
    at: NOW - 60_000
  };
}

function model(finding: string | null): {
  completion: CompletionClient;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  return {
    requests,
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

function poster(posts = true): { post: ProactivePoster; sent: ProactivePost[]; asked: () => number } {
  const sent: ProactivePost[] = [];
  let asks = 0;
  return {
    sent,
    asked: () => asks,
    post: {
      mayPost(): boolean {
        asks += 1;
        return true;
      },
      post(request): Promise<boolean> {
        sent.push(request);
        return Promise.resolve(posts);
      }
    }
  };
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

function fireWith(overrides: Partial<CheckOptions> = {}) {
  const reported: Array<CompletedTurn & { id: string }> = [];
  const surface = poster();
  const base: CheckOptions = {
    completion: model("Nobody has picked up the cert renewal.").completion,
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
  return {
    fire: createAmbientTaskFire(base),
    reported,
    sent: (overrides.post as typeof surface.post | undefined) === undefined ? surface.sent : []
  };
}

/** What the store says about the ticket now. */
function row(): { fired_at: number | null; outcome: string | null } {
  const rows = store.dueScheduledTasks(NOW + 1_000_000, 10);
  if (rows.length > 0) return { fired_at: null, outcome: null };
  // Pending is the absence of a stamp, so an empty due read means it fired. The
  // column itself is read through a second handle, since nothing on the
  // interface exposes it — deliberately, and this is a test rather than a caller.
  const db = new DatabaseSync(join(root, CHANNEL, "store.db"), { readOnly: true });
  const found = db
    .prepare(`SELECT fired_at, outcome FROM scheduled_task WHERE id = ?`)
    .get(TICKET.id) as { fired_at: number | null; outcome: string | null };
  db.close();
  return found;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-check-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
  store.append(said("staging certs expire friday, someone should renew them"));
  store.scheduleTask(TICKET);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a check that has an answer", () => {
  it("posts it as a task, not as a heartbeat", async () => {
    const surface = poster();
    const { fire } = fireWith({ post: surface.post });

    await fire(CHANNEL, store, TICKET);

    expect(surface.sent).toEqual([
      { channel: CHANNEL, text: "Nobody has picked up the cert renewal.", source: "task" }
    ]);
    // The window governs unbidden speech and this is not that. A fired check
    // never asks, so a heartbeat having spoken cannot make a reminder late.
    expect(surface.asked()).toBe(0);
  });

  it("ends the ticket, and records that it posted", async () => {
    const { fire } = fireWith();
    await fire(CHANNEL, store, TICKET);

    expect(row()).toEqual({ fired_at: NOW, outcome: "posted" });
    expect(store.nextScheduledTaskDueAt()).toBeNull();
  });

  it("shows the model the question and the channel's recent messages", async () => {
    const asked = model("found it");
    const { fire } = fireWith({ completion: asked.completion });

    await fire(CHANNEL, store, TICKET);

    const sent = String(asked.requests[0]?.messages[0]?.content ?? "");
    expect(sent).toContain(TICKET.prompt);
    expect(sent).toContain("staging certs expire friday");
  });

  it("meters the turn against the ticket's own id", async () => {
    const { fire, reported } = fireWith();
    await fire(CHANNEL, store, TICKET);

    expect(reported.map(turn => turn.id)).toEqual([`check-${TICKET.id}`]);
  });

  // A Slack failure is not a reason to run the check again: the turn has already
  // been paid for, and `not_in_channel` fails identically every time.
  it("ends the ticket even when the post does not land", async () => {
    const surface = poster(false);
    const { fire } = fireWith({ post: surface.post });

    await fire(CHANNEL, store, TICKET);

    expect(row()).toEqual({ fired_at: NOW, outcome: "posted" });
  });
});

describe("a check with nothing to say", () => {
  // The good outcome of a conditional check, and the one case that posts nothing.
  it("says nothing, and records that apart from having posted", async () => {
    const surface = poster();
    const { fire } = fireWith({ completion: model(null).completion, post: surface.post });

    await fire(CHANNEL, store, TICKET);

    expect(surface.sent).toEqual([]);
    expect(row()).toEqual({ fired_at: NOW, outcome: "silent" });
  });
});

// The decision this file exists to encode. A check that could not run is not
// queued, not retried and not silently dropped — the channel is told, so the
// people who set it up can act on the timer themselves.
describe("a check that could not run", () => {
  it("spends nothing on a capped channel, and tells the channel why", async () => {
    const surface = poster();
    const asked = model("should not be asked");
    const { fire } = fireWith({
      completion: asked.completion,
      post: surface.post,
      maySpend: () => Promise.resolve(false)
    });

    await fire(CHANNEL, store, TICKET);

    expect(asked.requests).toEqual([]);
    expect(surface.sent).toHaveLength(1);
    expect(surface.sent[0]?.text).toContain("daily budget");
    expect(surface.sent[0]?.source).toBe("task");
    expect(row()).toEqual({ fired_at: NOW, outcome: "over_budget" });
  });

  it("tells the channel when the provider failed, and ends the ticket", async () => {
    const surface = poster();
    const { fire } = fireWith({
      post: surface.post,
      completion: { complete: () => Promise.reject(new Error("upstream is down")) }
    });

    await fire(CHANNEL, store, TICKET);

    expect(surface.sent[0]?.text).toContain("could not be run");
    expect(row()).toEqual({ fired_at: NOW, outcome: "failed" });
  });

  // A call that was made and could not be used is a check that did not happen,
  // so the channel hears about it — unlike the heartbeat, where nobody is waiting.
  it("tells the channel when the model's answer was unusable", async () => {
    const surface = poster();
    const { fire } = fireWith({
      post: surface.post,
      completion: {
        complete: () =>
          Promise.resolve({
            text: "",
            toolCalls: [{ id: "c1", name: AMBIENT_FINDING_TOOL, arguments: { body: "wrong" } }],
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, outputTokens: 2 }
          })
      }
    });

    await fire(CHANNEL, store, TICKET);

    expect(surface.sent).toHaveLength(1);
    expect(row()).toEqual({ fired_at: NOW, outcome: "failed" });
  });

  // One post per firing, and a notice is that post rather than an extra one.
  it("posts once, whatever the firing produced", async () => {
    for (const options of [
      { maySpend: () => Promise.resolve(false) },
      { completion: { complete: () => Promise.reject(new Error("down")) } }
    ]) {
      store.markScheduledTaskFired(TICKET.id, 0, "posted");
      const surface = poster();
      const { fire } = fireWith({ post: surface.post, ...options });
      await fire(CHANNEL, store, TICKET);
      expect(surface.sent).toHaveLength(1);
    }
  });
});

describe("the notice", () => {
  // Composed here and never by a model: the whole point of this path is that
  // nothing was spent, so a notice needing a model call would defeat it.
  it("names the check, says why, and says the check is done", () => {
    const notice = renderCheckFailureNotice(TICKET.prompt, "over_budget");

    expect(notice).toContain(TICKET.prompt);
    expect(notice).toContain("daily budget");
    expect(notice).toContain("runs once");
  });

  // Two reasons rather than one, because they send a reader to different places:
  // a budget an admin can raise, and something broken somebody has to look at.
  it("says which of the two it was", () => {
    expect(renderCheckFailureNotice("x", "over_budget")).not.toEqual(
      renderCheckFailureNotice("x", "failed")
    );
  });
});

describe("what it does not do", () => {
  // Defence rather than a path — the clock enumerates from its own sheet read —
  // but the answer has to be the block's own: say nothing, and leave the row.
  it("says nothing and leaves the ticket when ambient is off", async () => {
    const surface = poster();
    const { fire } = fireWith({
      post: surface.post,
      settings: () => Promise.resolve({ ...SETTINGS, enabled: false })
    });

    await fire(CHANNEL, store, TICKET);

    expect(surface.sent).toEqual([]);
    expect(store.nextScheduledTaskDueAt()).toBe(TICKET.dueAt);
  });

  it("leaves the ticket when the sheet could not be read", async () => {
    const { logger, lines } = capturingLogger();
    const { fire } = fireWith({ settings: () => Promise.reject(new Error("gone")), logger });

    await fire(CHANNEL, store, TICKET);

    expect(store.nextScheduledTaskDueAt()).toBe(TICKET.dueAt);
    expect(lines.some(line => line.event === "check_failed")).toBe(true);
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

// #450. A fired check composes a message a channel reads, and the interrupt was
// authorized by a human at the create — so what is left for standing text to
// shape is only how it reads.
describe("the operator's standing region", () => {
  it("reaches the check turn's system prompt", async () => {
    const asked = model("Nobody has picked up the cert renewal.");
    const { fire } = fireWith({
      completion: asked.completion,
      sharedSkills: publishes(),
      settings: () =>
        Promise.resolve({
          ...SETTINGS,
          standing: { ...SETTINGS.standing, description: "we ship on Fridays" }
        })
    });

    await fire(CHANNEL, store, TICKET);

    const system = asked.requests[0]?.system ?? "";
    expect(system).toContain("<shared-skills>");
    expect(system).toContain("## shared/brand-voice");
    expect(system).toContain("we ship on Fridays");
    expect(system).toContain(SCHEDULED_CHECK_SYSTEM_PROMPT.slice(0, 40));
  });

  it("composes none where no reader was wired", async () => {
    const asked = model("Nobody has picked up the cert renewal.");
    const { fire } = fireWith({ completion: asked.completion });

    await fire(CHANNEL, store, TICKET);

    expect(asked.requests[0]?.system).toBe(SCHEDULED_CHECK_SYSTEM_PROMPT);
  });
});
