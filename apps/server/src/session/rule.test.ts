// Firing a standing rule, against a real store.
//
// `./check.test.ts`'s scaffolding, because the two run the same turn — which is
// the claim `./fired-turn.ts` exists to make structural, and half of what this
// file checks is that it stayed true.
//
// The weight is where the check suite puts it, for the same reason: almost every
// case asserts that *something reached the channel*, because the decision this
// file encodes is that a rule which could not run says so. What it adds is the
// half that is not a check — the wake reason on the post, the wording that says
// the rule still stands, and a turn id built from the occurrence rather than
// from a ticket that does not exist.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import type { CompletedTurn, CompletionClient, CompletionRequest } from "@getlibero/agent";
import { AMBIENT_FINDING_TOOL, AMBIENT_REQUESTING_USER, textBlock } from "@getlibero/schema";
import type { AmbientRule } from "@getlibero/schema";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import type { MessageStore, StoredMessage } from "@getlibero/memory";
import { openMessageStore } from "@getlibero/memory";
import { createAmbientRuleFire, renderRuleFailureNotice } from "./rule.js";
import type { RuleOptions, RuleSettings } from "./rule.js";
import { toSlackTs } from "./summarize.js";
import type { ProactivePost, ProactivePoster } from "../proactive/proactive.js";

const CHANNEL = "C0ENGINEERING";
const NOW = 1_749_998_700_000;
/** The occurrence a firing is for, distinct from `NOW` so the two cannot be confused. */
const DUE_AT = 1_749_998_400_000;

const SETTINGS: RuleSettings = {
  standing: { description: "", sharedSkills: [], maxAlwaysSkills: 2, maxAlwaysChars: 8_192 },
  enabled: true,
  // Off, which is every sheet that has not opted in (#348) — so every case in
  // this file is about the single-call shape unless it says otherwise.
  tools: false,
  caps: {
    maxToolCalls: 5,
    maxWallTimeMs: 30_000,
    maxTokens: 60_000,
    maxOutputTokensPerTurn: 1024
  },
  model: "test-model",
  maxTokens: 1024
};

