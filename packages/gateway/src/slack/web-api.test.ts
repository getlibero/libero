import { WebAPIHTTPError, WebAPIPlatformError } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { createSilentLogger } from "../log.js";
import { GatewayError } from "./types.js";
import { createWebApiPoster } from "./web-api.js";
import type { WebClientLike } from "./web-api.js";

type PostArgs = { channel: string; thread_ts: string; text: string };

function fakeClient(behaviour: () => Promise<unknown> = () => Promise.resolve({ ok: true })): {
  client: WebClientLike;
  calls: PostArgs[];
} {
  const calls: PostArgs[] = [];
  return {
    calls,
    client: {
      chat: {
        postMessage(args: PostArgs): Promise<unknown> {
          calls.push(args);
          return behaviour();
        }
      }
    }
  };
}

function poster(fake: { client: WebClientLike }) {
  return createWebApiPoster({
    botToken: "xoxb-placeholder-not-a-credential",
    logger: createSilentLogger(),
    createClient: () => fake.client
  });
}

describe("createWebApiPoster", () => {
  it("posts into the thread it was given", async () => {
    const fake = fakeClient();

    await poster(fake).postThreadReply({
      channelId: "C0OPS",
      threadTs: "1717171717.000100",
      text: "deploy is green"
    });

    expect(fake.calls).toEqual([
      { channel: "C0OPS", thread_ts: "1717171717.000100", text: "deploy is green" }
    ]);
  });

  it("surfaces Slack's own error code and nothing else", async () => {
    // `not_in_channel` is the first thing a self-hoster hits: the app is
    // installed but was never invited to the channel. It has to be readable in
    // a log line or the symptom is silence.
    const fake = fakeClient(() =>
      Promise.reject(new WebAPIPlatformError({ ok: false, error: "not_in_channel" }))
    );

    const error = await poster(fake)
      .postThreadReply({ channelId: "C0OPS", threadTs: "1.0", text: "hi" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      reason: "post_failed",
      retryable: false,
      slackError: "not_in_channel"
    });
  });

  it("does not carry an SDK error's detail out of the adapter", async () => {
    // WebAPIHTTPError holds response headers, and the Socket Mode client's
    // requests carry a bearer token. None of it may reach a message or a field.
    const fake = fakeClient(() =>
      Promise.reject(
        new WebAPIHTTPError(429, "Too Many Requests", { authorization: "Bearer xoxb-secret" })
      )
    );

    const error = (await poster(fake)
      .postThreadReply({ channelId: "C0OPS", threadTs: "1.0", text: "hi" })
      .catch((cause: unknown) => cause)) as GatewayError;

    expect(error.message).toBe("post_failed");
    expect(error.slackError).toBeUndefined();
    expect(JSON.stringify({ message: error.message, slackError: error.slackError })).not.toContain(
      "xoxb-"
    );
  });

  it("does not retry a post the Web API already retried", async () => {
    // The WebClient retries transport failures and honours rate limits itself.
    // A second attempt here either fails identically or posts twice.
    let attempts = 0;
    const fake = fakeClient(() => {
      attempts += 1;
      return Promise.reject(new WebAPIPlatformError({ ok: false, error: "msg_too_long" }));
    });

    await poster(fake)
      .postThreadReply({ channelId: "C0OPS", threadTs: "1.0", text: "hi" })
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });
});
