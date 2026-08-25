// The four background passes, composed the way the process composes them (#308).
//
// `apps/server/src/index.ts` builds these because they need things `compose.ts`
// does not hold — a completion client, an embedding client, and the spend
// reporter. This file is that block, and it is a sibling of ./agent.ts rather
// than part of it for one reason: it is roughly the length of the `createServer`
// call that file exists to show, and burying that call would cost more than the
// extra module does. What it buys is one file to diff against the production
// one.
//
// ## Why they are opt-in, one at a time
//
// All four fire from the message ingest — `deliverMessage`, never
// `deliverMention` — as four `session.mutex.run(…)` calls in a fixed order on
// one FIFO mutex. So a rig that composed all four would put every case's
// assertion behind three other writers to the same directory, and two of them
// would each consume a scripted model turn. `RigOptions.passes` names the one
// under test and nothing else is built.
//
// ## Three departures from the production block, and each is deliberate
//
// **The embedding client is the rig's, and is `null` unless a case asked for
// one.** `createSummarySweep` takes `null` legally and writes a summary without
// a vector, which is the documented degradation; `createSkillEmbedSweep` returns
// before its interval stamp and before its sheet read, which is the documented
// deployment. See ./embedding.ts for what the fake is and what rule comes with
// it.
//
// **`reportTurn` and `maySpend` are built here rather than passed in**,
// mirroring `index.ts`'s closures over the same transport — the *wrapped* one,
// so a case that compromised the agent's wire compromises both a pass's spend
// report and the question it asks before spending. That is what makes a
// background turn's tokens land on the proxy's own meter in another process, and
// what makes "a pass over its caps spends nothing" a claim about two processes
// rather than about a stub — which is the claim only this suite can make and the
// reason these cases are worth running here rather than in `apps/server`.
//
// **Only the requested passes are constructed.** A pass that was not asked for
// builds no settings closure and holds no reference to the store.

import type { CompletedTurn, CompletionClient, EmbeddingClient, ProxyTransport } from "@getlibero/agent";
import { createProxyBudgetClient, createProxySpendClient, totalTokens } from "@getlibero/agent";
import type { Logger } from "@getlibero/gateway";
import {
  createSkillCuratePass,
  createSkillEmbedSweep,
  createSkillLifecyclePass,
  createSkillProposalsOpener,
  createSummarySweep
} from "@getlibero/server";
import type { ServerDeps, SheetResolver, SkillFilesOpener } from "@getlibero/server";

/**
 * A background pass, by the name `ServerDeps` gives it.
 *
 * The members are the composition's own field names on purpose, so a case that
 * names one can be read straight through to `compose.ts` and to the module that
 * builds it.
 */
export type BackgroundPass = "summarize" | "embedSkills" | "lifecycleSkills" | "curateSkills";

/** Exactly the four fields this module fills in on `ServerDeps`. */
export type BackgroundPassDeps = Pick<
  ServerDeps,
  "summarize" | "embedSkills" | "lifecycleSkills" | "curateSkills"
>;

export interface BackgroundPassOptions {
  readonly passes: readonly BackgroundPass[];
  readonly completion: CompletionClient;
  /** The rig's fake, or `null` for the deployment that configured none. */
  readonly embedding: EmbeddingClient | null;
  /** The wrapped transport, so a compromised wire reaches a pass's spend report. */
  readonly transport: ProxyTransport;
  /** The same resolver `createServer` gets, so a pass reads what a reply reads. */
  readonly sheets: SheetResolver;
  /** The same opener, so a pass reaches the directory the router reaches. */
  readonly skills: SkillFilesOpener;
  readonly storeRoot: string;
  readonly channelsRoot: string;
  readonly logger: Logger;
  /** Aborted before the gateway stops, so a turn in flight at teardown is cancelled. */
  readonly signal: AbortSignal;
  /** `RigOptions.passClock`. Absent leaves every pass on the real clock. */
  readonly now?: () => number;
}

/** What the fake provider is stamped as. Only ever compared against itself. */
const EMBEDDING_MODEL = "e2e-embedding-model";

