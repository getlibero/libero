import { describe, expect, it } from "vitest";
import { serializeScheduledTask } from "@getlibero/schema";
import type { LogFields } from "@getlibero/gateway";
import type { MessageStore, StoredScheduledTask } from "@getlibero/memory";
import { createScheduledTaskSink } from "./scheduled.js";

const CHANNEL = "C0ENGINEERING";

const TICKET = serializeScheduledTask({
  id: "e3f1a2b4-0c5d-4e6f-8a90-1b2c3d4e5f60",
  task: "task-7",
  prompt: "check whether the release branch is still red",
  dueAt: "2026-08-19T10:30:00Z",
  createdAt: "2026-08-19T09:00:00Z"
});

/** Just the one method this touches, plus what it was handed. */
function fakeStore(scheduleTask?: (task: StoredScheduledTask) => void): {
  store: MessageStore;
  written: StoredScheduledTask[];
} {
  const written: StoredScheduledTask[] = [];
  const store = {
    scheduleTask: (task: StoredScheduledTask) => {
      written.push(task);
      scheduleTask?.(task);
    }
  } as unknown as MessageStore;
  return { store, written };
}

describe("recording a served create", () => {
  it("writes the ticket the proxy minted", () => {
    const { store, written } = fakeStore();
    const sink = createScheduledTaskSink({ store, channel: CHANNEL });

    expect(sink(TICKET)).toBe(true);
    expect(written).toEqual([
      {
        id: "e3f1a2b4-0c5d-4e6f-8a90-1b2c3d4e5f60",
        task: "task-7",
        prompt: "check whether the release branch is still red",
        dueAt: Date.UTC(2026, 7, 19, 10, 30, 0),
        createdAt: Date.UTC(2026, 7, 19, 9, 0, 0)
      }
    ]);
  });

  // The wire carries an instant a person can read and the column holds
  // milliseconds, which is `skill.ts`'s split. This is the only conversion, so a
  // slip here is a check that fires at the wrong time.
  it("converts the instant to the millisecond it names", () => {
    const { store, written } = fakeStore();
    createScheduledTaskSink({ store, channel: CHANNEL })(TICKET);

    expect(written[0]?.dueAt).toBe(1_787_135_400_000);
    expect(new Date(written[0]?.dueAt ?? 0).toISOString()).toBe("2026-08-19T10:30:00.000Z");
  });

  // Two halves of a deployment that do not agree about a shape. It cannot be
  // refused retroactively — the call ran and was audited — so the answer is
  // `false` and the model is told the check will not run.
  it("answers false for a confirmation it could not parse", () => {
    const { store, written } = fakeStore();
    const sink = createScheduledTaskSink({ store, channel: CHANNEL });

    expect(sink("not json")).toBe(false);
    expect(sink(JSON.stringify({ id: "x" }))).toBe(false);
    expect(written).toEqual([]);
  });

  // Never throws: it is called from inside the tool client, on the path that
  // answers the model, so a rejection would end a task over a confirmation.
  it("answers false rather than throwing when the store rejects the write", () => {
    const { store } = fakeStore(() => {
      throw new Error("SQLITE_FULL");
    });
    const sink = createScheduledTaskSink({ store, channel: CHANNEL });

    expect(() => sink(TICKET)).not.toThrow();
    expect(sink(TICKET)).toBe(false);
  });

  // A reason code and never the ticket's text. The prompt is model-authored and
  // this line is read by an operator debugging two builds, not by a channel.
  it("logs a reason and no model-authored text", () => {
    const lines: LogFields[] = [];
    const { store } = fakeStore();
    const sink = createScheduledTaskSink({
      store,
      channel: CHANNEL,
      logger: { log: (_level, fields) => void lines.push(fields) }
    });

    sink(JSON.stringify({ id: "x" }));
    sink(TICKET);

    expect(lines.map(line => line.event)).toEqual([
      "scheduled_task_unrecorded",
      "scheduled_task_recorded"
    ]);
    expect(lines[0]?.reason).toBe("schema_invalid");
    expect(JSON.stringify(lines)).not.toContain("release branch");
  });
});
