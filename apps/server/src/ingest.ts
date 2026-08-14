// The message path: a `SlackMessage` becomes a `StoredMessage`, and sometimes a
// `TaskRequest`. Its second half is the revision path, where a `SlackRevision`
// becomes a delete or a reindex against the same store.
//
// The sibling of handler.ts, and here for the same reason. It names both a
// Slack type and a session, which is exactly the pair `src/session/**`'s ESLint
// rule forbids in one file — so the mapping lives out here, above the seam, and
// the router below it goes on not knowing what Slack is.
//
// Two things happen to a message and they are independent. Every message that
// gets this far is **filed**. A message in a thread the agent is working in is
// also **answered** (#66), which means the same `TaskRequest` a mention
// produces, through the same router, on the same mutex. Everywhere else in the
// channel still needs a mention, so this is a second door into a session rather
// than a way past the one that was already there.
//
// **Nothing here decides how long a thread stays answerable.** It asks the
// session, which was told by the task that last ran there, which read the
// channel's sheet. That is what keeps this path from needing a sheet of its
// own — a read per message rather than a read per task.

import type {
  Logger,
  MessageHandler,
  RevisionHandler,
  SlackMessage,
  SlackReply,
  SlackRevision
} from "@getlibero/gateway";
import { createSilentLogger } from "@getlibero/gateway";
import type { HeldCallPrompter } from "@getlibero/agent";
import type { PromptTarget } from "./approvals/prompter.js";
import type { ChecklistReporter, ChecklistTarget } from "./checklist/checklist.js";
import type { DisplayNameLookup } from "./session/names.js";
import type { SessionRegistry } from "./session/registry.js";
import type { SummarySweep } from "./session/summarize.js";
import type { ChannelRouter } from "./session/router.js";

export interface MessageIngestOptions {
  sessions: SessionRegistry;
  /**
   * How the author's name is found, for the snapshot stored beside the message.
   *
   * Optional: without one every row stores `null`, which is what #176 did and
   * is a store that still works. The snapshot and the context assembler's live
   * resolution answer different questions — "what were they called when this
   * was said" against "what are they called today" — and this is the first,
   * which is the only attribution available to a reader holding no Slack token.
   */
  names?: DisplayNameLookup;
  /**
   * Where a follow-up goes.
   *
   * Optional, and its absence is the pre-#66 behaviour rather than a broken
   * wiring: messages are filed and never answered, which is a front-end that
   * records a conversation without joining it. A composing app that wants
   * follow-ups passes the same router the mention handler was built on — the
   * same one, deliberately, because two routers would be two session
   * registries and therefore two mutexes over one channel.
   */
  route?: ChannelRouter;
  /**
   * Where an approval card goes for a call a follow-up's task held.
   *
   * Optional on the same terms it is for a mention: a front-end with no one to
   * ask gets the refusal-shaped result instead. A follow-up's card belongs in
   * the thread the follow-up is in, which is why this is applied here rather
   * than shared with handler.ts — the two capture different threads.
   *
   * It may answer `undefined` per call, which `HeldCallPrompterFactory` does
   * not. That is compose.ts's knot rather than a second kind of optional: the
   * card poster is built *after* this handler, so "is there anyone to ask" can
   * only be answered when a card is actually wanted.
   */
  onHeld?: (target: PromptTarget) => HeldCallPrompter | undefined;
  /**
   * The quiescence sweep (#231), run after this message has been filed.
   *
   * Here rather than in the router, because a thread goes quiet through nothing
   * happening — which no event fires for — so the only reliable moment to look
   * is when something else happens in the channel. Every inbound message is that
   * moment; the sweep's own interval is what stops it looking on each one.
   *
   * Optional, and its absence is a deployment with no thread summaries: memory
   * Layers 1 and 2 are whole without them.
   */
  summarize?: SummarySweep;
  /**
   * Where a follow-up's checklist goes. Optional per call for `onHeld`'s
   * reason and answered by the same knot in compose.ts — the card poster is
   * built after this handler is.
   *
   * A follow-up gets its own card in its own thread. Sharing one with the
   * mention that started the thread would mean editing a message from a
   * finished task, and a reader would watch a completed checklist reopen.
   */
  checklist?: (target: ChecklistTarget) => ChecklistReporter | undefined;
  logger?: Logger;
  /** Injected so a test states the clock rather than faking timers. */
  now?: () => number;
}

