// Environment parsing for the gateway + agent process, apart from index.ts so
// the rules — and their failure modes — can be tested without a socket, a
// provider, or a process.
//
// Every message here names the variable and carries nothing of what was set.
// This process holds the Slack app and bot tokens and the model provider key,
// and a startup error is printed, logged by whatever supervises the container,
// and pasted into an issue.

import type { CompletionConfig, EmbeddingConfig, ProxyTransportOptions } from "@getlibero/agent";

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
 * Where the per-channel message stores live: `AGENT_STORE_ROOT`, holding one
 * directory per channel, each with a `store.db`.
 *
 * **A separate root from `AGENT_CHANNELS_ROOT`, and that is a security decision
 * rather than a filing preference.** The obvious layout puts `store.db` beside
 * the channel's `channel.toml`, which is what `architecture.md` drew — but both
 * services mount the channels directory, and it is where the tool proxy reads
 * its authorization from. Making it writable here would mean the process that
 * runs the model could rewrite a `channel.toml`; the proxy re-reads the sheet
 * per call, so that is a compromised agent widening its own permissions. The
 * channels root stays read-only to both services and everything this process
 * writes goes somewhere else.
 *
 * Required, with no default, and it holds message text — which is what makes it
 * unlike `PROXY_BUDGET_DB` and `PROXY_AUDIT_DB`, whose paragraphs otherwise
 * read the same. Those hold counts and outcomes. This holds what people said,
 * and an operator choosing where it lands should be choosing deliberately
 * rather than inheriting a default.
 *
 * Nothing here reads or creates the directory. Whether a channel gets a store,
 * and where under this root it goes, is `session/store.ts`'s — and it is gated
 * on that channel having a team sheet.
 */
export function storeRootFromEnv(env: Env): string {
  return requiredEnv(env, "AGENT_STORE_ROOT");
}

/**
 * Where the operator's shared skills live: `AGENT_SHARED_SKILLS_ROOT`, holding
 * one `<name>.md` per skill — or `null` when this deployment publishes none.
 *
 * **A third root, and the third one is a third security decision** (#373). It is
 * not `AGENT_CHANNELS_ROOT`, for that variable's stated reason: the proxy reads
 * its authorization there. It is not `AGENT_STORE_ROOT` either, and that is the
 * new half. The store root is the one directory this process *writes*, so a
 * shared skill kept under it would be a file a compromised agent could rewrite —
 * and unlike a channel-authored skill, which poisons one channel's future tasks,
 * a shared skill is read by every channel whose sheet names it. One writable file
 * poisoning every channel at once is exactly the cross-channel amplification the
 * per-channel layout exists to prevent, so this root is mounted read-only and
 * nothing in this process opens it for writing.
 *
 * **`null` rather than a throw when unset**, which is `embeddingConfigFromEnv`'s
 * departure and for its reason. A deployment that publishes no shared skills is
 * a supported deployment rather than a broken one: every channel's own skills
 * work exactly as before and there is simply no shared half. It is the second
 * optional variable in this file, and the test for whether an absence should
 * throw is the same one — does the process still do the thing it exists to do?
 *
 * What an unset root must not become is a silent empty load. A sheet naming a
 * `[[shared_skill]]` in a deployment with no root is an operator who configured
 * one half of a feature, and the channel is told rather than quietly served a
 * prompt with nothing in it. Saying so is the business of whatever assembles the
 * text (#435, #436) — this function's part is answering `null` distinctly rather
 * than defaulting to a path, so there is something to say it about.
 *
 * Nothing here reads or creates the directory. An empty root is the ordinary
 * state of a deployment that has mounted one and published nothing into it yet;
 * a root that is named and absent is `libero doctor`'s to report.
 */
