// The ambient half of the composition, when a case asks for it (#321).
//
// ./passes.ts's shape and its argument: `apps/server/src/index.ts` builds these
// because they need things `compose.ts` does not hold — a completion client, the
// spend closures, and the openers over the two roots — and this file is that
// block, so there is one file to diff against the production one rather than a
// graph reassembled from memory.
//
// ## Off unless a case asks, and off twice
//
// A rig gets no ambient wiring unless `RigOptions.ambient` says so, **and** a
// channel gets no heartbeat unless its sheet says `[ambient] enabled = true`.
// The two are not redundant. The first keeps every case written before this
// existed composing exactly what it composed before — no clock, no enumerator,
// no `Server.ambient` at all. The second is the property the suite has to be
// able to assert: that a channel which never opted in sees nothing, whatever its
// content asks for, which is only testable on a rig where the wiring is present
// and the sheet is what withholds it.
//
// ## The clock is the case's, and it is `scan`
//
// Nothing here starts a timer. `AmbientScheduler.scan(at)` is documented as the
// whole of the scheduler's behaviour precisely so a test drives it rather than
// waiting, and a case that called `start()` would be a case racing a real clock
// against a ten-second `waitForLog`. So the rig exposes `scan` and a case fires
// exactly one heartbeat, at an instant it names.
//
// That also makes the first-sight rule visible rather than incidental: the first
// `scan` schedules and never fires, so a case that wants a heartbeat scans
// twice, the second time past the cadence. See `Rig.heartbeat`.
//
// **A due check has no first-sight rule**, and the rig has a second verb because
// of it. A heartbeat's deadline is invented by the scheduler, so it cannot fire
// on the scan that invents it; a ticket's instant is already on disk when the
// scan starts, so the first scan past it fires. `Rig.check` scans once, and that
// difference is the thing it exists to make visible. See `Rig.check`.

import type { CompletionClient, ProxyTransport } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import {
  createAmbientHeartbeat,
  createAmbientTaskFire,
  createChannelLister,
  createSkillProposalsOpener
} from "@getlibero/server";
import type { ServerDeps, SheetResolver } from "@getlibero/server";
import { meteringClosures } from "./passes.js";

/** Exactly the three fields this module fills in on `ServerDeps`. */
export type AmbientDeps = Pick<ServerDeps, "channels" | "heartbeat" | "fireTask">;

export interface AmbientOptions {
  readonly completion: CompletionClient;
  /** The wrapped transport, so a compromised wire reaches the heartbeat's meter. */
  readonly transport: ProxyTransport;
  /** The same resolver `createServer` gets, so the clock reads what a reply reads. */
  readonly sheets: SheetResolver;
  readonly storeRoot: string;
  /** Read-only, and the directory the clock enumerates channels from. */
  readonly channelsRoot: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** `RigOptions.passClock`. Absent leaves the heartbeat on the real clock. */
  readonly now?: () => number;
}

export function ambientDeps(options: AmbientOptions): AmbientDeps {
  const { logger, sheets, signal } = options;
  const { reportTurn, maySpend } = meteringClosures(options);

  return {
    // What the clock enumerates: the channels an operator provisioned, read out
    // of the same root the sheets come from. A listing and nothing more.
    channels: createChannelLister({ channelsRoot: options.channelsRoot, logger }),

    // A factory over the poster, exactly as index.ts wires it — which is what
    // keeps the capability out of this file. The rig sees a `ProactivePoster`
    // only inside this closure, and the four background passes beside it are
    // constructed without one.
    heartbeat: post =>
      createAmbientHeartbeat({
        completion: options.completion,
        post,
        settings: async channel => {
          const settings = await sheets(channel);
          return {
            enabled: settings.ambient.enabled,
            answerAfterIdleMs: settings.ambient.answerAfterIdleMs,
            model: settings.model,
            maxTokens: settings.caps.maxOutputTokensPerTurn
          };
        },
        reportTurn,
        maySpend,
        // The same opener the curator writes through, so a case can write a
        // proposal and then watch the channel be told about that file (#320).
        proposals: createSkillProposalsOpener({
          storeRoot: options.storeRoot,
          channelsRoot: options.channelsRoot,
          logger
        }),
        signal,
        logger,
        ...(options.now === undefined ? {} : { now: options.now })
      }),

    // The second factory over the same poster (#324). Wired unconditionally
    // beside the heartbeat rather than behind a knob of its own, because a
    // channel still needs `[ambient] enabled = true` *and* a ticket in its store
    // before anything here runs — the two switches the file header describes
    // already gate it, and a third would make "a due check fired" depend on a
    // rig setting no production deployment has.
    fireTask: post =>
      createAmbientTaskFire({
        completion: options.completion,
        post,
        settings: async channel => {
          const settings = await sheets(channel);
          return {
            enabled: settings.ambient.enabled,
            model: settings.model,
            maxTokens: settings.caps.maxOutputTokensPerTurn
          };
        },
        // The same closures the heartbeat takes, over the wrapped transport, so
        // "a capped channel's due check spends nothing" is a claim about two
        // processes rather than about a stub.
        reportTurn,
        maySpend,
        signal,
        logger,
        ...(options.now === undefined ? {} : { now: options.now })
      })
  };
}