/**
 * Wraps the session registry as the handler the gateway hands messages to.
 *
 * **The store write does not take the session's mutex, deliberately.** The
 * mutex serializes model turns so a channel's tasks queue rather than
 * interleave; a store write is one synchronous statement with nothing to
 * serialize, and SQLite's own WAL and busy timeout are the concurrency control
 * for the file. Behind the mutex, a message arriving mid-task would wait out a
 * model turn — up to the channel's whole wall-clock cap — to be written, which
 * is the opposite of what a transcript is for.
 *
 * **The follow-up does take it**, because it is a model turn like any other.
 * That ordering is the whole reason the write comes first: by the time the task
 * starts, the message that provoked it is already a row, so the transcript the
 * task assembles is complete rather than missing the thing it was asked about.
 *
 * It opens the session either way, so a message in a channel with nothing
 * running is still written, and so the open file handle has an owner with a
 * lifetime.
 *
 * Nothing is deduplicated here. The store's `ts` is UNIQUE and its insert is
 * `ON CONFLICT DO NOTHING`, so a redelivered event is a no-op that returns
 * false — and that is the authoritative key, being the message's own identity
 * and surviving a restart, which the gateway's `seen` set does not.
 *
 * **It does await one thing before the write, and that is new.** Resolving the
 * author's name is a Slack call, so this path can now be slow and can now fail
 * in a way it could not before. Both are bounded: the session's cache makes it
 * one call per author per session and shares an in-flight one between
 * concurrent messages, and a failed lookup stores no name rather than dropping
 * the message. The `append` still happens either way.
 */
export function createMessageIngest(options: MessageIngestOptions): MessageHandler {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;
  const names = options.names;
  const route = options.route;
  const onHeld = options.onHeld;
  const summarize = options.summarize;

  return async (message: SlackMessage): Promise<SlackReply | undefined> => {
    const session = options.sessions.open({
      // Slack's word for the workspace is `team_id`; the router's is
      // `workspace`, and this is the same translation handler.ts makes.
      workspace: message.teamId,
      channel: message.channelId
    });

    // No store: no team sheet, or the file could not be opened. Said once when
    // the session was created, and silent per message after that.
    //
    // It skips the write and not the answer. A channel with an unreadable store
    // can still have a thread the agent worked in, and refusing to answer a
    // follow-up there would turn a storage failure into the agent going silent
    // mid-conversation — the task would simply run with no history, which is
    // what a first mention in that channel already does.
    if (session.store !== null) {
      // The author's name as of now, cached on the session — so this is one
      // Slack call per author per session and not one per message, and two
      // messages from the same new author share one in-flight lookup rather
      // than making two. `undefined` when there is no name to have or the
      // lookup failed, and neither costs the message: the row is stored either
      // way.
      const displayName =
        names === undefined ? undefined : await session.names.get(message.userId, names);

      try {
        session.store.append({
          ts: message.ts,
          threadTs: message.threadTs,
          userId: message.userId,
          // A snapshot, not a lookup: what the author was called when this was
          // said. It is deliberately not refreshed later, and the assembler's
          // live resolution is a different question with a different answer for
          // anyone who has since changed their name or left.
          displayName: displayName ?? null,
          text: message.text,
          // When this store learned of the message, not when it was sent — the
          // field's own definition. `message.ts` is the sent time and is stored
          // beside it.
          at: now()
        });
      } catch (error) {
        // One message lost, and the process carries on. The gateway would log
        // `message_failed` for a rejection, but this is the layer that knows it
        // was the store, and a channel's members do not want to be told in the
        // channel that their message was not filed.
        logger.log("error", {
          event: "store_write_failed",
          channel: message.channelId,
          eventId: message.eventId,
          reason: error instanceof Error ? error.name : "unknown"
        });
      }

      // The quiescence sweep (#231), queued and deliberately not awaited.
      //
      // **On the session mutex**, for the reason curation is: it reads the store
      // and writes summaries to it, and a task's context read has to be
      // serialized against that rather than racing it.
      //
      // **Not awaited**, because nothing is waiting on it and everything is
      // waiting on this handler — a follow-up's reply, and the Slack event
      // acknowledgement behind it, must not sit behind a model call about some
      // other thread.
      //
      // **After the append**, so the message that just arrived is part of the
      // thread it belongs to before anything decides that thread has gone quiet.
      //
      // `void` and a `.catch` that swallows, unlike curation's bare `void`: the
      // sweep is documented never to reject, and this is the one place in the
      // process where a broken promise would reach an unhandled rejection with
      // no task to attribute it to.
      if (summarize !== undefined) {
        const store = session.store;
        void session.mutex.run(() => summarize(message.channelId, store)).catch(() => {});
      }
    }

    // Three conditions on the way to answering, and each rules out a different
    // way of getting this wrong.
    //
    // **It must be in a thread.** `threadTs` is the raw value, so `null` means
    // top-level — not a reply to anything the agent said, and with nowhere to
    // put an answer, since the gateway refuses to start a thread on a message
    // nobody addressed it in.
    //
    // **It must not mention the app.** A message that does arrives *twice*,
    // once here and once as an `app_mention`, with a different `event_id` on
    // each — so nothing downstream can tell the pair apart, and answering both
    // runs the task twice, spends the channel's budget twice, and posts two
    // replies. The `app_mention` copy is the one that gets answered, including
    // in a thread that is already active.
    //
    // **The thread must be one the agent is working in**, which is what makes
    // this a follow-up rather than the agent reading the whole channel. The
    // session holds that, with a deadline the channel's own sheet set.
    const thread = message.threadTs;
    if (route === undefined || thread === null) return undefined;
    if (message.mentionsApp) return undefined;
    if (!session.threads.isActive(thread, now())) return undefined;

    const held = onHeld?.({ channelId: message.channelId, threadTs: thread });
    const checklist = options.checklist?.({ channelId: message.channelId, threadTs: thread });

    const reply = await route({
      key: { workspace: message.teamId, channel: message.channelId },
      requestingUser: message.userId,
      thread,
      text: message.text,
      traceId: message.eventId,
      ...(held !== undefined ? { onHeld: held } : {}),
      ...(checklist !== undefined ? { checklist } : {})
    });

    return reply === undefined ? undefined : { text: reply.text };
  };
}