export function sharedSkillsRootFromEnv(env: Env): string | null {
  const value = env["AGENT_SHARED_SKILLS_ROOT"];
  return value === undefined || value === "" ? null : value;
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

/** Every provider `AGENT_EMBEDDING_PROVIDER` accepts. One, so far. */
const EMBEDDING_PROVIDERS = ["openai-compatible"] as const;

/**
 * How this deployment embeds, or `null` if it does not.
 *
 * **Configured separately from `AGENT_PROVIDER`, and that is the point rather
 * than an oversight.** Anthropic publishes no embeddings endpoint, so the
 * ordinary deployment completes against one vendor and embeds against another —
 * Voyage, OpenAI, a local Ollama, the litellm sidecar. Deriving this from
 * `AGENT_PROVIDER` would make the commonest configuration the unexpressible
 * one.
 *
 * **`null` rather than a throw when unset**, which is the one place this file
 * departs from `completionConfigFromEnv`'s shape, and the reason is what each
 * absence means. A deployment with no completion provider cannot answer a
 * mention at all; a deployment with no embedding provider answers every mention
 * exactly as before and simply has no Layer 3. That is a supported
 * configuration — memory Layers 1 and 2 are whole without it — so it degrades
 * with a line in the log rather than refusing to boot. `apps/server/src/index.ts`
 * is where that line is said.
 *
 * Partial configuration is still an error. Naming a provider without a key, or
 * a key without a model, is someone who meant to turn this on, and answering
 * `null` to that would be a silent downgrade — the failure this whole function
 * is arranged to avoid.
 */
export function embeddingConfigFromEnv(
  env: Env
): { config: EmbeddingConfig; model: string } | null {
  const provider = env["AGENT_EMBEDDING_PROVIDER"];
  if (provider === undefined || provider === "") return null;

  switch (provider) {
    case "openai-compatible":
      return {
        config: {
          provider,
          // `AGENT_EMBEDDING_API_KEY` rather than reusing `OPENAI_API_KEY`,
          // because the embedding vendor is usually not the completion vendor
          // and a Voyage key under an OpenAI name is a trap. It falls back to
          // `OPENAI_API_KEY` for the deployment where they genuinely are the
          // same account, so that case needs one variable rather than two
          // copies of one secret.
          apiKey:
            env["AGENT_EMBEDDING_API_KEY"] !== undefined &&
            env["AGENT_EMBEDDING_API_KEY"] !== ""
              ? env["AGENT_EMBEDDING_API_KEY"]
              : requiredEnv(env, "OPENAI_API_KEY"),
          ...optionalBaseUrl(env, "AGENT_EMBEDDING_BASE_URL")
        },
        // Required once a provider is named: there is no sensible default, and
        // the id is stamped against a channel's vectors by `packages/memory`,
        // so guessing it would be guessing what a stored vector means.
        model: requiredEnv(env, "AGENT_EMBEDDING_MODEL")
      };
    default:
      throw new Error(
        `server: AGENT_EMBEDDING_PROVIDER must be one of ${EMBEDDING_PROVIDERS.join(", ")}, ` +
          `and was: ${provider}`
      );
  }
}

/**
 * A positive whole number, or nothing at all.
 *
 * **The first numbers this file has ever read, and the exception wants
 * arguing rather than assuming.** `session/registry.ts` states the rule they
 * bend: "this process's environment contract is that everything in it is
 * required and load-bearing; an optional knob for a number nobody has yet had a
 * reason to change cuts against it." Read exactly, that is a bar and not a ban
 * — it refuses a knob for a number *nobody has had a reason to change*. #465 is
 * the reason, arrived at by asking which of the figures bounding a deployment
 * an operator may move and finding that the answer for every one of these was
 * "none, short of a fork".
 *
 * So the contract is not "every variable is required" but the sentence
 * immediately above `sharedSkillsRootFromEnv`: the test for whether an absence
 * may be optional is whether the process still does the thing it exists to do.
 * Absent, every one of these keeps the figure the module already argued for, so
 * a deployment that sets nothing changes nothing.
 *
 * `apps/runner/src/env.ts` is the shape being copied, down to why `""` is
 * absent and why zero is refused rather than ignored: `AGENT_RECALL_LIMIT=0`
 * and `AGENT_RECALL_LIMIT=none` are both an operator trying to say something,
 * and neither means what silently continuing would do. It is copied rather than
 * shared, because sharing would mean one service importing another's package —
 * the edge that file refuses in its own header.
 *
 * **No ceiling on any of them**, which is `PROXY_MAX_RESPONSE_BYTES`' argument
 * one process over: capping the principal who owns the heap, the bill and the
 * context window would be advice rather than a boundary. The one figure with a
 * real bound is `AGENT_RECALL_LIMIT`, and that bound is the store's rather than
 * this file's — `index.ts` says so at boot instead of refusing it here.
 */
function positiveInteger(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    // Echoed, the way `completionConfigFromEnv` echoes a bad provider name: a
    // count is not a secret, and the number an operator typed is the whole of
    // what they need to see to fix it.
    throw new Error(`server: ${name} is not a positive whole number: ${raw}`);
  }
  return value;
}

