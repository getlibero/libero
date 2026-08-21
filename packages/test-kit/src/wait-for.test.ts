import { describe, it } from "node:test";
import { expect } from "expect";

import { waitFor } from "./wait-for.js";

describe("waitFor", () => {
  it("returns as soon as the check stops throwing", async () => {
    let attempts = 0;
    await waitFor(
      () => {
        attempts += 1;
        if (attempts < 3) throw new Error("not yet");
      },
      { timeout: 1_000, interval: 1 }
    );
    expect(attempts).toBe(3);
  });

  it("reports the last failure rather than a bare timeout", async () => {
    await expect(
      waitFor(
        () => {
          throw new Error("the card never appeared");
        },
        { timeout: 20, interval: 1 }
      )
    ).rejects.toThrow(/still failing after 20 ms: the card never appeared/);
  });

  it("checks once even when the timeout has already passed", async () => {
    let attempts = 0;
    await waitFor(
      () => {
        attempts += 1;
      },
      { timeout: 0 }
    );
    expect(attempts).toBe(1);
  });

  it("awaits an async check", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 5);
    await waitFor(
      async () => {
        await Promise.resolve();
        if (!ready) throw new Error("not ready");
      },
      { timeout: 1_000, interval: 1 }
    );
    expect(ready).toBe(true);
  });
});
