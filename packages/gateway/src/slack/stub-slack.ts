// A Slack workspace that is not one.
//
// Shipped rather than kept in a test file, for the same reason
// `packages/agent`'s stub tool source is: the hello-world agent should be
// demonstrable with no workspace, no tokens, and no socket, and the mock Slack
// harness should be a harness *over* this rather than a second implementation
// of it. Neither half reaches the network and neither holds a credential.
//
// It fakes at the SocketSource/SlackPoster seam and delivers raw envelopes,
// so normalization runs for real — a stub that handed down an already-clean
// SlackMention or SlackDecision would skip the one step whose job is to fail
// closed.

import type { ApprovalVerdict } from "@getlibero/schema";
import { actionIdForVerdict } from "./approval-ids.js";
import type {
  PostedCard,
  SlackCard,
  SlackEnvelope,
  SlackInteractionEnvelope,
  SlackPoster,
  SocketSource,
  UserDirectory
} from "./types.js";

export interface StubMentionFields {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  eventId: string;
}

export interface StubMessageFields {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  /**
   * The parent thread, when there is one. Absent means top-level — the
   * distinction `toMessage` preserves and `toMention` cannot, so it has to be
   * expressible here by omission rather than by a null.
   */
  threadTs?: string;
  /** `thread_broadcast`, `file_share`, `channel_join`, `message_changed`, … */
  subtype?: string;
  /** Present on a message an app posted. Set it to build one this app must drop. */
  botId?: string;
  eventId: string;
}

export interface StubDecisionFields {
  teamId: string;
  channelId: string;
  /** Who clicked. */
  userId: string;
  ticketId: string;
  verdict: ApprovalVerdict;
  /** The card's own ts — what an edit would target. */
  messageTs: string;
  threadTs?: string;
}

const DEFAULT_MENTION: StubMentionFields = {
  teamId: "T00000000",
  channelId: "C00000000",
  userId: "U00000000",
  text: "<@U0BOTBOTB> hello",
  ts: "1717171717.000100",
  eventId: "Ev00000001"
};

/** The envelope shape Slack sends for an `app_mention`, built from fields. */
export function appMentionEnvelope(
  fields: Partial<StubMentionFields> = {},
  ack: () => Promise<void> = () => Promise.resolve()
): SlackEnvelope {
  const merged = { ...DEFAULT_MENTION, ...fields };
  return {
    ack,
    event: {
      type: "app_mention",
      user: merged.userId,
      text: merged.text,
      ts: merged.ts,
      channel: merged.channelId,
      ...(merged.threadTs !== undefined ? { thread_ts: merged.threadTs } : {})
    },
    body: {
      team_id: merged.teamId,
      event_id: merged.eventId,
      type: "event_callback"
    }
  };
}

const DEFAULT_MESSAGE: StubMessageFields = {
  teamId: "T00000000",
  channelId: "C00000000",
  userId: "U00000000",
  text: "the deploy went out at four",
  // A different ts from DEFAULT_MENTION, so a test that delivers both does not
  // get one silently swallowed by the store's UNIQUE ts.
  ts: "1717171717.000300",
  eventId: "Ev00000002"
};

/** The envelope shape Slack sends for a `message`, built from fields. */
export function messageEnvelope(
  fields: Partial<StubMessageFields> = {},
  ack: () => Promise<void> = () => Promise.resolve()
): SlackEnvelope {
  const merged = { ...DEFAULT_MESSAGE, ...fields };
  return {
    ack,
    event: {
      type: "message",
      user: merged.userId,
      text: merged.text,
      ts: merged.ts,
      channel: merged.channelId,
      channel_type: "channel",
      ...(merged.threadTs !== undefined ? { thread_ts: merged.threadTs } : {}),
      ...(merged.subtype !== undefined ? { subtype: merged.subtype } : {}),
      ...(merged.botId !== undefined ? { bot_id: merged.botId } : {})
    },
    body: {
      team_id: merged.teamId,
      event_id: merged.eventId,
      type: "event_callback"
    }
  };
}

const DEFAULT_DECISION: StubDecisionFields = {
  teamId: "T00000000",
  channelId: "C00000000",
  userId: "U0HUMAN00",
  ticketId: "ticket-00000001",
  verdict: "approve",
  messageTs: "1717171717.000200"
};

/**
 * The payload shape Slack sends for a button click, built from fields.
 *
 * Raw, and complete enough to be worth reading defensively against: it carries
 * the `response_url` and the legacy verification `token` a real payload has, so
 * the tests that assert neither of them ever reaches a decision or a log line
 * have something real to catch.
 */
