// A Slack workspace that is not one.
//
// Shipped rather than kept in a test file, for the same reason
// `packages/agent`'s stub tool source is: the hello-world agent should be
// demonstrable with no workspace, no tokens, and no socket, and the mock Slack
// harness should be a harness *over* this rather than a second implementation
// of it. Neither half reaches the network and neither holds a credential.
//
// It fakes at the SocketSource/MessagePoster seam and delivers raw envelopes,
// so normalization runs for real — a stub that handed down an already-clean
// SlackMention would skip the one step whose job is to fail closed.

import type { MessagePoster, SlackEnvelope, SocketSource } from "./types.js";

export interface StubMentionFields {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  eventId: string;
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

export interface StubSlack {
  source: SocketSource;
  poster: MessagePoster;
  /** Delivers a raw envelope exactly as the socket would. Resolves once dispatched. */
  deliver(envelope: SlackEnvelope): Promise<void>;
  /** Builds a well-formed `app_mention` envelope and delivers it. */
  deliverMention(fields?: Partial<StubMentionFields>): Promise<void>;
  /** Ends the connection the way a dropped socket does. */
  drop(): void;
  connected(): boolean;
  /** Every reply posted, in order. */
  readonly posted: Array<{ channelId: string; threadTs: string; text: string }>;
  /** Every envelope that was acknowledged, in order. */
  readonly acked: SlackEnvelope[];
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
}

export function createStubSlack(options: StubSlackOptions = {}): StubSlack {
  const posted: Array<{ channelId: string; threadTs: string; text: string }> = [];
  const acked: SlackEnvelope[] = [];
  const connectFailures = [...(options.connectFailures ?? [])];

  let listener: ((envelope: SlackEnvelope) => Promise<void>) | undefined;
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
    onDrop(next: () => void): void {
      dropListener = next;
    }
  };

  const poster: MessagePoster = {
    postThreadReply(target): Promise<void> {
      if (options.postFailure !== undefined) return Promise.reject(options.postFailure);
      posted.push({ ...target });
      return Promise.resolve();
    }
  };

  return {
    source,
    poster,
    posted,
    acked,
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
    drop(): void {
      isConnected = false;
      dropListener?.();
    },
    connected(): boolean {
      return isConnected;
    }
  };
}
