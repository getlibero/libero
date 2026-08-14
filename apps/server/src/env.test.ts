import { describe, expect, it } from "vitest";
import {
  channelsRootFromEnv,
  completionConfigFromEnv,
  embeddingConfigFromEnv,
  modelFromEnv,
  proxyConfigFromEnv,
  requiredEnv,
  slackTokensFromEnv,
  storeRootFromEnv
} from "./env.js";

describe("requiredEnv", () => {
  it("returns a set value", () => {
    expect(requiredEnv({ AGENT_MODEL: "claude-sonnet-4-6" }, "AGENT_MODEL")).toBe(
      "claude-sonnet-4-6"
    );
  });

  it("refuses to start on a missing or empty value, naming the variable", () => {
    expect(() => requiredEnv({}, "SLACK_APP_TOKEN")).toThrow(/SLACK_APP_TOKEN/);
    expect(() => requiredEnv({ SLACK_BOT_TOKEN: "" }, "SLACK_BOT_TOKEN")).toThrow(/SLACK_BOT_TOKEN/);
  });
});

describe("slackTokensFromEnv", () => {
  const both = { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" };

  it("returns both tokens", () => {
    expect(slackTokensFromEnv(both)).toEqual({ appToken: "xapp-test", botToken: "xoxb-test" });
  });

  it("requires each one", () => {
    expect(() => slackTokensFromEnv({ SLACK_APP_TOKEN: "xapp-test" })).toThrow(/SLACK_BOT_TOKEN/);
    expect(() => slackTokensFromEnv({ SLACK_BOT_TOKEN: "xoxb-test" })).toThrow(/SLACK_APP_TOKEN/);
  });

  it("does not put a token value in the failure message", () => {
    // This process holds both tokens and a startup error is the one string an
    // operator pastes into an issue.
    expect(() => slackTokensFromEnv({ SLACK_APP_TOKEN: "xapp-secret" })).not.toThrow(
      /xapp-secret/
    );
  });
});

describe("modelFromEnv", () => {
  it("passes the model id through verbatim", () => {
    expect(modelFromEnv({ AGENT_MODEL: "openai/gpt-4.1-mini" })).toBe("openai/gpt-4.1-mini");
  });

  it("has no default", () => {
    expect(() => modelFromEnv({})).toThrow(/AGENT_MODEL/);
  });
});

describe("channelsRootFromEnv", () => {
  it("returns the root as given", () => {
    expect(channelsRootFromEnv({ AGENT_CHANNELS_ROOT: "/data/channels" })).toBe("/data/channels");
  });

  it("has no default", () => {
    // Advisory is not a reason to soften this. Unset, every channel silently
    // runs on the built-in caps with its sheet's `[llm]` block ignored, and
    // that looks identical to a path that is merely typed wrong.
    expect(() => channelsRootFromEnv({})).toThrow(/AGENT_CHANNELS_ROOT/);
  });

  it("reads nothing from disk", () => {
    // A root that does not exist is a startup that succeeds and a channel whose
    // sheet falls back — the deployment still answers, and the tool proxy
    // service still refuses everything it should.
    expect(channelsRootFromEnv({ AGENT_CHANNELS_ROOT: "/nowhere/at/all" })).toBe("/nowhere/at/all");
  });
});

describe("storeRootFromEnv", () => {
  it("returns the root as given", () => {
    expect(storeRootFromEnv({ AGENT_STORE_ROOT: "/data/store" })).toBe("/data/store");
  });

  it("has no default", () => {
    // It holds message text, which is what makes a default worse here than for
    // the two proxy databases: an operator should be choosing where a channel's
    // conversation lands, not inheriting a path.
    expect(() => storeRootFromEnv({})).toThrow(/AGENT_STORE_ROOT/);
  });

  it("is a separate variable from the channels root", () => {
    // The security decision, in the smallest form it can be asserted in. The
    // channels directory is where the tool proxy reads its authorization from
    // and stays read-only to both services; everything this process writes goes
    // somewhere else. One variable serving both would make the two the same
    // directory by default.
    const env = { AGENT_CHANNELS_ROOT: "/data/channels", AGENT_STORE_ROOT: "/data/store" };

    expect(storeRootFromEnv(env)).not.toBe(channelsRootFromEnv(env));
    expect(() => storeRootFromEnv({ AGENT_CHANNELS_ROOT: "/data/channels" })).toThrow(
      /AGENT_STORE_ROOT/
    );
  });

  it("reads nothing from disk", () => {
    expect(storeRootFromEnv({ AGENT_STORE_ROOT: "/nowhere/at/all" })).toBe("/nowhere/at/all");
  });
});

describe("completionConfigFromEnv", () => {
  it("builds the anthropic arm", () => {
    expect(
      completionConfigFromEnv({ AGENT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" })
    ).toEqual({ provider: "anthropic", apiKey: "sk-ant-test" });
  });

  it("builds the openai-compatible arm", () => {
    expect(
      completionConfigFromEnv({ AGENT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "sk-test" })
    ).toEqual({ provider: "openai-compatible", apiKey: "sk-test" });
  });

  it("passes a base URL through when set, and omits the key entirely when not", () => {
    // Omitted rather than undefined: exactOptionalPropertyTypes rejects an
    // explicit undefined, and the adapters have their own defaults. An empty
    // value falls back alongside unset, so a blanked-out line in an env file
    // means the provider's own endpoint.
    expect(
      completionConfigFromEnv({
        AGENT_PROVIDER: "openai-compatible",
        OPENAI_API_KEY: "sk-test",
        OPENAI_BASE_URL: "http://litellm:4000/v1"
      })
    ).toEqual({
      provider: "openai-compatible",
      apiKey: "sk-test",
      baseUrl: "http://litellm:4000/v1"
    });

    for (const OPENAI_BASE_URL of ["", undefined]) {
      const config = completionConfigFromEnv({
        AGENT_PROVIDER: "openai-compatible",
        OPENAI_API_KEY: "sk-test",
        OPENAI_BASE_URL
      });
      expect(Object.hasOwn(config, "baseUrl")).toBe(false);
    }
  });

  it("reads each provider's own base URL variable, not the other's", () => {
    expect(
      completionConfigFromEnv({
        AGENT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_BASE_URL: "http://gateway.internal/anthropic",
        OPENAI_BASE_URL: "http://litellm:4000/v1"
      })
    ).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      baseUrl: "http://gateway.internal/anthropic"
    });
  });

  it("requires the key for the provider that was named, and only that one", () => {
    // The point of naming the provider: a deployment with the other key set is
    // still a startup failure rather than a quiet switch of accounts.
    expect(() =>
      completionConfigFromEnv({ AGENT_PROVIDER: "anthropic", OPENAI_API_KEY: "sk-test" })
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("never infers the provider from which key is set", () => {
    expect(() => completionConfigFromEnv({ ANTHROPIC_API_KEY: "sk-ant-test" })).toThrow(
      /AGENT_PROVIDER/
    );
  });

  it("names the accepted values on an unknown provider", () => {
    expect(() =>
      completionConfigFromEnv({ AGENT_PROVIDER: "antropic", ANTHROPIC_API_KEY: "sk-ant-test" })
    ).toThrow(/anthropic, openai-compatible/);
  });

  it("does not put an API key in any failure message", () => {
    expect(() =>
      completionConfigFromEnv({ AGENT_PROVIDER: "nope", ANTHROPIC_API_KEY: "sk-ant-secret" })
    ).not.toThrow(/sk-ant-secret/);
  });
});

describe("proxyConfigFromEnv", () => {
  const PROXY = {
    PROXY_URL: "https://proxy:8443",
    PROXY_TLS_CA: "/etc/libero/certs/ca.pem",
    PROXY_CLIENT_CERT_DIR: "/etc/libero/certs/agent"
  };

  it("reads the three variables the compose file declares", () => {
    expect(proxyConfigFromEnv(PROXY)).toEqual({
      url: "https://proxy:8443",
      caPath: "/etc/libero/certs/ca.pem",
      clientCertDir: "/etc/libero/certs/agent"
    });
  });

  // No fallback to a toolless agent. A deployment missing one of these is not
  // one that answers without tools — it is misconfigured, and a silent
  // downgrade would be a model saying it cannot do what the channel permits,
  // with nothing in the logs to say why.
  it("refuses to start when any one of them is missing", () => {
    for (const name of Object.keys(PROXY)) {
      const partial = { ...PROXY, [name]: undefined };
      expect(() => proxyConfigFromEnv(partial)).toThrow(new RegExp(name));
    }
    expect(() => proxyConfigFromEnv({})).toThrow(/PROXY_URL/);
  });

  it("treats an empty value as unset", () => {
    expect(() => proxyConfigFromEnv({ ...PROXY, PROXY_TLS_CA: "" })).toThrow(/PROXY_TLS_CA/);
  });

  // Nothing here opens a file or a socket: the transport reads the CA at
  // construction, which is still before the socket opens.
  it("reads no file", () => {
    expect(() =>
      proxyConfigFromEnv({ ...PROXY, PROXY_TLS_CA: "/nowhere/at/all.pem" })
    ).not.toThrow();
  });
});

describe("embeddingConfigFromEnv", () => {
  const CONFIGURED = {
    AGENT_EMBEDDING_PROVIDER: "openai-compatible",
    AGENT_EMBEDDING_MODEL: "text-embedding-3-small",
    AGENT_EMBEDDING_API_KEY: "sk-embed-test"
  };

  it("builds the openai-compatible arm", () => {
    expect(embeddingConfigFromEnv(CONFIGURED)).toEqual({
      config: { provider: "openai-compatible", apiKey: "sk-embed-test" },
      model: "text-embedding-3-small"
    });
  });

  // The one optional provider in this file. Memory Layers 1 and 2 are whole
  // without embeddings, so an unset provider is a supported deployment rather
  // than a misconfigured one — and the caller logs it rather than throwing.
  it("answers null when no provider is named", () => {
    expect(embeddingConfigFromEnv({})).toBeNull();
    expect(embeddingConfigFromEnv({ AGENT_EMBEDDING_PROVIDER: "" })).toBeNull();
  });

  // Off is a decision an operator makes by leaving the provider unset. Naming
  // one and omitting what it needs is someone who meant to turn this on, and
  // answering "off" to that would be the silent downgrade.
  it("refuses partial configuration rather than silently degrading", () => {
    expect(() =>
      embeddingConfigFromEnv({ ...CONFIGURED, AGENT_EMBEDDING_MODEL: undefined })
    ).toThrow(/AGENT_EMBEDDING_MODEL/);

    expect(() =>
      embeddingConfigFromEnv({ ...CONFIGURED, AGENT_EMBEDDING_API_KEY: undefined })
    ).toThrow(/OPENAI_API_KEY/);
  });

  // One account, one variable. The fallback exists so a deployment whose
  // embedding vendor really is its completion vendor does not keep two copies
  // of one secret.
  it("falls back to OPENAI_API_KEY when no embedding key is set", () => {
    expect(
      embeddingConfigFromEnv({
        ...CONFIGURED,
        AGENT_EMBEDDING_API_KEY: undefined,
        OPENAI_API_KEY: "sk-shared"
      })
    ).toEqual({
      config: { provider: "openai-compatible", apiKey: "sk-shared" },
      model: "text-embedding-3-small"
    });
  });

  // Configured separately from AGENT_PROVIDER on purpose: Anthropic publishes
  // no embeddings endpoint, so completing against one vendor and embedding
  // against another is the ordinary case.
  it("does not read AGENT_PROVIDER", () => {
    expect(embeddingConfigFromEnv({ AGENT_PROVIDER: "anthropic" })).toBeNull();
    expect(embeddingConfigFromEnv({ ...CONFIGURED, AGENT_PROVIDER: "anthropic" })).not.toBeNull();
  });

  it("passes a base URL through when set, and omits it entirely when not", () => {
    expect(
      embeddingConfigFromEnv({
        ...CONFIGURED,
        AGENT_EMBEDDING_BASE_URL: "https://api.voyageai.com/v1"
      })?.config
    ).toEqual({
      provider: "openai-compatible",
      apiKey: "sk-embed-test",
      baseUrl: "https://api.voyageai.com/v1"
    });

    expect(
      Object.keys(embeddingConfigFromEnv({ ...CONFIGURED, AGENT_EMBEDDING_BASE_URL: "" })!.config)
    ).not.toContain("baseUrl");
  });

  it("echoes an unknown provider name, which is not a secret", () => {
    expect(() =>
      embeddingConfigFromEnv({ ...CONFIGURED, AGENT_EMBEDDING_PROVIDER: "voyage-native" })
    ).toThrow(/voyage-native/);
  });
});
