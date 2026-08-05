# @getlibero/gateway

Unpublished workspace package. The Slack side of the process that runs next to
the model. See the [architecture](https://getlibero.com/docs/architecture/)
("Gateway and channel router") for the specification, which is ahead of what is
built here.

## What exists

The Socket Mode adapter, and only that: dial Slack, receive an `app_mention`,
hand it to one handler, post what comes back into the thread, and reconnect when
the socket drops.

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

## What does not exist yet

Sessions, the per-session mutex, display-name attribution, the live-updating
checklist message, and the FTS message store are the channel router's, and are
not here. The router landed in `apps/server/src/session/` (#65) and serializes a
channel's mentions **above** this package: the gateway goes on dispatching
concurrently, because it acknowledges an inbound event within about three
seconds or Slack redelivers it, and a mention waiting its turn must not hold
that acknowledgement. `gateway.test.ts` still asserts the concurrent dispatch
for that reason.

## Layout

| File | What it is |
| --- | --- |
| `slack/types.ts` | The whole public surface: `SlackMention`, `MentionHandler`, `SocketSource`, `MessagePoster`, `GatewayError` |
| `slack/mention.ts` | One envelope to a `SlackMention`, or to a reason it is not one. Pure, and fails closed |
| `slack/gateway.ts` | Dispatch and the reconnect supervisor. No Slack SDK in it |
| `slack/backoff.ts` | The reconnect policy, as arithmetic |
| `slack/socket-mode.ts` | The inbound adapter. Holds the app token |
| `slack/web-api.ts` | The outbound adapter. Holds the bot token |
| `slack/sdk-logger.ts` | A `@slack/logger` that discards everything it is given |
| `slack/stub-slack.ts` | A workspace that is not one. Shipped, not test-only |
| `log.ts` | JSON lines with a closed field set |

Three files import a Slack SDK, and an ESLint rule keeps it that way. Everything
else runs against `SocketSource` and `MessagePoster`, which is why the dispatch
path, normalization, and the reconnect ladder are all testable with no socket —
and what the mock Slack harness will build on.

## Two rules the code keeps

**The two tokens never reach a log line or an error.** `GatewayError` carries a
code and, where Slack supplied one, Slack's own error string (`not_in_channel`).
Never an SDK message: `WebAPIHTTPError` holds response headers and the Socket
Mode client's requests carry a bearer token. The SDK's own logger is a sink for
the same reason — left alone it writes whole WebSocket frames to stdout.

**No log field holds message text.** A message belongs to the members of the
channel it was posted in. Ids identify a thread; what was said is not an
operator's to read out of a log collector.

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
subscription, and Socket Mode on. [Self-hosting](https://getlibero.com/docs/self-hosting/)
has the full setup, including the scopes the rest of the system will need. Use a
free scratch workspace first.

The most common first-run failure is `not_in_channel`, logged as `slackError`:
the app is installed but was never invited to the channel.
