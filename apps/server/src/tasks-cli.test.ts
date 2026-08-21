// The operator CLI, against a real store.
//
// `apps/proxy-server/src/budget-cli.test.ts`'s shape: argv, env and both writers
// are injected, so what is under test is the command rather than a process. The
// store is real because a cancel is a delete and this is the only place that
// verb has a caller — a fake would prove the CLI agrees with itself.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { openMessageStore } from "@getlibero/memory";
import type { MessageStore } from "@getlibero/memory";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runTasksCommand } from "./tasks-cli.js";

const CHANNEL = "C0ENGINEERING";
const DUE = Date.UTC(2026, 7, 19, 9, 30, 0);

let root: string;
/** When this suite's cancels happen, stated rather than read (#349). */
const NOW = Date.UTC(2026, 7, 19, 8, 0, 0);

let store: MessageStore;

function schedule(id: string, prompt = "check the release branch", dueAt = DUE): void {
  store.scheduleTask({ id, task: "task-7", prompt, dueAt, createdAt: DUE - 600_000 });
}

function run(...argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runTasksCommand({
    argv,
    env: { AGENT_STORE_ROOT: root },
    out: line => out.push(line),
    err: line => err.push(line),
    now: () => NOW,
    // The one store this suite opened, so a cancel is visible to the assertions
    // without the CLI and the test racing two handles on one file — with `close`
    // stubbed out, because the command owns the handle it opens and closes it in
    // a `finally`, which is right in production and would shut this suite's
    // handle after the first case.
    open: () => ({ ...store, close: () => {} })
  });
  return { code, out, err };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-tasks-"));
  mkdirSync(join(root, CHANNEL));
  store = openMessageStore({ channel: CHANNEL, root });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("list", () => {
  it("prints one line per waiting check, earliest first", () => {
    schedule("t2", "check the deploy", DUE + 60_000);
    schedule("t1", "check the certs", DUE);

    const { code, out } = run("list", CHANNEL);

    expect(code).toBe(EXIT_OK);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("t1");
    expect(out[0]).toContain("2026-08-19 09:30:00Z");
    expect(out[0]).toContain("check the certs");
    expect(out[1]).toContain("t2");
  });

  // The id has to be copy-pasteable into a `cancel`, which is why this is
  // tab-separated rather than an aligned table.
  it("puts the id first, separated by tabs", () => {
    schedule("t1");

    expect(run("list", CHANNEL).out[0]?.split("\t")[0]).toBe("t1");
  });

  // One check is one line, so the output stays greppable — a prompt written
  // across several lines must not become several rows.
  it("flattens a prompt written over several lines", () => {
    schedule("t1", "check the release branch\nand say if it is still red");

    const { out } = run("list", CHANNEL);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("check the release branch and say if it is still red");
  });

  it("says so when a channel is waiting on nothing", () => {
    const { code, out } = run("list", CHANNEL);

    expect(code).toBe(EXIT_OK);
    expect(out).toEqual([`no scheduled checks waiting in ${CHANNEL}`]);
  });

  it("does not list a check that has already run", () => {
    schedule("t1");
    store.markScheduledTaskFired("t1", DUE, "posted");

    expect(run("list", CHANNEL).out).toEqual([`no scheduled checks waiting in ${CHANNEL}`]);
  });
});

describe("cancel", () => {
  it("forgets a waiting check, and the check stops being due", () => {
    schedule("t1");

    const { code, out } = run("cancel", CHANNEL, "t1");

    expect(code).toBe(EXIT_OK);
    expect(out).toEqual(["cancelled t1"]);
    expect(store.nextScheduledTaskDueAt()).toBeNull();
  });

  // Frees the slot by the same act, which is what makes cancelling the answer to
  // a channel at its pending cap.
  it("frees the slot it was holding", () => {
    schedule("t1");
    schedule("t2");

    run("cancel", CHANNEL, "t1");

    expect(store.listScheduledTasks(10).map(task => task.id)).toEqual(["t2"]);
  });

  it("fails rather than pretending, for an id it did not cancel", () => {
    schedule("t1");
    store.markScheduledTaskFired("t1", DUE, "posted");

    for (const id of ["t1", "nosuch"]) {
      const { code, err } = run("cancel", CHANNEL, id);
      expect(code).toBe(EXIT_ERROR);
      expect(err[0]).toContain("no waiting check");
    }
  });

  it("needs an id", () => {
    expect(run("cancel", CHANNEL).code).toBe(EXIT_USAGE);
  });

  // The record the delete leaves (#349): the check a cancel calls off is one a
  // human approved, and undoing that with nothing left behind was a hole in
  // the account of what happened.
  it("leaves a record the cancelled command prints", () => {
    schedule("t1", "check the certs");

    run("cancel", CHANNEL, "t1");
    const { code, out } = run("cancelled", CHANNEL);

    expect(code).toBe(EXIT_OK);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("t1");
    expect(out[0]).toContain("2026-08-19 08:00:00Z");
    expect(out[0]).toContain("was due 2026-08-19 09:30:00Z");
    expect(out[0]).toContain("check the certs");
  });
});

describe("cancelled", () => {
  it("prints newest first, id first, tab-separated", () => {
    schedule("t1");
    schedule("t2");
    store.cancelScheduledTask("t1", NOW - 1_000);
    store.cancelScheduledTask("t2", NOW);

    const { out } = run("cancelled", CHANNEL);

    expect(out.map(line => line.split("\t")[0])).toEqual(["t2", "t1"]);
  });

  it("says so when nothing was ever called off", () => {
    const { code, out } = run("cancelled", CHANNEL);

    expect(code).toBe(EXIT_OK);
    expect(out).toEqual([`no cancelled checks recorded in ${CHANNEL}`]);
  });
});

describe("what it refuses", () => {
  // The id becomes a path segment and this one comes off a command line, which
  // is the case `openMessageReader`'s own check exists for.
  each(["../../etc", ".", "has/slash", ""])("refuses %s as a channel id", channel => {
    expect(run("list", channel).code).toBe(EXIT_USAGE);
  });

  each([[[]], [["list"]], [["wat", CHANNEL]], [["list", CHANNEL, "extra", "more"]]])(
    "prints usage for %s",
    argv => {
      const { code, err } = run(...argv);
      expect(code).toBe(EXIT_USAGE);
      expect(err.join("\n")).toContain("usage: tasks");
    }
  );

  it("says so when AGENT_STORE_ROOT is not set", () => {
    const err: string[] = [];
    const code = runTasksCommand({
      argv: ["list", CHANNEL],
      env: {},
      out: () => {},
      err: line => err.push(line),
      open: () => ({ ...store, close: () => {} })
    });

    expect(code).toBe(EXIT_ERROR);
    expect(err[0]).toContain("AGENT_STORE_ROOT");
  });

  // "No such channel" and "nothing scheduled" are different answers, and a
  // channel with no directory is the first rather than an empty listing.
  it("says so when the channel has no store", () => {
    const err: string[] = [];
    const code = runTasksCommand({
      argv: ["list", "C0NOSUCH"],
      env: { AGENT_STORE_ROOT: root },
      out: () => {},
      err: line => err.push(line)
    });

    expect(code).toBe(EXIT_ERROR);
    expect(err[0]).toContain("no store for C0NOSUCH");
  });
});

// No colour, ever: the audit CLI's rule, and there is no status here for one to
// mean anyway.
describe("the output", () => {
  it("emits no ANSI escapes", () => {
    schedule("t1");

    expect(run("list", CHANNEL).out.join("\n")).not.toMatch(/\u001b\[/);
  });
});
