import { randomBytes } from "node:crypto";
import { DEFAULT_UPSTREAM_CONCURRENCY, DEFAULT_UPSTREAM_RESPONSE_BYTES } from "@getlibero/proxy";
import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  auditDbFromEnv,
  storeRootFromEnv,
  budgetDbFromEnv,
  channelsRootFromEnv,
  hostFromEnv,
  maxResponseBytesFromEnv,
  maxUpstreamConcurrencyFromEnv,
  portFromEnv,
  requiredEnv,
  upstreamTimeoutMsFromEnv,
  vaultFileFromEnv,
  vaultKeyFromEnv
} from "./env.js";

describe("requiredEnv", () => {
  it("returns a set value", () => {
    expect(requiredEnv({ PROXY_TLS_CERT: "deploy/certs/proxy/server.pem" }, "PROXY_TLS_CERT")).toBe(
      "deploy/certs/proxy/server.pem"
    );
  });

  it("refuses to start on a missing or empty value, naming the variable", () => {
    expect(() => requiredEnv({}, "PROXY_TLS_CERT")).toThrow(/PROXY_TLS_CERT/);
    expect(() => requiredEnv({ PROXY_TLS_KEY: "" }, "PROXY_TLS_KEY")).toThrow(/PROXY_TLS_KEY/);
  });
});

