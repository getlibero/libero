import { describe, expect, it } from "vitest";
import { VAULT_KEY_BYTES, generateVaultKey } from "./vault-key.js";

describe("generateVaultKey", () => {
  // Asserted by the rule rather than by importing the proxy's parseVaultKey.
  // This package does not depend on @getlibero/proxy and must not start: see
  // the header of ./vault-key.ts.
  it("is base64 that decodes to exactly the key length", () => {
    const key = generateVaultKey();

    expect(Buffer.from(key, "base64")).toHaveLength(VAULT_KEY_BYTES);
    expect(Buffer.from(key, "base64").toString("base64")).toBe(key);
  });

  it("is different every time", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateVaultKey()));

    expect(keys.size).toBe(100);
  });
});
