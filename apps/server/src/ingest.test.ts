// The store is faked at the MessageStore seam rather than opened, because what
// this file decides is the mapping and the mutex, not SQLite. store.test.ts
// drives a real file; message-intake.test.ts drives the whole path.

import type {
  LogFields,
  LogLevel,
  Logger,
  SlackMessage,
  SlackRevision
} from "@getlibero/gateway";
import type { MessageStore, StoredMessage } from "@getlibero/memory";
import { describe, expect, it } from "vitest";
import { createMessageIngest, createRevisionIngest } from "./ingest.js";
import { createSessionRegistry } from "./session/registry.js";
import type { SessionRegistry } from "./session/registry.js";
import type { ChannelRouter } from "./session/router.js";
import type { TaskReply, TaskRequest } from "./session/types.js";

const MESSAGE: SlackMessage = {
  teamId: "T024BE7LD",
  channelId: "C024BE91L",
  userId: "U0ALICE",
  text: "the deploy went out at four",
  ts: "1717171717.000300",
  threadTs: null,
  eventId: "Ev0MESSAGE",
  mentionsApp: false
};

/** The same message, in a thread. What a follow-up looks like on the wire. */
function inThread(partial: Partial<SlackMessage> = {}): SlackMessage {
  return { ...MESSAGE, threadTs: "1717171717.000100", ...partial };
}

