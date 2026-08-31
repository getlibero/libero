// The fake, checked as strictly as it checks.
//
// ./fake-token-issuer.ts is a test double everywhere else in this package, and
// since #505 it is also a *verifier* — the thing that decides whether the
// proofs ./dpop.ts makes are proofs. That inverts what it is: a double nobody
// tests is fine when it only answers, and is worthless when it judges, because
// a verifier that accepts anything makes every DPoP test in the suite green
// over a client that signed nothing. #484 named this exactly — a fake has to be
// as strict as the thing it stands in for.
//
// So every case here sends a proof the fake ought to refuse and asserts the
// *reason* it refused, not the status: a server that rejected a replay because
// it mis-parsed the header would otherwise look like one that caught a replay.
// The positive control comes first, for the reason the e2e suite's do — every
// assertion below also passes against a server that refuses everything.

import { createHash, generateKeyPairSync, randomBytes, sign as signWith } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { expect } from "expect";
import { createDpopProof } from "./dpop.js";
import { startFakeTokenIssuer } from "./fake-token-issuer.js";
import type { FakeTokenIssuer } from "./fake-token-issuer.js";
import { mintSigningKeyMaterial, parseSigningKeyMaterial } from "./signing-key.js";
import type { SigningKey } from "./custody.js";

let issuer: FakeTokenIssuer | undefined;

afterEach(async () => {
  await issuer?.close();
  issuer = undefined;
});

function key(): SigningKey {
  const parsed = parseSigningKeyMaterial(mintSigningKeyMaterial());
  if (parsed === null) throw new Error("fixture key failed to parse");
  return parsed;
}

async function started(overrides: Parameters<typeof startFakeTokenIssuer>[0] = {}): Promise<FakeTokenIssuer> {
  issuer = await startFakeTokenIssuer({ dpop: true, ...overrides });
  return issuer;
}

/** One refresh exchange, with whatever proof the case wants to send. */
async function exchange(
  at: FakeTokenIssuer,
  proof: string | undefined,
  refreshToken = at.currentRefreshToken
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${at.url}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(proof !== undefined ? { dpop: proof } : {})
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "https://getlibero.com/client.json"
    }).toString()
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A proof this module signs itself, so a case can make one the maker never would. */
function handMadeProof(
  signing: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {}
): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const head = encode({ typ: "dpop+jwt", alg: "ES256", jwk: signing.publicJwk, ...header });
  const payload = encode({
    jti: randomBytes(16).toString("base64url"),
    htm: "POST",
    iat: Math.floor(Date.now() / 1_000),
    ...claims
  });
  const signature = signing.sign(Buffer.from(`${head}.${payload}`, "utf8"));
  return `${head}.${payload}.${signature.toString("base64url")}`;
}

describe("the positive control", () => {
  it("accepts a proof this repository's own maker produced", async () => {
    const at = await started();
    const answer = await exchange(at, createDpopProof({ key: key(), method: "POST", url: `${at.url}/token` }));

    expect(answer.status).toBe(200);
    expect(answer.body["token_type"]).toBe("DPoP");
    expect(at.dpopFailures).toEqual([]);
  });

  // The other half of the control: with DPoP off the server is the bearer one
  // every test written before #505 was written against.
  it("asks for no proof at all when DPoP is off", async () => {
    const at = await started({ dpop: false });
    const answer = await exchange(at, undefined);

    expect(answer.status).toBe(200);
    expect(answer.body["token_type"]).toBe("Bearer");
    expect(at.dpopFailures).toEqual([]);
  });
});