const RULE: AmbientRule = {
  name: "standup-digest",
  at: ["09:00"],
  days: ["mon", "tue", "wed", "thu", "fri"],
  question: "What moved yesterday, and what is blocked?"
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

function fireWith(overrides: Partial<RuleOptions> = {}) {
  const reported: Array<CompletedTurn & { id: string }> = [];
  const surface = poster();
  const base: RuleOptions = {
    completion: model("Two things moved; the cert renewal is still blocked.").completion,
    post: surface.post,
    settings: () => Promise.resolve(SETTINGS),
    reportTurn: (_channel, turn) => {
      reported.push(turn);
      return Promise.resolve();
    },
    maySpend: () => Promise.resolve(true),
    ...overrides
  };
  return {
    fire: createAmbientRuleFire(base),
    reported,
    sent: (overrides.post as typeof surface.post | undefined) === undefined ? surface.sent : []
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-rule-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
  store.append(said("staging certs expire friday, someone should renew them"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a rule that has an answer", () => {
  it("posts it as a rule, not as a task or a heartbeat", async () => {
    const surface = poster();
    const { fire } = fireWith({ post: surface.post });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toEqual([
      {
        channel: CHANNEL,
        text: "Two things moved; the cert renewal is still blocked.",
        source: "rule"
      }
    ]);
  });

  // The window governs unbidden speech, and a rule is not that: the sheet edit
  // that created it was the authorization. Never asking is how that is true by
  // construction rather than by the poster being lenient.
  it("never asks the rate window whether it may speak", async () => {
    const surface = poster();
    const { fire } = fireWith({ post: surface.post });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.asked()).toBe(0);
  });

  // Built from the rule and the occurrence, because there is no ticket id to use.
  // The occurrence rather than the instant the scan reached it, so two scans
  // racing one firing meter it once.
  it("meters the turn under the rule and the occurrence", async () => {
    const { fire, reported } = fireWith();

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(reported).toHaveLength(1);
    expect(reported[0]?.id).toBe(`rule-standup-digest-${DUE_AT}`);
  });

  it("gives the next occurrence a different id from this one", async () => {
    const { fire, reported } = fireWith();

    await fire(CHANNEL, store, RULE, DUE_AT);
    await fire(CHANNEL, store, RULE, DUE_AT + 86_400_000);

    expect(new Set(reported.map(turn => turn.id)).size).toBe(2);
  });

  it("asks the rule's question, not the channel's last message", async () => {
    const asked = model("something");
    const { fire } = fireWith({ completion: asked.completion });

    await fire(CHANNEL, store, RULE, DUE_AT);

    const text = JSON.stringify(asked.requests[0]?.messages);
    expect(text).toContain("What moved yesterday, and what is blocked?");
  });

  // The containment claim, from the caller's side: the turn is given no tools it
  // could serve a call with, so a rule cannot reach the tool proxy service.
  it("induces no served tool calls", async () => {
    const asked = model("something");
    const { fire } = fireWith({ completion: asked.completion });

    await fire(CHANNEL, store, RULE, DUE_AT);

    const offered = asked.requests[0]?.tools ?? [];
    expect(offered.map(tool => tool.name)).toEqual([AMBIENT_FINDING_TOOL]);
  });

  it("posts nothing more when the post itself fails", async () => {
    const surface = poster(false);
    const { logger, lines } = capturingLogger();
    const { fire } = fireWith({ post: surface.post, logger });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toHaveLength(1);
    expect(lines.some(line => line.event === "rule_unposted")).toBe(true);
  });
});

describe("a rule with nothing to say", () => {
  // The good outcome of a conditional question, and the one case that posts
  // nothing: a digest on a quiet week is silence, and saying "nothing happened"
  // every Monday is the noise this avoids.
  it("says nothing and posts nothing", async () => {
    const surface = poster();
    const { logger, lines } = capturingLogger();
    const { fire } = fireWith({ completion: model(null).completion, post: surface.post, logger });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toEqual([]);
    expect(lines.some(line => line.event === "rule_silent")).toBe(true);
  });

  it("still meters the turn it spent", async () => {
    const { fire, reported } = fireWith({ completion: model(null).completion });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(reported).toHaveLength(1);
  });
});

describe("a rule that could not run", () => {
  it("spends nothing and still tells the channel when over budget", async () => {
    const surface = poster();
    const asked = model("unreachable");
    const { fire, reported } = fireWith({
      completion: asked.completion,
      post: surface.post,
      maySpend: () => Promise.resolve(false)
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    // Nothing was asked of the model, which is the whole point of the pregate.
    expect(asked.requests).toEqual([]);
    expect(reported).toEqual([]);
    expect(surface.sent).toHaveLength(1);
    expect(surface.sent[0]?.source).toBe("rule");
    expect(surface.sent[0]?.text).toContain("spent its daily budget");
  });

  it("tells the channel when the turn threw", async () => {
    const surface = poster();
    const { fire } = fireWith({
      completion: {
        complete: () => Promise.reject(new Error("provider down"))
      },
      post: surface.post
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toHaveLength(1);
    expect(surface.sent[0]?.text).toContain("could not be run");
  });

  // One post per firing, whatever happened. A notice is the firing's post rather
  // than an extra one.
  it("posts exactly once", async () => {
    const surface = poster();
    const { fire } = fireWith({ post: surface.post, maySpend: () => Promise.resolve(false) });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toHaveLength(1);
  });

  it("names the rule on the line it logs", async () => {
    const { logger, lines } = capturingLogger();
    const { fire } = fireWith({ logger, maySpend: () => Promise.resolve(false) });

    await fire(CHANNEL, store, RULE, DUE_AT);

    const declined = lines.find(line => line.event === "rule_declined");
    expect(declined?.rule).toBe("standup-digest");
  });
});

describe("the notice a channel reads", () => {
  // The line that is not the check's, and the reason this renderer is separate.
  // A check says the timer is spent; a rule says it still stands, because it
  // does — and a team told otherwise would go and re-create something that was
  // never lost.
  it("says the rule still stands", () => {
    const notice = renderRuleFailureNotice(RULE, "failed");

    expect(notice).toContain("still stands and will run again at its next time");
    expect(notice).not.toContain("this one is done");
  });

  it("names the rule, so an operator can find it in the sheet", () => {
    expect(renderRuleFailureNotice(RULE, "failed")).toContain("standup-digest");
  });

  it("quotes the question, so the team knows which firing failed", () => {
    expect(renderRuleFailureNotice(RULE, "over_budget")).toContain(
      "What moved yesterday, and what is blocked?"
    );
  });

  // Two reasons that send a reader to different places: one is a budget an admin
  // can raise, the other is something broken somebody has to look at.
  it("distinguishes a budget from a breakage", () => {
    const budget = renderRuleFailureNotice(RULE, "over_budget");
    const broken = renderRuleFailureNotice(RULE, "failed");

    expect(budget).toContain("spent its daily budget");
    expect(broken).not.toContain("budget");
  });
});

describe("a channel that is not to be spoken to", () => {
  // The scheduler enumerates from a sheet read of its own, so reaching here with
  // ambient off is a race rather than a path — and the answer is the block's own
  // switch: say nothing at all, not even a notice.
  it("says nothing when ambient is off", async () => {
    const surface = poster();
    const { fire, reported } = fireWith({
      post: surface.post,
      settings: () => Promise.resolve({ ...SETTINGS, enabled: false })
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("says nothing when no sheet resolved", async () => {
    const surface = poster();
    const { fire } = fireWith({ post: surface.post, settings: () => Promise.resolve(null) });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toEqual([]);
  });

  it("says nothing when the sheet read threw", async () => {
    const surface = poster();
    const { logger, lines } = capturingLogger();
    const { fire } = fireWith({
      post: surface.post,
      logger,
      settings: () => Promise.reject(new Error("unreadable"))
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toEqual([]);
    expect(lines.some(line => line.event === "rule_failed")).toBe(true);
  });
});

describe("a rule whose channel opted into tools", () => {
  /** The sheet that turns the loop on. Everything else is `SETTINGS`. */
  const WITH_TOOLS: RuleSettings = { ...SETTINGS, tools: true };

  /** A stub proxy client: lists one tool, records what was executed. */
  function client(result = "main is green") {
    const executed: Array<{ name: string; requestingUser: string; taskId: string }> = [];
    return {
      executed,
      tools: {
        list: () =>
          Promise.resolve([
            { name: "ci_status", description: "CI status.", inputSchema: { type: "object" as const, properties: {} } }
          ]),
        execute: (call: { name: string }, attribution: { requestingUser: string; taskId: string }) => {
          executed.push({ name: call.name, ...attribution });
          return Promise.resolve({ content: [textBlock(result)] });
        }
      }
    };
  }

  /** A model that calls `ci_status`, then posts, then stops. */
  const looks = (finding: string | null): CompletionClient => {
    let turn = 0;
    return {
      complete() {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            text: "",
            toolCalls: [{ id: "t1", name: "ci_status", arguments: {} }],
            stopReason: "tool_use" as const,
            usage: { inputTokens: 100, outputTokens: 10 },
            model: "served-model"
          });
        }
        // The loop dispatches on `tool_use` and stops on `end_turn`, so a turn
        // that posts has to be the first of those and the run ends on the next.
        if (turn === 2 && finding !== null) {
          return Promise.resolve({
            text: "",
            toolCalls: [{ id: "t2", name: AMBIENT_FINDING_TOOL, arguments: { text: finding } }],
            stopReason: "tool_use" as const,
            usage: { inputTokens: 120, outputTokens: 12 },
            model: "served-model"
          });
        }
        return Promise.resolve({
          text: "",
          toolCalls: [],
          stopReason: "end_turn" as const,
          usage: { inputTokens: 120, outputTokens: 12 },
          model: "served-model"
        });
      }
    };
  };

  it("calls the channel's tools and posts what it found", async () => {
    const surface = poster();
    const stub = client();
    const { fire } = fireWith({
      completion: looks("main is green; nothing is blocked."),
      post: surface.post,
      firedTools: () => stub.tools,
      settings: () => Promise.resolve(WITH_TOOLS)
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(stub.executed.map(call => call.name)).toEqual(["ci_status"]);
    expect(surface.sent).toHaveLength(1);
    expect(surface.sent[0]?.source).toBe("rule");
    expect(surface.sent[0]?.text).toContain("main is green");
  });

  // The audit log's "who asked" for a call no person asked for. Reserved by an
  // alphabet no user id can reach, so it can never be mistaken for one.
  it("attributes every call to the clock rather than to a person", async () => {
    const stub = client();
    const { fire } = fireWith({
      completion: looks("something"),
      firedTools: () => stub.tools,
      settings: () => Promise.resolve(WITH_TOOLS)
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(stub.executed[0]?.requestingUser).toBe(AMBIENT_REQUESTING_USER);
    // And the task id still says which firing it was, so a row can be traced.
    expect(stub.executed[0]?.taskId).toBe(`rule-standup-digest-${DUE_AT}`);
  });

  // Silence survives the loop. With one tool it was structural; with two it is
  // still structural, because saying nothing is calling `post_finding` not at all
  // — and a model that has just used a tool has more reason to think it owes the
  // channel a summary, which is exactly why this case exists.
  it("says nothing when it looked and found nothing worth saying", async () => {
    const surface = poster();
    const stub = client();
    const { fire } = fireWith({
      completion: looks(null),
      post: surface.post,
      firedTools: () => stub.tools,
      settings: () => Promise.resolve(WITH_TOOLS)
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(stub.executed).toHaveLength(1);
    expect(surface.sent).toEqual([]);
  });

  // The switch is what selects the shape, and off is the default. A channel that
  // never wrote the line gets the single call it always got, whatever tools its
  // sheet lists for its members.
  it("calls nothing when the sheet did not opt in", async () => {
    const stub = client();
    const { fire } = fireWith({
      completion: model("Nothing moved.").completion,
      firedTools: () => stub.tools,
      settings: () => Promise.resolve(SETTINGS)
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(stub.executed).toEqual([]);
  });

  // A deployment with no transport is not a channel's mistake to be silent
  // about: the sheet asked for tools and got the shape that still answers.
  it("falls back to the single call when no client was composed", async () => {
    const surface = poster();
    const { fire } = fireWith({
      completion: model("Nothing moved.").completion,
      post: surface.post,
      settings: () => Promise.resolve(WITH_TOOLS)
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(surface.sent).toHaveLength(1);
  });

  // Over budget is asked before anything, whichever shape would have run — so an
  // opted-in channel at its cap spends nothing on tools either.
  it("spends nothing on tools when it is over budget", async () => {
    const surface = poster();
    const stub = client();
    const { fire } = fireWith({
      completion: looks("unreachable"),
      post: surface.post,
      firedTools: () => stub.tools,
      settings: () => Promise.resolve(WITH_TOOLS),
      maySpend: () => Promise.resolve(false)
    });

    await fire(CHANNEL, store, RULE, DUE_AT);

    expect(stub.executed).toEqual([]);
    expect(surface.sent).toHaveLength(1);
    expect(surface.sent[0]?.text).toContain("spent its daily budget");
  });
});