describe("hostFromEnv", () => {
  it("defaults to localhost", () => {
    expect(hostFromEnv({})).toBe(DEFAULT_HOST);
  });

  it("treats an empty PROXY_HOST as unset", () => {
    // Node binds every interface when given an empty host string, so a
    // blanked-out PROXY_HOST= line must mean localhost, not 0.0.0.0.
    expect(hostFromEnv({ PROXY_HOST: "" })).toBe(DEFAULT_HOST);
  });

  it("passes an explicit host through", () => {
    expect(hostFromEnv({ PROXY_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

describe("portFromEnv", () => {
  it("defaults when unset or empty", () => {
    expect(portFromEnv({})).toBe(DEFAULT_PORT);
    expect(portFromEnv({ PROXY_PORT: "" })).toBe(DEFAULT_PORT);
  });

  it("parses a port number", () => {
    expect(portFromEnv({ PROXY_PORT: "9443" })).toBe(9443);
  });

  // Not a deployment setting: no PROXY_URL can be written against a port the
  // OS has not chosen yet. It exists so a harness spawning this process can be
  // told the port in the `listening` line instead of racing to reserve one.
  it("accepts 0, which asks the OS to choose", () => {
    expect(portFromEnv({ PROXY_PORT: "0" })).toBe(0);
  });

  each(["65536", "-1", "8443.5", "https"])("refuses %j", raw => {
    expect(() => portFromEnv({ PROXY_PORT: raw })).toThrow(/PROXY_PORT/);
  });
});

// The deployment's half of #151. The channel's half is a team sheet field, and
// the split is which principal owns the resource each spends: this one buys
// memory in a process every channel shares, so no sheet may raise it.
describe("maxResponseBytesFromEnv", () => {
  it("defaults when unset or empty", () => {
    expect(maxResponseBytesFromEnv({})).toBe(DEFAULT_UPSTREAM_RESPONSE_BYTES);
    expect(maxResponseBytesFromEnv({ PROXY_MAX_RESPONSE_BYTES: "" })).toBe(DEFAULT_UPSTREAM_RESPONSE_BYTES);
  });

  it("takes the operator's number", () => {
    expect(maxResponseBytesFromEnv({ PROXY_MAX_RESPONSE_BYTES: "8388608" })).toBe(8_388_608);
  });

  // Zero is not "no limit" here, it is every call refused — unlike PROXY_PORT,
  // where zero is a real request. And no upper bound: the operator setting this
  // is the one who owns the heap it spends, so a ceiling would be advice.
  each(["0", "-1", "4194304.5", "4mb", "unlimited"])("refuses %j", raw => {
    expect(() => maxResponseBytesFromEnv({ PROXY_MAX_RESPONSE_BYTES: raw })).toThrow(/PROXY_MAX_RESPONSE_BYTES/);
  });

  it("accepts a number far above the default", () => {
    expect(maxResponseBytesFromEnv({ PROXY_MAX_RESPONSE_BYTES: "67108864" })).toBe(67_108_864);
  });
});

describe("maxUpstreamConcurrencyFromEnv", () => {
  it("defaults when unset or empty", () => {
    expect(maxUpstreamConcurrencyFromEnv({})).toBe(DEFAULT_UPSTREAM_CONCURRENCY);
    expect(maxUpstreamConcurrencyFromEnv({ PROXY_MAX_UPSTREAM_CONCURRENCY: "" })).toBe(DEFAULT_UPSTREAM_CONCURRENCY);
  });

  it("takes the operator's number", () => {
    expect(maxUpstreamConcurrencyFromEnv({ PROXY_MAX_UPSTREAM_CONCURRENCY: "16" })).toBe(16);
  });

  // One is a setting, not a mistake: an upstream that permits a single
  // concurrent call is a real thing, and serialising against it is what an
  // operator would be asking for.
  it("accepts one", () => {
    expect(maxUpstreamConcurrencyFromEnv({ PROXY_MAX_UPSTREAM_CONCURRENCY: "1" })).toBe(1);
  });

  // Zero is every call refused rather than "no limit", per the bound above. No
  // ceiling either — the operator who knows what their upstream tolerates is the
  // only one who could set one.
  each(["0", "-4", "8.5", "eight", "unlimited"])("refuses %j", raw => {
    expect(() => maxUpstreamConcurrencyFromEnv({ PROXY_MAX_UPSTREAM_CONCURRENCY: raw })).toThrow(
      /PROXY_MAX_UPSTREAM_CONCURRENCY/
    );
  });
});

describe("upstreamTimeoutMsFromEnv", () => {
  // Absent means "the package's default applies" rather than a number this
  // file restates: the option is spread in conditionally, so undefined here is
  // an option not passed rather than a timeout of undefined.
  it("is undefined when unset or empty", () => {
    expect(upstreamTimeoutMsFromEnv({})).toBeUndefined();
    expect(upstreamTimeoutMsFromEnv({ PROXY_UPSTREAM_TIMEOUT_MS: "" })).toBeUndefined();
  });

  it("takes the operator's number", () => {
    expect(upstreamTimeoutMsFromEnv({ PROXY_UPSTREAM_TIMEOUT_MS: "2000" })).toBe(2000);
  });

  // Zero is every call timed out rather than "no timeout", the same reading
  // its neighbours give a blanked-out zero. No ceiling — a patient operator is
  // spending their own sockets.
  each(["0", "-1", "1.5", "abc"])("refuses %j", raw => {
    expect(() => upstreamTimeoutMsFromEnv({ PROXY_UPSTREAM_TIMEOUT_MS: raw })).toThrow(
      /PROXY_UPSTREAM_TIMEOUT_MS/
    );
  });
});

describe("channelsRootFromEnv", () => {
  it("returns the directory team sheets are read from", () => {
    expect(channelsRootFromEnv({ PROXY_CHANNELS_ROOT: "/data/channels" })).toBe("/data/channels");
  });

  it("refuses to start without one", () => {
    // No default. An unset PROXY_CHANNELS_ROOT would otherwise become an empty
    // directory, every channel would resolve to `no_team_sheet`, and the
    // misconfiguration would surface as every call being refused in Slack
    // rather than as a process that did not come up.
    expect(() => channelsRootFromEnv({})).toThrow(/PROXY_CHANNELS_ROOT/);
    expect(() => channelsRootFromEnv({ PROXY_CHANNELS_ROOT: "" })).toThrow(/PROXY_CHANNELS_ROOT/);
  });
});

describe("vaultFileFromEnv", () => {
  it("returns the vault path", () => {
    expect(vaultFileFromEnv({ PROXY_VAULT_FILE: "/data/vault/vault.enc" })).toBe(
      "/data/vault/vault.enc"
    );
  });

  it("refuses to start without one", () => {
    expect(() => vaultFileFromEnv({})).toThrow(/PROXY_VAULT_FILE/);
    expect(() => vaultFileFromEnv({ PROXY_VAULT_FILE: "" })).toThrow(/PROXY_VAULT_FILE/);
  });
});

describe("budgetDbFromEnv", () => {
  it("returns the budget database path", () => {
    expect(budgetDbFromEnv({ PROXY_BUDGET_DB: "/data/budget/budget.db" })).toBe(
      "/data/budget/budget.db"
    );
  });

  // The one of the three whose default would fail *open*: a budget file under
  // a path nobody meant is a channel whose hard limits never bite.
  it("refuses to start without one", () => {
    expect(() => budgetDbFromEnv({})).toThrow(/PROXY_BUDGET_DB/);
    expect(() => budgetDbFromEnv({ PROXY_BUDGET_DB: "" })).toThrow(/PROXY_BUDGET_DB/);
  });
});

describe("storeRootFromEnv", () => {
  it("returns the per-channel store root", () => {
    expect(storeRootFromEnv({ PROXY_STORE_ROOT: "/data/store" })).toBe("/data/store");
  });

  // The quiet alternative is a proxy that starts, publishes
  // search_channel_history to every channel whose sheet grants it, and answers
  // each call with "no messages have been stored yet" — a tool that is present,
  // permitted, metered, audited, and useless.
  it("refuses to start without one", () => {
    expect(() => storeRootFromEnv({})).toThrow(/PROXY_STORE_ROOT/);
    expect(() => storeRootFromEnv({ PROXY_STORE_ROOT: "" })).toThrow(/PROXY_STORE_ROOT/);
  });

  // Team sheets are what this process reads its authorization from, and the
  // agent must not be able to write there — so the store has its own root on
  // the agent's writable side (#176). Reading it from here does not merge them.
  it("is not the channels root", () => {
    const env = { PROXY_STORE_ROOT: "/data/store", PROXY_CHANNELS_ROOT: "/data/channels" };
    expect(storeRootFromEnv(env)).not.toBe(channelsRootFromEnv(env));
  });
});

describe("auditDbFromEnv", () => {
  it("returns the audit database path", () => {
    expect(auditDbFromEnv({ PROXY_AUDIT_DB: "/data/audit/audit.db" })).toBe("/data/audit/audit.db");
  });

  // Nothing misbehaves without it — which is the problem. An audit file under a
  // path nobody meant is a deployment that looks audited and has nothing to
  // show at the one moment it is asked.
  it("refuses to start without one", () => {
    expect(() => auditDbFromEnv({})).toThrow(/PROXY_AUDIT_DB/);
    expect(() => auditDbFromEnv({ PROXY_AUDIT_DB: "" })).toThrow(/PROXY_AUDIT_DB/);
  });

  // The prefix every variable this process reads carries. `AUDIT_DB` sat in the
  // compose file unread until #97 and is not a name anything answers to.
  it("does not answer to the unprefixed name compose used to carry", () => {
    expect(() => auditDbFromEnv({ AUDIT_DB: "/data/audit/audit.db" })).toThrow(/PROXY_AUDIT_DB/);
  });
});

describe("vaultKeyFromEnv", () => {
  it("decodes a key from `openssl rand -base64 32`", () => {
    const raw = randomBytes(32).toString("base64");
    expect(vaultKeyFromEnv({ PROXY_VAULT_KEY: raw }).toString("base64")).toBe(raw);
  });

  it("refuses to start without one", () => {
    expect(() => vaultKeyFromEnv({})).toThrow(/PROXY_VAULT_KEY/);
    expect(() => vaultKeyFromEnv({ PROXY_VAULT_KEY: "" })).toThrow(/PROXY_VAULT_KEY/);
  });

  it("tells a non-base64 key apart from one of the wrong length", () => {
    expect(() => vaultKeyFromEnv({ PROXY_VAULT_KEY: "hunter2!!!!hunter2!!!!" })).toThrow(/base64/);
    expect(() =>
      vaultKeyFromEnv({ PROXY_VAULT_KEY: randomBytes(16).toString("base64") })
    ).toThrow(/32 bytes/);
  });

  // The error message is the one place a rejected key would be printed, logged,
  // and pasted into an issue.
  it("keeps the rejected key out of the failure", () => {
    for (const raw of ["hunter2!!!!hunter2!!!!", randomBytes(16).toString("base64")]) {
      let thrown: unknown;
      try {
        vaultKeyFromEnv({ PROXY_VAULT_KEY: raw });
      } catch (error) {
        thrown = error;
      }
      expect(`${String(thrown)}${(thrown as Error).stack}`).not.toContain(raw);
    }
  });
});
