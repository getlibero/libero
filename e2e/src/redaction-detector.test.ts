// Can this suite catch a leak at all?
//
// Every assertion #132 will make is a negative — "the credential is not on this
// surface" — and a negative passes for good reasons and bad ones alike. The
// positive control in canary.ts rules out one bad reason (the credential was
// never resolved, so there was nothing to leak). This file rules out the other:
// that the scan is looking in the wrong place, or that the surfaces it reads are
// not the ones a credential would land on.
//
// The method is a mutant. The upstream is told to reflect its `Authorization`
// header straight into the tool result — a real leak attempt, and the shape #132
// starts from — and the pair is run twice: once as shipped, once with the
// proxy's redaction pass gutted inside the spawned process. Shipped must scrub
// it; gutted must be caught. A change that made `expectNoCanary` vacuous would
// fail the second half here long before it made #132 pass for nothing.

import { after as afterAll, before as beforeAll, it } from "node:test";
import { expect } from "expect";
import {
  CANARY,
  CHANNEL,
  breakRedaction,
  calls,
  createCleanup,
  expectCanaryReachedUpstream,
  expectNoCanary,
  rigOf,
  says,
  startRig
} from "./harness/index.js";
import type { Cleanup, Rig } from "./harness/index.js";

const SETUP_MS = 60_000;
const CASE_MS = 30_000;

/** The upstream hands the credential straight back in the tool result. */
const ECHOES_ITS_AUTH = { echoHeaders: "text" } as const;

const SCRIPT = [calls("list_prs", { repo: "getlibero/libero" }), says("Done.")];

const mention = (eventId: string) => ({
  teamId: "T024BE7LD",
  channelId: CHANNEL,
  userId: "U024BE7LH",
  text: "<@U0BOTBOTB> go",
  ts: "1758000000.000100",
  threadTs: "1758000000.000100",
  eventId
});

asShipped();
withRedactionGutted();

function asShipped(): void {
  let rig: Rig | undefined;

  beforeAll(async () => {
    rig = await startRig({ upstream: ECHOES_ITS_AUTH, script: SCRIPT });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
  }, { timeout: SETUP_MS });

  it(
    "an upstream that echoes its auth header is scrubbed before the model sees it",
    { timeout: CASE_MS },
    async () => {
      const { agent, upstream, model, surfaces } = rigOf(rig);
      await agent.slack.deliverMention(mention("Ev00000030"));

      // The attempt was real: the credential did reach the upstream, and the
      // upstream did reflect it. Without this the case proves only that nothing
      // happened.
      expectCanaryReachedUpstream(upstream);

      // And what came back names the credential instead of carrying it. The
      // marker is asserted rather than only the absence, because a result that
      // lost the whole body would also contain no canary.
      const transcript = JSON.stringify(model.seen);
      expect(transcript).toContain("[redacted:e2e_canary]");
      expectNoCanary(surfaces());
    });
}

function withRedactionGutted(): void {
  let rig: Rig | undefined;
  let cleanup: Cleanup | undefined;

  beforeAll(async () => {
    // Its own stack: the hook file has to exist before `startRig`, so it cannot
    // be registered on the rig's.
    cleanup = createCleanup();
    rig = await startRig({
      nodeArgs: ["--import", breakRedaction(cleanup)],
      upstream: ECHOES_ITS_AUTH,
      script: SCRIPT
    });
  }, { timeout: SETUP_MS });

  afterAll(async () => {
    await rig?.stop();
    await cleanup?.drain();
  }, { timeout: SETUP_MS });

  it(
    "with the proxy's redaction pass gutted, the suite's own assertion fails",
    { timeout: CASE_MS },
    async () => {
      const { agent, model, surfaces } = rigOf(rig);
      await agent.slack.deliverMention(mention("Ev00000031"));

      // The leak is real and complete: the credential is in the model's
      // transcript verbatim, which is where a leaked one actually lands.
      expect(JSON.stringify(model.seen)).toContain(CANARY);

      // And the check every #132 case will lean on catches it. This is the
      // assertion the file exists for — the others describe the setup.
      expect(() => expectNoCanary(surfaces())).toThrow(/agent-visible surface/);
    });
}
