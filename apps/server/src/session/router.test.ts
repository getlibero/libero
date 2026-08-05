// The three things #65 claims: mentions in one channel queue rather than
// interleave, channels do not block each other, and each channel's task runs on
// its own sheet's model and caps.
//
// The task is faked here. What a real task does with settings is task.test.ts;
// what a sheet resolves to is sheet.test.ts. This file is about what happens
// between them.

import { DEFAULT_AGENT_LOOP_CAPS } from "@getlibero/agent";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { createChannelRouter } from "./router.js";
import type { SheetResolver } from "./sheet.js";
import type { TaskReply, TaskRequest, TaskSettings } from "./types.js";

const SETTINGS: TaskSettings = { model: "test-model", caps: { ...DEFAULT_AGENT_LOOP_CAPS } };

/** Every channel resolves to the same settings unless a test says otherwise. */
const anySheet: SheetResolver = () => Promise.resolve(SETTINGS);

function request(partial: Partial<TaskRequest> = {}): TaskRequest {
  return {
    key: { workspace: "T024BE7LD", channel: "C024BE91L" },
    requestingUser: "U024BE7LH",
    text: "<@U0BOT> ping",
    traceId: "Ev0PV52K25",
    ...partial
  };
}

function capturingLogger(): { lines: Array<{ level: LogLevel } & LogFields>; logger: Logger } {
  const lines: Array<{ level: LogLevel } & LogFields> = [];
  return { lines, logger: { log: (level, fields) => lines.push({ level, ...fields }) } };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => Promise.resolve().then(() => {});

describe("two mentions in one channel", () => {
  it("queues the second behind the first rather than interleaving", async () => {
    // There is no session state to write yet — the message store is #63 and the
    // assembled context is #67 — so the shared counter stands in for one. The
    // await between the read and the write is the point: interleaved runs lose
    // an increment, serialized ones do not.
    const shared = { value: 0 };
    const route = createChannelRouter({
      sheets: anySheet,
      task: async (): Promise<TaskReply> => {
        const seen = shared.value;
        await flush();
        shared.value = seen + 1;
        return { text: "ok" };
      }
    });

    await Promise.all([route(request()), route(request())]);

    expect(shared.value).toBe(2);
  });

  it("never has two of a channel's tasks in flight at once", async () => {
    let running = 0;
    let maxRunning = 0;
    const route = createChannelRouter({
      sheets: anySheet,
      task: async (): Promise<TaskReply> => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await flush();
        running -= 1;
        return { text: "ok" };
      }
    });

    await Promise.all([request(), request(), request()].map(route));

    expect(maxRunning).toBe(1);
  });

  it("runs a channel's mentions in the order they arrived", async () => {
    const seen: string[] = [];
    const route = createChannelRouter({
      sheets: anySheet,
      task: async (task): Promise<TaskReply> => {
        await flush();
        seen.push(task.traceId);
        return { text: "ok" };
      }
    });

    await Promise.all(
      ["Ev1", "Ev2", "Ev3"].map(traceId => route(request({ traceId })))
    );

    expect(seen).toEqual(["Ev1", "Ev2", "Ev3"]);
  });

  it("does not wedge a channel when a task throws", async () => {
    // The gateway logs a throwing handler and posts nothing. What must not
    // happen is the channel never answering again.
    let calls = 0;
    const route = createChannelRouter({
      sheets: anySheet,
      task: (): Promise<TaskReply> => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("connect ECONNREFUSED"))
          : Promise.resolve({ text: "ok" });
      }
    });

    const failed = route(request());
    const after = route(request());

    await expect(failed).rejects.toThrow(/ECONNREFUSED/);
    await expect(after).resolves.toEqual({ text: "ok" });
  });

  it("logs the wait, and only when there was one", async () => {
    const captured = capturingLogger();
    const gate = deferred();
    let first = true;
    const route = createChannelRouter({
      sheets: anySheet,
      logger: captured.logger,
      task: async (): Promise<TaskReply> => {
        if (first) {
          first = false;
          await gate.promise;
        }
        return { text: "ok" };
      }
    });

    const held = route(request({ traceId: "Ev1" }));
    await flush();
    const queued = route(request({ traceId: "Ev2" }));
    gate.resolve();
    await Promise.all([held, queued]);

    const lines = captured.lines.filter(entry => entry.event === "queued");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", channel: "C024BE91L", eventId: "Ev2" });
    expect(typeof lines[0]?.queuedMs).toBe("number");
  });
});

