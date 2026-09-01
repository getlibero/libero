// What the shared signing-key module does, over a backing that is not a store.
//
// ./custody-conformance.ts asserts the storage semantics against all three real
// backends. What it cannot reach from outside is what happens *between* the
// store and its backing — how many times `create` is called, what a backing
// that already held a key does to the caller, and whether a failed acquisition
// is remembered. A fake backing is what makes those countable, and every one of
// them is a mistake that would look like working code in a backend.

import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { describe, it } from "node:test";
import { expect } from "expect";
import { each } from "@getlibero/test-kit";
import { MAX_SECRET_BYTES } from "./custody.js";
import type { SigningKey } from "./custody.js";
import {
  SIGNING_ALG,
  jwkThumbprint,
  mintSigningKeyMaterial,
  openSigningKeyStore,
  parseSigningKeyMaterial
} from "./signing-key.js";
import type { SigningKeyBacking } from "./signing-key.js";

const PROOF = Buffer.from("eyJ0eXAiOiJkcG9wK2p3dCJ9.eyJodG0iOiJQT1NUIn0", "utf8");

class Rejected extends Error {
  readonly reason = "malformed_plaintext";
}

/**
 * A backing that counts what the store asked it for.
 *
 * `create` is create-if-absent, as every real one is: `held` wins if something
 * got there first, which is how the adoption path is reached without two
 * processes.
 */
function fakeBacking(
  options: { held?: string; failReads?: number } = {}
): SigningKeyBacking & { reads: number; creates: number; held: string | undefined; closed: boolean } {
  let failures = options.failReads ?? 0;
  const backing = {
    reads: 0,
    creates: 0,
    held: options.held,
    closed: false,

    read(): string | null {
      backing.reads += 1;
      if (backing.closed) throw new Rejected("closed");
      if (failures > 0) {
        failures -= 1;
        throw new Rejected("unreachable");
      }
      return backing.held ?? null;
    },

    create(material: string): Promise<string> {
      backing.creates += 1;
      if (backing.closed) return Promise.reject(new Rejected("closed"));
      backing.held ??= material;
      return Promise.resolve(backing.held);
    },

    malformed: (): Error => new Rejected("malformed"),

    close(): void {
      backing.closed = true;
    }
  };
  return backing;
}

const parsed = (material: string): SigningKey => {
  const key = parseSigningKeyMaterial(material);
  if (key === null) throw new Error("fixture material failed to parse");
  return key;
};

