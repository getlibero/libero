import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  SCHEDULED_TASK_MAX_HORIZON_MINUTES,
  SCHEDULED_TASK_MAX_PENDING,
  SCHEDULED_TASK_MAX_PROMPT_CHARS,
  SCHEDULED_TASK_MIN_LEAD_MINUTES,
  SCHEDULE_TASK_INPUT_SCHEMA,
  ScheduleTaskArguments,
  ScheduledInstant,
  ScheduledTask,
  msFromScheduledInstant,
  parseScheduledTask,
  scheduledInstantFromMs,
  serializeScheduledTask
} from "./schedule-task.js";

const ticket: ScheduledTask = {
  id: "e3f1a2b4-0c5d-4e6f-8a90-1b2c3d4e5f60",
  task: "task-7",
  prompt: "Check whether the release branch is still red, and say so if it is.",
  dueAt: "2026-08-19T09:30:00Z",
  createdAt: "2026-08-19T08:00:00Z"
};

describe("the caps", () => {
  // A floor above its own roof is a tool with no legal input at all, which
  // parses, publishes, and refuses everything.
  it("leave a window a check can be scheduled in", () => {
    expect(SCHEDULED_TASK_MIN_LEAD_MINUTES).toBeLessThan(SCHEDULED_TASK_MAX_HORIZON_MINUTES);
    expect(SCHEDULED_TASK_MAX_PENDING).toBeGreaterThan(0);
  });
});

