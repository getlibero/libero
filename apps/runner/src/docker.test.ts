import { describe, it } from "node:test";
import { expect } from "expect";
import { demultiplex } from "./docker.js";

/** One Docker log frame: [stream, 0,0,0, length big-endian], then the payload. */
const frame = (stream: 1 | 2, text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

// The framing is the easiest thing here to get subtly wrong, and getting it
// wrong is not loud: the header bytes become mojibake in the middle of the
// model's context rather than an error anybody sees.
describe("demultiplexing a container's output", () => {
  it("splits the two streams", () => {
    const buffer = Buffer.concat([frame(1, "answer\n"), frame(2, "warning\n"), frame(1, "more\n")]);
    expect(demultiplex(buffer, false)).toEqual({ stdout: "answer\nmore\n", stderr: "warning\n", truncated: false });
  });

  it("keeps no header bytes in either stream", () => {
    // The failure this guards: treating the body as text puts the stream byte
    // and the four length bytes into the output.
    const { stdout } = demultiplex(frame(1, "hello"), false);
    expect(stdout).toBe("hello");
    expect(stdout).not.toContain("");
  });

  it("is empty for an empty container", () => {
    expect(demultiplex(Buffer.alloc(0), false)).toEqual({ stdout: "", stderr: "", truncated: false });
  });

  it("carries the truncation flag through", () => {
    expect(demultiplex(frame(1, "x"), true).truncated).toBe(true);
  });

  // A bound that cut mid-frame leaves a header promising more than is there.
  // The bytes present are still worth returning — the flag already says the
  // tail is gone — and the walk must not read past the buffer to do it.
  it("returns what it has when the bound cut a frame in half", () => {
    const whole = frame(1, "abcdefghij");
    const cut = whole.subarray(0, 8 + 4);
    const result = demultiplex(cut, true);
    expect(result.stdout).toBe("abcd");
    expect(result.truncated).toBe(true);
  });

  it("stops rather than looping on a trailing partial header", () => {
    const buffer = Buffer.concat([frame(1, "ok"), Buffer.alloc(3)]);
    expect(demultiplex(buffer, false).stdout).toBe("ok");
  });
});