describe("what it refuses", () => {
  const refused = async (
    proof: string | undefined,
    at: FakeTokenIssuer
  ): Promise<{ status: number; body: Record<string, unknown> }> => exchange(at, proof);

  it("refuses a request carrying no proof", async () => {
    const at = await started();
    const answer = await refused(undefined, at);

    expect(answer.status).toBe(400);
    expect(answer.body["error"]).toBe("invalid_dpop_proof");
    expect(at.dpopFailures).toEqual(["missing_proof"]);
  });

  it("refuses something that is not a JWS", async () => {
    const at = await started();
    await refused("not-a-proof", at);
    expect(at.dpopFailures).toEqual(["not_a_jws"]);
  });

  // The one that matters most: a proof whose signature does not check out is a
  // proof anybody could have written.
  it("refuses a proof signed by another key than the one it carries", async () => {
    const at = await started();
    const real = createDpopProof({ key: key(), method: "POST", url: `${at.url}/token` });
    const [header, payload, signature] = real.split(".") as [string, string, string];
    // Somebody else's signature over somebody else's input, kept the right
    // length so nothing but the cryptography can reject it.
    const other = createDpopProof({ key: key(), method: "POST", url: `${at.url}/token` });
    const otherSignature = other.split(".")[2] as string;
    expect(otherSignature).not.toBe(signature);

    await refused(`${header}.${payload}.${otherSignature}`, at);
    expect(at.dpopFailures).toEqual(["bad_signature"]);
  });

  it("refuses a proof for another method or another url", async () => {
    const at = await started();
    const signing = key();

    await refused(handMadeProof(signing, { htm: "GET", htu: `${at.url}/token` }), at);
    await refused(handMadeProof(signing, { htu: "https://elsewhere.example/token" }), at);
    expect(at.dpopFailures).toEqual(["wrong_htm", "wrong_htu"]);
  });

  it("refuses a proof minted too long ago", async () => {
    const at = await started();
    const stale = Math.floor(Date.now() / 1_000) - 3_600;
    await refused(handMadeProof(key(), { htu: `${at.url}/token`, iat: stale }), at);

    expect(at.dpopFailures).toEqual(["stale_iat"]);
  });

  // A replay is a proof the server has already accepted. Without the `jti`
  // memory, a proof lifted off one exchange spends the next one.
  it("refuses a proof it has already accepted", async () => {
    const at = await started();
    const proof = createDpopProof({ key: key(), method: "POST", url: `${at.url}/token` });

    const first = await exchange(at, proof);
    expect(first.status).toBe(200);
    const second = await exchange(at, proof);

    expect(second.status).toBe(400);
    expect(at.dpopFailures).toEqual(["replayed_jti"]);
  });

  // The property the whole feature exists for: a refresh token in somebody
  // else's hands proves nothing, because the grant is bound to the key that
  // was proved for when it was made.
  it("refuses an exchange under a key the grant was not bound to", async () => {
    const at = await started();
    const first = await exchange(at, createDpopProof({ key: key(), method: "POST", url: `${at.url}/token` }));
    expect(first.status).toBe(200);
    expect(at.boundThumbprint).toBeDefined();

    // The thief holds the rotated refresh token and a key of their own.
    const stolen = await exchange(at, createDpopProof({ key: key(), method: "POST", url: `${at.url}/token` }));

    expect(stolen.status).toBe(400);
    expect(stolen.body["error"]).toBe("invalid_dpop_proof");
    expect(at.dpopFailures).toEqual(["thumbprint_changed"]);
  });

  it("refuses a header carrying a private key", async () => {
    const at = await started();
    const signing = key();
    await refused(
      handMadeProof(signing, { htu: `${at.url}/token` }, { jwk: { ...signing.publicJwk, d: "not-telling" } }),
      at
    );

    expect(at.dpopFailures).toEqual(["private_key_in_header"]);
  });

  it("refuses a key that is not the algorithm it claims", async () => {
    const at = await started();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
    const encode = (value: object): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const head = encode({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: jwk["kty"], crv: jwk["crv"], x: jwk["x"], y: jwk["y"] } });
    const payload = encode({ jti: "j", htm: "POST", htu: `${at.url}/token`, iat: Math.floor(Date.now() / 1_000) });
    const signature = signWith("sha384", Buffer.from(`${head}.${payload}`, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363"
    });

    await refused(`${head}.${payload}.${signature.toString("base64url")}`, at);
    expect(at.dpopFailures).toEqual(["wrong_key_type"]);
  });

  it("refuses a proof with the wrong nonce once it has issued one", async () => {
    const at = await started({ requireNonce: true });
    // The challenge, which carries no proof of its own.
    const challenged = await exchange(at, createDpopProof({ key: key(), method: "POST", url: `${at.url}/token` }));
    expect(challenged.status).toBe(400);
    expect(challenged.body["error"]).toBe("use_dpop_nonce");

    await refused(handMadeProof(key(), { htu: `${at.url}/token`, nonce: "not-the-one" }), at);
    expect(at.dpopFailures).toEqual(["wrong_nonce"]);
  });
});

describe("the thumbprint it computes", () => {
  // Computed here from the JWK's own members, a third time — the maker, the
  // fake and this test each spell RFC 7638's canonical form independently, so a
  // change to any one of them is a failure rather than a silent agreement.
  it("is RFC 7638's over the public members", async () => {
    const at = await started();
    const signing = key();
    await exchange(at, createDpopProof({ key: signing, method: "POST", url: `${at.url}/token` }));

    const { crv, kty, x, y } = signing.publicJwk;
    const expected = createHash("sha256")
      .update(`{"crv":"${crv}","kty":"${kty}","x":"${x}","y":"${y}"}`, "utf8")
      .digest("base64url");
    expect(at.boundThumbprint).toBe(expected);
    expect(at.boundThumbprint).toBe(signing.thumbprint);
  });
});
