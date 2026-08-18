import type { ChannelPoster } from "@getlibero/gateway";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_POST_WINDOW_MS, createProactivePoster } from "./proactive.js";

/** Records what reached Slack, and can be made to fail. */
function fakePoster(failure?: unknown): {
  poster: ChannelPoster;
  sent: Array<{ channelId: string; text: string }>;
} {
  const sent: Array<{ channelId: string; text: string }> = [];
  return {
    sent,
    poster: {
      postToChannel(target): Promise<void> {
        if (failure !== undefined) return Promise.reject(failure);
        sent.push({ ...target });
        return Promise.resolve();
      }
    }
  };
}

/** A clock a test states rather than one it waits on. */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe("createProactivePoster", () => {
  it("posts a heartbeat finding into the channel", async () => {
    const slack = fakePoster();
    const surface = createProactivePoster({ poster: slack.poster });

    const posted = await surface.post({
      channel: "C0OPS",
      text: "Two questions have had no reply since Friday.",
      source: "heartbeat"
    });

    expect(posted).toBe(true);
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.channelId).toBe("C0OPS");
    expect(slack.sent[0]?.text).toContain("no reply since Friday");
  });

  describe("the heartbeat window", () => {
    it("refuses a second heartbeat post inside the window", async () => {
      const time = clock();
      const slack = fakePoster();
      const surface = createProactivePoster({ poster: slack.poster, now: time.now });

      expect(await surface.post({ channel: "C0OPS", text: "one", source: "heartbeat" })).toBe(true);
      time.advance(HEARTBEAT_POST_WINDOW_MS - 1);
      expect(await surface.post({ channel: "C0OPS", text: "two", source: "heartbeat" })).toBe(false);

      expect(slack.sent).toHaveLength(1);
    });

    it("opens again once the window has passed", async () => {
      const time = clock();
      const slack = fakePoster();
      const surface = createProactivePoster({ poster: slack.poster, now: time.now });

      await surface.post({ channel: "C0OPS", text: "one", source: "heartbeat" });
      time.advance(HEARTBEAT_POST_WINDOW_MS);

      expect(await surface.post({ channel: "C0OPS", text: "two", source: "heartbeat" })).toBe(true);
      expect(slack.sent).toHaveLength(2);
    });

    it("holds however many evaluations run inside one window", async () => {
      // The acceptance criterion states it this way on purpose: the cadence can
      // be as low as one minute, so a four-hour window can hold 240 ticks. One
      // post, whatever the clock does inside it.
      const time = clock();
      const slack = fakePoster();
      const surface = createProactivePoster({ poster: slack.poster, now: time.now });

      const results: boolean[] = [];
      for (let tick = 0; tick < 240; tick += 1) {
        results.push(await surface.post({ channel: "C0OPS", text: "x", source: "heartbeat" }));
        time.advance(60_000);
      }

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(slack.sent).toHaveLength(1);
    });

    it("claims the window before the post, so overlapping evaluations cannot both pass", async () => {
      // Claim-then-post rather than post-then-stamp. With the stamp after the
      // await, both of these read an empty window and both would post.
      const time = clock();
      let release: (() => void) | undefined;
      const gate = new Promise<void>(resolve => (release = resolve));
      const sent: string[] = [];
      const poster: ChannelPoster = {
        async postToChannel(target): Promise<void> {
          await gate;
          sent.push(target.text);
        }
      };
      const surface = createProactivePoster({ poster, now: time.now });

      const first = surface.post({ channel: "C0OPS", text: "one", source: "heartbeat" });
      const second = surface.post({ channel: "C0OPS", text: "two", source: "heartbeat" });
      release?.();

      expect(await first).toBe(true);
      expect(await second).toBe(false);
      expect(sent).toHaveLength(1);
    });

    it("is per channel, so one busy channel cannot silence another", async () => {
      const time = clock();
      const slack = fakePoster();
      const surface = createProactivePoster({ poster: slack.poster, now: time.now });

      expect(await surface.post({ channel: "C0OPS", text: "one", source: "heartbeat" })).toBe(true);
      expect(await surface.post({ channel: "C0DEV", text: "one", source: "heartbeat" })).toBe(true);
      expect(await surface.post({ channel: "C0OPS", text: "two", source: "heartbeat" })).toBe(false);

      expect(slack.sent).toHaveLength(2);
    });

    it("does not refund a failed post", async () => {
      // A refund would turn a channel the app was removed from into repeated
      // attempts at the same failure, at whatever rate the clock is running.
      const time = clock();
      const surface = createProactivePoster({
        poster: fakePoster(new Error("post_failed")).poster,
        now: time.now
      });

      expect(await surface.post({ channel: "C0GONE", text: "one", source: "heartbeat" })).toBe(
        false
      );
      time.advance(60_000);
      expect(await surface.post({ channel: "C0GONE", text: "two", source: "heartbeat" })).toBe(
        false
      );
    });
  });

  describe("a fired task", () => {
    it("is not blocked by a window a heartbeat just closed", async () => {
      // A reminder is not late because the heartbeat spoke first. Its bound was
      // the governed create, not this window.
      const time = clock();
      const slack = fakePoster();
      const surface = createProactivePoster({ poster: slack.poster, now: time.now });

      await surface.post({ channel: "C0OPS", text: "finding", source: "heartbeat" });
      time.advance(60_000);

      expect(await surface.post({ channel: "C0OPS", text: "standup in ten", source: "task" })).toBe(
        true
      );
      expect(slack.sent).toHaveLength(2);
    });

    it("does not consume the window it passed through", async () => {
      const time = clock();
      const slack = fakePoster();
      const surface = createProactivePoster({ poster: slack.poster, now: time.now });

      await surface.post({ channel: "C0OPS", text: "standup in ten", source: "task" });
      await surface.post({ channel: "C0OPS", text: "and another", source: "task" });

      expect(await surface.post({ channel: "C0OPS", text: "finding", source: "heartbeat" })).toBe(
        true
      );
      expect(slack.sent).toHaveLength(3);
    });
  });

  it("never rejects, whatever Slack does", async () => {
    // The only callers are background passes with nowhere to report an
    // exception to: the clock is not waiting on an answer and no person is.
    const surface = createProactivePoster({
      poster: fakePoster(new Error("post_failed")).poster
    });

    await expect(
      surface.post({ channel: "C0OPS", text: "one", source: "task" })
    ).resolves.toBe(false);
  });
});

