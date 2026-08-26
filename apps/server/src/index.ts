// The gateway + agent process.
//
// The environment and the lifecycle, and nothing else: read the variables,
// build the adapters, hand them to `createServer`, connect, stop cleanly. The
// wiring those dependencies get plugged into is compose.ts, which holds no
// environment and starts nothing — so the same graph this process runs is the
// one the tests run. Everything it does lives in @getlibero/gateway and
// @getlibero/agent — and the environment rules in env.ts, the Slack mapping in
// handler.ts, the sessions and the loop under session/ — where they are
// testable without a socket, a provider, or a process.
//
// Sessions are in memory, and one thing in them is not: since #176 a live
// session holds an open `store.db` for its channel. A restart drops every
// session and reopens the files on demand, which costs nothing — the store is
// the durable thing and the session is only a handle to it, the team sheet is
// read from disk per task rather than cached into one, and a queue that was
// drained by the abort below has nothing left to lose.
//
// This process holds the Slack app and bot tokens and the model provider key.
// It holds no tool credential and has no way to reach a tool except one: a
// mutual-TLS call to the tool proxy service, which owns every credential and
// decides every call from the channel's team sheet.

import {
  createCompletionClient,
  createEmbeddingClient,
  createProxyBudgetClient,
  createProxySpendClient,
  createProxyTransport,
  totalTokens
} from "@getlibero/agent";
import type { CompletedTurn } from "@getlibero/agent";
import { GatewayError, createJsonLogger, createSlackSurface } from "@getlibero/gateway";
import {
  createAmbientHeartbeat,
  createAmbientRuleFire,
  createAmbientTaskFire,
  createServer,
  createSharedSkillReader,
  createSharedSkillPoolOpener
} from "./compose.js";
import type {
  AmbientHeartbeat,
  AmbientRuleFire,
  AmbientTaskFire,
  ProactivePoster
} from "./compose.js";
import {
  channelsRootFromEnv,
  completionConfigFromEnv,
  embeddingConfigFromEnv,
  modelFromEnv,
  proxyConfigFromEnv,
  sharedSkillsRootFromEnv,
  slackTokensFromEnv,
  storeRootFromEnv
} from "./env.js";
import { createChannelLister } from "./session/channels.js";
import { createMemoryFileOpener } from "./session/memory.js";
import { createQueryEmbedder } from "./session/embed.js";
import { createRecall } from "./session/recall.js";
import { createSkillEmbedSweep } from "./session/skill-embed.js";
import { createSkillCuratePass } from "./session/skill-curate.js";
import { createSkillLifecyclePass } from "./session/skill-lifecycle.js";
import { createSkillRecall } from "./session/skill-recall.js";
import { createSkillProposalsOpener } from "./session/proposals.js";
import { createSkillFilesOpener } from "./session/skills.js";
import { createSheetResolver } from "./session/sheet.js";
import { createSummarySweep } from "./session/summarize.js";
import { createMessageStoreOpener } from "./session/store.js";

const logger = createJsonLogger();

