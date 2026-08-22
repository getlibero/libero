import { describe, it } from "node:test";
import { expect } from "expect";
import type { SandboxCaps, SandboxRunResult } from "@getlibero/schema";
import { render } from "./sandbox-dispatcher.js";

const result = (over: Partial<SandboxRunResult> = {}): SandboxRunResult => ({
  outcome: "completed",
  stdout: "",
  stderr: "",
  exitCode: 0,
  truncated: false,
  deniedHost: null,
  appliedCaps: null,
  ...over
});

/** What the sheet asked for. Every case below renders against this. */
const ASKED: SandboxCaps = { cpus: 4, memoryMb: 4096, timeoutSeconds: 120 };

describe("rendering a run for the model", () => {
  it("labels the two streams rather than concatenating them", () => {
    const text = render(result({ stdout: "the answer\n", stderr: "a warning\n" }), 10_000, ASKED);
    expect(text).toContain("stdout:\nthe answer");
    expect(text).toContain("stderr:\na warning");
  });

  // "It printed nothing" and "I did not tell you" are different sentences, and
  // a model reading an omitted section will assume the second.
  it("says a stream was empty rather than omitting it", () => {
    const text = render(result({ stdout: "x" }), 10_000, ASKED);
    expect(text).toContain("stderr:\n(empty)");
  });

  it("names the exit status of a completed run", () => {
    expect(render(result({ exitCode: 3 }), 10_000, ASKED)).toContain("exited with status 3");
  });

  // A timeout is a resource fact, not a governance decision: the request was
  // served and what it printed before the kill is a real answer. The sentence
  // has to say that without reading as a refusal.
  it("says a killed run was stopped, and still gives back what it printed", () => {
    const text = render(result({ outcome: "timed_out", exitCode: null, stdout: "partial\n" }), 10_000, ASKED);
    expect(text).toContain("stopped at its time limit");
    expect(text).toContain("partial");
    expect(text).not.toMatch(/refus|denied|not permitted/i);
  });

  it("distinguishes the runner's own bound from the channel's", () => {
    const text = render(result({ stdout: "x", truncated: true }), 10_000, ASKED);
    expect(text).toContain("runner's own output limit");
  });

  describe("the channel's bound", () => {
    it("leaves a result under it alone", () => {
      const text = render(result({ stdout: "short" }), 10_000, ASKED);
      expect(text).not.toContain("truncated");
    });

    it("cuts a long one and says how much was dropped", () => {
      const text = render(result({ stdout: "x".repeat(5_000) }), 200, ASKED);
      expect(text).toMatch(/\[result truncated: 200 of \d+ characters\]/);
    });

    // #151's shape: the notice sits past the limit rather than inside it, so
    // the channel gets the whole of what it asked for plus an honest note. That
    // is the same choice `boundedResult` makes in ./mcp-bounds.ts, and the two
    // differing would be two answers to one question.
    it("puts the notice past the limit, as the MCP bound does", () => {
      const text = render(result({ stdout: "x".repeat(5_000) }), 200, ASKED);
      expect(text.length).toBeGreaterThan(200);
      expect(text.slice(0, 200)).not.toContain("truncated");
    });
  });
});

// The clamp notice (#405). A deployment ceiling sizes a run below what its
// sheet asked for, and the channel is told — because the case this exists for
// is a program the OOM reaper killed at a limit it was never configured for,
// and an operator's log line is not read by the model holding the corpse.
describe("a run the deployment's ceiling sized down", () => {
  const clamped = (over: Partial<SandboxCaps>) =>
    render(result({ appliedCaps: { ...ASKED, ...over } }), 10_000, ASKED);

  it("says so, with both numbers", () => {
    expect(clamped({ memoryMb: 512 })).toContain("memory_mb 4096 to 512");
  });

  // Listing the two caps that were honoured beside the one that was not is how
  // a note becomes noise, and noise is what a model reads past.
  it("names only the fields that actually differ", () => {
    const text = clamped({ memoryMb: 512 });
    expect(text).not.toContain("cpus");
    expect(text).not.toContain("timeout_seconds");
  });

  it("names each of the three when each is clamped", () => {
    const text = clamped({ cpus: 1, memoryMb: 512, timeoutSeconds: 30 });
    expect(text).toContain("cpus 4 to 1");
    expect(text).toContain("memory_mb 4096 to 512");
    expect(text).toContain("timeout_seconds 120 to 30");
  });

  // The sheet's spelling, not the wire's. The reader who can act on this is
  // looking at a `[[builtin]]` block, and `memoryMb` is not a field they can
  // find in one.
  it("uses the sheet's field names rather than the wire's", () => {
    const text = clamped({ memoryMb: 512, timeoutSeconds: 30 });
    expect(text).not.toContain("memoryMb");
    expect(text).not.toContain("timeoutSeconds");
  });

  // It is a resource fact, and reading as a refusal would send the model to
  // apologise to the channel for something the channel did not do.
  it("does not read as a refusal", () => {
    expect(clamped({ memoryMb: 512 })).not.toMatch(/refus|denied|not permitted|forbidden/i);
  });

  // The ordinary run — every run on a deployment whose ceiling is above its
  // sheets — must gain no line at all.
  it("says nothing when nothing was clamped", () => {
    const text = render(result({ stdout: "x" }), 10_000, ASKED);
    expect(text).not.toContain("sized the run");
  });

  // Ahead of the streams, because it is what explains them. A note after two
  // screens of stderr is a note read too late.
  it("comes before the output it explains", () => {
    const text = clamped({ memoryMb: 512 });
    expect(text.indexOf("memory_mb")).toBeLessThan(text.indexOf("stdout:"));
  });

  // A timed-out run whose `timeout_seconds` was clamped is the case where the
  // notice carries the whole explanation: the program did not loop, it was
  // given a quarter of the time its channel says it has.
  it("explains a timeout it caused", () => {
    const text = render(
      result({ outcome: "timed_out", exitCode: null, appliedCaps: { ...ASKED, timeoutSeconds: 30 } }),
      10_000,
      ASKED
    );
    expect(text).toContain("stopped at its time limit");
    expect(text).toContain("timeout_seconds 120 to 30");
  });
});
