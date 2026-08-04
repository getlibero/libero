// Flat config. The rule that matters most is the security boundary:
// packages/agent must never import packages/proxy. The only path from
// agent to tools is the network call to the proxy service.
import tseslint from "typescript-eslint";

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
    // next to the model, so it sits on the same side of the boundary.
    files: ["packages/agent/**/*.ts", "apps/server/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@getlibero/proxy", "@getlibero/proxy/*", "**/packages/proxy/*"],
              message:
                "SECURITY BOUNDARY: the agent may not import the proxy. Tools are reached only via the proxy's HTTP API."
            }
          ]
        }
      ]
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