// All of it, before anything connects. A process that came up on half its
// configuration would open a socket and then fail every task at the far end of
// a thread, which is the slowest possible way to learn a variable is missing.
const { appToken, botToken } = slackTokensFromEnv(process.env);
const model = modelFromEnv(process.env);
const channelsRoot = channelsRootFromEnv(process.env);
// A different root from the sheets, on purpose: this one is written to, and the
// sheets directory is the tool proxy's authorization source. See env.ts.
const storeRoot = storeRootFromEnv(process.env);
// The third root (#433), read-only and optional. Not the channels root the proxy
// reads authorization from, and not the store root this process writes — see
// env.ts for why the second of those is a security decision and not filing.
//
// `null` is a supported deployment: every channel's own skills work exactly as
// before and there is no shared half. It says which it got here, once, for
// `embeddings_unconfigured`'s reason — the alternative is an operator who has
// written `[[shared_skill]]` into a sheet discovering from a feature quietly
// doing nothing that the root was never mounted.
const sharedSkillsRoot = sharedSkillsRootFromEnv(process.env);
if (sharedSkillsRoot === null) {
  logger.log("info", { event: "shared_skills_unconfigured", reason: "shared_skills_root_unset" });
} else {
  logger.log("info", { event: "shared_skills_ready", file: sharedSkillsRoot });
}
// Built even when the root is null, because the reader is what turns a sheet
// that names a shared skill in a deployment with no root into a log line saying
// so. Omitting it there would make the two indistinguishable from inside a task.
const sharedSkills = createSharedSkillReader({ root: sharedSkillsRoot, logger });
// The retrieved half of the same root (#436). A second opener rather than a
// second use of the reader above: the standing region reads and weighs in one
// shot and keeps nothing, where the pool has to survive as a handle across a
// reconcile, two rank lists and a read loop. Built even when the root is null,
// for the reader's reason.
const sharedSkillPool = createSharedSkillPoolOpener({ root: sharedSkillsRoot, logger });
const completion = createCompletionClient(completionConfigFromEnv(process.env));
// Optional, and its absence is a supported deployment rather than a failure:
// memory Layers 1 and 2 are whole without embeddings, so a process with no
// embedding provider answers every mention exactly as before and simply has no
// semantic recall. It says so once, here, because the alternative is an
// operator discovering it from a feature quietly not working.
const embedding = embeddingConfigFromEnv(process.env);
if (embedding === null) {
  logger.log("info", { event: "embeddings_unconfigured", reason: "embedding_provider_unset" });
} else {
  logger.log("info", { event: "embeddings_ready", embeddingModel: embedding.model });
}
// Null when unconfigured, which the sweep takes: a summary is still written and
// stored, and only its vector is skipped. See `SummarySweepOptions.embedding`.
const embeddings = embedding === null ? null : createEmbeddingClient(embedding.config);
// Reads the CA and rejects a non-https PROXY_URL here, before the socket opens.
// A per-channel client certificate is resolved on first use — one channel with
// no certificate is that channel's problem, not the process's.
const transport = createProxyTransport(proxyConfigFromEnv(process.env));

// Aborts every task in flight when the process is asked to stop. The loop
// reports `cancelled` rather than throwing, and a cancelled task posts nothing
// — and a task holding an approval settles its wait and repaints its card on
// the way out, because the prompter listens on this same signal.
const tasks = new AbortController();

const sheets = createSheetResolver({ root: channelsRoot, model, logger });

/**
 * Reports one turn's tokens to the proxy's meter.
 *
 * Shared by the quiescence sweep and by recall, because an embedding call is
 * spend whether it was spent writing the corpus or reading it — and two copies
 * of this would be two chances to meter one of them and not the other.
 *
 * A spend client per call, exactly as `runTask` builds one per task: it is a
 * transport and a channel id, and the channel comes from the client certificate
 * at the other end rather than from anything in the body.
 *
 * **Never throws.** Both callers sit on a path where a person is waiting — the
 * message ingest handler and the head of a task — and an unreported turn must
 * not cost a channel its reply.
 */
