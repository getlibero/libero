import { describe, expect, it } from "vitest";
import type { SandboxRunResult } from "@getlibero/schema";
import { render } from "./sandbox-dispatcher.js";

const result = (over: Partial<SandboxRunResult> = {}): SandboxRunResult => ({
  outcome: "completed",
  stdout: "",
  stderr: "",
  exitCode: 0,
  truncated: false,
  deniedHost: null,
  ...over
});

describe("rendering a run for the model", () => {
  it("labels the two streams rather than concatenating them", () => {
    const text = render(result({ stdout: "the answer\n", stderr: "a warning\n" }), 10_000);
    expect(text).toContain("stdout:\nthe answer");
    expect(text).toContain("stderr:\na warning");
  });

  // "It printed nothing" and "I did not tell you" are different sentences, and
  // a model reading an omitted section will assume the second.
  it("says a stream was empty rather than omitting it", () => {
    const text = render(result({ stdout: "x" }), 10_000);
    expect(text).toContain("stderr:\n(empty)");
  });

  it("names the exit status of a completed run", () => {
    expect(render(result({ exitCode: 3 }), 10_000)).toContain("exited with status 3");
  });

  // A timeout is a resource fact, not a governance decision: the request was
  // served and what it printed before the kill is a real answer. The sentence
  // has to say that without reading as a refusal.
  it("says a killed run was stopped, and still gives back what it printed", () => {
    const text = render(result({ outcome: "timed_out", exitCode: null, stdout: "partial\n" }), 10_000);
    expect(text).toContain("stopped at its time limit");
    expect(text).toContain("partial");
    expect(text).not.toMatch(/refus|denied|not permitted/i);
  });

  it("distinguishes the runner's own bound from the channel's", () => {
    const text = render(result({ stdout: "x", truncated: true }), 10_000);
    expect(text).toContain("runner's own output limit");
  });

  describe("the channel's bound", () => {
    it("leaves a result under it alone", () => {
      const text = render(result({ stdout: "short" }), 10_000);
      expect(text).not.toContain("truncated");
    });

    it("cuts a long one and says how much was dropped", () => {
      const text = render(result({ stdout: "x".repeat(5_000) }), 200);
      expect(text).toMatch(/\[result truncated: 200 of \d+ characters\]/);
    });

    // #151's shape: the notice sits past the limit rather than inside it, so
    // the channel gets the whole of what it asked for plus an honest note. That
    // is the same choice `boundedResult` makes in ./mcp-bounds.ts, and the two
    // differing would be two answers to one question.
    it("puts the notice past the limit, as the MCP bound does", () => {
      const text = render(result({ stdout: "x".repeat(5_000) }), 200);
      expect(text.length).toBeGreaterThan(200);
      expect(text.slice(0, 200)).not.toContain("truncated");
    });
  });
});