describe("two channels", () => {
  it("does not let a slow task in one channel delay another", async () => {
    const gate = deferred();
    const route = createChannelRouter({
      sheets: anySheet,
      task: async (task): Promise<TaskReply> => {
        if (task.key.channel === "C024BE91L") await gate.promise;
        return { text: task.key.channel };
      }
    });

    const slow = route(request());
    const other = route(request({ key: { workspace: "T024BE7LD", channel: "C0OTHER11" } }));

    // Resolves while the first channel is still blocked, which is the claim.
    await expect(other).resolves.toEqual({ text: "C0OTHER11" });

    gate.resolve();
    await expect(slow).resolves.toEqual({ text: "C024BE91L" });
  });

  it("does not let the same channel id in two workspaces share a queue", async () => {
    const gate = deferred();
    const route = createChannelRouter({
      sheets: anySheet,
      task: async (task): Promise<TaskReply> => {
        if (task.key.workspace === "T024BE7LD") await gate.promise;
        return { text: task.key.workspace };
      }
    });

    const slow = route(request());
    const other = route(request({ key: { workspace: "T0OTHER99", channel: "C024BE91L" } }));

    await expect(other).resolves.toEqual({ text: "T0OTHER99" });

    gate.resolve();
    await slow;
  });

  it("runs each channel's task on that channel's own settings", async () => {
    const settingsFor: Record<string, TaskSettings> = {
      C024BE91L: { model: "sheet-model", caps: { ...DEFAULT_AGENT_LOOP_CAPS, maxToolCalls: 3 } },
      C0OTHER11: { model: "other-model", caps: { ...DEFAULT_AGENT_LOOP_CAPS, maxToolCalls: 9 } }
    };
    const seen: Array<[string, TaskSettings]> = [];

    const route = createChannelRouter({
      sheets: channel => Promise.resolve(settingsFor[channel] ?? SETTINGS),
      task: (task, settings): Promise<TaskReply> => {
        seen.push([task.key.channel, settings]);
        return Promise.resolve({ text: "ok" });
      }
    });

    await Promise.all([
      route(request()),
      route(request({ key: { workspace: "T024BE7LD", channel: "C0OTHER11" } }))
    ]);

    expect(seen).toContainEqual(["C024BE91L", settingsFor.C024BE91L]);
    expect(seen).toContainEqual(["C0OTHER11", settingsFor.C0OTHER11]);
  });
});

describe("the sheet a task runs on", () => {
  it("is resolved inside the lock, once per task", async () => {
    // Inside the lock is what makes an operator's edit land between two tasks
    // rather than half way through one.
    const resolvedDuring: number[] = [];
    let running = 0;

    const route = createChannelRouter({
      sheets: () => {
        resolvedDuring.push(running);
        return Promise.resolve(SETTINGS);
      },
      task: async (): Promise<TaskReply> => {
        running += 1;
        await flush();
        running -= 1;
        return { text: "ok" };
      }
    });

    await Promise.all([route(request()), route(request())]);

    // Never resolved while another task in the same channel was running.
    expect(resolvedDuring).toEqual([0, 0]);
  });

  it("is resolved again for the next task", async () => {
    let calls = 0;
    const route = createChannelRouter({
      sheets: () => {
        calls += 1;
        return Promise.resolve(SETTINGS);
      },
      task: () => Promise.resolve({ text: "ok" })
    });

    await route(request());
    await route(request());

    expect(calls).toBe(2);
  });
});

describe("what the router passes through", () => {
  it("posts nothing when the task returns nothing", async () => {
    const route = createChannelRouter({
      sheets: anySheet,
      task: () => Promise.resolve(undefined)
    });

    await expect(route(request())).resolves.toBeUndefined();
  });

  it("hands the task the request it was given, unchanged", async () => {
    let seen: TaskRequest | undefined;
    const route = createChannelRouter({
      sheets: anySheet,
      task: (task): Promise<TaskReply> => {
        seen = task;
        return Promise.resolve({ text: "ok" });
      }
    });

    const sent = request();
    await route(sent);

    expect(seen).toEqual(sent);
  });
});
