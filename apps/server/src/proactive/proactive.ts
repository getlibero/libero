// The proactive post surface, and the window that governs it (#318).
//
// This is the first path in this process that can speak into a channel without
// an inbound event behind it. Everything else here answers something: a reply
// answers a mention, a card answers a held tool call, and both carry a
// `threadTs` because an event supplied one. The four background passes have
// lived without any of it — `../session/skill-curate.ts` writes a proposal to the
// filesystem and says outright that the review surface was forced rather than
// chosen, because nothing in this process could reach a channel.
//
// Something now can. What keeps that from becoming a general capability is not a
// rule anybody remembers: it is that `ProactivePoster` is minted in
// `../compose.ts` and handed to the ambient clock's heartbeat factory alone. The
// sweep, the skill-embed pass, the lifecycle job and the curator are constructed
// without one and cannot name the type. That is checkable by reading what each
// is given, which is the same discipline `packages/memory` gets from a store
// that closes over one file.
//
// ## Why it is here rather than under session/
//
// An ESLint block on `../session/**` lets four names through from
// `@getlibero/gateway`, and this file needs three others: the channel-post verb,
// the renderer, and the source union. That rule is not in the way — it is the
// reason this directory exists. `session/` is transport-neutral by construction
// (the router takes a `TaskRequest`, never a `SlackMention`), and anything that
// renders Slack sits beside it instead: `../checklist/checklist.ts` holds a
// `CardPoster` and a card renderer for exactly this reason, and
// `../approvals/prompter.ts` does the same. What crosses back into session-land
// is `ProactivePoster`, which names no Slack anything — a channel id, a string,
// and a wake reason.
//
// ## Two sources, and no adjective
//
// A post arrives here for one of two reasons, and they are governed in different
// places:
//
//   - A **heartbeat** decided something merits saying. Nothing authorized it but
//     a clock, so its bound lives here: the window below.
//   - A **task** fired at its due time (#324). Its creation was a served request
//     through the tool proxy service — allowlisted, held for approval by
//     default, capped, audited — so its bound lived at the create. One post per
//     firing, and the window neither blocks it nor is spent by it. A reminder is
//     not late because a heartbeat spoke first.
//
// The discriminant is the wake reason, spelled with the word list
// `../session/ambient.ts` already has: `DueEntry.kind` is `"heartbeat"` today and its
// header says the point of the field is that a due task adds a *member*. One
// vocabulary for the phase — what wakes the loop, what governs the post, and
// what the channel is told are three views of the same two cases.
//
// Earlier drafts of this said "bidden" and "unbidden". Those are gone
// deliberately and should not come back: an adjective names how a post feels,
// where the wake reason names what authorized it, and only the second is a fact
// the code has.
//
// ## Three rules the window comes with
//
// **Per channel, never per workspace.** A workspace-wide window would let one
// busy channel silence every other, which is a channel's ambient setting being
// decided by a channel nobody there can see.
//
// **The permit is claimed at the attempt, not on success.** The stamp is taken
// before the Slack call and is not refunded when that call fails. Two reasons,
// and the second is the load-bearing one: claiming first is what makes the limit
// hold when evaluations overlap, and refunding would turn a channel the app was
// removed from into a retry loop of unprompted speech — `not_in_channel` fails
// identically every time, so a refund buys a second attempt at the same failure
// and a third, at whatever rate the clock is running.
//
// **A refusal is legible to the caller.** `post` answers whether it posted, and
// `mayPost` answers the same question before anything is spent.
//
// The second one is what #319 did with the decision this file left it. There is
// no queue here, so an evaluation that finds something real while the window is
// shut produces nothing — and whether that is a *deferral* or a *loss* depended
// on whether the refused evaluation still advanced its last-evaluated position.
// The heartbeat answers by not evaluating at all when the window is shut: its
// watermark therefore never moves on a refusal, the material is weighed again
// when the window opens, and nothing is lost. `post`'s refusal stays as the
// backstop for a race that the ambient clock's overrun rule already prevents.
//
// ## Where the state lives
//
// In memory, per channel, on `../session/ambient.ts`'s argument for its own
// schedule. An
// empty map at startup means "allowed", which is the fail-open direction — and
// what makes that safe is not this file but the clock above it: first sight
// never fires, so no heartbeat runs until a full cadence after a restart, and a
// crash-looping process never posts at all. Persisting would mean this surface
// writing into the channel's store, which it otherwise has no reason to open.

