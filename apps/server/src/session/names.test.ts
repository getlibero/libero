// What "resolved once per user per session" means, tested as a count of
// lookups rather than as a count of names — the two are indistinguishable in
// the output, and only one of them is the acceptance criterion.

import { describe, it } from "node:test";
import { expect } from "expect";
import { NAME_CACHE_MAX, createNameCache } from "./names.js";
import type { DisplayNameLookup } from "./names.js";

/** A directory that records what it was asked, and answers from a table. */
function recording(table: Record<string, string> = {}): {
  lookup: DisplayNameLookup;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    lookup: userId => {
      asked.push(userId);
      return Promise.resolve(table[userId]);
    }
  };
}

describe("createNameCache", () => {
  it("answers with the name the lookup found", async () => {
    const directory = recording({ U0ALICE: "alice" });

    await expect(createNameCache().get("U0ALICE", directory.lookup)).resolves.toBe("alice");
  });

  it("asks once for a user however many times it is read", async () => {
    const directory = recording({ U0ALICE: "alice" });
    const cache = createNameCache();

    await cache.get("U0ALICE", directory.lookup);
    await cache.get("U0ALICE", directory.lookup);
    await cache.get("U0ALICE", directory.lookup);

    expect(directory.asked).toEqual(["U0ALICE"]);
  });

  it("asks once per user, not once in total", async () => {
    const directory = recording({ U0ALICE: "alice", U0BOB: "bob" });
    const cache = createNameCache();

    await expect(cache.get("U0ALICE", directory.lookup)).resolves.toBe("alice");
    await expect(cache.get("U0BOB", directory.lookup)).resolves.toBe("bob");

    expect(directory.asked).toEqual(["U0ALICE", "U0BOB"]);
  });

  it("remembers that a user has no name", async () => {
    // The half that is easy to leave out. A departed user has no name and will
    // not grow one, and a cache of successes alone would ask about them once
    // per message forever — which is the failure the criterion names, for
    // exactly the users it is most likely to happen to.
    const directory = recording();
    const cache = createNameCache();

    await expect(cache.get("U0GONE", directory.lookup)).resolves.toBeUndefined();
    await expect(cache.get("U0GONE", directory.lookup)).resolves.toBeUndefined();

    expect(directory.asked).toEqual(["U0GONE"]);
    expect(cache.size).toBe(1);
  });

  it("shares one in-flight lookup between concurrent readers", async () => {
    // The cache holds the promise, not the settled value. Ingest does not take
    // the session mutex, so two messages from one new author genuinely overlap.
    const asked: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const cache = createNameCache();
    const lookup: DisplayNameLookup = async userId => {
      asked.push(userId);
      await gate;
      return "alice";
    };

    const both = Promise.all([cache.get("U0ALICE", lookup), cache.get("U0ALICE", lookup)]);
    release();

    await expect(both).resolves.toEqual(["alice", "alice"]);
    expect(asked).toEqual(["U0ALICE"]);
  });

  it("remembers a failed lookup as no name rather than retrying it", async () => {
    // An outage costs a session its attribution and never a call per message.
    // A session lasts thirty idle minutes, which is the blast radius.
    let calls = 0;
    const cache = createNameCache();
    const lookup: DisplayNameLookup = () => {
      calls += 1;
      return Promise.reject(new Error("rate limited"));
    };

    await expect(cache.get("U0ALICE", lookup)).resolves.toBeUndefined();
    await expect(cache.get("U0ALICE", lookup)).resolves.toBeUndefined();

    expect(calls).toBe(1);
  });

  it("never rejects, whatever the lookup does", async () => {
    const cache = createNameCache();

    await expect(
      cache.get("U0ALICE", () => Promise.reject(new Error("boom")))
    ).resolves.toBeUndefined();
  });

  it("stays bounded, evicting the oldest entry", async () => {
    // A channel can have thousands of members and this process is long-lived.
    const directory = recording();
    const cache = createNameCache({ max: 2 });

    await cache.get("U0A", directory.lookup);
    await cache.get("U0B", directory.lookup);
    await cache.get("U0C", directory.lookup);

    expect(cache.size).toBe(2);
    // U0A was evicted, so reading it again is a second lookup.
    await cache.get("U0A", directory.lookup);
    expect(directory.asked).toEqual(["U0A", "U0B", "U0C", "U0A"]);
  });

  it("defaults to a bound rather than to none", () => {
    expect(NAME_CACHE_MAX).toBeGreaterThan(0);
    expect(Number.isFinite(NAME_CACHE_MAX)).toBe(true);
  });
});
