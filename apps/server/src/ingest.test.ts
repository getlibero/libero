// The store is faked at the MessageStore seam rather than opened, because what
// this file decides is the mapping and the mutex, not SQLite. store.test.ts
// drives a real file; message-intake.test.ts drives the whole path.

import type { LogFields, LogLevel, Logger, SlackMessage } from "@getlibero/gateway";
import type { MessageStore, StoredMessage } from "@getlibero/memory";
import { describe, expect, it } from "vitest";
import { createMessageIngest } from "./ingest.js";
import { createSessionRegistry } from "./session/registry.js";

const MESSAGE: SlackMessage = {
  teamId: "T024BE7LD",
  channelId: "C024BE91L",
  userId: "U0ALICE",
  text: "the deploy went out at four",
  ts: "1717171717.000300",
  threadTs: null,
  eventId: "Ev0MESSAGE"
};

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

  it("leaves the display name unresolved", async () => {
    // A snapshot of the author's name, and nothing here has one: resolving a
    // user id is a Slack API call with a cache in front of it, which is #67's.
    const recorded = recordingStore();
    const sessions = createSessionRegistry({ openStore: () => recorded.store });

    await createMessageIngest({ sessions })(MESSAGE);

    expect(recorded.appended[0]?.displayName).toBeNull();
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
