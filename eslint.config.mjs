// Flat config. The rule that matters most is the security boundary:
// packages/agent must never import packages/proxy. The only path from
// agent to tools is the network call to the proxy service.
import tseslint from "typescript-eslint";

// `no-restricted-imports` is replaced wholesale by the last config block that
// matches a file, not merged into what an earlier one set. Two blocks both
// naming packages/gateway would silently drop the first one's patterns, so the
// shared pattern is a constant and every block that needs it says so.
// The patterns match the import *specifier*, not the resolved path, so the
// bare-name forms alone would miss a relative deep import into the proxy's
// build output ("../../proxy/dist/vault.js") — which tsc does not stop either,
// because a .d.ts in another package's dist is not subject to rootDir. The
// dist globs close that hole; the CI boundary-check grep covers the same
// spelling with a `\.\./proxy` pattern.
const PROXY_IMPORT_BAN = {
  group: [
    "@getlibero/proxy",
    "@getlibero/proxy/*",
    "**/packages/proxy/*",
    "**/packages/proxy/**",
    "**/proxy/dist/*",
    "**/proxy/dist/**"
  ],
  message:
    "SECURITY BOUNDARY: the agent may not import the proxy. Tools are reached only via the proxy's HTTP API."
};

const SLACK_SDK_BAN = {
  group: ["@slack/*"],
  message:
    "Only slack/socket-mode.ts, slack/web-api.ts, and slack/sdk-logger.ts may import a Slack SDK. Everything else runs against SocketSource and MessagePoster, which is what lets the dispatch path be tested without a socket."
};