const reportTurn = async (
  channel: string,
  turn: CompletedTurn & { id: string }
): Promise<void> => {
  if (totalTokens(turn.usage) === 0) return;
  try {
    const outcome = await createProxySpendClient({ transport, channel }).report(
      turn.id,
      turn.usage,
      turn.model
    );
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
 * Whether a channel may be spent for at all, asked before a background turn runs
 * (#335).
 *
 * `reportTurn`'s counterpart and its exact mirror: that one says what a turn
 * cost after the fact, this one asks whether the turn should happen. The pairing
 * exists because the two halves of the meter are only both reachable from here —
 * a completion never goes near the tool proxy service, so a turn that calls no
 * tool would otherwise meet no bound at all however far over its caps a channel
 * was.
 *
 * A client per call, exactly as `reportTurn` builds a spend client per call: it
 * is a transport and a channel id, and the channel comes from the client
 * certificate at the other end.
 *
 * **Never throws, and answers `false` when it cannot ask.** The three passes
 * that take this are the three nobody is waiting on, and the failure it refuses
 * is the sharp one: during an outage their spend would be not merely unbounded
 * but *unrecorded*, because `reportTurn` fails at the same moment and for the
 * same reason. The argument for that direction is written out in
 * `session/summarize.ts`, beside the gate it governs.
 *
 * The two failures are logged apart on purpose. A refusal is the steady state
 * for a channel that is over its caps or has no sheet, and a `warn` per message
 * would be noise; a question that could not be asked at all is what an operator
 * needs when they come looking for why summarization stopped.
 */
const maySpend = async (channel: string): Promise<boolean> => {
  let refusal;
  try {
    refusal = await createProxyBudgetClient({ transport, channel }).status(tasks.signal);
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

// The quiescence sweep (#231). Built here rather than in compose.ts because it
// needs the completion client, the embedding client and the spend sender, none
// of which that file holds.
//
// It reads the same resolver every task reads, so `[memory] summarize` and the
// idle threshold are as fresh for a sweep as they are for a reply, and a channel
// with no sheet summarizes nothing.
const summarize = createSummarySweep({
  completion,
  embedding: embeddings,
  ...(embedding === null ? {} : { embeddingModel: embedding.model }),
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
  signal: tasks.signal,
  logger
});

// The one embedding of a task's question (#292), sharing the sweep's meter path:
// an embedding call is spend whether it was spent writing the corpus or reading
// it. Built once and handed to the router, which calls it once per task and
// gives the vector to both retrievers — see `session/embed.ts` on why this is a
// call site rather than a cache.
const embed = createQueryEmbedder({
  embedding: embeddings,
  ...(embedding === null ? {} : { embeddingModel: embedding.model }),
  reportTurn,
  logger
});

// Semantic recall (#232). It embeds nothing of its own since #292 — what it
// takes is the vector above, so a deployment with no embedding provider gets a
// null and no summaries, which is #230's stated degradation unchanged.
const recall = createRecall({ logger });

// Skill retrieval (#292). No embedding client and no meter: the vector arrives
// as an argument, and with none it retrieves on full text alone, which the team
// sheet says is the behaviour rather than a setting.
const skillRecall = createSkillRecall({ logger });

// How a channel's `skills/` directory is opened. Hoisted out of the dependency
// object below because two things need it now: the router, per task, and the
// embedding pass, per sweep. One opener, so both reach the same directory under
// the same rules.
const skills = createSkillFilesOpener({ storeRoot, channelsRoot, logger });

// The skill-embedding pass (#305), which is what gives skill retrieval its
// second leg: `reconcileSkillIndex` writes no vector, so without this
// `nearest(…, "skill")` answers nothing and the hybrid fusion runs on full text.
// Built here beside the sweep and for its reasons — the embedding client and the
// spend reporter are this file's.
//
// It reads the same resolver every task reads, so `[skills] enabled` and
// `max_skills` are as fresh for a pass as they are for a reply, and a channel
// with no sheet embeds nothing.
const embedSkills = createSkillEmbedSweep({
  embedding: embeddings,
  ...(embedding === null ? {} : { embeddingModel: embedding.model }),
  files: skills,
  settings: async channel => {
    const settings = await sheets(channel);
    return {
      enabled: settings.skills.enabled,
      maxSkills: settings.skills.maxSkills,
      // Both modes, unsplit — the pool opener filters. Read whatever `enabled`
      // says, because it gates the channel leg of the pool and never the pool.
      sharedSkills: settings.sharedSkills
    };
  },
  sharedPool: sharedSkillPool,
  reportTurn,
  maySpend,
  signal: tasks.signal,
  logger
});

// The skill lifecycle job (#294): the stale and archive clocks, on channel
// activity beside the two passes above.
//
// **No `reportTurn` and no `maySpend`, and that is the point rather than an
// omission.** This is the first background pass in the process that holds
// nothing it could spend with — no completion client, no embedding client, no
// meter, and since #335 no way to ask about a budget either — so "deterministic,
// no model call" is a fact about what was wired rather than a promise the module
// makes. The two absences are one fact from both sides: a pass with nothing to
// spend has nothing to ask about. Anyone adding either here should treat that as
// the question.
//
// Same resolver and same opener as the pass above, so `[skills] enabled` is as
// fresh for a clock as it is for a reply, and a channel with no sheet ages
// nothing.
const lifecycleSkills = createSkillLifecyclePass({
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
  signal: tasks.signal,
  logger
});

/**
 * How a channel's `proposals/` directory is opened.
 *
 * One opener rather than two, because two consumers now reach this directory and
 * they are the two halves of one loop: the curator writes a proposal here
 * (#295), and the heartbeat is what finally tells the channel it is waiting
 * (#320). A second opener would be a second answer to where a proposal lives.
 */
const proposals = createSkillProposalsOpener({ storeRoot, channelsRoot, logger });

// The merge curator (#295): one model call a day, per channel, about the two
// playbooks the index says are closest to each other — and a file in
// `proposals/` that a person reads and applies, or deletes.
//
// Built here rather than in compose.ts because it needs the completion client
// and the spend reporter, which is `summarize`'s reason and not the lifecycle
// job's: that one is deliberately wired without either.
//
// It shares the `skills` opener with the two passes above and gets its own for
// `proposals/`, which is a sibling directory rather than a child — anything
// inside `skills/` whose name parses is a retrievable skill, and a proposal
// quoting two playbooks must never become a third.
const curateSkills = createSkillCuratePass({
  completion,
  sharedSkills,
  files: skills,
  proposals,
  settings: async channel => {
    const settings = await sheets(channel);
    return {
      // The operator's own text, carried to every turn that composes something
      // (#450). The reader below is what turns it into a region.
      standing: {
        description: settings.description,
        sharedSkills: settings.sharedSkills,
        maxAlwaysSkills: settings.skills.maxAlwaysSkills,
        maxAlwaysChars: settings.skills.maxAlwaysChars
      },
      enabled: settings.skills.enabled,
      curate: settings.skills.curate,
      maxSkills: settings.skills.maxSkills,
      model: settings.model,
      maxTokens: settings.caps.maxOutputTokensPerTurn
    };
  },
  reportTurn,
  maySpend,
  signal: tasks.signal,
  logger
});

/**
 * The heartbeat evaluation (#319), as a factory over the one thing this process
 * can speak with.
 *
 * A factory rather than a built pass, unlike the four above, and the reason is
 * `ServerDeps.heartbeat`'s: the poster does not exist until `createServer` calls
 * the `slack` factory, so building it out here would mean handing the capability
 * back out to this file — where everything else this process constructs could
 * reach it. This closure is the only thing that ever sees one.
 *
 * It takes the same `reportTurn` and `maySpend` the on-activity passes take,
 * because a heartbeat is spend on a clock exactly as they are spend on traffic.
 */
const heartbeat = (post: ProactivePoster): AmbientHeartbeat =>
  createAmbientHeartbeat({
    completion,
    sharedSkills,
    post,
    settings: async channel => {
      const settings = await sheets(channel);
      return {
      // The operator's own text, carried to every turn that composes something
      // (#450). The reader below is what turns it into a region.
      standing: {
        description: settings.description,
        sharedSkills: settings.sharedSkills,
        maxAlwaysSkills: settings.skills.maxAlwaysSkills,
        maxAlwaysChars: settings.skills.maxAlwaysChars
      },
        enabled: settings.ambient.enabled,
        answerAfterIdleMs: settings.ambient.answerAfterIdleMs,
        model: settings.model,
        maxTokens: settings.caps.maxOutputTokensPerTurn
      };
    },
    reportTurn,
    maySpend,
    // The deferred half of phase 3 (#320): the curator writes a proposal to this
    // directory because nothing could reach a channel, and the heartbeat is what
    // finally can. The same opener the curator writes through, so the file a
    // person is pointed at is the file that was written.
    proposals,
    signal: tasks.signal,
    logger
  });

/**
 * Running a due scheduled check (#324), as a second factory over the same thing.
 *
 * `heartbeat` above and its reasons, with one difference worth naming: it takes
 * no `proposals`. A merge proposal is housekeeping the heartbeat mentions when it
 * happens to be speaking; a check is a question somebody asked, and folding an
 * unrelated notice into its one post would answer them together.
 *
 * The same `reportTurn` and `maySpend`, because a check is spend on a clock in
 * exactly the way a heartbeat is — and `maySpend` is what makes a capped channel
 * spend nothing and still be told its check did not run.
 */
const fireTask = (post: ProactivePoster): AmbientTaskFire =>
  createAmbientTaskFire({
    completion,
    sharedSkills,
    post,
    settings: async channel => {
      const settings = await sheets(channel);
      return {
      // The operator's own text, carried to every turn that composes something
      // (#450). The reader below is what turns it into a region.
      standing: {
        description: settings.description,
        sharedSkills: settings.sharedSkills,
        maxAlwaysSkills: settings.skills.maxAlwaysSkills,
        maxAlwaysChars: settings.skills.maxAlwaysChars
      },
        enabled: settings.ambient.enabled,
        model: settings.model,
        maxTokens: settings.caps.maxOutputTokensPerTurn
      };
    },
    reportTurn,
    maySpend,
    signal: tasks.signal,
    logger
  });

/**
 * Firing a due standing rule (#461), as a third factory over the same thing.
 *
 * `fireTask` above and its reasons. The one difference is what the settings carry:
 * a rule needs no idle threshold and no ticket, so what it resolves is the same
 * set a check does — which is the point, since the two run one turn.
 */
const fireRule = (post: ProactivePoster): AmbientRuleFire =>
  createAmbientRuleFire({
    completion,
    sharedSkills,
    post,
    settings: async channel => {
      const settings = await sheets(channel);
      return {
        // The operator's own text, carried to every turn that composes something
        // (#450). The reader below is what turns it into a region.
        standing: {
          description: settings.description,
          sharedSkills: settings.sharedSkills,
          maxAlwaysSkills: settings.skills.maxAlwaysSkills,
          maxAlwaysChars: settings.skills.maxAlwaysChars
        },
        enabled: settings.ambient.enabled,
        model: settings.model,
        maxTokens: settings.caps.maxOutputTokensPerTurn
      };
    },
    reportTurn,
    maySpend,
    signal: tasks.signal,
    logger
  });

const { gateway, ambient } = createServer({
  // The one thing this process supplies that a test does not: the real socket
  // and the real Web API client, built from the two tokens. `onFatal` stays
  // here with them, because what it does is exit.
  slack: ({ handler, onDecision, onMessage, onRevision }) =>
    // `createSlackSurface` returns `users` alongside `gateway` and `cards`, and
    // the whole object is what `SlackSurfaceLike` reads — so the directory is
    // wired by returning it rather than by naming it here.
    createSlackSurface({
      appToken,
      botToken,
      handler,
      onDecision,
      onMessage,
      onRevision,
      logger,
      // The socket died for a reason retrying cannot fix — a revoked or rotated
      // token. Exiting is the honest outcome: the alternative is a process that
      // is up, healthy to every probe, and will never answer another mention.
      // Under compose, `restart: unless-stopped` picks it back up, which is what
      // makes a rotated token recover on its own once the environment is fixed.
      onFatal: error => {
        logger.log("error", { event: "gateway_dead", reason: error.reason });
        process.exit(1);
      }
    }),
  completion,
  transport,
  sheets: sheets,
  store: createMessageStoreOpener({ storeRoot, channelsRoot, logger }),
  // What the ambient clock enumerates (#317): the channels an operator
  // provisioned, read out of the same root the sheets come from. A listing and
  // nothing more — this process must never write there.
  channels: createChannelLister({ channelsRoot, logger }),
  heartbeat,
  fireTask,
  fireRule,
  memory: createMemoryFileOpener({ storeRoot, channelsRoot, logger }),
  skills,
  summarize,
  embedSkills,
  lifecycleSkills,
  curateSkills,
  recall,
  embed,
  skillRecall,
  sharedSkills,
  sharedSkillPool,
  signal: tasks.signal,
  logger
});

// Rejects on credentials Slack will never accept — which is a startup failure,
// not something to retry.
//
// Caught rather than left to Node, and this is the reason: an uncaught
// rejection prints the error *and its whole cause chain*, and a GatewayError
// carries the SDK error that produced it as `cause`. That is precisely what
// `GatewayError` keeps out of its own fields — a `WebAPIHTTPError` holds
// response headers, and the Socket Mode client's requests carry a bearer
// token. The reason code is what an operator needs; the chain is what leaks.
try {
  await gateway.start();
} catch (error) {
  logger.log("error", {
    event: "startup_failed",
    reason: error instanceof GatewayError ? error.reason : "connect_failed"
  });
  process.exit(1);
}

// The ambient clock (#317), started only now — after the socket is up, because
// what it needs from the gateway is the workspace, and that arrives with
// `auth.test` inside `start()`. Starting it earlier would cost every enabled
// channel a scan or two saying it does not know where it is installed.
//
// `undefined` only for a composition given no channel lister; this one always
// supplies one. Nothing awaits it and a failing scan costs nothing here — it is
// a clock, and this process answers mentions with or without one.
ambient?.start();

/**
 * How long shutdown waits for cancelled tasks to finish unwinding (#118).
 *
 * A constant rather than a variable, because the number is a property of this
 * shutdown path and not of a deployment: it is sized from the two things a
 * cancelled task still does on its way out, both of which carry their own
 * deadlines. `DEFAULT_SPEND_TIMEOUT_MS` is five seconds, and the checklist's
 * terminal edit is one Slack call. Eight seconds covers both without waiting
 * on a rate-limited retry nobody is reading the answer of.
 *
 * **It is not how long a task can take.** A task's own bound is the channel's
 * `max_task_seconds`, five minutes by default, and no drain worth having is
 * that long — `deploy/docker-compose.yml` sets `stop_grace_period: 20s` and
 * SIGKILL follows it. This waits out the accounting, not the work; what a
 * mid-turn task loses is its answer, which it lost before this too.
 */
const SHUTDOWN_DRAIN_MS = 8_000;

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) {
      // A second signal is an operator done waiting, and it cuts the drain
      // below short. Exiting with a session's `store.db` still open is safe
      // rather than merely tolerable: the store runs in WAL with
      // `synchronous = FULL`, so a committed row survives a hard kill and an
      // uncommitted one was one synchronous statement that either ran or did
      // not. Nothing is buffered waiting for a `close()`.
      //
      // What it costs is what the drain was about to save: the spend report of
      // whatever turn each in-flight task was reporting, and a checklist card
      // left reading `WORKING`. The meter under-reports in that case rather
      // than over-reports — the budget fails open, bounded by the tasks running
      // at that moment, and the loop's own token cap and the proxy's tool-call
      // meter are what still bite.
      process.exit(1);
    }
    closing = true;
    logger.log("info", { event: "shutting_down", reason: signal });
    // Cancel first, then close the socket. The other order leaves tasks running
    // against the provider with nowhere to post: `stop()` already refuses to
    // post a reply that arrives after it, so those tokens would be spent on
    // answers nobody ever sees.
    //
    // Then wait for what the cancel started (#118). A cancelled task still
    // unwinds — the turn it had already completed is reported to the meter, and
    // its checklist card is repainted terminal — and both of those were being
    // killed by the `process.exit` below. The drain is bounded because the
    // alternative is not "wait longer", it is SIGKILL from the orchestrator.
    //
    // **Shutdown is still quiet.** Nothing here lets a task post an answer: the
    // gateway refuses to post once stopped, and a cancelled task has no reply
    // to post anyway. What drains is the accounting, and a task that was
    // mid-turn loses its answer exactly as it did before.
    tasks.abort();
    // And stop the clock, so nothing new is enumerated into a process that is
    // going away. In-flight heartbeats unwind on the signal above with every
    // other task; this only cancels the pending sleep, which is what would
    // otherwise start a scan during the drain.
    ambient?.stop();
    void gateway.stop({ drainMs: SHUTDOWN_DRAIN_MS }).then(() => {
      process.exit(0);
    });
  });
}
