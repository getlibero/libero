// The proof, read the way a server reads it.
//
// Everything here decodes the compact JWS and asserts on what a verifier would
// actually see, rather than on how it was built. ./fake-token-issuer.test.ts is
// the other side of the same claim — that a server written from the RFC accepts
// these and refuses everything else.

import { createPublicKey, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { describe, it } from "node:test";
import { expect } from "expect";
import { DPOP_PROOF_TYPE, createDpopProof } from "./dpop.js";
import { mintSigningKeyMaterial, parseSigningKeyMaterial } from "./signing-key.js";
import type { SigningKey } from "./custody.js";

const URL_UNDER_TEST = "https://as.example/token";

function key(): SigningKey {
  const parsed = parseSigningKeyMaterial(mintSigningKeyMaterial());
  if (parsed === null) throw new Error("fixture key failed to parse");
  return parsed;
}

/** The three parts, decoded — a verifier's view of a proof. */
function readProof(proof: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
} {
  const [encodedHeader, encodedPayload, encodedSignature] = proof.split(".") as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    signature: Buffer.from(encodedSignature, "base64url")
  };
}

describe("the header", () => {
  it("says what the proof is and carries the key that signed it", () => {
    const signing = key();
    const { header } = readProof(createDpopProof({ key: signing, method: "POST", url: URL_UNDER_TEST }));

    expect(header["typ"]).toBe(DPOP_PROOF_TYPE);
    expect(header["alg"]).toBe("ES256");
    expect(header["jwk"]).toEqual(signing.publicJwk);
  });

  // The mistake that would ship the proxy's private key to every authorization
  // server it talks to, inside the very thing meant to protect it.
  it("carries no private member", () => {
    const proof = createDpopProof({ key: key(), method: "POST", url: URL_UNDER_TEST });
    const jwk = readProof(proof).header["jwk"] as Record<string, unknown>;

    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(proof).not.toContain("PRIVATE KEY");
  });
});

describe("the payload", () => {
  it("binds the proof to one method, one url and one moment", () => {
    const { payload } = readProof(
      createDpopProof({ key: key(), method: "POST", url: URL_UNDER_TEST, now: () => 1_700_000_000_000 })
    );

    expect(payload["htm"]).toBe("POST");
    expect(payload["htu"]).toBe(URL_UNDER_TEST);
    expect(payload["iat"]).toBe(1_700_000_000);
    expect(typeof payload["jti"]).toBe("string");
    // Absent rather than empty: a `nonce` member the server did not ask for and
    // an `ath` with no token behind it are both claims about nothing.
    expect(payload["nonce"]).toBeUndefined();
    expect(payload["ath"]).toBeUndefined();
  });

  // RFC 9449 §4.2: a server recomputes `htu` from the request it received, and
  // a query string any hop could reorder would make a good proof fail.
  it("drops the query and the fragment from htu", () => {
    const { payload } = readProof(
      createDpopProof({
        key: key(),
        method: "POST",
        url: "https://as.example/token?tenant=a&b=c#frag"
      })
    );
    expect(payload["htu"]).toBe(URL_UNDER_TEST);
  });

  it("carries the server's nonce where one was issued", () => {
    const { payload } = readProof(
      createDpopProof({ key: key(), method: "POST", url: URL_UNDER_TEST, nonce: "nonce_abc" })
    );
    expect(payload["nonce"]).toBe("nonce_abc");
  });

  // `ath` is the digest of the token, never the token: a proof discloses
  // nothing about the credential it binds.
  it("hashes the access token rather than carrying it", () => {
    const proof = createDpopProof({
      key: key(),
      method: "POST",
      url: URL_UNDER_TEST,
      accessToken: "at_live_secret_value"
    });
    const { payload } = readProof(proof);

    expect(typeof payload["ath"]).toBe("string");
    expect(payload["ath"]).not.toBe("at_live_secret_value");
    expect(proof).not.toContain("at_live_secret_value");
  });

  // A server that remembers `jti` to catch replays needs them to differ, and a
  // proof is per request rather than per exchange.
  it("gives every proof its own jti", () => {
    const signing = key();
    const first = readProof(createDpopProof({ key: signing, method: "POST", url: URL_UNDER_TEST }));
    const second = readProof(createDpopProof({ key: signing, method: "POST", url: URL_UNDER_TEST }));

    expect(second.payload["jti"]).not.toBe(first.payload["jti"]);
  });
});

describe("the signature", () => {
  it("verifies under the key the header carries", () => {
    const signing = key();
    const { signingInput, signature } = readProof(
      createDpopProof({ key: signing, method: "POST", url: URL_UNDER_TEST })
    );

    expect(
      verify(
        "sha256",
        signingInput,
        {
          key: createPublicKey({ key: signing.publicJwk as JsonWebKey, format: "jwk" }),
          dsaEncoding: "ieee-p1363"
        },
        signature
      )
    ).toBe(true);
  });

  // The P-1363 pair, not DER. A DER signature is rejected as a *bad* signature
  // rather than as a malformed one, which is the failure that costs a day.
  it("is the 64-byte pair a JWS verifier reads", () => {
    const { signature } = readProof(createDpopProof({ key: key(), method: "POST", url: URL_UNDER_TEST }));
    expect(signature).toHaveLength(64);
  });

  it("does not verify under another key", () => {
    const { signingInput, signature } = readProof(
      createDpopProof({ key: key(), method: "POST", url: URL_UNDER_TEST })
    );

    expect(
      verify(
        "sha256",
        signingInput,
        {
          key: createPublicKey({ key: key().publicJwk as JsonWebKey, format: "jwk" }),
          dsaEncoding: "ieee-p1363"
        },
        signature
      )
    ).toBe(false);
  });
});
