import { beforeEach, describe, expect, it } from "vitest";
import type { ResolvedToolCall } from "@getlibero/schema";
import {
  APPROVAL_TTL_MS,
  MAX_TICKETS_PER_CHANNEL,
  TICKET_RETENTION_MS,
  createApprovalStore
} from "./approvals.js";
import type { ApprovalStore } from "./approvals.js";

const CHANNEL = "C0ENGINEERING";
const OTHER = "C0DESIGN";
const NOON = Date.UTC(2026, 7, 4, 12, 0, 0);
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const APPROVER = "U0BOSS";

/** The clock every test drives. Nothing here waits for a real fifteen minutes. */
let clock: number;
let store: ApprovalStore;

beforeEach(() => {
  clock = NOON;
  store = createApprovalStore({ now: () => clock });
});

function callTo(
  overrides: Partial<Pick<ResolvedToolCall, "channel" | "server" | "tool" | "id">> = {}
): ResolvedToolCall {
  return {
    id: "toolu_01",
    server: "github",
    tool: "merge_pr",
    arguments: { pr: 42 },
    requestingUser: "U0ASKER",
    task: "b9d5a2f0-0000-4000-8000-000000000001",
    channel: CHANNEL,
    ...overrides
  };
}

describe("the lifecycle", () => {
  /**
   * Each case is a script against one store: what happens to a ticket, and what
   * the store says when it is finally presented. Driven as ./enforce.test.ts
   * drives its decision table, so a new state is a row rather than a new test.
   */
  const cases: {
    name: string;
    run: (mint: () => string) => { outcome: string };
    outcome: string;
  }[] = [
    {
      name: "approved, then redeemed",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "approve", APPROVER);
        return store.redeem(CHANNEL, id, callTo(), HASH);
      },
      outcome: "redeemed"
    },
    {
      name: "denied, then redeemed",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "deny", APPROVER);
        return store.redeem(CHANNEL, id, callTo(), HASH);
      },
      outcome: "denied"
    },
    {
      name: "redeemed before a human has clicked",
      run: mint => store.redeem(CHANNEL, mint(), callTo(), HASH),
      outcome: "pending"
    },
    {
      name: "redeemed twice",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "approve", APPROVER);
        store.redeem(CHANNEL, id, callTo(), HASH);
        return store.redeem(CHANNEL, id, callTo(), HASH);
      },
      outcome: "spent"
    },
    {
      name: "approved, then redeemed after the deadline",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "approve", APPROVER);
        clock += APPROVAL_TTL_MS;
        return store.redeem(CHANNEL, id, callTo(), HASH);
      },
      outcome: "expired"
    },
    {
      name: "decided after the deadline",
      run: mint => {
        const id = mint();
        clock += APPROVAL_TTL_MS;
        return store.decide(CHANNEL, id, "approve", APPROVER);
      },
      outcome: "expired"
    },
    {
      name: "approved, then redeemed with different arguments",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "approve", APPROVER);
        return store.redeem(CHANNEL, id, callTo(), OTHER_HASH);
      },
      outcome: "mismatch"
    },
    {
      name: "approved, then redeemed against a different tool",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "approve", APPROVER);
        return store.redeem(CHANNEL, id, callTo({ tool: "close_pr" }), HASH);
      },
      outcome: "mismatch"
    },
    {
      name: "approved, then redeemed against a different server",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "approve", APPROVER);
        return store.redeem(CHANNEL, id, callTo({ server: "gitlab" }), HASH);
      },
      outcome: "mismatch"
    },
    {
      name: "redeemed with an id that was never minted",
      run: mint => {
        mint();
        return store.redeem(CHANNEL, "no-such-ticket", callTo(), HASH);
      },
      outcome: "unknown"
    },
    {
      name: "minted in one channel, redeemed from another",
      run: mint => {
        const id = mint();
        store.decide(CHANNEL, id, "approve", APPROVER);
        return store.redeem(OTHER, id, callTo({ channel: OTHER }), HASH);
      },
      outcome: "unknown"
    },
    {
      name: "minted in one channel, decided from another",
      run: mint => store.decide(OTHER, mint(), "approve", APPROVER),
      outcome: "unknown"
    }
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = testCase.run(() => store.mint(callTo(), HASH).id);
      expect(result.outcome).toBe(testCase.outcome);
    });
  }
});

describe("minting", () => {
  it("carries everything a decision's audit row will need", () => {
    const ticket = store.mint(callTo(), HASH);

    expect(ticket).toMatchObject({
      channel: CHANNEL,
      server: "github",
      tool: "merge_pr",
      argumentsSha256: HASH,
      requestingUser: "U0ASKER",
      task: "b9d5a2f0-0000-4000-8000-000000000001",
      callId: "toolu_01",
      createdAt: NOON,
      expiresAt: NOON + APPROVAL_TTL_MS,
      verdict: null,
      approver: null,
      spentAt: null
    });
  });

  it("gives two holds of the same call two tickets", () => {
    expect(store.mint(callTo(), HASH).id).not.toBe(store.mint(callTo(), HASH).id);
  });
});