/** What every metered turn on this side is built with. See `meteringClosures`. */
export interface MeteringOptions {
  /** The wrapped transport, so a compromised wire reaches both halves. */
  readonly transport: ProxyTransport;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

export interface Metering {
  readonly reportTurn: (
    channel: string,
    turn: CompletedTurn & { id: string }
  ) => Promise<void>;
  readonly maySpend: (channel: string) => Promise<boolean>;
}

/**
 * The two halves of the meter, built once and shared.
 *
 * `index.ts`'s shape exactly: both are module-level closures there, handed to
 * every background pass and to the ambient heartbeat alike. Extracted here when
 * the heartbeat arrived (#321), because it is wired independently of the four —
 * a rig can ask for ambient and no passes — and two copies of these would be two
 * chances to meter one and not the other.
 *
 * Built over the **wrapped** transport, which is what makes a case that
 * compromised the agent's wire compromise a background turn's spend report and
 * the question it asks before spending.
 */
export function meteringClosures(options: MeteringOptions): Metering {
  const { logger, signal } = options;

  /**
   * One turn's tokens, on the proxy's meter.
   *
   * `index.ts`'s closure, and never throws for its reason: nothing is waiting on
   * a background pass and an unreported turn must not cost a channel its
   * message write.
   */
  const reportTurn = async (
    channel: string,
    turn: CompletedTurn & { id: string }
  ): Promise<void> => {
    if (totalTokens(turn.usage) === 0) return;
    try {
      const outcome = await createProxySpendClient({
        transport: options.transport,
        channel
      }).report(turn.id, turn.usage, turn.model);
      logger.log("info", {
        event: "spend_reported",
        channel,
        report: outcome,
        totalTokens: totalTokens(turn.usage),
        ...(turn.model === undefined ? {} : { servedModel: turn.model })
      });
    } catch (error) {
      logger.log("error", {
        event: "spend_report_failed",
        channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
    }
  };

  /**
   * The gate the three spending passes ask before they spend (#335).
   *
   * `reportTurn`'s counterpart and built here for its reason: over the *wrapped*
   * transport, so a case that compromises the agent's wire reaches the question
   * as well as the report. That is what makes "a background pass over its caps
   * spends nothing" a claim about two processes rather than about a stub.
   *
   * Fail-closed and never throws, mirroring `index.ts` — a rig whose proxy is
   * unreachable declines rather than spending freely.
   */
  const maySpend = async (channel: string): Promise<boolean> => {
    let refusal;
    try {
      refusal = await createProxyBudgetClient({ transport: options.transport, channel }).status(signal);
    } catch (error) {
      logger.log("warn", {
        event: "budget_unreadable",
        channel,
        reason: error instanceof Error ? error.name : "unknown"
      });
      return false;
    }
    if (refusal === null) return true;
    logger.log("info", { event: "budget_declined", channel, reason: refusal.reason });
    return false;
  };

  return { reportTurn, maySpend };
}

export function backgroundPasses(options: BackgroundPassOptions): BackgroundPassDeps {
  const { logger, sheets, skills, signal } = options;
  const wanted = new Set(options.passes);
  const clock = options.now === undefined ? {} : { now: options.now };
  const { reportTurn, maySpend } = meteringClosures(options);

  const embeddingModel =
    options.embedding === null ? {} : { embeddingModel: EMBEDDING_MODEL };

  return {
    ...(wanted.has("summarize")
      ? {
          summarize: createSummarySweep({
            completion: options.completion,
            embedding: options.embedding,
            ...embeddingModel,
            settings: async channel => {
              const settings = await sheets(channel);
              return {
                summarize: settings.memory.summarize,
                idleMs: settings.memory.summarizeAfterIdleMs,
                model: settings.model,
                maxTokens: settings.caps.maxOutputTokensPerTurn
              };
            },
            reportTurn,
            maySpend,
            signal,
            logger,
            ...clock
          })
        }
      : {}),

    ...(wanted.has("embedSkills")
      ? {
          embedSkills: createSkillEmbedSweep({
            embedding: options.embedding,
            ...embeddingModel,
            files: skills,
            settings: async channel => {
              const settings = await sheets(channel);
              return {
                enabled: settings.skills.enabled,
                maxSkills: settings.skills.maxSkills,
                // Carried, and reaching nothing: no `sharedPool` is wired here,
                // so the rig has no shared half at all. Mounting a third root is
                // #437's, which is the file that attacks it.
                sharedSkills: settings.sharedSkills
              };
            },
            reportTurn,
            maySpend,
            signal,
            logger,
            ...clock
          })
        }
      : {}),

    ...(wanted.has("lifecycleSkills")
      ? {
          lifecycleSkills: createSkillLifecyclePass({
            files: skills,
            settings: async channel => {
              const settings = await sheets(channel);
              return {
                enabled: settings.skills.enabled,
                maxSkills: settings.skills.maxSkills,
                staleAfterMs: settings.skills.staleAfterMs,
                archiveAfterMs: settings.skills.archiveAfterMs
              };
            },
            signal,
            logger,
            ...clock
          })
        }
      : {}),

    ...(wanted.has("curateSkills")
      ? {
          curateSkills: createSkillCuratePass({
            completion: options.completion,
            files: skills,
            proposals: createSkillProposalsOpener({
              storeRoot: options.storeRoot,
              channelsRoot: options.channelsRoot,
              logger
            }),
            settings: async channel => {
              const settings = await sheets(channel);
              return {
                enabled: settings.skills.enabled,
                curate: settings.skills.curate,
                maxSkills: settings.skills.maxSkills,
                model: settings.model,
                maxTokens: settings.caps.maxOutputTokensPerTurn
              };
            },
            reportTurn,
            maySpend,
            signal,
            logger,
            ...clock
          })
        }
      : {})
  };
}
