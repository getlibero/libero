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

// The MCP SDK is the proxy's one third-party network client, and it is allowed
// in exactly one module. `mcp-client.ts` is where the SDK's open error surface
// is mapped onto the closed `McpFailure` set and where the guarded fetch is
// installed; a second importer would be a second way to reach an upstream, one
// that had not passed through ./outbound.ts. Bare package specifiers, so the
// path globs the other bans use would not catch it.
const MCP_SDK_BAN = {
  group: ["@modelcontextprotocol", "@modelcontextprotocol/*"],
  message:
    "Only packages/proxy/src/mcp-client.ts may import the MCP SDK. It is the module that installs the guarded fetch and maps the SDK's errors onto the closed McpFailure set; reaching an upstream anywhere else would bypass both."
};

// The durable-replace recipe, which four groups below ban and which stopped
// being a file in this repository's proxy at #272 — it is `@getlibero/atomic-write`
// now, a leaf every service and the published CLI import. The bans stay: the
// primitive holds no credential value, but a module with no file to replace
// should not be able to name the thing that replaces files, which is the same
// claim those groups make about the vault. Three spellings and not one — the two
// specifiers catch the package, and the glob still catches a copy inlined back
// into a source file, which is how the recipe came to exist three times.
const ATOMIC_WRITE_BAN = [
  "**/atomic-write*",
  "@getlibero/atomic-write",
  "@getlibero/atomic-write/*"
];

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
      "no-restricted-imports": ["error", { patterns: [PROXY_IMPORT_BAN, MCP_SDK_BAN] }]
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
      "no-restricted-imports": ["error", { patterns: [PROXY_IMPORT_BAN, SLACK_SDK_BAN, MCP_SDK_BAN] }]
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
      "no-restricted-imports": ["error", { patterns: [PROXY_IMPORT_BAN, MCP_SDK_BAN] }]
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
            MCP_SDK_BAN,
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
    // The third boundary, and the narrowest (#239). The price-drift record is
    // an observation: a router's own cost figure, kept beside the counts so an
    // operator can see a stale price table. It must never reach a decision, and
    // "never" is a property of what the deciding module can import rather than
    // of what today's code happens to read. `enforce.ts` is where every budget
    // refusal is made, and a figure a gateway computed reaching it would move
    // enforcement out of the proxy — the invariant the whole design hangs on.
    files: ["packages/proxy/src/enforce.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/drift-db*"],
              message:
                "Enforcement never reads the price-drift record. It is a router's own cost figure, recorded for an operator to compare against the price table; metering or refusing on it would move enforcement onto a number the proxy did not compute. See drift-db.ts."
            }
          ]
        }
      ]
    }
  },
  {
    // The same mechanism, for the route that reaches an upstream. `GET
    // /v1/tools` asks each server the sheet named what its tools take, and the
    // claim worth enforcing is the shape of what it holds: **it can ask an
    // upstream what it offers, and it can run nothing.**
    //
    // It closes over `ToolCatalog`, whose only method describes. What is banned
    // is everything that could turn a listing into a call or into a second
    // credential path — the vault, the pool, the client, the dispatcher
    // implementation, the outbound sender, and the package's own barrel.
    //
    // Two things are deliberately *not* banned. `dispatch` holds the
    // `ToolCatalog` type, and a type-only import of an interface reaches
    // nothing. `team-sheet-store` and `enforce` are what this route is for —
    // unlike spend-route.ts, resolving a sheet is precisely its job.
    files: ["packages/proxy/src/listing-route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            MCP_SDK_BAN,
            {
              group: [
                "**/vault*",
                "**/custody*",
                "**/token-store*",
                "**/token-engine*",
                "**/grant-flow*",
                "**/envelope*",
                ...ATOMIC_WRITE_BAN,
                "**/mcp-pool*",
                "**/mcp-client*",
                "**/mcp-catalog*",
                "**/http-dispatcher*",
                "**/builtin-dispatcher*",
                "**/outbound*",
                "@getlibero/memory",
                "@getlibero/proxy"
              ],
              message:
                "The tool listing route can ask an upstream what it offers and can run nothing. It holds a ToolCatalog, never a vault, a pool, a client, the sender that attaches a credential, or the executor that reads a channel's messages. ./builtins.ts is allowed and ./builtin-dispatcher.ts is not: definitions are constants, the executor opens a store."
            }
          ]
        }
      ]
    }
  },
  {
    // `GET /v1/budget` (#335). `team-sheet-store` and `enforce` are what this
    // route is for, as they are for listing-route.ts above and as they are not
    // for spend-route.ts: answering "may this channel be spent for" *is*
    // resolving a sheet and applying the same comparison the gate applies.
    //
    // What it must not reach is anything that could turn a question into a
    // change. `budget-admin*` clears counters and belongs to the operator's
    // second process; `approvals*` mints and spends tickets. Neither has any
    // business behind a read, and the meter's own write half is already kept out
    // by the `SpendReader` the handler closes over rather than by this list.
    // The sandbox arm, and the first block written for what a module must *not*
    // gain rather than for what it currently lacks (#395). It talks to a runner
    // that holds the Docker socket, so the property #393 hangs the whole
    // topology on — the process with host-root privilege and the process with
    // the credentials are different ones — is a property of what this module can
    // reach. Nothing here is a credential today; this is what keeps it that way
    // when somebody wants to pass an upstream token through to a run.
    files: ["packages/proxy/src/sandbox-dispatcher.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            MCP_SDK_BAN,
            {
              group: [
                "**/vault*",
                "**/custody*",
                "**/token-store*",
                "**/token-engine*",
                "**/grant-flow*",
                "**/envelope*",
                "**/outbound*",
                "**/mcp-pool*",
                "**/mcp-client*",
                "**/http-dispatcher*",
                "**/builtin-dispatcher*",
                "@getlibero/memory"
              ],
              message:
                "The sandbox arm sends code to a runner that holds the Docker socket, and holds no credential itself. It may not reach a vault, a token store, the grant flow, the sender that attaches a credential, a pool, a client, or a channel's messages. See packages/proxy/README.md, 'Reaching a runtime'."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["packages/proxy/src/budget-route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            MCP_SDK_BAN,
            {
              group: [
                "**/vault*",
                "**/custody*",
                "**/token-store*",
                "**/token-engine*",
                "**/grant-flow*",
                "**/envelope*",
                ...ATOMIC_WRITE_BAN,
                "**/budget-admin*",
                "**/approvals*",
                "**/mcp-pool*",
                "**/mcp-client*",
                "**/mcp-catalog*",
                "**/http-dispatcher*",
                "**/builtin-dispatcher*",
                "**/outbound*",
                "@getlibero/memory",
                "@getlibero/proxy"
              ],
              message:
                "The budget route answers a question and changes nothing. It resolves a sheet and reads the meter; it may not reach the operator's reset path, the approval store, a vault, a pool, a client, or any dispatcher. The meter's write half is kept out by the SpendReader it closes over."
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
    // `redact` **is** banned here now, and the reversal is the point. It used
    // to be left out on the ground that argument capture might one day redact
    // while building the record. #122 designed that and declined it — the whole
    // argument is in audit-log.ts's header — so the exception was standing on a
    // future that is not coming, and a rule kept open for a change nobody is
    // going to make is a rule with a hole in it. Nothing here imported it; the
    // ban costs nothing and makes the import list say what it means.
    files: ["packages/proxy/src/audit-db.ts", "packages/proxy/src/audit-log.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            MCP_SDK_BAN,
            {
              group: [
                "**/vault*",
                "**/custody*",
                "**/token-store*",
                "**/token-engine*",
                "**/grant-flow*",
                "**/envelope*",
                "**/redact*",
                ...ATOMIC_WRITE_BAN,
                "@getlibero/proxy"
              ],
              message:
                "The audit writer holds no credential value. It records names, ids, and a hash of arguments; a column that needed the vault — or the token store beside it — would be a column that must not exist. `redact` is banned with them since #122: there is nothing here to redact, and there is not going to be."
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
    // is a rule CI enforces. Now it is both.
    //
    // `redact` is banned here too, since #122 decided argument capture will not
    // be built — see audit-log.ts's header for why, and the audit writer's block
    // above for why an exception held open for a change nobody will make is a
    // hole rather than a courtesy. The vault stays out either way: values reach
    // a call in ./outbound.ts, inside the dispatcher, and nowhere upstream of it.
    files: ["packages/proxy/src/server.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            MCP_SDK_BAN,
            {
              group: [
                "**/vault*",
                "**/custody*",
                "**/token-store*",
                "**/token-engine*",
                "**/grant-flow*",
                "**/envelope*",
                "**/redact*",
                ...ATOMIC_WRITE_BAN,
                "@getlibero/proxy"
              ],
              message:
                "The tool-call route holds no credential value: values live inside the dispatcher (./outbound.ts), and the audit row's hash-not-redact argument rests on this import list staying clean. The token store is a second credential store, banned for the vault's reason; `redact` is banned because #122 declined the capture that would have needed it."
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
    // The other end of the operator boundary: the barrel re-exports the
    // operator functions for the vault, budget and audit CLIs, so the
    // composition root could reach them by name without ever naming
    // budget-admin or audit-db. The serving process closes over
    // read/recordToolCall/recordTokens and an `AuditWriter` that can only
    // append; the three CLIs, each its own entrypoint, are the importers these
    // exports exist for.
    files: ["apps/proxy-server/src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@getlibero/proxy",
              importNames: [
                "resetChannel",
                "readChannelSpend",
                "channelDays",
                "pruneTurnReports",
                "openAuditReader",
                "performAuthorizationGrant",
                "GrantFlowError",
                // #482's addition, and the load-bearing one: `openVaultAdmin`
                // is the vault's writer. "The process serving tool calls never
                // writes the vault" is an import list in packages/proxy's
                // vault.ts, again in custody-backend.ts not importing
                // custody-admin.ts, and here — the same claim at the one level
                // where the two could otherwise meet.
                "openVaultAdmin",
                // And the key, so `vaultKeyFromEnv` in ./env.ts stays the
                // deployment's single acquisition seam. #495 is what that
                // bought: a second source — PROXY_VAULT_KEY_FILE — is a change
                // to one function's body, and a second *reader* of the variable
                // would have made it a change in more than one place.
                "parseVaultKey",
                "VAULT_KEY_BYTES"
              ],
              message:
                "Operator paths stay off the serving process. Meter resets and aggregate reads belong to the budget CLI, reading the audit log belongs to the audit CLI, running a grant belongs to the grant CLI, and writing the vault belongs to the vault CLI — each reached as its own entrypoint. A master key comes from vaultKeyFromEnv and nowhere else."
            }
          ]
        }
      ]
    }
  },
  {
    // The same key rule for the two operator entrypoints. They open a store —
    // that is what they are for — and they still must not parse a key
    // themselves: `custodyFromEnv` composes `vaultKeyFromEnv`, and a branch
    // that acquires material some other way is how a backend ends up with two
    // key sources to keep in step. The operator-function bans above do not
    // apply here, which is why this is its own block rather than a wider
    // `files` list: `no-restricted-imports` is replaced by the last block that
    // matches a file, and grant-cli.ts must import `performAuthorizationGrant`.
    files: ["apps/proxy-server/src/vault-cli.ts", "apps/proxy-server/src/grant-cli.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@getlibero/proxy",
              importNames: ["parseVaultKey", "VAULT_KEY_BYTES"],
              message:
                "A master key comes from vaultKeyFromEnv in ./env.ts and nowhere else — the one acquisition seam, which is why PROXY_VAULT_KEY_FILE was a change to its body alone."
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
            MCP_SDK_BAN,
            {
              group: [
                "**/team-sheet-store*",
                "**/enforce*",
                "**/dispatch*",
                "**/vault*",
                "**/custody*",
                "**/token-store*",
                "**/token-engine*",
                "**/grant-flow*",
                "**/envelope*",
                ...ATOMIC_WRITE_BAN,
                "@getlibero/proxy"
              ],
              message:
                "The approval broker decides no permission and serves no call. The sheet is enforced on /v1/tools/call, at mint and again at redemption; a ticket only says a human approved one exact call."
            }
          ]
        }
      ]
    }
  },
  {
    // The e2e suite composes both sides of the boundary, which is what it is
    // for — so PROXY_IMPORT_BAN is deliberately absent here, and
    // scripts/boundary-check.sh deliberately does not scan e2e/. This is the
    // one package where naming the proxy from a file that also drives the agent
    // is the intended arrangement.
    //
    // What it may not do is reach the two things the suite claims to fake. The
    // suite's whole premise is that Slack and the model are the only fakes and
    // everything between them is real; a file here that opened a socket or
    // called a provider would make that premise false while every test still
    // passed, and would do it by adding an import rather than by changing an
    // assertion.
    files: ["e2e/**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            MCP_SDK_BAN,
            {
              group: ["@slack/*"],
              message:
                "The e2e suite drives the gateway through createStubSlack. A Slack SDK here would reach slack.com from a test that claims to need no workspace."
            },
            {
              group: ["@anthropic-ai/*", "openai", "openai/*"],
              message:
                "The e2e suite's model is a scripted CompletionClient. A provider SDK here would spend real tokens from a test that claims to need no model."
            }
          ],
          paths: [
            {
              // Banning the SDKs alone does not close this: the factory is
              // re-exported from @getlibero/agent, so a real provider client is
              // reachable without any file here naming a provider.
              name: "@getlibero/agent",
              importNames: ["createCompletionClient", "createEmbeddingClient"],
              message:
                "The e2e suite's model is a scripted CompletionClient and its embedder is a constant fake — see e2e/src/harness/model.ts and harness/embedding.ts. Both factories build real clients and would reach a provider with a real key."
            }
          ]
        }
      ]
    }
  },
  {
    // The message store is a leaf, and this block is what keeps it one.
    //
    // It holds channel content and both services open it: the gateway writes
    // every inbound message, and since #64 the proxy reads one back to answer
    // search_channel_history. So this package is imported from either side and
    // may name neither. The concrete hazard is transitive: a Logger imported
    // from the gateway would put the Slack SDK into the proxy's image through an
    // edge no import in the proxy names. packages/memory/src/log.ts duplicates
    // an interface rather than importing one for exactly this reason.
    //
    // #64 closing made this stricter rather than moot — the proxy edge exists
    // today, so the ban now guards a live import path rather than a prospective
    // one.
    //
    // Wider than PROXY_IMPORT_BAN rather than a member of it, so this is its own
    // block. Note the config's rule at the top of this file: no-restricted-imports
    // is replaced wholesale by the last matching block, and no earlier block
    // matches packages/memory/**, so nothing is being overridden here.
    //
    // @getlibero/schema is deliberately not banned. ChannelId is the one rule
    // about channel ids, stated once, and a store that re-implemented it would
    // be the hole that file exists to close.
    //
    // @getlibero/atomic-write is not banned either, and for the same shape of
    // reason. It is a leaf under this leaf — `node:` builtins and nothing else,
    // no dependencies at all — so the edge adds no code to either service's
    // image, which is the property this block exists to protect. What it cost to
    // do without is on the record: until #272 this package carried a hand-kept
    // copy of the proxy's durable-replace recipe, because the ban is real and
    // the alternative was importing across it. A guarantee implemented twice is
    // one that eventually holds once, and `src/log.ts` is the duplication that
    // remains because a `Logger` genuinely has no third home.
    files: ["packages/memory/**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            MCP_SDK_BAN,
            {
              group: [
                "@getlibero/proxy",
                "@getlibero/proxy/*",
                "@getlibero/gateway",
                "@getlibero/gateway/*",
                "@getlibero/agent",
                "@getlibero/agent/*",
                "**/packages/proxy/**",
                "**/packages/gateway/**",
                "**/packages/agent/**"
              ],
              message:
                "The message store is a leaf: it holds channel content and both services open it — the gateway writes, the proxy reads (#64) — so it may depend on neither. Its Logger is duplicated in src/log.ts on purpose."
            }
          ]
        }
      ]
    }
  },
  {
    // The allowance, and it must stay last: `no-restricted-imports` is replaced
    // by the last block that matches, so anything after this would silently
    // re-ban the SDK in the one module entitled to it.
    //
    // Restated rather than inherited — this block deliberately clears the rule
    // rather than narrowing it, because the module's whole job is to hold the
    // SDK. What keeps that honest is not this config but ./outbound.test.ts's
    // greps, which assert there is one `reveal()` in the tree and that no other
    // source file names the SDK at all.
    files: ["packages/proxy/src/mcp-client.ts", "packages/proxy/src/mcp-client.test.ts"],
    rules: {
      "no-restricted-imports": "off"
    }
  }
);