export function blockActionsEnvelope(
  fields: Partial<StubDecisionFields> = {},
  ack: () => Promise<void> = () => Promise.resolve()
): SlackInteractionEnvelope {
  const merged = { ...DEFAULT_DECISION, ...fields };
  return {
    ack,
    body: {
      type: "block_actions",
      token: "legacy-verification-token",
      response_url: "https://hooks.slack.com/actions/T00000000/1234/RESPONSEURLSECRET",
      trigger_id: "1234.5678.abcdef",
      team: { id: merged.teamId, domain: "example" },
      user: { id: merged.userId, username: "someone", team_id: merged.teamId },
      channel: { id: merged.channelId, name: "engineering" },
      container: {
        type: "message",
        message_ts: merged.messageTs,
        channel_id: merged.channelId,
        ...(merged.threadTs !== undefined ? { thread_ts: merged.threadTs } : {})
      },
      message: {
        ts: merged.messageTs,
        ...(merged.threadTs !== undefined ? { thread_ts: merged.threadTs } : {})
      },
      actions: [
        {
          type: "button",
          action_id: actionIdForVerdict(merged.verdict),
          block_id: "block",
          value: merged.ticketId,
          action_ts: "1717171718.000000"
        }
      ]
    }
  };
}

export interface StubSlack {
  source: SocketSource;
  poster: SlackPoster;
  /** Who a user id is, from `StubSlackOptions.users`. */
  users: UserDirectory;
  /** Delivers a raw envelope exactly as the socket would. Resolves once dispatched. */
  deliver(envelope: SlackEnvelope): Promise<void>;
  /** Builds a well-formed `app_mention` envelope and delivers it. */
  deliverMention(fields?: Partial<StubMentionFields>): Promise<void>;
  /** Builds a `message` envelope and delivers it on the message listener. */
  deliverMessage(fields?: Partial<StubMessageFields>): Promise<void>;
  /** Delivers a raw interactive envelope exactly as the socket would. */
  deliverInteraction(envelope: SlackInteractionEnvelope): Promise<void>;
  /** Builds a well-formed `block_actions` envelope and delivers it. */
  deliverDecision(fields?: Partial<StubDecisionFields>): Promise<void>;
  /** Ends the connection the way a dropped socket does. */
  drop(): void;
  connected(): boolean;
  /** Every reply posted, in order. */
  readonly posted: Array<{ channelId: string; threadTs: string; text: string }>;
  /** Every card posted, in order, with the ts the stub gave it. */
  readonly cards: Array<PostedCard & { threadTs: string; card: SlackCard }>;
  /** Every card edit, in order. */
  readonly edits: Array<{ channelId: string; messageTs: string; card: SlackCard }>;
  /**
   * The card currently showing at a ts — the last edit, or the original post.
   * One line for "the card is green now", which is the assertion most tests
   * actually want.
   */
  cardAt(messageTs: string): SlackCard | undefined;
  /** Every envelope that was acknowledged, in order. */
  readonly acked: Array<SlackEnvelope | SlackInteractionEnvelope>;
  /**
   * Every user id looked up, in order, including repeats.
   *
   * In order and unfiltered because the assertion this exists for is about
   * *how many times*: a cache that resolves a name once per session and one
   * that resolves it once per message return identical transcripts, and this
   * array is the only thing that tells them apart.
   */
  readonly lookups: string[];
}

export interface StubSlackOptions {
  /**
   * Errors to throw from successive `connect()` calls, oldest first. An entry of
   * `undefined` connects. Exhausted entries connect. Lets a test drive the
   * reconnect ladder without a socket that can actually fail.
   */
  connectFailures?: Array<unknown>;
  /** Thrown by every `postThreadReply`. */
  postFailure?: unknown;
  /** Thrown by every `postCard`. */
  cardPostFailure?: unknown;
  /** Thrown by every `updateCard`. */
  cardUpdateFailure?: unknown;
  /**
   * The workspace's directory, as ids to names. Anyone absent has no name.
   *
   * An id with no entry answers `undefined` rather than a plausible name, for
   * the reason `updateCard` rejects an unknown ts: a stub that invented one
   * would let a test pass while the real thing rendered something nobody is
   * called. A departed user is a real state and this is how a test states it.
   */
  users?: Record<string, string>;
  /** Thrown by every `displayName`, so a test can drive a failed lookup. */
  userLookupFailure?: unknown;
}

