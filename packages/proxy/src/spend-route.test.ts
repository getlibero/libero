// The spend route's own cases, against fakes rather than through the listener.
//
// ./server.test.ts already covers what the route does over a real socket with a
// real meter — the channel comes from the certificate, a retry is a duplicate, a
// body asserting a channel is a 400. What is here is the branch #239 added: when
// a router's cost figure is recorded beside the counts, and the four conditions
// under which it deliberately is not. Each of those is a decision rather than a
// guard, and each is cheaper to state against a recorder that remembers what it
// was told than through a database and a socket.

import { describe, it } from "node:test";
import { expect } from "expect";
import { createSpendRoute } from "./spend-route.js";
import type { DriftRecorder, ReportedCost } from "./drift-db.js";
import type { SpendRecord, TokenRecorder } from "./dispatch.js";
import { createSilentLogger } from "./log.js";
import type { RequestContext, RouteResponse } from "./server.js";

const CHANNEL = "C0ENGINEERING";
const DAY = "2026-08-29";
const MODEL = "claude-sonnet-4-6";

const usage = {
  inputTokens: 11,
  outputTokens: 2,
  cacheReadInputTokens: 7,
  cacheCreationInputTokens: 13
};

/** What LiteLLM main-stable answers for those counts on that model: $0.00011385. */
const REPORTED_NANO_USD = 113_850;

interface Recorded {
  readonly channel: string;
  readonly day: string;
  readonly cost: ReportedCost;
}

function fakeDrift(): DriftRecorder & { readonly recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    recordReported(channel, day, cost) {
      recorded.push({ channel, day, cost });
    }
  };
}

function fakeMeter(outcome: SpendRecord["outcome"] = "recorded"): TokenRecorder {
  return { recordTokens: () => ({ outcome, day: DAY }) };
}

async function report(
  body: unknown,
  options: { meter?: TokenRecorder; drift?: DriftRecorder } = {}
): Promise<RouteResponse> {
  const route = createSpendRoute({
    meter: options.meter ?? fakeMeter(),
    ...(options.drift === undefined ? {} : { drift: options.drift }),
    logger: createSilentLogger()
  });
  return route({ channel: CHANNEL, requestId: "req_1", body } as RequestContext);
}

describe("recording what a gateway said a turn cost (#239)", () => {
  it("records the reported figure beside the counts it priced", async () => {
    const drift = fakeDrift();

    const response = await report(
      { turn: "t1", model: MODEL, usage, costNanoUsd: REPORTED_NANO_USD },
      { drift }
    );

    expect(response.status).toBe(200);
    expect(drift.recorded).toEqual([
      {
        channel: CHANNEL,
        day: DAY,
        cost: {
          model: MODEL,
          // The same counts the meter was given, renamed to the columns that
          // hold them. A comparison against a different set of counts than the
          // ones that were metered would not be a comparison at all.
          usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 13 },
          costNanoUsd: REPORTED_NANO_USD
        }
      }
    ]);
  });

  // The day is the meter's answer, not a clock this route reads. A report
  // landing in the last millisecond of a day would otherwise be compared
  // against counts filed under the next one.
  it("files the observation under the day the meter filed the counts under", async () => {
    const drift = fakeDrift();

    await report({ turn: "t1", model: MODEL, usage, costNanoUsd: 1 }, { drift });

    expect(drift.recorded[0]?.day).toBe(DAY);
  });

  it("records nothing when no gateway priced the call", async () => {
    const drift = fakeDrift();

    // Every direct provider call is this shape, which is most calls in most
    // deployments. A zero recorded here would read as "the gateway says this
    // was free" and show a deployment a drift it does not have.
    const response = await report({ turn: "t1", model: MODEL, usage }, { drift });

    expect(response.status).toBe(200);
    expect(drift.recorded).toEqual([]);
  });

  // A reported zero is a statement — priced, and free — and it is not the same
  // statement as the absence above. The record has to be able to hold it.
  it("records a reported zero, which is a gateway saying free", async () => {
    const drift = fakeDrift();

    await report({ turn: "t1", model: MODEL, usage, costNanoUsd: 0 }, { drift });

    expect(drift.recorded[0]?.cost.costNanoUsd).toBe(0);
  });

  it("records nothing for a report that named no model", async () => {
    const drift = fakeDrift();

    // Those counts are metered — under `(unreported)` — but there is no price
    // table row to compare a figure against, so there is no comparison to draw.
    const response = await report({ turn: "t1", usage, costNanoUsd: REPORTED_NANO_USD }, { drift });

    expect(response.status).toBe(200);
    expect(drift.recorded).toEqual([]);
  });

  // The meter deduped this turn, so its counts are counted once. Adding its
  // cost again would inflate one side of a comparison whose other side did not
  // move — the drift would be the retry's rather than the price table's.
  it("records nothing on a retry the meter treated as a duplicate", async () => {
    const drift = fakeDrift();

    const response = await report(
      { turn: "t1", model: MODEL, usage, costNanoUsd: REPORTED_NANO_USD },
      { drift, meter: fakeMeter("duplicate") }
    );

    expect(response.body).toEqual({ outcome: "duplicate" });
    expect(drift.recorded).toEqual([]);
  });

  // A deployment that sets no PROXY_DRIFT_DB has no recorder at all, and that
  // is not a degraded route: it meters exactly as it did before this existed.
  it("meters a report carrying a cost with no recorder configured", async () => {
    const response = await report({ turn: "t1", model: MODEL, usage, costNanoUsd: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ outcome: "recorded" });
  });

  // The response is the meter's answer and nothing else. An observation the
  // route happened to record is not something the agent is told about, because
  // there is nothing it could do with it.
  it("says nothing about the observation in its answer", async () => {
    const drift = fakeDrift();

    const response = await report(
      { turn: "t1", model: MODEL, usage, costNanoUsd: REPORTED_NANO_USD },
      { drift }
    );

    expect(response.body).toEqual({ outcome: "recorded" });
  });
});