/** A store that records what it was asked to append, and nothing else. */
function recordingStore(append: (message: StoredMessage) => boolean = () => true): {
  store: MessageStore;
  appended: StoredMessage[];
  closes: () => number;
} {
  const appended: StoredMessage[] = [];
  let closed = 0;
  return {
    appended,
    closes: () => closed,
    store: {
      append: message => {
        appended.push(message);
        return append(message);
      },
      remove: () => false,
      replaceText: () => false,
      search: () => [],
      recent: () => [],
      recentInThread: () => [],
      // Inert, like `remove` and `search` above: ingestion writes messages and
      // never touches Layer 3, so these exist to satisfy `MessageStore` rather
      // than to be called.
      putEmbedding: () => {},
      nearest: () => [],
      removeEmbedding: () => false,
      putThreadSummary: () => {},
      idleThreads: () => [],
    staleThreads: () => [],
      listSkills: () => [],
      reconcileSkills: () => ({ indexed: 0, dropped: 0, invalidated: 0 }),
      searchSkills: () => [],
      recordSkillUse: () => {},
      skillsNeedingEmbedding: () => [],
      summariesNeedingEmbedding: () => [],
      embeddingModel: () => null,
      dropEmbeddings: () => null,
      skillClocks: () => [],
      adoptSkillStatus: () => {},
      recordSkillStatus: () => {},
      skillMergeCandidate: () => null,
      recordSkillMergeConsidered: () => {},
      orphanedSkillMergeProposals: () => [],
      forgetSkillMergeProposal: () => {},
      skillMergeNoticed: () => false,
      recordSkillMergeNotice: () => {},
      scheduleTask: () => {},
      nextScheduledTaskDueAt: () => null,
      dueScheduledTasks: () => [],
      markScheduledTaskFired: () => {},
      listScheduledTasks: () => [],
      cancelScheduledTask: () => false,
        listCancelledScheduledTasks: () => [],
      readThreadSummary: () => null,
      close: () => {
        closed += 1;
      }
    }
  };
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

describe("createMessageIngest", () => {
  it("stores the message's fields, mapped one for one", async () => {
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const ingest = createMessageIngest({ sessions, now: () => 1_749_998_700_123 });

    await ingest(MESSAGE);

    expect(recorded.appended).toEqual([
      {
        ts: "1717171717.000300",
        threadTs: null,
        userId: "U0ALICE",
        displayName: null,
        text: "the deploy went out at four",
        at: 1_749_998_700_123
      }
    ]);
  });

  it("stores the parent thread's ts for a reply and null for a top-level message", async () => {
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const ingest = createMessageIngest({ sessions });

    await ingest(MESSAGE);
    await ingest({ ...MESSAGE, ts: "1717171717.000400", threadTs: "1717171717.000300" });

    expect(recorded.appended.map(message => message.threadTs)).toEqual([
      null,
      "1717171717.000300"
    ]);
  });

  it("records when the store learned of the message, not when it was sent", async () => {
    // `at` and `ts` are different clocks and the field's own doc says so. A
    // backfill would put a row's `at` far from its `ts`, and conflating them
    // would make that unrecoverable.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const ingest = createMessageIngest({ sessions, now: () => 9_999 });

    await ingest(MESSAGE);

    expect(recorded.appended[0]?.at).toBe(9_999);
    expect(recorded.appended[0]?.ts).toBe("1717171717.000300");
  });

  it("stores the author's name as a snapshot", async () => {
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });

    await createMessageIngest({
      sessions,
      names: userId => Promise.resolve(userId === "U0ALICE" ? "alice" : undefined)
    })(MESSAGE);

    expect(recorded.appended[0]?.displayName).toBe("alice");
  });

  it("leaves the name null when no directory was composed", async () => {
    // A front-end with nowhere to ask. The row is still stored — the snapshot
    // is worth having and not worth a message.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });

    await createMessageIngest({ sessions })(MESSAGE);

    expect(recorded.appended[0]?.displayName).toBeNull();
  });

  it("stores the message when the lookup finds nobody", async () => {
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });

    await createMessageIngest({ sessions, names: () => Promise.resolve(undefined) })(MESSAGE);

    expect(recorded.appended).toHaveLength(1);
    expect(recorded.appended[0]?.displayName).toBeNull();
  });

  it("stores the message when the lookup throws", async () => {
    // The new failure mode on a path that could not fail before. Attribution is
    // worth a round trip and never a message.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });

    await expect(
      createMessageIngest({ sessions, names: () => Promise.reject(new Error("rate limited")) })(
        MESSAGE
      )
    ).resolves.toBeUndefined();

    expect(recorded.appended).toHaveLength(1);
    expect(recorded.appended[0]?.displayName).toBeNull();
  });

  it("resolves a name once per author per session, not once per message", async () => {
    // The acceptance criterion, on the write path. A busy channel is one author
    // saying many things, and a lookup per message is a rate limit waiting to
    // happen.
    const asked: string[] = [];
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const ingest = createMessageIngest({
      sessions,
      names: userId => {
        asked.push(userId);
        return Promise.resolve("alice");
      }
    });

    await ingest(MESSAGE);
    await ingest({ ...MESSAGE, ts: "1717171717.000400" });
    await ingest({ ...MESSAGE, ts: "1717171717.000500", userId: "U0BOB" });

    expect(asked).toEqual(["U0ALICE", "U0BOB"]);
  });

  it("shares one in-flight lookup between messages that arrive together", async () => {
    // Ingest does not take the session mutex, so two messages from one new
    // author really do run concurrently. A cache of settled values would have
    // both miss.
    const asked: string[] = [];
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const ingest = createMessageIngest({
      sessions,
      names: async userId => {
        asked.push(userId);
        await gate;
        return "alice";
      }
    });

    const both = Promise.all([ingest(MESSAGE), ingest({ ...MESSAGE, ts: "1717171717.000400" })]);
    release();
    await both;

    expect(asked).toEqual(["U0ALICE"]);
    expect(recorded.appended.map(message => message.displayName)).toEqual(["alice", "alice"]);
  });

  it("does not look anybody up for a channel with no store", async () => {
    // Checked before the name is resolved, so an unprovisioned channel — which
    // is most of a workspace — costs no Slack calls at all.
    const asked: string[] = [];
    const sessions = createSessionRegistry({ openStore: () => null });

    await createMessageIngest({
      sessions,
      names: userId => {
        asked.push(userId);
        return Promise.resolve("alice");
      }
    })(MESSAGE);

    expect(asked).toEqual([]);
  });

  it("stores a message in a channel with no session yet", async () => {
    // Ingest is not request-scoped: the acceptance criterion is that a quiet
    // channel's messages are still recorded, and a session is created for them.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });

    expect(sessions.size).toBe(0);
    await createMessageIngest({ sessions })(MESSAGE);

    expect(sessions.size).toBe(1);
    expect(recorded.appended).toHaveLength(1);
  });

  it("does not queue behind a running task in the same channel", async () => {
    // The decision this file exists to hold. The mutex serializes model turns; a
    // store write is one synchronous statement with nothing to serialize.
    // Behind the mutex, a message arriving mid-task would wait out a whole model
    // turn — up to the channel's wall-clock cap — to be filed.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const ingest = createMessageIngest({ sessions });

    let release = (): void => {};
    const held = sessions
      .open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId })
      .mutex.run(() => new Promise<void>(resolve => (release = resolve)));

    await ingest(MESSAGE);
    expect(recorded.appended).toHaveLength(1);

    release();
    await held;
  });

  it("takes no lock, so it leaves the queue exactly as it found it", async () => {
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const session = sessions.open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId });

    await createMessageIngest({ sessions })(MESSAGE);

    expect(session.mutex.pending).toBe(0);
  });

  it("keeps a session warm rather than reopening the file per message", async () => {
    let opens = 0;
    const recorded = recordingStore();
    const sessions = createSessionRegistry({
      openStore: () => {
        opens += 1;
        return recorded.store;
      }
    });
    const ingest = createMessageIngest({ sessions });

    await ingest(MESSAGE);
    await ingest({ ...MESSAGE, ts: "1717171717.000400" });
    await ingest({ ...MESSAGE, ts: "1717171717.000500" });

    expect(opens).toBe(1);
    expect(recorded.appended).toHaveLength(3);
  });

  it("does nothing, quietly, for a channel with no store", async () => {
    // The channel has no team sheet, or the file would not open. `store.ts` has
    // already said so once for this session; one line per message after that
    // would be a log that scales with the conversation.
    const captured = capturingLogger();
    const sessions = createSessionRegistry({ openStore: () => null });
    const ingest = createMessageIngest({ sessions, logger: captured.logger });

    await ingest(MESSAGE);
    await ingest({ ...MESSAGE, ts: "1717171717.000400" });

    expect(captured.lines.filter(line => line.event === "store_write_failed")).toEqual([]);
  });

  it("works with no store opener at all", async () => {
    // A front-end that composed no store still dispatches messages. It must not
    // be a crash.
    const sessions = createSessionRegistry();

    await expect(createMessageIngest({ sessions })(MESSAGE)).resolves.toBeUndefined();
  });

  it("does not treat a duplicate ts as a failure", async () => {
    // `append` returns false on a redelivery — the store's own idempotency, and
    // the authoritative one. Nothing here inspects it, and nothing should: it is
    // not an error, and there is nothing to do about it.
    const captured = capturingLogger();
    const recorded = recordingStore(() => false);
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const ingest = createMessageIngest({ sessions, logger: captured.logger });

    await expect(ingest(MESSAGE)).resolves.toBeUndefined();
    expect(captured.lines).toEqual([]);
  });

  it("loses one message and stays up when the store throws", async () => {
    const captured = capturingLogger();
    const sessions = createSessionRegistry({
      openStore: () => ({
        append: () => {
          throw new TypeError("disk went away");
        },
        remove: () => false,
        replaceText: () => false,
        search: () => [],
        recent: () => [],
        recentInThread: () => [],
        putEmbedding: () => {},
        nearest: () => [],
        removeEmbedding: () => false,
        putThreadSummary: () => {},
        idleThreads: () => [],
        staleThreads: () => [],
        listSkills: () => [],
        reconcileSkills: () => ({ indexed: 0, dropped: 0, invalidated: 0 }),
        searchSkills: () => [],
        recordSkillUse: () => {},
        skillsNeedingEmbedding: () => [],
        summariesNeedingEmbedding: () => [],
        embeddingModel: () => null,
        dropEmbeddings: () => null,
        skillClocks: () => [],
        adoptSkillStatus: () => {},
        recordSkillStatus: () => {},
        skillMergeCandidate: () => null,
        recordSkillMergeConsidered: () => {},
        orphanedSkillMergeProposals: () => [],
        forgetSkillMergeProposal: () => {},
        skillMergeNoticed: () => false,
        recordSkillMergeNotice: () => {},
        scheduleTask: () => {},
        nextScheduledTaskDueAt: () => null,
        dueScheduledTasks: () => [],
        markScheduledTaskFired: () => {},
        listScheduledTasks: () => [],
        cancelScheduledTask: () => false,
        listCancelledScheduledTasks: () => [],
        readThreadSummary: () => null,
        close: () => {}
      })
    });
    const ingest = createMessageIngest({ sessions, logger: captured.logger });

    await expect(ingest(MESSAGE)).resolves.toBeUndefined();

    expect(captured.lines).toEqual([
      {
        level: "error",
        event: "store_write_failed",
        channel: "C024BE91L",
        eventId: "Ev0MESSAGE",
        reason: "TypeError"
      }
    ]);
  });

  it("puts no message text in a failure line", async () => {
    // The rule at the top of the gateway's log.ts: a message belongs to the
    // members of its channel and stdout is not on that path.
    const captured = capturingLogger();
    const sessions = createSessionRegistry({
      openStore: () => ({
        append: () => {
          throw new Error("append failed on: the deploy went out at four");
        },
        remove: () => false,
        replaceText: () => false,
        search: () => [],
        recent: () => [],
        recentInThread: () => [],
        putEmbedding: () => {},
        nearest: () => [],
        removeEmbedding: () => false,
        putThreadSummary: () => {},
        idleThreads: () => [],
        staleThreads: () => [],
        listSkills: () => [],
        reconcileSkills: () => ({ indexed: 0, dropped: 0, invalidated: 0 }),
        searchSkills: () => [],
        recordSkillUse: () => {},
        skillsNeedingEmbedding: () => [],
        summariesNeedingEmbedding: () => [],
        embeddingModel: () => null,
        dropEmbeddings: () => null,
        skillClocks: () => [],
        adoptSkillStatus: () => {},
        recordSkillStatus: () => {},
        skillMergeCandidate: () => null,
        recordSkillMergeConsidered: () => {},
        orphanedSkillMergeProposals: () => [],
        forgetSkillMergeProposal: () => {},
        skillMergeNoticed: () => false,
        recordSkillMergeNotice: () => {},
        scheduleTask: () => {},
        nextScheduledTaskDueAt: () => null,
        dueScheduledTasks: () => [],
        markScheduledTaskFired: () => {},
        listScheduledTasks: () => [],
        cancelScheduledTask: () => false,
        listCancelledScheduledTasks: () => [],
        readThreadSummary: () => null,
        close: () => {}
      })
    });

    await createMessageIngest({ sessions, logger: captured.logger })(MESSAGE);

    expect(JSON.stringify(captured.lines)).not.toContain("the deploy went out at four");
  });

  it("gives two channels two stores and two sessions", async () => {
    const opened: string[] = [];
    const sessions = createSessionRegistry({
      openStore: channel => {
        opened.push(channel);
        return recordingStore().store;
      }
    });
    const ingest = createMessageIngest({ sessions });

    await ingest(MESSAGE);
    await ingest({ ...MESSAGE, channelId: "C0OTHER11" });

    expect(opened).toEqual(["C024BE91L", "C0OTHER11"]);
    expect(sessions.size).toBe(2);
  });
});