export interface RevisionIngestOptions {
  /**
   * The same registry the message ingest was built on, and it has to be: a
   * revision opens the session that holds the channel's store handle, and a
   * second registry would open the same file twice.
   */
  sessions: SessionRegistry;
  logger?: Logger;
}

/**
 * Wraps the session registry as the handler the gateway hands revisions to.
 *
 * Slack retention is the whole point. A message deleted in Slack is deleted
 * here, index entry included, and an edited one is reindexed — so what the store
 * holds is what the channel still holds, rather than a copy that quietly
 * outlives it. The store's half was built in #63; this is the events reaching
 * it.
 *
 * **An edit is not a way into the store.** `replaceText` answers false for a ts
 * the store does not hold and that is left as a no-op, deliberately, rather than
 * being turned into an insert. The store's rows are the messages the message
 * path agreed to record, and inserting on an edit would be a second write door
 * with none of the first one's filters — an app's own message, a `channel_join`,
 * a subtype the store declined, all of them recordable by being edited
 * afterwards. It also has an honest reading: a channel provisioned today has no
 * history from last week, and back-filling one message out of that week because
 * somebody fixed a typo in it is an arbitrary transcript rather than a fuller
 * one. The same answer for a deletion, for the simpler reason that there is
 * nothing to delete.
 *
 * **It does not take the session's mutex**, for the reason the message ingest
 * gives: the mutex serializes model turns, and this is one synchronous
 * statement whose concurrency control is SQLite's own.
 *
 * One ordering limit is worth stating rather than implying. The store is keyed
 * on `ts` and holds no tombstone, so a deletion that somehow arrived before the
 * message it deletes would find nothing and the message would then be stored by
 * the later event. Slack delivers a message before its own revision, so this
 * needs a redelivery to reorder them; the cost of closing it is a second table
 * that every read would have to consult, and that trade is not phase 1's.
 */
export function createRevisionIngest(options: RevisionIngestOptions): RevisionHandler {
  const logger = options.logger ?? createSilentLogger();

  return (revision: SlackRevision): Promise<void> => {
    const session = options.sessions.open({
      workspace: revision.teamId,
      channel: revision.channelId
    });

    // No store: no team sheet, or the file could not be opened. Said once when
    // the session was created, and silent per revision after that. A channel
    // that records nothing has nothing to retract.
    if (session.store === null) return Promise.resolve();

    try {
      // The return value is deliberately unused. False means the store never
      // held this ts, which is the ordinary case for any channel provisioned
      // after the conversation started — see above.
      if (revision.kind === "deleted") session.store.remove(revision.ts);
      else session.store.replaceText(revision.ts, revision.text);
    } catch (error) {
      // One revision lost and the process carries on, exactly as a failed
      // append loses one message. It is worth a line where the append's is,
      // because the consequence outlives the event: a delete that did not land
      // leaves retracted text in a file that the context assembler reads on
      // every turn, and nothing will try again.
      logger.log("error", {
        event: "store_write_failed",
        channel: revision.channelId,
        eventId: revision.eventId,
        revision: revision.kind,
        reason: error instanceof Error ? error.name : "unknown"
      });
    }
    return Promise.resolve();
  };
}
