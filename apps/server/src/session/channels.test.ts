// The channel enumerator, against a real directory.
//
// A fake would leave the only claims this module makes — what counts as a
// channel, and what a broken mount does — asserted against the fake. Both are
// about the filesystem.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogFields, LogLevel, Logger } from "@getlibero/gateway";
import { createChannelLister } from "./channels.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libero-channels-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function captureLogger(): { logger: Logger; lines: LogFields[] } {
  const lines: LogFields[] = [];
  return {
    lines,
    logger: {
      log: (_level: LogLevel, fields: LogFields) => {
        lines.push(fields);
      }
    }
  };
}

describe("the channel lister", () => {
  it("answers the provisioned channels in name order", async () => {
    for (const channel of ["C0ZULU", "C0ALPHA", "C0MIKE"]) mkdirSync(join(root, channel));

    // Deterministic rather than whatever the filesystem listed, so a scan that
    // hits a bound works through a library in a stated order.
    await expect(createChannelLister({ channelsRoot: root })()).resolves.toEqual([
      "C0ALPHA",
      "C0MIKE",
      "C0ZULU"
    ]);
  });

  it("ignores anything that could not be a channel", async () => {
    mkdirSync(join(root, "C0ENGINEERING"));
    // A directory whose name is not a `ChannelId` — the gate that keeps an id
    // from becoming a path segment it should not be — and a stray file, which is
    // what a `.DS_Store` or an editor's backup looks like here.
    mkdirSync(join(root, "not a channel"));
    writeFileSync(join(root, "README.md"), "# channels\n");

    await expect(createChannelLister({ channelsRoot: root })()).resolves.toEqual([
      "C0ENGINEERING"
    ]);
  });

  it("does not require a channel to have a sheet", async () => {
    // Deliberately not checked here: a channel with no sheet resolves to the
    // built-in defaults, where every optional feature is off, so it is skipped
    // by the branch that skips a channel which asked for nothing. A second
    // existence check would be a second answer to ./sheet.ts's question.
    mkdirSync(join(root, "C0ENGINEERING"));

    await expect(createChannelLister({ channelsRoot: root })()).resolves.toEqual([
      "C0ENGINEERING"
    ]);
  });

  it("answers an empty list and one line when the root cannot be read", async () => {
    // The wrong mount. The one caller runs on a clock with nobody waiting on it,
    // so this costs a scan rather than the process.
    const { logger, lines } = captureLogger();
    const lister = createChannelLister({ channelsRoot: join(root, "nowhere"), logger });

    await expect(lister()).resolves.toEqual([]);
    expect(lines).toEqual([{ event: "channels_unreadable", reason: "ENOENT" }]);
  });
});
