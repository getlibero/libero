import { describe, expect, it } from "vitest";
import {
  channelsRootFromEnv,
  completionConfigFromEnv,
  modelFromEnv,
  proxyConfigFromEnv,
  requiredEnv,
  slackTokensFromEnv
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
