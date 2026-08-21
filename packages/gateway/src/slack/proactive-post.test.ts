import { describe, it } from "node:test";
import { expect } from "expect";
import { renderProactivePost } from "./proactive-post.js";

describe("renderProactivePost", () => {
  it("labels a heartbeat post with what noticed it", () => {
    const text = renderProactivePost({
      source: "heartbeat",
      text: "Two questions in this channel have had no reply since Friday."
    });

    expect(text.startsWith("`NOTICED`\n")).toBe(true);
    expect(text).toContain("no reply since Friday");
  });

  it("labels a fired task as the scheduled check it is", () => {
    const text = renderProactivePost({
      source: "task",
      text: "Standup is in ten minutes and the release notes are unwritten."
    });

    expect(text.startsWith("`SCHEDULED CHECK`\n")).toBe(true);
  });

  it("tells a reader where the switch is, but only when nobody asked", () => {
    // The asymmetry is the decision, not an omission: a scheduled check was
    // asked for, and its off switch is the governed create rather than
    // `[ambient]` — so naming that block there would point at the wrong knob.
    const heartbeat = renderProactivePost({ source: "heartbeat", text: "something" });
    const task = renderProactivePost({ source: "task", text: "something" });

    expect(heartbeat).toContain("[ambient]");
    expect(task).not.toContain("[ambient]");
  });

  it("neutralizes Slack markup in a body it did not author", () => {
    // The body is model-authored and reaches a channel. A post that could carry
    // a working `<!channel>` would be an unprompted message that also pings
    // everyone, which is the rate limit defeated by a different route.
    const text = renderProactivePost({
      source: "heartbeat",
      text: "<!channel> <https://example.test|click> & <@U0OPS>"
    });

    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&amp;");
  });

  it("caps a body that ran long, and says it did", () => {
    const text = renderProactivePost({ source: "heartbeat", text: "x".repeat(5_000) });

    // The ellipsis is what distinguishes a capped body from one that happened to
    // end there — a silently cut message claims to be the whole of itself.
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(1_100);
  });

  it("cannot let the cap put live markup back", () => {
    // Escaping runs first, so the limit applies to the escaped length and
    // nothing can exceed it. The cap can then land inside an entity — `&amp;`
    // cut to `&am` — which renders as those literal characters and is cosmetic.
    // What must hold is stronger and is the assertion: truncating an escaped
    // string yields prefixes of `&amp;`/`&lt;`/`&gt;`, never a `<` or a `>`, so
    // no cut can reconstruct a tag the escape had just taken apart.
    for (const body of ["<".repeat(400), "&".repeat(400), "<!channel>".repeat(200)]) {
      const text = renderProactivePost({ source: "heartbeat", text: body });
      const rendered = text.slice(0, text.indexOf("\n\n"));

      expect(rendered).not.toContain("<");
      expect(rendered).not.toContain(">");
    }
  });
});