describe("asking before spending", () => {
  it("says a fresh channel may post, and says so without posting", () => {
    const slack = fakePoster();
    const surface = createProactivePoster({ poster: slack.poster });

    expect(surface.mayPost("C0OPS")).toBe(true);
    // The question is free and changes nothing — a check that claimed the
    // window would make asking twice a way to silence a channel.
    expect(surface.mayPost("C0OPS")).toBe(true);
    expect(slack.sent).toEqual([]);
  });

  it("agrees with post, on both sides of the window", async () => {
    // Two spellings of one comparison, so they are asserted against each other
    // rather than each against a number.
    const time = clock();
    const slack = fakePoster();
    const surface = createProactivePoster({ poster: slack.poster, now: time.now });

    await surface.post({ channel: "C0OPS", text: "one", source: "heartbeat" });

    expect(surface.mayPost("C0OPS")).toBe(false);
    expect(await surface.post({ channel: "C0OPS", text: "two", source: "heartbeat" })).toBe(false);

    time.advance(HEARTBEAT_POST_WINDOW_MS);

    expect(surface.mayPost("C0OPS")).toBe(true);
    expect(await surface.post({ channel: "C0OPS", text: "three", source: "heartbeat" })).toBe(true);
  });

  it("is per channel, like the window it reports on", async () => {
    const time = clock();
    const slack = fakePoster();
    const surface = createProactivePoster({ poster: slack.poster, now: time.now });

    await surface.post({ channel: "C0OPS", text: "one", source: "heartbeat" });

    expect(surface.mayPost("C0OPS")).toBe(false);
    expect(surface.mayPost("C0DEV")).toBe(true);
  });

  it("is unmoved by a fired task's post", async () => {
    // A task does not draw on the window, so it cannot close one — which is why
    // this takes no source to ask about.
    const time = clock();
    const slack = fakePoster();
    const surface = createProactivePoster({ poster: slack.poster, now: time.now });

    await surface.post({ channel: "C0OPS", text: "standup in ten", source: "task" });

    expect(surface.mayPost("C0OPS")).toBe(true);
  });
});