import type { ChannelPoster, Logger, ProactiveSource } from "@getlibero/gateway";
import { createSilentLogger, renderProactivePost } from "@getlibero/gateway";

/**
 * How long a channel waits between heartbeat posts.
 *
 * **An architecture constant, never a sheet field.** `packages/schema`'s
 * `[ambient]` block says so at the point where somebody would add one: stated in
 * time rather than in ticks, because one post per tick is no throttle once ticks
 * are minutes apart, and enforced in the posting surface so that tightening
 * `heartbeat_every_minutes` cannot quietly loosen the throttle. It lives beside
 * its mechanism the way `APPROVAL_TTL_MS` does. Nothing named `posts_per_hour`
 * goes on that block.
 *
 * **Four hours, and the argument is arithmetic plus an asymmetry.**
 *
 * This is not the primary volume control — the evaluation turn's pregate is. A
 * tick with nothing new since the last evaluated position is silent by
 * construction and spends nothing, and a question is not eligible until it has
 * sat `answer_after_idle_minutes`, which defaults to an hour. Most ticks post
 * nothing whatever this number is. What the window bounds is the channel where
 * there genuinely *is* material every time anyone looks: even when every other
 * gate says post, how often may this thing speak.
 *
 * At the sheet's defaults the cadence is fifteen minutes, so an eight-hour
 * working day holds 32 ticks, and the window converts that to posts per working
 * day: one hour gives eight, which is too chatty for speech nobody asked for and
 * collides confusingly with `answer_after_idle_minutes`' own default of sixty;
 * two hours gives four; **four hours gives two — a morning and an afternoon**;
 * eight gives one, which is safe but lets a nine o'clock finding block the rest
 * of the day. Twelve or more starts to straddle the night, where a post at
 * 17:00 blocks the next morning and posts-per-day stops being legible
 * arithmetic at all.
 *
 * The asymmetry decides between the survivors. **Too short kills the feature and
 * too long only costs a finding.** A chatty agent gets `[ambient] enabled`
 * flipped back to false, and then nothing here works; the recovery path for an
 * agent that is too quiet is that somebody tags it, which the sheet already
 * calls the designed path and which costs one word.
 *
 * It holds at both ends of the cadence range. A channel at
 * `heartbeat_every_minutes = 1` gets 240 ticks per permitted post, which is
 * exactly the property the schema comment asks for; a channel at the 1440
 * ceiling never has the window bind at all.
 */
export const HEARTBEAT_POST_WINDOW_MS = 4 * 60 * 60 * 1000;

/** What a caller asks for: a channel, what to say, and what authorized it. */
export interface ProactivePost {
  readonly channel: string;
  /**
   * The message, in the caller's words.
   *
   * Escaped and capped by the renderer, which is where every other
   * caller-authored string this app posts is handled.
   */
  readonly text: string;
  /** The wake reason. Only `"heartbeat"` draws on the window. */
  readonly source: ProactiveSource;
}

/**
 * The governed capability: the one way this process starts a message.
 *
 * One verb taking a discriminant rather than two verbs, because the two cases
 * differ in *what governs them* rather than in what they do — both render the
 * same way, post through the same adapter, and reach the same channel. A second
 * verb would put that shared path in two places to encode one field.
 */