// The four passes that run on channel activity rather than on a mention: the
// quiescence sweep (#231), the skill-embedding pass (#305), the skill lifecycle
// job (#294) and the merge curator (#295). All are wired the same way and all
// are asserted the same way, because the wiring is the claim — each one's own
// behaviour is its own file's.
describe("the background passes", () => {
  /** Records which pass ran in which channel, in the order they ran. */
  function recordingPasses(): {
    ran: Array<[string, string]>;
    summarize: (channel: string, store: MessageStore) => Promise<number>;
    embedSkills: (channel: string, store: MessageStore) => Promise<number>;
    lifecycleSkills: (channel: string, store: MessageStore) => Promise<number>;
    curateSkills: (channel: string, store: MessageStore) => Promise<number>;
  } {
    const ran: Array<[string, string]> = [];
    return {
      ran,
      summarize: channel => {
        ran.push(["summarize", channel]);
        return Promise.resolve(0);
      },
      embedSkills: channel => {
        ran.push(["embedSkills", channel]);
        return Promise.resolve(0);
      },
      lifecycleSkills: channel => {
        ran.push(["lifecycleSkills", channel]);
        return Promise.resolve(0);
      },
      curateSkills: channel => {
        ran.push(["curateSkills", channel]);
        return Promise.resolve(0);
      }
    };
  }

  it("runs all four passes for a message it filed, in one order rather than a race", async () => {
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const passes = recordingPasses();
    const session = sessions.open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId });

    await createMessageIngest({
      sessions,
      summarize: passes.summarize,
      embedSkills: passes.embedSkills,
      lifecycleSkills: passes.lifecycleSkills,
      curateSkills: passes.curateSkills
    })(MESSAGE);

    // Queued behind both, which is how a test waits on work the handler
    // deliberately did not wait on. The mutex is FIFO, so the order is the order
    // they were queued in rather than whichever finished first.
    await session.mutex.run(() => Promise.resolve());

    expect(passes.ran).toEqual([
      ["summarize", MESSAGE.channelId],
      ["embedSkills", MESSAGE.channelId],
      ["lifecycleSkills", MESSAGE.channelId],
      ["curateSkills", MESSAGE.channelId]
    ]);
  });

  it("does not wait for any of them", async () => {
    // The handler resolves while the first is still running. A reply, and the
    // Slack acknowledgement behind it, must not sit behind a provider round trip
    // about some other thread or some other playbook.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });
    const session = sessions.open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId });
    let release = (): void => {};

    await createMessageIngest({
      sessions,
      summarize: () => new Promise<number>(resolve => (release = () => resolve(0))),
      embedSkills: () => Promise.resolve(0),
      lifecycleSkills: () => Promise.resolve(0),
      curateSkills: () => Promise.resolve(0)
    })(MESSAGE);

    // On the mutex — all four read and write the channel's file, so they
    // serialize against a task's context read rather than racing it.
    expect(session.mutex.pending).toBeGreaterThan(0);
    release();
  });

  it("runs none of them for a channel with no store", async () => {
    const sessions = createSessionRegistry({ openStore: () => null });
    const passes = recordingPasses();

    await createMessageIngest({
      sessions,
      summarize: passes.summarize,
      embedSkills: passes.embedSkills,
      lifecycleSkills: passes.lifecycleSkills,
      curateSkills: passes.curateSkills
    })(MESSAGE);

    expect(passes.ran).toEqual([]);
  });

  it("stays up when a pass rejects, which it is documented never to do", async () => {
    // Defence rather than a path: all four are documented never to reject, and
    // this is the one place in the process where a broken promise would reach an
    // unhandled rejection with no task to attribute it to.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });

    await expect(
      createMessageIngest({
        sessions,
        summarize: () => Promise.reject(new Error("sweep is broken")),
        embedSkills: () => Promise.reject(new Error("pass is broken")),
        lifecycleSkills: () => Promise.reject(new Error("job is broken")),
        curateSkills: () => Promise.reject(new Error("curator is broken"))
      })(MESSAGE)
    ).resolves.toBeUndefined();

    expect(recorded.appended).toHaveLength(1);
  });
});