export function createStubSlack(options: StubSlackOptions = {}): StubSlack {
  const posted: Array<{ channelId: string; threadTs: string; text: string }> = [];
  const cards: Array<PostedCard & { threadTs: string; card: SlackCard }> = [];
  const edits: Array<{ channelId: string; messageTs: string; card: SlackCard }> = [];
  const acked: Array<SlackEnvelope | SlackInteractionEnvelope> = [];
  const lookups: string[] = [];
  const connectFailures = [...(options.connectFailures ?? [])];

  /** The card showing at each ts. Updated by a post and by every edit. */
  const showing = new Map<string, SlackCard>();
  let nextCard = 0;

  let listener: ((envelope: SlackEnvelope) => Promise<void>) | undefined;
  let messageListener: ((envelope: SlackEnvelope) => Promise<void>) | undefined;
  let interactionListener:
    | ((envelope: SlackInteractionEnvelope) => Promise<void>)
    | undefined;
  let dropListener: (() => void) | undefined;
  let isConnected = false;

  const source: SocketSource = {
    connect(): Promise<void> {
      const failure = connectFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      isConnected = true;
      return Promise.resolve();
    },
    close(): Promise<void> {
      isConnected = false;
      return Promise.resolve();
    },
    onMention(next: (envelope: SlackEnvelope) => Promise<void>): void {
      listener = next;
    },
    // Its own slot rather than the mention one, so a test can prove the socket
    // keeps the two apart — a stub that fanned one listener out to both would
    // hide exactly the bug that matters, a mention reaching the message path.
    onMessage(next: (envelope: SlackEnvelope) => Promise<void>): void {
      messageListener = next;
    },
    onInteraction(next: (envelope: SlackInteractionEnvelope) => Promise<void>): void {
      interactionListener = next;
    },
    onDrop(next: () => void): void {
      dropListener = next;
    }
  };

  const poster: SlackPoster = {
    postThreadReply(target): Promise<void> {
      if (options.postFailure !== undefined) return Promise.reject(options.postFailure);
      posted.push({ ...target });
      return Promise.resolve();
    },

    postCard(target): Promise<PostedCard> {
      if (options.cardPostFailure !== undefined) {
        return Promise.reject(options.cardPostFailure);
      }
      // Deterministic, so a test can name the ts it expects to see edited. The
      // real adapter's contract is that a card you cannot edit is a failed
      // post, so this always has one.
      nextCard += 1;
      const messageTs = `1717171717.0001${String(nextCard).padStart(2, "0")}`;
      cards.push({ channelId: target.channelId, messageTs, threadTs: target.threadTs, card: target.card });
      showing.set(messageTs, target.card);
      return Promise.resolve({ channelId: target.channelId, messageTs });
    },

    updateCard(target): Promise<void> {
      if (options.cardUpdateFailure !== undefined) {
        return Promise.reject(options.cardUpdateFailure);
      }
      // Editing a message the stub never posted is the mistake a live
      // workspace would catch, so this catches it too. A stub that quietly
      // recorded an edit against nothing would let a test pass while the real
      // thing edited someone else's message, or nothing at all.
      if (!showing.has(target.messageTs)) {
        return Promise.reject(new Error(`no card at ts ${target.messageTs}`));
      }
      edits.push({ ...target });
      showing.set(target.messageTs, target.card);
      return Promise.resolve();
    }
  };

  const users: UserDirectory = {
    displayName(userId: string): Promise<string | undefined> {
      // Recorded before the failure check, so a test asserting on a failing
      // lookup can still see that it was attempted — and, more to the point,
      // that a cache did not attempt it twice.
      lookups.push(userId);
      if (options.userLookupFailure !== undefined) {
        return Promise.reject(options.userLookupFailure);
      }
      return Promise.resolve(options.users?.[userId]);
    }
  };

  return {
    source,
    poster,
    users,
    lookups,
    posted,
    cards,
    edits,
    acked,
    cardAt(messageTs: string): SlackCard | undefined {
      return showing.get(messageTs);
    },
    async deliver(envelope: SlackEnvelope): Promise<void> {
      await listener?.(envelope);
    },
    async deliverMention(fields: Partial<StubMentionFields> = {}): Promise<void> {
      const envelope = appMentionEnvelope(fields, () => {
        acked.push(envelope);
        return Promise.resolve();
      });
      await listener?.(envelope);
    },
    async deliverMessage(fields: Partial<StubMessageFields> = {}): Promise<void> {
      const envelope = messageEnvelope(fields, () => {
        acked.push(envelope);
        return Promise.resolve();
      });
      await messageListener?.(envelope);
    },
    async deliverInteraction(envelope: SlackInteractionEnvelope): Promise<void> {
      await interactionListener?.(envelope);
    },
    async deliverDecision(fields: Partial<StubDecisionFields> = {}): Promise<void> {
      const envelope = blockActionsEnvelope(fields, () => {
        acked.push(envelope);
        return Promise.resolve();
      });
      await interactionListener?.(envelope);
    },
    drop(): void {
      isConnected = false;
      dropListener?.();
    },
    connected(): boolean {
      return isConnected;
    }
  };
}