describe("the deadline", () => {
  // The half-open window, pinned at both edges. A ticket is alive at the last
  // millisecond and dead at the first.
  it("is alive up to the deadline and dead at it", () => {
    const alive = store.mint(callTo(), HASH);
    store.decide(CHANNEL, alive.id, "approve", APPROVER);
    clock = alive.expiresAt - 1;
    expect(store.redeem(CHANNEL, alive.id, callTo(), HASH).outcome).toBe("redeemed");

    clock = NOON;
    const dead = store.mint(callTo(), HASH);
    store.decide(CHANNEL, dead.id, "approve", APPROVER);
    clock = dead.expiresAt;
    expect(store.redeem(CHANNEL, dead.id, callTo(), HASH).outcome).toBe("expired");
  });

  // What keeps "one terminal row per ticket" true. Without it, N retries of an
  // expired ticket write N `expired` rows and every count of expiries is wrong.
  it("reports the expiry as first seen exactly once, across both operations", () => {
    const ticket = store.mint(callTo(), HASH);
    clock += APPROVAL_TTL_MS;

    const first = store.redeem(CHANNEL, ticket.id, callTo(), HASH);
    const second = store.redeem(CHANNEL, ticket.id, callTo(), HASH);
    const third = store.decide(CHANNEL, ticket.id, "approve", APPROVER);

    expect(first).toMatchObject({ outcome: "expired", firstObserved: true });
    expect(second).toMatchObject({ outcome: "expired", firstObserved: false });
    expect(third).toMatchObject({ outcome: "expired", firstObserved: false });
  });

  it("reports an expiry the decision route saw first as seen", () => {
    const ticket = store.mint(callTo(), HASH);
    clock += APPROVAL_TTL_MS;

    expect(store.decide(CHANNEL, ticket.id, "deny", APPROVER)).toMatchObject({ firstObserved: true });
    expect(store.redeem(CHANNEL, ticket.id, callTo(), HASH)).toMatchObject({ firstObserved: false });
  });

  // Expiry beats every other state, because a dead ticket is dead whatever a
  // human said about it and whether or not it was already used.
  it("answers expired rather than spent or denied once the deadline passes", () => {
    const spent = store.mint(callTo(), HASH);
    store.decide(CHANNEL, spent.id, "approve", APPROVER);
    store.redeem(CHANNEL, spent.id, callTo(), HASH);

    const denied = store.mint(callTo(), HASH);
    store.decide(CHANNEL, denied.id, "deny", APPROVER);

    clock += APPROVAL_TTL_MS;

    expect(store.redeem(CHANNEL, spent.id, callTo(), HASH).outcome).toBe("expired");
    expect(store.redeem(CHANNEL, denied.id, callTo(), HASH).outcome).toBe("expired");
  });
});

describe("deciding", () => {
  it("records the approver and the moment", () => {
    const ticket = store.mint(callTo(), HASH);
    clock += 1000;
    const decided = store.decide(CHANNEL, ticket.id, "approve", APPROVER);

    expect(decided).toMatchObject({ outcome: "recorded" });
    expect(decided.outcome === "recorded" && decided.ticket).toMatchObject({
      verdict: "approve",
      approver: APPROVER,
      decidedAt: NOON + 1000
    });
  });

  // A double click, a stale card, a retry. The first answer stands even when the
  // second disagrees: a decided ticket may already have been spent, so there is
  // no coherent un-approving of it.
  it("keeps the first verdict when a second decision disagrees", () => {
    const ticket = store.mint(callTo(), HASH);
    store.decide(CHANNEL, ticket.id, "approve", "U0FIRST");

    const second = store.decide(CHANNEL, ticket.id, "deny", "U0SECOND");

    expect(second.outcome).toBe("already_decided");
    expect(second.outcome === "already_decided" && second.ticket).toMatchObject({
      verdict: "approve",
      approver: "U0FIRST"
    });
    expect(store.redeem(CHANNEL, ticket.id, callTo(), HASH).outcome).toBe("redeemed");
  });
});