export default tseslint.config(
  {
    // site/ is outside the pnpm workspace and has its own toolchain and CI job
    // (.github/workflows/pages.yml runs `astro check` there). Without this,
    // `pnpm lint` walks its build output and generated types.
    ignores: ["site/**", "**/dist/**", "**/.astro/**"]
  },
  ...tseslint.configs.recommended,
  {
    // apps/server composes the gateway and agent into the process that runs
    // next to the model, so all three sit on the same side of the boundary.
    // packages/gateway holds the Slack socket in that same process: it is where
    // an inbound message first arrives, which makes it the most attractive place
    // for a shortcut to the proxy's internals to appear.
    //
    // Every extension, not just *.ts: a stray .mjs helper on the agent side is
    // still on the agent side, and the CI grep covers the same set — the ban
    // stays two mechanisms deep for every file kind that can hold an import.
    files: [
      "packages/agent/**/*.{ts,mts,cts,js,mjs,cjs}",
      "packages/gateway/**/*.{ts,mts,cts,js,mjs,cjs}",
      "apps/server/**/*.{ts,mts,cts,js,mjs,cjs}"
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [PROXY_IMPORT_BAN] }]
    }
  },
  {
    // The channel router is transport-neutral, and this is what makes that true
    // rather than aspirational. It takes a TaskRequest; handler.ts is the six
    // lines that turn a SlackMention into one, and a second front-end writes its
    // own version of exactly that file. A module that cannot name a Slack type
    // cannot quietly start depending on Slack's shape — which is the failure
    // that would only surface when the second front-end was already being
    // written, and by then the router would have to be unpicked rather than
    // reused.
    //
    // Directory-scoped rather than file-by-file on purpose. This is a deny rule,
    // so enumerating filenames would be fail-open: a router file added later
    // would silently escape it. The glob covers what does not exist yet.
    //
    // `Logger` is allowed through because it is a structured logger with nothing
    // Slack in it — it lives in the gateway package for boundary reasons of its
    // own (see the header of log.ts), not because it belongs to the socket.
    // `allowImportNames` rather than `importNames`, so the exception is a list
    // of what may cross rather than a list of what may not.
    files: ["apps/server/src/session/**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Restated, not inherited. `no-restricted-imports` is replaced
          // wholesale by the last matching block — see the note at the top of
          // this file — so leaving it out here would drop the agent/proxy ban
          // for every file under session/.
          patterns: [PROXY_IMPORT_BAN],
          paths: [
            {
              name: "@getlibero/gateway",
              allowImportNames: ["Logger", "LogLevel", "LogFields", "createSilentLogger"],
              message:
                "The channel router is transport-neutral: it takes TaskRequest, not SlackMention. The Slack adapter is apps/server/src/handler.ts."
            }
          ]
        }
      ]
    }
  },
  {
    // The claim the gateway's tests rest on is that the dispatch path — inbound
    // envelope, normalization, the handler, the reply, the reconnect loop —
    // runs with no socket and no Slack SDK anywhere in it. That is what makes
    // the whole thing testable, and what #47's mock harness will build on.
    //
    // Enforced rather than described, for the same reason the spend-route rule
    // is: the risk is not the files as written but a later import somewhere
    // else, which next to the adapters would not look wrong. A module that
    // cannot import @slack/* cannot quietly start needing a socket.
    files: ["packages/gateway/src/**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [PROXY_IMPORT_BAN, SLACK_SDK_BAN] }]
    }
  },
  {
    // The three files that wrap the SDK, and the two tests that need its real
    // error classes to prove the adapters map them. Named one by one rather
    // than matched as `*.test.ts`, so gateway.test.ts stays covered — that the
    // dispatch tests cannot reach a socket is the property being claimed.
    files: [
      "packages/gateway/src/slack/socket-mode.ts",
      "packages/gateway/src/slack/web-api.ts",
      "packages/gateway/src/slack/sdk-logger.ts",
      "packages/gateway/src/slack/socket-mode.test.ts",
      "packages/gateway/src/slack/web-api.test.ts"
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [PROXY_IMPORT_BAN] }]
    }
  },
  {
    // The second boundary, and the same mechanism. `POST /v1/spend` writes the
    // budget meter and makes no authorization decision — see the header of
    // spend-route.ts. The risk is not this file as written but a later change
    // quietly putting a decision on it, which next to the route that *does*
    // decide would not look wrong. A module that cannot import a sheet resolver
    // cannot grow one by accident.
    files: ["packages/proxy/src/spend-route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/team-sheet-store*", "**/enforce*", "@getlibero/proxy"],
              message:
                "The spend report route makes no authorization decision: it resolves no team sheet and shares no handler that does. A rule that needs one belongs on /v1/tools/call."
            }
          ]
        }
      ]
    }
  },
  {
    // The third, and the same mechanism again. The audit writer records what the
    // route observed, and what the route observed never included a credential
    // value — that is why the record can hold a hash of the model's arguments
    // at all. A module that cannot import the vault cannot grow one by accident.
    //
    // `redact` is deliberately *not* banned, and the reason is worth stating
    // rather than leaving to be inferred: arguments are not stored, so nothing
    // here has anything to redact. If the follow-up issue adds capture, it
    // redacts on the route while building the record — where the secret set for
    // that call is knowable — and not in the writer, which is handed a record
    // that is already safe to persist.
    files: ["packages/proxy/src/audit-db.ts", "packages/proxy/src/audit-log.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/vault*", "@getlibero/proxy"],
              message:
                "The audit writer holds no credential value. It records names, ids, and a hash of arguments; a column that needed the vault would be a column that must not exist."
            }
          ]
        }
      ]
    }
  },
  {
    // The fourth: the route that *builds* the audit record. The reason the row
    // carries a hash rather than redacted arguments is that nothing on the
    // write path holds a credential value — and for this file that was an
    // import list a reviewer could read, where every peer claim in this config
    // is a rule CI enforces. Now it is both. `redact` is deliberately not
    // banned: when argument capture lands (#122) it redacts on this route,
    // where the secret set for the call is knowable. The vault stays out either
    // way — values reach a call in ./outbound.ts, inside the dispatcher, and
    // nowhere upstream of it.
    files: ["packages/proxy/src/server.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/vault*", "@getlibero/proxy"],
              message:
                "The tool-call route holds no credential value: values live inside the dispatcher (./outbound.ts), and the audit row's hash-not-redact argument rests on this import list staying clean."
            },
            {
              // The serving surface on the meter is read/recordToolCall/
              // recordTokens and nothing else. Clearing a counter and reading
              // across channels are operator paths, reached by the budget CLI
              // in apps/proxy-server and never by the server — this was the one
              // documented module boundary held by review alone.
              group: ["**/budget-admin*"],
              message:
                "The server never imports budget-admin: resets and aggregate reads are operator commands on the budget CLI, not anything the serving process can reach."
            }
          ]
        }
      ]
    }
  },
  {
    // The other end of the budget-admin boundary: the barrel re-exports the
    // operator functions for the budget CLI, so the composition root could
    // reach them by name without ever naming budget-admin. The serving process
    // closes over read/recordToolCall/recordTokens; the CLI (budget-cli.ts,
    // its own bin) is the importer these exports exist for.
    files: ["apps/proxy-server/src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@getlibero/proxy",
              importNames: ["resetChannel", "readChannelSpend", "channelDays", "pruneTurnReports"],
              message:
                "Operator paths on the meter stay off the serving process. They belong to the budget CLI (budget-cli.ts), reached as its own entrypoint."
            }
          ]
        }
      ]
    }
  },
  {
    // The fifth: the approval broker. Two claims, both readable as an import
    // list and now both enforced.
    //
    // **It decides nothing about permission.** The team sheet is enforced when
    // a ticket is minted and again when it is redeemed, both on /v1/tools/call.
    // A third read here could authorize nothing — this code serves no call —
    // and could withhold nothing, because the redemption check would catch it
    // anyway. What it would do is put an enforcement decision on a path with no
    // call to decide about, which is where the next mistake goes.
    //
    // **It serves nothing.** An approval is not a capability to run something:
    // it answers "a human approved this exact call" and hands that back to the
    // route, which still has to get past enforcement and the meter. A module
    // here that could reach the dispatcher or the vault could turn a click into
    // a call on its own, and the whole design is that it cannot.
    files: ["packages/proxy/src/approvals.ts", "packages/proxy/src/approvals-route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/team-sheet-store*",
                "**/enforce*",
                "**/dispatch*",
                "**/vault*",
                "@getlibero/proxy"
              ],
              message:
                "The approval broker decides no permission and serves no call. The sheet is enforced on /v1/tools/call, at mint and again at redemption; a ticket only says a human approved one exact call."
            }
          ]
        }
      ]
    }
  }
);
