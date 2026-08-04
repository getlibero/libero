// Flat config. The rule that matters most is the security boundary:
// packages/agent must never import packages/proxy. The only path from
// agent to tools is the network call to the proxy service.
import tseslint from "typescript-eslint";

// `no-restricted-imports` is replaced wholesale by the last config block that
// matches a file, not merged into what an earlier one set. Two blocks both
// naming packages/gateway would silently drop the first one's patterns, so the
// shared pattern is a constant and every block that needs it says so.
const PROXY_IMPORT_BAN = {
  group: ["@getlibero/proxy", "@getlibero/proxy/*", "**/packages/proxy/*"],
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
    files: ["packages/agent/**/*.ts", "packages/gateway/**/*.ts", "apps/server/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [PROXY_IMPORT_BAN] }]
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
    files: ["packages/gateway/src/**/*.ts"],
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
  }
);
