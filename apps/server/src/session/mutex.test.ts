import { describe, it } from "node:test";
import { expect } from "expect";
import { createMutex } from "./mutex.js";

/** A promise the test resolves when it wants the work under test to proceed. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets every already-scheduled microtask run. */
const flush = (): Promise<void> => Promise.resolve().then(() => {});

describe("createMutex", () => {
  it("runs one at a time", async () => {
    const mutex = createMutex();
    const gate = deferred();
    let running = 0;
    let maxRunning = 0;

    const track = async (wait: Promise<void>): Promise<void> => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await wait;
      running -= 1;
    };

    const first = mutex.run(() => track(gate.promise));
    const second = mutex.run(() => track(Promise.resolve()));

    await flush();
    expect(maxRunning).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);
    expect(maxRunning).toBe(1);
  });

  it("runs work in the order it arrived", async () => {
    const mutex = createMutex();
    const order: string[] = [];

    await Promise.all(
      ["a", "b", "c"].map(id =>
        mutex.run(async () => {
          await flush();
          order.push(id);
        })
      )
    );

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("does not interleave a read-modify-write", async () => {
    // The shape the serialization exists for: an await between the read and the
    // write means interleaving silently loses one of the increments.
    const mutex = createMutex();
    const shared = { value: 0 };

    await Promise.all(
      [1, 2, 3].map(() =>
        mutex.run(async () => {
          const seen = shared.value;
          await flush();
          shared.value = seen + 1;
        })
      )
    );

    expect(shared.value).toBe(3);
  });

  it("gives a rejection to its own caller and no other", async () => {
    const mutex = createMutex();

    const failed = mutex.run(() => Promise.reject(new Error("boom")));
    const after = mutex.run(() => Promise.resolve("ran"));

    await expect(failed).rejects.toThrow(/boom/);
    await expect(after).resolves.toBe("ran");
  });

  it("does not wedge the queue when work throws", async () => {
    const mutex = createMutex();
    const order: string[] = [];

    const failed = mutex.run(async () => {
      order.push("first");
      throw new Error("boom");
    });
    const second = mutex.run(() => {
      order.push("second");
      return Promise.resolve();
    });

    await expect(failed).rejects.toThrow(/boom/);
    await second;
    expect(order).toEqual(["first", "second"]);
    expect(mutex.pending).toBe(0);
  });

  it("counts queued as well as running, and returns to zero", async () => {
    // Eviction rests on this: a session with anything queued must never look
    // idle, or it is dropped out from under work that is about to start.
    const mutex = createMutex();
    const gate = deferred();
    expect(mutex.pending).toBe(0);

    const first = mutex.run(() => gate.promise);
    expect(mutex.pending).toBe(1);

    const second = mutex.run(() => Promise.resolve());
    expect(mutex.pending).toBe(2);

    gate.resolve();
    await Promise.all([first, second]);
    expect(mutex.pending).toBe(0);
  });

  it("does not let one mutex hold another", async () => {
    // Channels do not block each other, and this is the whole mechanism.
    const held = createMutex();
    const other = createMutex();
    const gate = deferred();

    const blocked = held.run(() => gate.promise);
    await expect(other.run(() => Promise.resolve("free"))).resolves.toBe("free");

    gate.resolve();
    await blocked;
  });
});
