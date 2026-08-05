// Environment parsing for the gateway + agent process, apart from index.ts so
// the rules — and their failure modes — can be tested without a socket, a
// provider, or a process.
//
// Every message here names the variable and carries nothing of what was set.
// This process holds the Slack app and bot tokens and the model provider key,
// and a startup error is printed, logged by whatever supervises the container,
// and pasted into an issue.

import type { CompletionConfig, ProxyTransportOptions } from "@getlibero/agent";

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
 * This is the fallback rather than the answer. A channel whose team sheet names
 * an `[llm] model` runs on that one — the resolution is in session/sheet.ts —
 * and this is what a channel that names none, or has no readable sheet at all,
 * gets. Which is why it stays required: it is the model every unprovisioned
 * channel in the deployment will use.
 */
export function modelFromEnv(env: Env): string {
  return requiredEnv(env, "AGENT_MODEL");
}

/**
 * Where the per-channel team sheets live: `AGENT_CHANNELS_ROOT`, holding one
 * directory per channel, each with a `channel.toml`.
 *
 * Prefixed as this process's own setting rather than shared with the proxy's,
 * because the two services mount the same directory and do not read it the same
 * way. For the tool proxy service it is the authorization source: which tools
 * exist, which need a human, what the daily budget is. Here it is advisory — a
 * model id and four per-task caps the loop applies to itself as defence in
 * depth, while the proxy's meter stays authoritative.
 *
 * Required, with no default, and advisory is not a reason to soften that. Unset,
 * every channel silently runs on the built-in caps and this process's model,
 * with each sheet's `[llm]` block ignored and nothing in the log to say so —
 * which is the same silent downgrade the three `PROXY_*` variables refuse, and
 * it looks identical to a path that is merely typed wrong.
 *
 * Nothing here reads the directory. A root that does not exist is a channel
 * whose sheet cannot be read, which falls back rather than failing: the
 * deployment still answers, and the proxy still refuses everything it should.
 */
export function channelsRootFromEnv(env: Env): string {
  return requiredEnv(env, "AGENT_CHANNELS_ROOT");
}

/**
 * How to reach the tool proxy: `PROXY_URL`, `PROXY_TLS_CA`, `PROXY_CLIENT_CERT_DIR`.
 *
 * All three required, none defaulted, and this is the variable set that decides
 * whether the process can call a tool at all. There is no fallback to a
 * toolless agent when they are unset, on purpose: a deployment missing one of
 * these is not a deployment that answers without tools, it is a misconfigured
 * one, and a silent downgrade would be a model that says it cannot do something
 * it is in fact permitted to do — with nothing in the logs to say why.
 *
 * `PROXY_URL` must be https, which `createProxyTransport` checks. Mutual TLS is
 * the proxy's only authentication, so a plaintext URL is not a weaker
 * deployment but a broken one.
 *
 * Nothing here reads a file. The paths are handed to the transport, which reads
 * the CA at construction — before the socket opens — so a wrong path is a
 * startup failure naming it rather than a task that fails in a thread.
 */
export function proxyConfigFromEnv(env: Env): ProxyTransportOptions {
  return {
    url: requiredEnv(env, "PROXY_URL"),
    caPath: requiredEnv(env, "PROXY_TLS_CA"),
    clientCertDir: requiredEnv(env, "PROXY_CLIENT_CERT_DIR")
  };
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