describe("answering a follow-up", () => {
  const THREAD = "1717171717.000100";
  const NOW = 1_700_000_000_000;

  /** A registry whose one session has `THREAD` active, unless told otherwise. */
  function activeSessions(window = 60_000): SessionRegistry {
    const sessions = createSessionRegistry({ now: () => NOW });
    sessions
      .open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId })
      .threads.activate(THREAD, NOW, window);
    return sessions;
  }

  /** Captures what the router was handed, and answers with whatever it was given. */
  function recordingRouter(reply: TaskReply | undefined = { text: "reverted" }): {
    seen: TaskRequest[];
    route: ChannelRouter;
  } {
    const seen: TaskRequest[] = [];
    return {
      seen,
      route: request => {
        seen.push(request);
        return Promise.resolve(reply);
      }
    };
  }

  it("routes a reply in an active thread and answers with what came back", async () => {
    const router = recordingRouter();
    const ingest = createMessageIngest({
      sessions: activeSessions(),
      route: router.route,
      now: () => NOW
    });

    await expect(ingest(inThread())).resolves.toEqual({ text: "reverted" });
    expect(router.seen).toEqual([
      {
        key: { workspace: "T024BE7LD", channel: "C024BE91L" },
        requestingUser: "U0ALICE",
        thread: THREAD,
        text: "the deploy went out at four",
        traceId: "Ev0MESSAGE"
      }
    ]);
  });

  it("does not route a reply in a thread the agent is not working in", async () => {
    const router = recordingRouter();
    const ingest = createMessageIngest({
      sessions: activeSessions(),
      route: router.route,
      now: () => NOW
    });

    await expect(ingest(inThread({ threadTs: "1717171717.000900" }))).resolves.toBeUndefined();
    expect(router.seen).toEqual([]);
  });

  it("does not route once the window has passed", async () => {
    const router = recordingRouter();
    const ingest = createMessageIngest({
      sessions: activeSessions(60_000),
      route: router.route,
      now: () => NOW + 60_000
    });

    await expect(ingest(inThread())).resolves.toBeUndefined();
    expect(router.seen).toEqual([]);
  });

  it("does not route a top-level message", async () => {
    // Not a reply to anything the agent said, and with nowhere for an answer to
    // go — the gateway refuses to start a thread on one.
    const router = recordingRouter();
    const sessions = activeSessions();
    // Even with the message's own ts standing in as a thread that is active.
    sessions
      .open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId })
      .threads.activate(MESSAGE.ts, NOW, 60_000);
    const ingest = createMessageIngest({ sessions, route: router.route, now: () => NOW });

    await expect(ingest(MESSAGE)).resolves.toBeUndefined();
    expect(router.seen).toEqual([]);
  });

  it("does not route a message that mentions the app", async () => {
    // The `app_mention` copy of it is what gets answered. Routing this one too
    // would run the task twice for one question, and there is no id shared
    // between the two deliveries for anything downstream to notice.
    const router = recordingRouter();
    const ingest = createMessageIngest({
      sessions: activeSessions(),
      route: router.route,
      now: () => NOW
    });

    await expect(ingest(inThread({ mentionsApp: true }))).resolves.toBeUndefined();
    expect(router.seen).toEqual([]);
  });

  it("files the message whichever way the routing went", async () => {
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ now: () => NOW, openStore: () => recorded.store });
    sessions
      .open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId })
      .threads.activate(THREAD, NOW, 60_000);
    const ingest = createMessageIngest({
      sessions,
      route: recordingRouter().route,
      now: () => NOW
    });

    await ingest(inThread());
    await ingest(inThread({ ts: "1717171717.000500", threadTs: "1717171717.000900" }));

    expect(recorded.appended.map(entry => entry.ts)).toEqual([
      "1717171717.000300",
      "1717171717.000500"
    ]);
  });

  it("files the message before routing it", async () => {
    // So the transcript the task assembles already holds the thing it was asked
    // about, rather than being one message behind the conversation.
    const order: string[] = [];
    const sessions = createSessionRegistry({
      now: () => NOW,
      openStore: () => recordingStore(() => {
        order.push("append");
        return true;
      }).store
    });
    sessions
      .open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId })
      .threads.activate(THREAD, NOW, 60_000);
    const ingest = createMessageIngest({
      sessions,
      now: () => NOW,
      route: () => {
        order.push("route");
        return Promise.resolve({ text: "ok" });
      }
    });

    await ingest(inThread());

    expect(order).toEqual(["append", "route"]);
  });

  it("still answers a follow-up in a channel whose store would not open", async () => {
    // A storage failure must not turn into the agent going silent mid-thread.
    // The task simply runs with no history, which is what a first mention in
    // that channel already does.
    const router = recordingRouter();
    const sessions = createSessionRegistry({ now: () => NOW, openStore: () => null });
    sessions
      .open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId })
      .threads.activate(THREAD, NOW, 60_000);
    const ingest = createMessageIngest({ sessions, route: router.route, now: () => NOW });

    await expect(ingest(inThread())).resolves.toEqual({ text: "reverted" });
  });

  it("answers nothing when the task answered nothing", async () => {
    const ingest = createMessageIngest({
      sessions: activeSessions(),
      route: () => Promise.resolve(undefined),
      now: () => NOW
    });

    await expect(ingest(inThread())).resolves.toBeUndefined();
  });

  it("files the message and answers nothing when no router was composed", async () => {
    // The pre-#66 behaviour, and a real front-end rather than a broken wiring:
    // one that records a conversation without joining it.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ now: () => NOW, openStore: () => recorded.store });
    sessions
      .open({ workspace: MESSAGE.teamId, channel: MESSAGE.channelId })
      .threads.activate(THREAD, NOW, 60_000);

    await expect(createMessageIngest({ sessions, now: () => NOW })(inThread())).resolves.toBeUndefined();
    expect(recorded.appended).toHaveLength(1);
  });

  it("builds the held-call prompter on the follow-up's own thread", async () => {
    // A card raised by a follow-up's task belongs beside the follow-up, not in
    // whatever thread the mention that started this all was in.
    const targets: Array<{ channelId: string; threadTs: string }> = [];
    const router = recordingRouter();
    const ingest = createMessageIngest({
      sessions: activeSessions(),
      route: router.route,
      now: () => NOW,
      onHeld: target => {
        targets.push(target);
        return () => Promise.resolve();
      }
    });

    await ingest(inThread());

    expect(targets).toEqual([{ channelId: "C024BE91L", threadTs: THREAD }]);
    expect(router.seen[0]?.onHeld).toBeDefined();
  });
});

