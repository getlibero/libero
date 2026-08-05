// Environment parsing for the gateway + agent process, apart from index.ts so
// the rules — and their failure modes — can be tested without a socket, a
// provider, or a process.
//
// Every message here names the variable and carries nothing of what was set.
// This process holds the Slack app and bot tokens and the model provider key,
// and a startup error is printed, logged by whatever supervises the container,
// and pasted into an issue.

import type { CompletionConfig } from "@getlibero/agent";

/** The slice of process.env this process reads. */
export type Env = Record<string, string | undefined>;

export function requiredEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    // Loud, and at startup. Every alternative fails at the far end of a Slack
    // thread: no socket and no answer, or an answer from a model the operator
    // did not choose.
    throw new Error(`server: ${name} is required and was not set`);
  }
  return value;
}

/**
 * The two Slack tokens, `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`.
 *
 * Both required, no defaults. They are different credentials with different
 * powers — the app-level token opens the socket and cannot post, the bot token
 * posts and cannot open the socket — so a deployment with one of them is not a
 * degraded deployment, it is a broken one.
 *
 * Nothing here checks the `xapp-`/`xoxb-` prefixes. Slack's own rejection is
 * authoritative, arrives at `start()`, and says which token it refused;
 * a prefix check here would only add a second, less accurate opinion.
 */
export function slackTokensFromEnv(env: Env): { appToken: string; botToken: string } {
  return {
    appToken: requiredEnv(env, "SLACK_APP_TOKEN"),
    botToken: requiredEnv(env, "SLACK_BOT_TOKEN")
  };
}

/**
 * The model id: `AGENT_MODEL`, passed to the provider verbatim.
 *
 * Required with no default. A default is a model id that goes stale on the
 * provider's schedule and pins a price the operator never chose, and it would
 * be wrong for every channel at once.
 *
 * The per-channel `[llm] model` override in the team sheet resolves upstream of
 * this and does not exist yet — reading a sheet per channel is the session
 * router's job (#65). This is the one model the process answers with.
 */
export function modelFromEnv(env: Env): string {
  return requiredEnv(env, "AGENT_MODEL");
}

/** Every provider `AGENT_PROVIDER` accepts, in the message an operator sees. */
const PROVIDERS = ["anthropic", "openai-compatible"] as const;

/**
 * `{ baseUrl }` when the variable is set, `{}` when it is not.
 *
 * An empty value falls back alongside unset: a blanked-out `OPENAI_BASE_URL=`
 * line in an env file means "the provider's own endpoint", not an empty string
 * for an SDK to resolve URLs against.
 */
function optionalBaseUrl(env: Env, name: string): { baseUrl?: string } {
  const value = env[name];
  return value === undefined || value === "" ? {} : { baseUrl: value };
}

/**
 * Which provider to complete against, and the key for it.
 *
 * `AGENT_PROVIDER` is required and never inferred from which key happens to be
 * set. `deploy/docker-compose.yml` declares both `ANTHROPIC_API_KEY` and
 * `OPENAI_API_KEY` on this service, so inference would resolve on the order the
 * arms are written in and bill an account the operator did not pick — a failure
 * that produces correct-looking answers and an unexpected invoice.
 *
 * The key and the base URL are read from each provider's own conventional
 * variable rather than one `AGENT_*` pair, because that is what an operator
 * already has in their shell and what every other tool in the deployment
 * reads. `OPENAI_BASE_URL` is the openai-compatible arm's whole reach:
 * Together, Fireworks, Groq, Ollama, Gemini's compatibility endpoint, and the
 * litellm sidecar in the compose file are all one base URL apart.
 *
 * A base URL is passed through only when set — `exactOptionalPropertyTypes`
 * rejects an explicit `undefined`, and each adapter has its own default.
 */
export function completionConfigFromEnv(env: Env): CompletionConfig {
  const provider = requiredEnv(env, "AGENT_PROVIDER");

  switch (provider) {
    case "anthropic":
      return {
        provider,
        apiKey: requiredEnv(env, "ANTHROPIC_API_KEY"),
        ...optionalBaseUrl(env, "ANTHROPIC_BASE_URL")
      };
    case "openai-compatible":
      return {
        provider,
        apiKey: requiredEnv(env, "OPENAI_API_KEY"),
        ...optionalBaseUrl(env, "OPENAI_BASE_URL")
      };
    default:
      // Echoed, the way PROXY_PORT echoes a bad port: a provider name is not a
      // secret, and a typo is the whole failure mode this arm exists for.
      throw new Error(
        `server: AGENT_PROVIDER must be one of ${PROVIDERS.join(", ")}, and was: ${provider}`
      );
  }
}