describe("redeeming", () => {
  it("hands back the approver so the served call can be attributed", () => {
    const ticket = store.mint(callTo(), HASH);
    store.decide(CHANNEL, ticket.id, "approve", APPROVER);

    const redeemed = store.redeem(CHANNEL, ticket.id, callTo(), HASH);
    expect(redeemed.outcome === "redeemed" && redeemed.ticket.approver).toBe(APPROVER);
  });

  // A client that sent the wrong arguments can send the right ones. Burning the
  // ticket would let one bad re-submission destroy a decision a human gave.
  it("does not spend a ticket a mismatched call presented", () => {
    const ticket = store.mint(callTo(), HASH);
    store.decide(CHANNEL, ticket.id, "approve", APPROVER);

    expect(store.redeem(CHANNEL, ticket.id, callTo(), OTHER_HASH).outcome).toBe("mismatch");
    expect(store.redeem(CHANNEL, ticket.id, callTo(), HASH).outcome).toBe("redeemed");
  });

  // The whole of the match. A re-submission that changed only its tool-use id or
  // its attribution is still the call a human approved.
  it("ignores the call id, which a re-submission may legitimately mint afresh", () => {
    const ticket = store.mint(callTo(), HASH);
    store.decide(CHANNEL, ticket.id, "approve", APPROVER);

    expect(store.redeem(CHANNEL, ticket.id, callTo({ id: "toolu_99" }), HASH).outcome).toBe("redeemed");
  });
});

describe("channel scoping", () => {
  // Not "the guard rejects it" but "the lookup cannot see it" — which is why a
  // foreign ticket and a nonexistent one are genuinely one answer.
  it("keeps two channels' tickets apart through every operation", () => {
    const mine = store.mint(callTo(), HASH);
    const theirs = store.mint(callTo({ channel: OTHER }), HASH);

    expect(store.decide(OTHER, mine.id, "approve", APPROVER).outcome).toBe("unknown");
    expect(store.redeem(OTHER, mine.id, callTo({ channel: OTHER }), HASH).outcome).toBe("unknown");
    expect(store.decide(CHANNEL, theirs.id, "approve", APPROVER).outcome).toBe("unknown");

    // And the rejected attempts left both tickets decidable by their own channel.
    expect(store.decide(CHANNEL, mine.id, "approve", APPROVER).outcome).toBe("recorded");
    expect(store.decide(OTHER, theirs.id, "approve", APPROVER).outcome).toBe("recorded");
  });

  it("does not let a foreign attempt mark a ticket's expiry as observed", () => {
    const ticket = store.mint(callTo(), HASH);
    clock += APPROVAL_TTL_MS;

    expect(store.decide(OTHER, ticket.id, "approve", APPROVER).outcome).toBe("unknown");
    expect(store.redeem(CHANNEL, ticket.id, callTo(), HASH)).toMatchObject({ firstObserved: true });
  });
});

describe("growth", () => {
  // A held call is not metered, so an agent looping on an approval-required tool
  // mints a ticket per iteration for free. This is the only bound on that.
  it("evicts the oldest ticket past the cap, and the newest still works", () => {
    const first = store.mint(callTo(), HASH);
    for (let n = 1; n < MAX_TICKETS_PER_CHANNEL; n += 1) store.mint(callTo(), HASH);
    const last = store.mint(callTo(), HASH);

    expect(store.decide(CHANNEL, first.id, "approve", APPROVER).outcome).toBe("unknown");
    expect(store.decide(CHANNEL, last.id, "approve", APPROVER).outcome).toBe("recorded");
    expect(store.redeem(CHANNEL, last.id, callTo(), HASH).outcome).toBe("redeemed");
  });

  it("caps each channel separately", () => {
    const mine = store.mint(callTo(), HASH);
    for (let n = 0; n < MAX_TICKETS_PER_CHANNEL * 2; n += 1) store.mint(callTo({ channel: OTHER }), HASH);

    expect(store.decide(CHANNEL, mine.id, "approve", APPROVER).outcome).toBe("recorded");
  });

  // The reason retention is a separate constant from the deadline: inside the
  // window the store still says what actually happened.
  it("answers spent rather than unknown while the record is retained", () => {
    const ticket = store.mint(callTo(), HASH);
    store.decide(CHANNEL, ticket.id, "approve", APPROVER);
    store.redeem(CHANNEL, ticket.id, callTo(), HASH);

    clock = ticket.expiresAt - 1;
    expect(store.redeem(CHANNEL, ticket.id, callTo(), HASH).outcome).toBe("spent");
  });

  it("forgets a ticket nobody touched once it is long dead", () => {
    const ticket = store.mint(callTo(), HASH);

    clock = ticket.expiresAt + TICKET_RETENTION_MS - 1;
    expect(store.redeem(CHANNEL, ticket.id, callTo(), HASH).outcome).toBe("expired");

    // Pruning happens on the next mint, because minting is the only operation
    // that grows the map.
    clock = ticket.expiresAt + TICKET_RETENTION_MS;
    store.mint(callTo(), HASH);
    expect(store.redeem(CHANNEL, ticket.id, callTo(), HASH).outcome).toBe("unknown");
  });
});
