# @getlibero/gateway

Unpublished workspace package. The Slack side of the process that runs next to
the model. See the [architecture](https://getlibero.com/docs/architecture/)
("Gateway and channel router") for the specification, which is ahead of what is
built here.

## What exists

The Socket Mode adapter: dial Slack, receive an `app_mention`, hand it to one
handler, post what comes back into the thread, and reconnect when the socket
drops. Since #176 it also surfaces ordinary `message` events, normalized and
handed down — recorded by whatever composed it, never answered here. Since #67
it answers one question as well: who a user id belongs to, over `users.info` on
the same client the posters use. That is the only read in the package, and what
a name is *used for* is above it.

```ts
import { createSlackGateway } from "@getlibero/gateway";

const gateway = createSlackGateway({
  appToken,  // xapp-…, opens the socket
  botToken,  // xoxb-…, posts the reply
  handler: async mention => ({ text: `heard you, <@${mention.userId}>` })
});

await gateway.start();
```

`handler` is the whole seam to the agent: a mention in, a reply or `undefined`
out. Returning `undefined` posts nothing.

And, since #126, the interactive half: a click on an approval card decoded into
a `SlackDecision`, and a card that can be drawn and then edited in place.

```ts
import { createSlackSurface, renderApprovalCard } from "@getlibero/gateway";

const { gateway, cards } = createSlackSurface({
  appToken,
  botToken,
  handler,
  onDecision: async decision => {
    // decision.ticketId, decision.verdict, decision.approverId — and
    // decision.messageTs, which is the card to edit.
  }
});

const posted = await cards.postCard({
  channelId,
  threadTs,
  card: renderApprovalCard({ toolName: "github.pr.merge", status: { state: "awaiting", ticket } })
});
```

Both halves come from one call because they must share one `WebClient`: it
handles rate limits per instance, so a second client on the same bot token would
give the process two independent queues over `chat.*`. `createSlackGateway` is
still there and still returns a `SlackGateway`, for a process that draws no
cards.

`cards` is narrowed to `CardPoster` deliberately — a composing app cannot reach
`postThreadReply` through it, so "a handler still running when the gateway
stopped does not get to post" stays a property of the dispatcher rather than a
habit of every caller.

### The third subscription: ordinary messages

Since #176 there is an `onMessage` beside `onMention`, and `toMessage` beside
`toMention`. They differ in two places that matter.

**`toMessage` keeps the raw `thread_ts`.** `toMention`'s `?? ts` is picking a
*reply target*, which is right for a mention and wrong here: it makes a top-level
message and a self-threaded one indistinguishable, and the layer above needs that
difference to decide whether a message is a reply to anything.

**Subtypes are an allowlist**: absent, `thread_broadcast`, and `file_share`.
`message_changed` and `message_deleted` are dropped under their own reason code
rather than silently, because they are the landing site for deletion mirroring
(#177) — the store already has `remove` and `replaceText` waiting for them.

**A mention arrives on both subscriptions**, with a *different* `event_id` on
each, so nothing downstream can tell the pair apart by id. The gateway therefore
resolves its own user id with `auth.test` inside `connectWithRetry`, before the
socket opens, and sets `SlackMessage.mentionsApp`. Resolving identity there also
turns a bot token Slack will never accept into a startup `auth_rejected` rather
than a reply that never appears.

**`mentionsApp` fails closed**: with no id, any `<@…>` token counts. Losing a
follow-up costs a message the user can repeat; mistaking a mention for one costs
two model turns and two replies in the same thread.

A `MessageHandler` returns a `SlackReply | undefined`, and the gateway posts it
to `message.threadTs` and **never `?? ts`** — so the adapter still cannot start a
thread on a message nobody addressed it in. An answered message logs `follow_up`,
not `replied`; nothing else on that path logs at all, because one line per
message would turn stdout into a record of who spoke in which channel and when.

## What does not exist yet

**Nothing posts a card in production.** The verbs exist and the decoder works;
what joins them — hold a tool call, put a card up, wait, re-submit with the
ticket — is `apps/server`'s and is #127. Until then `packages/agent` still
relays a hold to the model as an error result, which abandons the call rather
than serving it unapproved.

**The gateway holds no timer.** A ticket dies fifteen minutes after it is
minted, and this package renders `expired` when it is told to and never on its
own. The deadline belongs to whoever holds the ticket, which is the same layer
that is already awaiting the decision. That is why `updateCard` takes a whole
freshly rendered card: nothing here keeps mutable card state between calls.


Sessions, the per-session mutex, display-name attribution, and the FTS message
store are the channel router's, and are not here. So is the live checklist's
lifetime: `checklist-card.ts` renders one from whole state the way
`approval-card.ts` does, and the coalescing that keeps a twenty-call task to a
handful of edits lives in `apps/server`, where the clock is. The router landed in `apps/server/src/session/` (#65) and serializes a
channel's mentions **above** this package: the gateway goes on dispatching
concurrently, because it acknowledges an inbound event within about three
seconds or Slack redelivers it, and a mention waiting its turn must not hold
that acknowledgement. `gateway.test.ts` still asserts the concurrent dispatch
for that reason.

## Layout

| File | What it is |
| --- | --- |
| `slack/types.ts` | The whole public surface: `SlackMention`, `SlackMessage`, `SlackDecision`, the handlers, `SocketSource`, `MessagePoster`, `CardPoster`, `GatewayError` |
| `slack/mention.ts` | One envelope to a `SlackMention`, or to a reason it is not one. Pure, and fails closed |
| `slack/message.ts` | One envelope to a `SlackMessage`, on the same terms. Keeps the raw `thread_ts`, which is the whole reason it is not `mention.ts` |
| `slack/decision.ts` | One `block_actions` payload to a `SlackDecision`, on the same terms |
| `slack/approval-ids.ts` | The two action ids and the verdict each means, read both directions |
| `slack/approval-card.ts` | The approval card renderer. Pure, and the three status colours live here |
| `slack/checklist-card.ts` | The live checklist renderer. Pure, whole state in, one card out |
| `slack/gateway.ts` | Dispatch and the reconnect supervisor. No Slack SDK in it |
| `slack/backoff.ts` | The reconnect policy, as arithmetic |
| `slack/socket-mode.ts` | The inbound adapter. Holds the app token |
| `slack/web-api.ts` | The Web API adapter — both posters and the user directory, on one client. Holds the bot token |
| `slack/sdk-logger.ts` | A `@slack/logger` that discards everything it is given |
| `slack/stub-slack.ts` | A workspace that is not one. Shipped, not test-only |
| `log.ts` | JSON lines with a closed field set |

Three files import a Slack SDK, and an ESLint rule keeps it that way — **#126
added none.** The renderer emits plain objects and the decoder reads them, so
the two adapters absorbed one `client.on` and two `chat.*` calls between them
and the allowlist did not have to move. Everything else runs against
`SocketSource` and `MessagePoster`, which is why the dispatch path,
normalization, and the reconnect ladder are all testable with no socket — and
what the mock Slack harness will build on.

The one workspace import is `@getlibero/schema`, and it is **type only**:
`ApprovalVerdict` is the wire vocabulary of the thing being decoded, and two
definitions of one enum drift silently. Type only because zod must not reach
this package at runtime — the gateway validates nothing and must not start. The
proxy parses at the boundary that enforces, and a second parse here would be a
second authority with no power to act on the result. So `SlackDecision.ticketId`
is a plain `string`, which is honest: the gateway did not validate it.

## Three rules the code keeps

**The two tokens never reach a log line or an error.** `GatewayError` carries a
code and, where Slack supplied one, Slack's own error string (`not_in_channel`).
Never an SDK message: `WebAPIHTTPError` holds response headers and the Socket
Mode client's requests carry a bearer token. The SDK's own logger is a sink for
the same reason — left alone it writes whole WebSocket frames to stdout.

**No log field holds message text.** A message belongs to the members of the
channel it was posted in. Ids identify a thread; what was said is not an
operator's to read out of a log collector. A card's contents are the same rule's
business: a `decision` line carries ids and a verdict, never the card.

`response_url` is where both rules meet, and it is the reason it is never read.
It is the obvious way to edit a message, and it is a URL with a secret in it. A
`response_url` on a `SlackDecision` would be a field holding a token, reachable
by anything that logs a decision. Cards are edited with `chat.update` on the bot
token instead — a credential this process already holds and never surfaces.

**Colour is status, and never the only signal.** Green is allowed and executed,
amber is a human who still has to click, red is blocked, and there is no fourth;
the three hexes in `approval-card.ts` are the dark values of `--lb-warn`,
`--lb-accent`, and `--lb-danger` from `design/tokens.css`. They are hex for the
reason `design/README.md` already gives where it ships Slack a raw theme string:
Slack cannot read a token. They are drawn as an attachment's left border, which
is legacy by Slack's own documentation and still the only way to get an arbitrary
colour into a message — so every state also names itself in the blocks and in
`fallback`. A card with no colour at all is still correct, which is what makes it
correct in a push notification, to a screen reader, and on the day attachments
go away.

**`SlackCard.color` is optional, and absence is the in-flight face** (#68, #143).
A checklist mid-task, and an approved call whose re-submission has not answered
yet, are none of the three: not executed, not waiting on a human, not blocked.
Rather than widen amber to mean "unsettled" — which would make the one colour
that means *click this* also mean *nothing to do* — those states carry no colour
and Slack draws its own default border. It reads as *not a status yet*, which is
what in-flight is, and the colour arrives with the terminal repaint. That is only
safe because of the paragraph above: a card is already required to be legible
with no colour at all.

Two consequences worth stating: arguments rendered onto a card are escaped
before they reach a block, because that field carries model-authored text onto
the one surface whose job is to be trusted enough to click — `<!channel>` on an
approval card pages a company. And the gateway decides nothing about approvals:
which tickets exist, what a click is worth, and whether a call may run are the
proxy's, from the team sheet, and this package never sees one.

## Running it against a real workspace

`packages/gateway` reads no `process.env` — the composing app parses the
environment, as `apps/proxy-server/src/env.ts` does. Until `apps/server` is
wired up, point a short script at a scratch workspace:

```ts
import { createSlackGateway } from "@getlibero/gateway";

const gateway = createSlackGateway({
  appToken: process.env.SLACK_APP_TOKEN!,
  botToken: process.env.SLACK_BOT_TOKEN!,
  handler: async mention => ({ text: `heard: ${mention.text}` })
});
await gateway.start();
```

The app needs `app_mentions:read` and `chat:write`, the `app_mention` event
subscription, Socket Mode on, and — for a click to arrive at all —
**Interactivity on**. There is no Request URL to configure for either. For
ordinary messages to arrive as well it needs `channels:history` (and
`groups:history` for private channels) with `message.channels` and
`message.groups` subscribed; without them the adapter answers mentions and
surfaces no messages, which is a working app with no transcript. `users:read` is
what turns a `U…` id into a name — without it the directory answers `undefined`
for everyone and logs `user_lookup_failed` with `missing_scope`.
[Self-hosting](https://getlibero.com/docs/self-hosting/)
has the full setup, including the scopes the rest of the system will need. Use a
free scratch workspace first.

The most common first-run failure is `not_in_channel`, logged as `slackError`:
the app is installed but was never invited to the channel.