export interface ProactivePoster {
  /**
   * Whether a heartbeat post would be permitted right now (#319).
   *
   * Synchronous, because it is a map lookup — there is nothing to await and an
   * async answer would suggest otherwise.
   *
   * **This exists so that a turn is not paid for when its result could not be
   * used.** The only output of a heartbeat evaluation is a post, so evaluating
   * with the window shut is spend with a guaranteed-refused result. Asking first
   * also settles the question this surface deliberately left open: because the
   * evaluation does not run, it does not advance its watermark either, so the
   * material stays where it is and is weighed again once the window opens. A
   * shut window defers a finding rather than losing one, by construction.
   *
   * **It is a check, not a claim**, and `post` remains the enforcement. Two
   * evaluations that both read `true` and then both post would be a race this
   * answer cannot prevent — the ambient clock's overrun rule means one heartbeat
   * per channel at a time, so it does not arise, and if it did the loser is
   * refused at `post` and has wasted a turn rather than spoken twice.
   *
   * Always `true` for `source: "task"`, which is why it takes no source: a fired
   * task does not draw on this window, so there is nothing for it to ask.
   */
  mayPost(channel: string): boolean;
  /**
   * Posts, or refuses. Answers whether it posted.
   *
   * Never rejects. A Slack failure is a log line and `false`, because the only
   * callers are background passes with nowhere to report an exception to — the
   * clock is not waiting on an answer and no person is. A caller that treats
   * `false` as "say it again later" is behaving correctly for a refusal and for
   * a failure alike, which is why the two do not need separating here.
   */
  post(request: ProactivePost): Promise<boolean>;
}

export interface ProactivePosterOptions {
  /** The channel-post verb, from the Slack surface. See `SlackSurface.channel`. */
  poster: ChannelPoster;
  /** Injected so a test states the clock rather than faking timers. */
  now?: () => number;
  logger?: Logger;
}

/**
 * Builds the surface. It holds the window; the clock above decides when to ask.
 *
 * One instance per process, so the window is shared by every caller that gets
 * one — a second instance would be a second window over the same channel, which
 * is the workspace-versus-channel mistake made in the other direction.
 */
export function createProactivePoster(options: ProactivePosterOptions): ProactivePoster {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  /** When each channel last had a heartbeat post attempted. Task posts never appear. */
  const lastHeartbeatPost = new Map<string, number>();

  /** Whether `at` is outside the channel's window. The one comparison, once. */
  function windowOpen(channel: string, at: number): boolean {
    const last = lastHeartbeatPost.get(channel);
    return last === undefined || at - last >= HEARTBEAT_POST_WINDOW_MS;
  }

  return {
    mayPost(channel): boolean {
      return windowOpen(channel, now());
    },

    async post(request): Promise<boolean> {
      const at = now();

      if (request.source === "heartbeat") {
        if (!windowOpen(request.channel, at)) {
          const last = lastHeartbeatPost.get(request.channel) ?? at;
          logger.log("info", {
            event: "proactive_throttled",
            channel: request.channel,
            // How long the caller would have to wait, rather than when the last
            // post was: an operator reading this wants to know whether the
            // window is nearly open or just shut.
            waitMs: HEARTBEAT_POST_WINDOW_MS - (at - last)
          });
          return false;
        }
        // Claimed here, before the await below. Two evaluations racing inside
        // one window both read `last` before either posts if this moves down.
        lastHeartbeatPost.set(request.channel, at);
      }

      try {
        await options.poster.postToChannel({
          channelId: request.channel,
          text: renderProactivePost({ source: request.source, text: request.text })
        });
      } catch (error) {
        // Not refunded. See the header: a refund turns a channel that fails
        // every time into repeated attempts at the same failure.
        logger.log("error", {
          event: "proactive_failed",
          channel: request.channel,
          source: request.source,
          reason: error instanceof Error ? error.name : "unknown"
        });
        return false;
      }

      logger.log("info", {
        event: "proactive_posted",
        channel: request.channel,
        source: request.source
      });
      return true;
    }
  };
}
