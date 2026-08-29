// What SigV4 has to cover, asserted from outside the module.
//
// ./fake-secrets-manager.ts recomputes every signature, which catches any
// *mismatch* between what the client signs and what it sends. It cannot catch
// the failure where both sides leave something out — a body that is not covered
// looks identical to both halves of one implementation. That is this file: the
// differential half, asserting that changing each signed input changes the
// signature, so an input that silently fell out of the canonical request fails
// here rather than at a real account.
//
// Through the client's own path with an injected `fetch` rather than by
// exporting the signer. apps/runner/src/docker.ts exports `demultiplex` "for
// its own test — the framing is easy to get subtly wrong", and the same
// argument would apply; what makes this the better shape is that a signature
// only matters as the header a request actually carries, and testing the header
// tests the assembly too.

import { describe, it } from "node:test";
import { each } from "@getlibero/test-kit";
import { expect } from "expect";
import { createSecretsManagerClient } from "./custody-aws-client.js";
import type { AwsClientOptions } from "./custody-aws-client.js";

const SECRET_VALUE = "ghp_a_value_that_must_never_appear_in_a_header";

/**
 * A transport that answers the three IMDS legs and every action plausibly, and
 * keeps the `authorization` header off each Secrets Manager call.
 */
function recording(): {
  fetch: typeof globalThis.fetch;
  authorizations: string[];
  requests: { headers: Record<string, string>; body: string }[];
} {
  const authorizations: string[] = [];
  const requests: { headers: Record<string, string>; body: string }[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const text = (body: string): Response =>
      new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

    if (url.endsWith("/latest/api/token")) return text("imds-token");
    if (url.endsWith("/security-credentials/")) return text("libero-role\n");
    if (url.includes("/security-credentials/")) {
      return new Response(
        JSON.stringify({
          AccessKeyId: "ASIATESTACCESSKEY000",
          SecretAccessKey: "test-secret-access-key-0000000000000000",
          Token: "imds-session-token",
          Expiration: new Date(Date.now() + 3_600_000).toISOString()
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [
        name.toLowerCase(),
        value
      ])
    );
    const body = String(init?.body ?? "");
    requests.push({ headers, body });
    const authorization = headers["authorization"];
    if (authorization !== undefined) authorizations.push(authorization);

    // Enough of a reply for every call the client makes to succeed.
    return new Response(
      JSON.stringify({ SecretString: SECRET_VALUE, SecretList: [], VersionIdsToStages: {} }),
      { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } }
    );
  };

  return { fetch: fetchImpl, authorizations, requests };
}

const OPTIONS = (extra: Partial<AwsClientOptions> = {}): AwsClientOptions => ({
  region: "eu-west-2",
  endpoints: { secretsManager: "https://secretsmanager.eu-west-2.amazonaws.com", metadata: "http://imds" },
  now: () => Date.parse("2026-08-29T11:07:00.000Z"),
  ...extra
});

const signatureOf = (authorization: string): string =>
  /Signature=([0-9a-f]+)/.exec(authorization)?.[1] ?? "";

/** One call through a fresh client, returning the header it signed. */
async function signOne(
  run: (client: ReturnType<typeof createSecretsManagerClient>) => Promise<unknown>,
  extra: Partial<AwsClientOptions> = {}
): Promise<{ authorization: string; headers: Record<string, string>; body: string }> {
  const transport = recording();
  const client = createSecretsManagerClient({ ...OPTIONS(extra), fetch: transport.fetch });
  await run(client);
  const authorization = transport.authorizations[0] ?? "";
  const request = transport.requests[0] ?? { headers: {}, body: "" };
  return { authorization, headers: request.headers, body: request.body };
}

describe("the signature covers what it has to", () => {
  it("is deterministic for one request", async () => {
    const first = await signOne(client => client.get("libero/vault/github_token"));
    const second = await signOne(client => client.get("libero/vault/github_token"));
    expect(signatureOf(first.authorization)).toBe(signatureOf(second.authorization));
    expect(signatureOf(first.authorization)).toMatch(/^[0-9a-f]{64}$/);
  });

  // The one that matters most. Every call here either carries a credential
  // value or asks for one, so a signature that did not cover the body would let
  // anything in the path change which secret was written.
  it("changes when the body changes", async () => {
    const one = await signOne(client => client.get("libero/vault/github_token"));
    const other = await signOne(client => client.get("libero/vault/deploy_key"));
    expect(one.body).not.toBe(other.body);
    expect(signatureOf(one.authorization)).not.toBe(signatureOf(other.authorization));
  });

  // A target that fell out of the canonical request would let a signed
  // `GetSecretValue` be replayed as a `DeleteSecret`.
  it("changes when the action changes", async () => {
    const read = await signOne(client => client.get("libero/vault/x"));
    const removed = await signOne(client => client.remove("libero/vault/x"));
    expect(read.headers["x-amz-target"]).not.toBe(removed.headers["x-amz-target"]);
    expect(signatureOf(read.authorization)).not.toBe(signatureOf(removed.authorization));
  });

  each([
    ["the region", { region: "us-east-1" } as Partial<AwsClientOptions>],
    ["the date", { now: () => Date.parse("2026-08-30T11:07:00.000Z") } as Partial<AwsClientOptions>]
  ])("changes when %s changes", async (_label, extra) => {
    const base = await signOne(client => client.get("libero/vault/github_token"));
    const changed = await signOne(client => client.get("libero/vault/github_token"), extra);
    expect(signatureOf(base.authorization)).not.toBe(signatureOf(changed.authorization));
  });

  it("names exactly the headers it sent, and the four that matter", async () => {
    const { authorization, headers } = await signOne(client => client.get("libero/vault/x"));
    const signed = (/SignedHeaders=([^,]+)/.exec(authorization)?.[1] ?? "").split(";");

    for (const name of ["content-type", "host", "x-amz-date", "x-amz-target"]) {
      expect(signed).toContain(name);
    }
    // Temporary credentials carry a session token, and it must be signed: a
    // token sent but unsigned is one an intermediary could strip or swap.
    expect(signed).toContain("x-amz-security-token");
    expect(headers["x-amz-security-token"]).toBe("imds-session-token");
    // Nothing signed that was not sent.
    for (const name of signed) expect(Object.keys(headers)).toContain(name);
  });

  it("scopes the credential to one day, one region and one service", async () => {
    const { authorization } = await signOne(client => client.get("libero/vault/x"));
    expect(authorization).toContain(
      "Credential=ASIATESTACCESSKEY000/20260829/eu-west-2/secretsmanager/aws4_request"
    );
    expect(authorization.startsWith("AWS4-HMAC-SHA256 ")).toBe(true);
  });

  // The signature is derived from the secret access key and must not be a way
  // to read one back, and nothing in the header may carry a credential value.
  it("puts no secret into the header it produces", async () => {
    const { authorization } = await signOne(client =>
      client.create("libero/vault/x", SECRET_VALUE, { "libero-kind": "vault" })
    );
    expect(authorization).not.toContain("test-secret-access-key");
    expect(authorization).not.toContain(SECRET_VALUE);
    expect(authorization).not.toContain("ghp_");
  });
});
