// The adapter, without a socket.
//
// No test here constructs a real SocketModeClient: `start()` opens a WebSocket,
// and its ping timers and retry queue keep the event loop alive whether or not
// the connection succeeds, so vitest would hang or report open handles. The
// client is injected instead.

import { WebAPIPlatformError } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { createSilentLogger } from "../log.js";
import { createSocketModeSource, socketModeOptions } from "./socket-mode.js";
import type { SocketModeClientLike } from "./socket-mode.js";
import { GatewayError } from "./types.js";
import type { SlackEnvelope } from "./types.js";

interface FakeClient {
  client: SocketModeClientLike;
  emit(event: string, arg: unknown): void;
  starts: number;
  disconnects: number;
}

function fakeClient(startBehaviour: () => Promise<unknown> = () => Promise.resolve({})): FakeClient {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const state = {
    starts: 0,
    disconnects: 0,
    client: {
      on(event: string, listener: (...args: unknown[]) => void): unknown {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
        return undefined;
      },
      start(): Promise<unknown> {
        state.starts += 1;
        return startBehaviour();
      },
      disconnect(): Promise<void> {
        state.disconnects += 1;
        return Promise.resolve();
      }
    },
    emit(event: string, arg: unknown): void {
      for (const listener of listeners.get(event) ?? []) listener(arg);
    }
  };
  return state;
}

function source(fake: FakeClient) {
  return createSocketModeSource({
    appToken: "xapp-placeholder-not-a-credential",
    logger: createSilentLogger(),
    createClient: () => fake.client
  });
}

/** Slack's own error shape for a rejected `apps.connections.open`. */
function platformError(error: string): WebAPIPlatformError {
  return new WebAPIPlatformError({ ok: false, error });
}

describe("socketModeOptions", () => {
  it("turns the SDK's own reconnect loop off", () => {
    // The gateway owns reconnection. Two loops means two backoffs, and the
    // SDK's reconnect path can throw an uncatchable rejection from a timer.
    expect(socketModeOptions("xapp-x", createSilentLogger()).autoReconnectEnabled).toBe(false);
  });

  it("bounds the retries the SDK does inside a single connect", () => {
    // Left at its default of 100 retries, a transient failure is absorbed for
    // minutes and our backoff never sees it.
    expect(socketModeOptions("xapp-x", createSilentLogger()).clientOptions?.retryConfig).toEqual({
      retries: 2,
      factor: 2
    });
  });

  it("hands the SDK a logger that discards what it is given", () => {
    const options = socketModeOptions("xapp-x", createSilentLogger());
    // The SDK interpolates whole WebSocket frames into debug strings and its
    // requests carry a bearer token. Nothing it writes reaches our stdout.
    expect(options.logger).toBeDefined();
    expect(() => options.logger?.debug("frame", { token: "xoxb-secret" })).not.toThrow();
  });
});

