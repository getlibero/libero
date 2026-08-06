import { WebAPIHTTPError, WebAPIPlatformError } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { createSilentLogger } from "../log.js";
import { GatewayError } from "./types.js";
import type { SlackCard } from "./types.js";
import { createWebApiPoster } from "./web-api.js";
import type { WebClientLike } from "./web-api.js";

type PostArgs = Parameters<WebClientLike["chat"]["postMessage"]>[0];
type UpdateArgs = Parameters<WebClientLike["chat"]["update"]>[0];

/** A card whose contents do not matter — these tests are about the transport. */
const CARD: SlackCard = {
  color: "#F5B544",
  fallback: "Awaiting a human: github.pr.merge is held.",
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "`APPROVAL REQUIRED`" } }]
};

function fakeClient(behaviour: () => Promise<unknown> = () => Promise.resolve({ ok: true })): {
  client: WebClientLike;
  calls: PostArgs[];
  updates: UpdateArgs[];
} {
  const calls: PostArgs[] = [];
  const updates: UpdateArgs[] = [];
  return {
    calls,
    updates,
    client: {
      chat: {
        postMessage(args: PostArgs): Promise<unknown> {
          calls.push(args);
          return behaviour();
        },
        update(args: UpdateArgs): Promise<unknown> {
          updates.push(args);
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

  describe("cards", () => {
    it("posts one attachment carrying the colour, the fallback, and the blocks", async () => {
      const fake = fakeClient(() => Promise.resolve({ ok: true, ts: "1717171717.000200" }));

      const posted = await poster(fake).postCard({
        channelId: "C0OPS",
        threadTs: "1717171717.000100",
        card: CARD
      });

      expect(posted).toEqual({ channelId: "C0OPS", messageTs: "1717171717.000200" });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({
        channel: "C0OPS",
        thread_ts: "1717171717.000100",
        // The card's own words at the top level too: a push notification shows
        // this rather than the blocks.
        text: CARD.fallback,
        attachments: [{ color: "#F5B544", fallback: CARD.fallback, blocks: CARD.blocks }]
      });
    });

    it("refuses a card it could not learn the ts of", async () => {
      // A handle with no ts is a card nothing can ever edit — it would sit
      // amber forever, which is the lie the feature exists to avoid.
      for (const response of [{ ok: true }, { ok: true, ts: 17171717 }, { ok: true, ts: "" }]) {
        const fake = fakeClient(() => Promise.resolve(response));

        const error = await poster(fake)
          .postCard({ channelId: "C0OPS", threadTs: "1.0", card: CARD })
          .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(GatewayError);
        expect(error).toMatchObject({ reason: "post_failed", slackError: "no_message_ts" });
      }
    });

    it("edits the message it was given, and never reaches for a response_url", async () => {
      const fake = fakeClient();

      await poster(fake).updateCard({
        channelId: "C0OPS",
        messageTs: "1717171717.000200",
        card: { ...CARD, color: "#1BA85A", fallback: "Approved: a human approved github.pr.merge." }
      });

      expect(fake.calls).toHaveLength(0);
      expect(fake.updates).toHaveLength(1);
      expect(fake.updates[0]).toMatchObject({
        channel: "C0OPS",
        ts: "1717171717.000200",
        attachments: [{ color: "#1BA85A" }]
      });
      // `response_url` is the obvious shortcut and it is a URL with a secret in
      // it. Nothing in this adapter may grow one.
      expect(JSON.stringify(fake.updates)).not.toContain("response_url");
    });

    it("says a failed edit is a failed edit", async () => {
      // Its own code, because the symptom differs from a failed post: something
      // wrong is still on screen rather than nothing having appeared.
      const fake = fakeClient(() =>
        Promise.reject(new WebAPIPlatformError({ ok: false, error: "message_not_found" }))
      );

      const error = await poster(fake)
        .updateCard({ channelId: "C0OPS", messageTs: "1.0", card: CARD })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(GatewayError);
      expect(error).toMatchObject({
        reason: "update_failed",
        retryable: false,
        slackError: "message_not_found"
      });
    });

    it("carries no SDK error detail out of either card verb", async () => {
      const fake = fakeClient(() =>
        Promise.reject(
          new WebAPIHTTPError(429, "Too Many Requests", { authorization: "Bearer xoxb-secret" })
        )
      );
      const subject = poster(fake);

      const onPost = (await subject
        .postCard({ channelId: "C0OPS", threadTs: "1.0", card: CARD })
        .then(() => undefined, (cause: unknown) => cause)) as GatewayError;
      const onUpdate = (await subject
        .updateCard({ channelId: "C0OPS", messageTs: "1.0", card: CARD })
        .then(() => undefined, (cause: unknown) => cause)) as GatewayError;
      const failures = [onPost, onUpdate];

      expect(failures.map(error => error.message)).toEqual(["post_failed", "update_failed"]);
      for (const error of failures) {
        expect(error.slackError).toBeUndefined();
        expect(
          JSON.stringify({ message: error.message, slackError: error.slackError })
        ).not.toContain("xoxb-");
      }
    });
  });
});