/**
 * How many thread summaries one task may open with: `AGENT_RECALL_LIMIT`.
 *
 * `RECALL_LIMIT`'s five is sized against a corpus — "a retrieved summary that
 * was not relevant is not neutral, it is a distractor" — and the size of the
 * corpus is a deployment fact this repository cannot know. A workspace with
 * years of threads and one with a fortnight's are not the same question.
 *
 * Not a sheet field, and that split is the same one `PROXY_MAX_RESPONSE_BYTES`
 * draws: what a channel may spend on its own task is `[llm]`'s business, and
 * how many rows this process pulls out of a store on every task is the
 * operator's.
 */
export function recallLimitFromEnv(env: Env): number | undefined {
  return positiveInteger(env, "AGENT_RECALL_LIMIT");
}

/** How many characters the recall block may reach: `AGENT_RECALL_MAX_CHARS`. */
export function recallMaxCharsFromEnv(env: Env): number | undefined {
  return positiveInteger(env, "AGENT_RECALL_MAX_CHARS");
}

/** How many characters retrieved skills may reach: `AGENT_SKILLS_MAX_CHARS`. */
export function skillsMaxCharsFromEnv(env: Env): number | undefined {
  return positiveInteger(env, "AGENT_SKILLS_MAX_CHARS");
}

/**
 * How many merge proposals may wait at once: `AGENT_MAX_OPEN_PROPOSALS`.
 *
 * What `MAX_OPEN_PROPOSALS` bounds is how much unread review a team is carrying,
 * and three is sized against a small one. A larger team clears them faster and
 * has no way to say so.
 */
export function maxOpenProposalsFromEnv(env: Env): number | undefined {
  return positiveInteger(env, "AGENT_MAX_OPEN_PROPOSALS");
}

/**
 * How often the skill lifecycle job may run, in milliseconds:
 * `AGENT_SKILL_LIFECYCLE_INTERVAL_MS`.
 *
 * The spec calls this a weekly job and `LIFECYCLE_INTERVAL_MS` is six hours;
 * what makes any interval at or below a week satisfy it is idempotence. An
 * operator serving many channels is the one who knows what that costs them.
 */
export function lifecycleIntervalMsFromEnv(env: Env): number | undefined {
  return positiveInteger(env, "AGENT_SKILL_LIFECYCLE_INTERVAL_MS");
}

/**
 * How long between unbidden posts, in milliseconds:
 * `AGENT_HEARTBEAT_POST_WINDOW_MS`.
 *
 * `[ambient]`'s own comment refuses the *sheet field* version of this and the
 * refusal stands: "nothing named `posts_per_hour` goes on this block", because
 * a channel able to tighten its cadence must not thereby loosen its own
 * throttle. **An operator is not a channel.** The throttle stays where that
 * comment puts it, enforced in the posting surface and reachable by no sheet;
 * what moves is who may size it, and the deployment paying for the posts is
 * better placed than a figure chosen once against one workspace's taste.
 */
export function heartbeatPostWindowMsFromEnv(env: Env): number | undefined {
  return positiveInteger(env, "AGENT_HEARTBEAT_POST_WINDOW_MS");
}