describe("createSocketModeSource", () => {
  it("hands the SDK's ack down unused, for the dispatcher to order", async () => {
    // The adapter does not ack. Acking is the first thing the dispatcher does,
    // before normalization and before the handler, and gateway.test.ts asserts
    // that ordering. Doing it here as well would ack twice.
    let acked = 0;
    const fake = fakeClient();
    const adapter = source(fake);
    const seen: SlackEnvelope[] = [];
    adapter.onMention(envelope => {
      seen.push(envelope);
      return Promise.resolve();
    });
    await adapter.connect();

    fake.emit("app_mention", {
      ack: () => {
        acked += 1;
        return Promise.resolve();
      },
      event: { type: "app_mention" },
      body: { team_id: "T0TEAM" }
    });

    expect(acked).toBe(0);
    await seen[0]?.ack();
    expect(acked).toBe(1);
  });

  it("passes the raw event and body through untouched", async () => {
    const fake = fakeClient();
    const adapter = source(fake);
    const seen: SlackEnvelope[] = [];
    adapter.onMention(envelope => {
      seen.push(envelope);
      return Promise.resolve();
    });
    await adapter.connect();

    fake.emit("app_mention", {
      ack: () => Promise.resolve(),
      event: { type: "app_mention", channel: "C0CHAN" },
      body: { team_id: "T0TEAM" }
    });

    expect(seen[0]?.event).toEqual({ type: "app_mention", channel: "C0CHAN" });
    expect(seen[0]?.body).toEqual({ team_id: "T0TEAM" });
  });

  it("drops a payload it cannot read instead of throwing into the SDK", async () => {
    const fake = fakeClient();
    const adapter = source(fake);
    let calls = 0;
    adapter.onMention(() => {
      calls += 1;
      return Promise.resolve();
    });
    await adapter.connect();

    expect(() => fake.emit("app_mention", null)).not.toThrow();
    expect(() => fake.emit("app_mention", { event: {}, body: {} })).not.toThrow();
    expect(calls).toBe(0);
  });

  it("does not let a listener rejection escape into the SDK's emit", async () => {
    const fake = fakeClient();
    const adapter = source(fake);
    adapter.onMention(() => Promise.reject(new Error("dispatch blew up")));
    await adapter.connect();

    expect(() =>
      fake.emit("app_mention", { ack: () => Promise.resolve(), event: {}, body: {} })
    ).not.toThrow();
    await Promise.resolve();
  });

  it("reports a dropped socket", async () => {
    const fake = fakeClient();
    const adapter = source(fake);
    let drops = 0;
    adapter.onDrop(() => {
      drops += 1;
    });
    await adapter.connect();

    fake.emit("disconnected", undefined);

    expect(drops).toBe(1);
  });

  it("does not report a close the gateway asked for as a drop", async () => {
    const fake = fakeClient();
    const adapter = source(fake);
    let drops = 0;
    adapter.onDrop(() => {
      drops += 1;
    });
    await adapter.connect();
    await adapter.close();

    // The SDK emits `disconnected` for an intentional disconnect too. Reading
    // that as a drop would reconnect a gateway that was told to stop.
    fake.emit("disconnected", undefined);

    expect(drops).toBe(0);
    expect(fake.disconnects).toBe(1);
  });

  it("marks credentials Slack will never accept as not retryable", async () => {
    for (const code of [
      "not_authed",
      "invalid_auth",
      "account_inactive",
      "user_removed_from_team",
      "team_disabled"
    ]) {
      const adapter = source(fakeClient(() => Promise.reject(platformError(code))));
      await expect(adapter.connect()).rejects.toMatchObject({
        reason: "auth_rejected",
        retryable: false
      });
    }
  });

  it("marks everything else as worth retrying", async () => {
    const adapter = source(fakeClient(() => Promise.reject(new Error("ECONNRESET"))));

    await expect(adapter.connect()).rejects.toMatchObject({
      reason: "connect_failed",
      retryable: true
    });
  });

  it("treats a Slack error that is not about credentials as retryable", async () => {
    const adapter = source(fakeClient(() => Promise.reject(platformError("ratelimited"))));

    await expect(adapter.connect()).rejects.toMatchObject({
      reason: "connect_failed",
      retryable: true
    });
  });

  it("carries no token or SDK message on the error it raises", async () => {
    const adapter = source(
      fakeClient(() => Promise.reject(new Error("failed to reach https://slack.com?token=xapp-1")))
    );

    const error = await adapter.connect().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(GatewayError);
    expect(JSON.stringify({ name: (error as Error).name, message: (error as Error).message })).not.toContain(
      "xapp-"
    );
    expect((error as Error).message).toBe("connect_failed");
  });

  it("reconnects through the same client rather than building a second one", async () => {
    const fake = fakeClient();
    const adapter = source(fake);
    await adapter.connect();
    await adapter.close();
    await adapter.connect();

    expect(fake.starts).toBe(2);
  });
});
