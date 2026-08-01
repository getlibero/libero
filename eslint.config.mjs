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
    files: ["packages/agent/**/*.ts"],
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
  }
);