describe("createRevisionIngest", () => {
  const DELETION: SlackRevision = {
    kind: "deleted",
    teamId: "T024BE7LD",
    channelId: "C024BE91L",
    ts: "1717171717.000300",
    eventId: "Ev0REVISION"
  };

  const EDIT: SlackRevision = {
    kind: "edited",
    teamId: "T024BE7LD",
    channelId: "C024BE91L",
    ts: "1717171717.000300",
    text: "the deploy went out at five",
    eventId: "Ev0REVISION"
  };

  /** A store that records which operation it was asked for, and with what. */
  function mirroringStore(answer = true): {
    store: MessageStore;
    appended: StoredMessage[];
    removed: string[];
    replaced: Array<[string, string]>;
  } {
    const appended: StoredMessage[] = [];
    const removed: string[] = [];
    const replaced: Array<[string, string]> = [];
    return {
      appended,
      removed,
      replaced,
      store: {
        append: message => {
          appended.push(message);
          return true;
        },
        remove: ts => {
          removed.push(ts);
          return answer;
        },
        replaceText: (ts, text) => {
          replaced.push([ts, text]);
          return answer;
        },
        search: () => [],
        recent: () => [],
        recentInThread: () => [],
        putEmbedding: () => {},
        nearest: () => [],
        removeEmbedding: () => false,
        putThreadSummary: () => {},
        idleThreads: () => [],
        staleThreads: () => [],
        listSkills: () => [],
        reconcileSkills: () => ({ indexed: 0, dropped: 0, invalidated: 0 }),
        searchSkills: () => [],
        recordSkillUse: () => {},
        skillsNeedingEmbedding: () => [],
        summariesNeedingEmbedding: () => [],
        embeddingModel: () => null,
        dropEmbeddings: () => null,
        skillClocks: () => [],
        adoptSkillStatus: () => {},
        recordSkillStatus: () => {},
        skillMergeCandidate: () => null,
        recordSkillMergeConsidered: () => {},
        orphanedSkillMergeProposals: () => [],
        forgetSkillMergeProposal: () => {},
        skillMergeNoticed: () => false,
        recordSkillMergeNotice: () => {},
        scheduleTask: () => {},
        nextScheduledTaskDueAt: () => null,
        dueScheduledTasks: () => [],
        markScheduledTaskFired: () => {},
        listScheduledTasks: () => [],
        cancelScheduledTask: () => false,
        listCancelledScheduledTasks: () => [],
        readThreadSummary: () => null,
        close: () => {}
      }
    };
  }

  it("removes on a deletion and reindexes on an edit", async () => {
    const mirror = mirroringStore();
    const sessions = createSessionRegistry({ openStore: () => mirror.store });
    const ingest = createRevisionIngest({ sessions });

    await ingest(DELETION);
    await ingest(EDIT);

    expect(mirror.removed).toEqual(["1717171717.000300"]);
    expect(mirror.replaced).toEqual([["1717171717.000300", "the deploy went out at five"]]);
  });

  it("does not insert a message the store never held", async () => {
    // The decision #177 asked for. `replaceText` answering false is left alone:
    // the rows are what the message path agreed to record, and an insert here
    // would be a second write door with none of that path's filters.
    const captured = capturingLogger();
    const mirror = mirroringStore(false);
    const sessions = createSessionRegistry({ openStore: () => mirror.store });
    const ingest = createRevisionIngest({ sessions, logger: captured.logger });

    await expect(ingest(EDIT)).resolves.toBeUndefined();
    await expect(ingest(DELETION)).resolves.toBeUndefined();

    // The assertion that matters: neither revision reached `append`, so a false
    // answer stayed a no-op rather than becoming a row.
    expect(mirror.appended).toEqual([]);
    expect(captured.lines).toEqual([]);
  });

  it("does nothing, quietly, for a channel with no store", async () => {
    const captured = capturingLogger();
    const sessions = createSessionRegistry({ openStore: () => null });

    await expect(
      createRevisionIngest({ sessions, logger: captured.logger })(DELETION)
    ).resolves.toBeUndefined();
    expect(captured.lines).toEqual([]);
  });

  it("shares the session the append opened rather than a second handle", async () => {
    // One file per channel, and one handle on it. A revision that opened its own
    // would be a second connection writing where the first one is.
    let opens = 0;
    const mirror = mirroringStore();
    const sessions = createSessionRegistry({
      openStore: () => {
        opens += 1;
        return mirror.store;
      }
    });

    await createMessageIngest({ sessions })(MESSAGE);
    await createRevisionIngest({ sessions })(DELETION);

    expect(opens).toBe(1);
  });

  it("loses one revision and stays up when the store throws", async () => {
    const captured = capturingLogger();
    const sessions = createSessionRegistry({
      openStore: () => ({
        append: () => true,
        remove: () => {
          throw new TypeError("disk went away");
        },
        replaceText: () => false,
        search: () => [],
        recent: () => [],
        recentInThread: () => [],
        putEmbedding: () => {},
        nearest: () => [],
        removeEmbedding: () => false,
        putThreadSummary: () => {},
        idleThreads: () => [],
        staleThreads: () => [],
        listSkills: () => [],
        reconcileSkills: () => ({ indexed: 0, dropped: 0, invalidated: 0 }),
        searchSkills: () => [],
        recordSkillUse: () => {},
        skillsNeedingEmbedding: () => [],
        summariesNeedingEmbedding: () => [],
        embeddingModel: () => null,
        dropEmbeddings: () => null,
        skillClocks: () => [],
        adoptSkillStatus: () => {},
        recordSkillStatus: () => {},
        skillMergeCandidate: () => null,
        recordSkillMergeConsidered: () => {},
        orphanedSkillMergeProposals: () => [],
        forgetSkillMergeProposal: () => {},
        skillMergeNoticed: () => false,
        recordSkillMergeNotice: () => {},
        scheduleTask: () => {},
        nextScheduledTaskDueAt: () => null,
        dueScheduledTasks: () => [],
        markScheduledTaskFired: () => {},
        listScheduledTasks: () => [],
        cancelScheduledTask: () => false,
        listCancelledScheduledTasks: () => [],
        readThreadSummary: () => null,
        close: () => {}
      })
    });

    await expect(
      createRevisionIngest({ sessions, logger: captured.logger })(DELETION)
    ).resolves.toBeUndefined();

    expect(captured.lines).toEqual([
      {
        level: "error",
        event: "store_write_failed",
        channel: "C024BE91L",
        eventId: "Ev0REVISION",
        revision: "deleted",
        reason: "TypeError"
      }
    ]);
  });

  it("puts an edit's text in no log line", async () => {
    const captured = capturingLogger();
    const sessions = createSessionRegistry({
      openStore: () => ({
        append: () => true,
        remove: () => false,
        replaceText: () => {
          throw new Error("update failed on: the deploy went out at five");
        },
        search: () => [],
        recent: () => [],
        recentInThread: () => [],
        putEmbedding: () => {},
        nearest: () => [],
        removeEmbedding: () => false,
        putThreadSummary: () => {},
        idleThreads: () => [],
        staleThreads: () => [],
        listSkills: () => [],
        reconcileSkills: () => ({ indexed: 0, dropped: 0, invalidated: 0 }),
        searchSkills: () => [],
        recordSkillUse: () => {},
        skillsNeedingEmbedding: () => [],
        summariesNeedingEmbedding: () => [],
        embeddingModel: () => null,
        dropEmbeddings: () => null,
        skillClocks: () => [],
        adoptSkillStatus: () => {},
        recordSkillStatus: () => {},
        skillMergeCandidate: () => null,
        recordSkillMergeConsidered: () => {},
        orphanedSkillMergeProposals: () => [],
        forgetSkillMergeProposal: () => {},
        skillMergeNoticed: () => false,
        recordSkillMergeNotice: () => {},
        scheduleTask: () => {},
        nextScheduledTaskDueAt: () => null,
        dueScheduledTasks: () => [],
        markScheduledTaskFired: () => {},
        listScheduledTasks: () => [],
        cancelScheduledTask: () => false,
        listCancelledScheduledTasks: () => [],
        readThreadSummary: () => null,
        close: () => {}
      })
    });

    await createRevisionIngest({ sessions, logger: captured.logger })(EDIT);

    expect(JSON.stringify(captured.lines)).not.toContain("the deploy went out at five");
  });
});
