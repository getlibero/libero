import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  auditDbFromEnv,
  budgetDbFromEnv,
  channelsRootFromEnv,
  hostFromEnv,
  portFromEnv,
  requiredEnv,
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

  it.each(["65536", "-1", "8443.5", "https"])("refuses %j", raw => {
    expect(() => portFromEnv({ PROXY_PORT: raw })).toThrow(/PROXY_PORT/);
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