describe("the arguments", () => {
  it("takes a prompt and an offset", () => {
    const parsed = ScheduleTaskArguments.safeParse({ prompt: "check the deploy", due_in_minutes: 60 });
    expect(parsed.success).toBe(true);
  });

  // The whole of "no argument the model controls can widen this beyond the
  // calling channel", in executable form: there is no channel field, and an
  // unknown key is a rejection rather than a silently dropped one.
  each(["channel", "dueAt", "due_at", "id", "task"])("rejects %s as an unknown key", key => {
    const parsed = ScheduleTaskArguments.safeParse({
      prompt: "check the deploy",
      due_in_minutes: 60,
      [key]: "C0OTHER"
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty prompt and one over the cap", () => {
    expect(ScheduleTaskArguments.safeParse({ prompt: "", due_in_minutes: 60 }).success).toBe(false);
    expect(
      ScheduleTaskArguments.safeParse({
        prompt: "x".repeat(SCHEDULED_TASK_MAX_PROMPT_CHARS + 1),
        due_in_minutes: 60
      }).success
    ).toBe(false);
  });

  it("rejects an offset that is not a positive whole number of minutes", () => {
    for (const due_in_minutes of [0, -60, 1.5, "60"]) {
      expect(ScheduleTaskArguments.safeParse({ prompt: "check", due_in_minutes }).success).toBe(false);
    }
  });

  // The asymmetry the module's header argues for: the floor and the horizon are
  // governance, refused by the proxy with an audit row behind them, so the parser
  // must let them through or both refusals are unreachable and #322's acceptance
  // is untestable.
  it("admits an offset outside the floor and the horizon, which the gate refuses", () => {
    for (const due_in_minutes of [1, SCHEDULED_TASK_MAX_HORIZON_MINUTES + 1]) {
      expect(ScheduleTaskArguments.safeParse({ prompt: "check", due_in_minutes }).success).toBe(true);
    }
  });
});

describe("the published input schema", () => {
  // Two spellings of one contract. `builtins.test.ts` closes the same drift for
  // `search_channel_history`; this closes it here, where the two spellings
  // deliberately disagree about the offset's bounds and must agree about
  // everything else.
  it("states the bounds the parser leaves to the gate", () => {
    expect(SCHEDULE_TASK_INPUT_SCHEMA.properties.due_in_minutes.minimum).toBe(
      SCHEDULED_TASK_MIN_LEAD_MINUTES
    );
    expect(SCHEDULE_TASK_INPUT_SCHEMA.properties.due_in_minutes.maximum).toBe(
      SCHEDULED_TASK_MAX_HORIZON_MINUTES
    );
  });

  it("mirrors .strict() and the prompt's cap", () => {
    expect(SCHEDULE_TASK_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(SCHEDULE_TASK_INPUT_SCHEMA.properties.prompt.maxLength).toBe(
      SCHEDULED_TASK_MAX_PROMPT_CHARS
    );
    expect([...SCHEDULE_TASK_INPUT_SCHEMA.required]).toEqual(
      Object.keys(SCHEDULE_TASK_INPUT_SCHEMA.properties)
    );
  });

  // Every key the schema publishes must be one the parser accepts, or the model
  // is told about a field that is an unknown-key rejection.
  it("publishes no field the parser would reject", () => {
    const value: Record<string, unknown> = { prompt: "check", due_in_minutes: 60 };
    for (const key of Object.keys(SCHEDULE_TASK_INPUT_SCHEMA.properties)) {
      expect(Object.hasOwn(value, key)).toBe(true);
    }
    expect(ScheduleTaskArguments.safeParse(value).success).toBe(true);
  });
});

describe("the instant", () => {
  it("takes a UTC instant to the second", () => {
    expect(ScheduledInstant.safeParse("2026-08-19T09:30:00Z").success).toBe(true);
  });

  // A zoneless instant is read as the host's time by whatever parses it next, and
  // the two processes that read this one are configured separately. An offset
  // form is a second spelling of one instant.
  each([
    "2026-08-19T09:30:00",
    "2026-08-19T09:30:00+01:00",
    "2026-08-19 09:30:00Z",
    "2026-08-19T09:30:00.000Z",
    "2026-08-19"
  ])("refuses %s", value => {
    expect(ScheduledInstant.safeParse(value).success).toBe(false);
  });

  // The pattern admits these and `Date.UTC` would roll them forward silently,
  // which is `SkillCreated`'s reason for having the same check.
  each(["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T25:00:00Z"])(
    "refuses %s, which does not exist",
    value => {
      expect(ScheduledInstant.safeParse(value).success).toBe(false);
    }
  );

  it("round-trips through milliseconds in both directions", () => {
    expect(msFromScheduledInstant("2026-08-19T09:30:00Z")).toBe(Date.UTC(2026, 7, 19, 9, 30, 0));
    expect(scheduledInstantFromMs(Date.UTC(2026, 7, 19, 9, 30, 0))).toBe("2026-08-19T09:30:00Z");
    expect(msFromScheduledInstant(scheduledInstantFromMs(1_755_594_600_123))).toBe(1_755_594_600_000);
  });

  // Truncated rather than rounded, so an instant is never later than the
  // millisecond it was minted from. A check may be a fraction of a second early.
  it("never mints an instant later than the millisecond it came from", () => {
    const ms = Date.UTC(2026, 7, 19, 9, 30, 0) + 999;
    expect(msFromScheduledInstant(scheduledInstantFromMs(ms))).toBeLessThanOrEqual(ms);
  });

  it("throws on a string that never parsed", () => {
    expect(() => msFromScheduledInstant("tomorrow")).toThrow();
  });
});

describe("the ticket", () => {
  it("round-trips unchanged", () => {
    const again = parseScheduledTask(serializeScheduledTask(ticket));
    expect(again.ok && again.task).toEqual(ticket);
  });

  it("is stable under repeated rewriting", () => {
    const once = serializeScheduledTask(ticket);
    const parsed = parseScheduledTask(once);
    expect(parsed.ok && serializeScheduledTask(parsed.task)).toBe(once);
  });

  // The three fields whose absence is the design. A channel here would be a
  // second answer to which store the ticket belongs in; the certificate and the
  // file are the only two that may answer.
  each(["channel", "requestingUser", "thread", "status"])("declares no %s", key => {
    expect(ScheduledTask.safeParse({ ...ticket, [key]: "C0OTHER" }).success).toBe(false);
  });

  it("requires every field it does declare", () => {
    for (const key of Object.keys(ticket)) {
      const partial: Record<string, unknown> = { ...ticket };
      delete partial[key];
      expect(ScheduledTask.safeParse(partial).success).toBe(false);
    }
  });

  it("refuses a due instant that is not one", () => {
    expect(ScheduledTask.safeParse({ ...ticket, dueAt: "2026-08-19T09:30:00" }).success).toBe(false);
  });
});

describe("parsing a result that is not a ticket", () => {
  // Never throws: the caller is the agent's tool client, which has to answer the
  // model either way, and a rejection there would end a task over a confirmation.
  it("answers a reason rather than throwing", () => {
    expect(parseScheduledTask("not json at all")).toEqual({ ok: false, reason: "malformed_json" });

    const wrong = parseScheduledTask(JSON.stringify({ id: "x" }));
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.reason).toBe("schema_invalid");
  });

  // Paths and zod codes, `parseSkillFile`'s discipline: no prose, and nothing
  // from the content interpolated into what a caller logs.
  it("reports paths and codes and no messages", () => {
    const parsed = parseScheduledTask(JSON.stringify({ ...ticket, dueAt: 7 }));
    expect(!parsed.ok && parsed.issues?.some(issue => issue.path === "dueAt")).toBe(true);
    for (const issue of (!parsed.ok && parsed.issues) || []) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });
});