describe("the material", () => {
  it("round-trips a minted key", () => {
    const material = mintSigningKeyMaterial();
    const key = parsed(material);
    expect(key.alg).toBe(SIGNING_ALG);
    expect(key.publicJwk.crv).toBe("P-256");
    expect(verifies(key, PROOF, key.sign(PROOF))).toBe(true);
  });

  it("holds the private half in PKCS#8 and nothing else", () => {
    const body = JSON.parse(mintSigningKeyMaterial()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["alg", "key", "v"]);
    expect(body["key"]).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  // A stored credential like any other, so the contract's cap applies before
  // `createPrivateKey` is handed a megabyte to parse.
  it("refuses material past the contract's cap", () => {
    const material = JSON.stringify({
      v: 1,
      alg: SIGNING_ALG,
      key: "x".repeat(MAX_SECRET_BYTES)
    });
    expect(parseSigningKeyMaterial(material)).toBeNull();
  });

  each([
    ["not JSON at all", "-----BEGIN PRIVATE KEY-----"],
    ["a JSON scalar", '"a string"'],
    ["null", "null"],
    ["an empty object", "{}"],
    ["a future version", JSON.stringify({ v: 2, alg: SIGNING_ALG, key: pem() })],
    ["another algorithm", JSON.stringify({ v: 1, alg: "ES384", key: pem() })],
    ["no key at all", JSON.stringify({ v: 1, alg: SIGNING_ALG })],
    ["an empty key", JSON.stringify({ v: 1, alg: SIGNING_ALG, key: "" })],
    ["a key that is not a PEM", JSON.stringify({ v: 1, alg: SIGNING_ALG, key: "not a pem" })],
    ["an RSA key", JSON.stringify({ v: 1, alg: SIGNING_ALG, key: pem("rsa") })],
    // The one a looser parse would accept and every authorization server would
    // then reject: a P-384 key signs happily under an `ES256` header.
    ["a key on another curve", JSON.stringify({ v: 1, alg: SIGNING_ALG, key: pem("p384") })]
  ])("refuses %s", (_label, material) => {
    expect(parseSigningKeyMaterial(material as string)).toBeNull();
  });
});

describe("the thumbprint", () => {
  // RFC 7638 §3.2's canonical form, written here in the order the RFC fixes
  // rather than in the order `export({format:"jwk"})` happens to produce. If
  // this test and ./signing-key.ts ever disagree, an authorization server that
  // computed the thumbprint itself would disagree with one of them.
  it("is SHA-256 over the required members, lexicographic and base64url", () => {
    const key = parsed(mintSigningKeyMaterial());
    const { crv, kty, x, y } = key.publicJwk;
    const canonical = `{"crv":"${crv}","kty":"${kty}","x":"${x}","y":"${y}"}`;
    expect(key.thumbprint).toBe(createHash("sha256").update(canonical, "utf8").digest("base64url"));
    expect(key.thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is stable across parses and different between keys", () => {
    const material = mintSigningKeyMaterial();
    expect(parsed(material).thumbprint).toBe(parsed(material).thumbprint);
    expect(parsed(mintSigningKeyMaterial()).thumbprint).not.toBe(parsed(material).thumbprint);
  });

  it("changes when any member of the public key does", () => {
    const key = parsed(mintSigningKeyMaterial());
    // The replacement is chosen against what is there rather than fixed, and
    // the fixture is asserted before the thumbprint is. A fixed `"A"` passes
    // for fifteen keys in sixteen and mutates nothing for the sixteenth — the
    // last character of a 43-character base64url value comes from a set of
    // sixteen — so it failed in CI having passed everywhere else, which is the
    // worst way for a fixture to be wrong.
    const x = key.publicJwk.x;
    const bumped = { ...key.publicJwk, x: `${x.slice(0, -1)}${x.endsWith("A") ? "B" : "A"}` };
    expect(bumped.x).not.toBe(x);
    expect(jwkThumbprint(bumped)).not.toBe(key.thumbprint);
  });
});

describe("the store over a backing", () => {
  it("mints once and serves the rest from what it holds", async () => {
    const backing = fakeBacking();
    const store = openSigningKeyStore(backing);

    const first = await store.signingKey();
    const second = await store.signingKey();

    expect(second.thumbprint).toBe(first.thumbprint);
    expect(backing.creates).toBe(1);
    // One read, at the first call. The rest are served from the cache, which is
    // what keeps a proof per upstream call off the backing.
    expect(backing.reads).toBe(1);
  });

  // Two exchanges starting at once must not mint two keys: the second would
  // strand whatever the first had already bound.
  it("mints once for callers that arrive together", async () => {
    const backing = fakeBacking();
    const store = openSigningKeyStore(backing);

    const keys = await Promise.all([store.signingKey(), store.signingKey(), store.signingKey()]);

    expect(new Set(keys.map(key => key.thumbprint)).size).toBe(1);
    expect(backing.creates).toBe(1);
  });

  it("loads what the backing already held rather than minting", async () => {
    const held = mintSigningKeyMaterial();
    const backing = fakeBacking({ held });
    const key = await openSigningKeyStore(backing).signingKey();

    expect(key.thumbprint).toBe(parsed(held).thumbprint);
    expect(backing.creates).toBe(0);
  });

  // The adoption. A backing whose `create` answers with somebody else's key is
  // a second process that got there first, and its key is the one this
  // deployment has.
  it("adopts the material a create answers with", async () => {
    const winner = mintSigningKeyMaterial();
    const backing = fakeBacking();
    backing.create = (material: string): Promise<string> => {
      backing.creates += 1;
      void material;
      return Promise.resolve(winner);
    };

    const key = await openSigningKeyStore(backing).signingKey();
    expect(key.thumbprint).toBe(parsed(winner).thumbprint);
  });

  // A backing that is unreachable at the first exchange must not make every
  // later one fail from a cache.
  it("does not remember a failed acquisition", async () => {
    const backing = fakeBacking({ failReads: 1 });
    const store = openSigningKeyStore(backing);

    await expect(async () => store.signingKey()).rejects.toThrow();
    const key = await store.signingKey();
    expect(key.alg).toBe(SIGNING_ALG);
  });

  it("wraps material the backing holds and cannot parse in the backing's word", async () => {
    const backing = fakeBacking({ held: "not a signing key" });
    await expect(async () => openSigningKeyStore(backing).signingKey()).rejects.toThrow(
      expect.objectContaining({ reason: "malformed_plaintext" })
    );
  });

  it("closes the backing and stops serving what it held", async () => {
    const backing = fakeBacking();
    const store = openSigningKeyStore(backing);
    await store.signingKey();

    store.close();
    expect(backing.closed).toBe(true);
    // Not from the cache: `close` means closed, and the refusal is the
    // backing's own rather than a word this module invented.
    await expect(async () => store.signingKey()).rejects.toThrow();
  });

  it("logs the thumbprint it minted and the one it opened, and no material", async () => {
    const lines: object[] = [];
    const logger = { log: (level: string, fields: object) => lines.push({ level, fields }) };
    const backing = fakeBacking();

    const minted = await openSigningKeyStore(backing, { logger }).signingKey();
    await openSigningKeyStore(backing, { logger }).signingKey();

    const text = JSON.stringify(lines);
    expect(text).toContain("signing_key_minted");
    expect(text).toContain("signing_key_opened");
    expect(text).toContain(minted.thumbprint);
    expect(text).not.toContain("PRIVATE KEY");
  });
});

function verifies(key: SigningKey, input: Buffer, signature: Buffer): boolean {
  return verify(
    "sha256",
    input,
    {
      key: createPublicKey({ key: key.publicJwk as JsonWebKey, format: "jwk" }),
      dsaEncoding: "ieee-p1363"
    },
    signature
  );
}

/** A PEM of the wrong kind, for the parse's refusals. */
function pem(kind: "p256" | "p384" | "rsa" = "p256"): string {
  const pair =
    kind === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: kind === "p384" ? "P-384" : "P-256" });
  return pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
