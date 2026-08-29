// An AWS Secrets Manager that is not one, and an IMDS that is not one.
//
// ./fake-secret-manager.ts's sibling — the GCP one — and shipped on the same
// argument as ./fake-token-issuer.ts and ./mcp-fake-server.ts: a server holding
// no store, no engine and no client, which can open nothing. Not exported from
// ./index.ts, because nothing outside this package needs it.
//
// **It verifies the signature, which is the point.** LocalStack accepts any
// well-formed `Authorization` header, and a real account is the only other
// thing that would check one — so without this, nothing in the fast suite would
// notice if ./custody-aws-client.ts signed the wrong bytes. Here every call is
// rejected with `InvalidSignatureException` unless the signature recomputes,
// which is what makes "a signing mistake is a 403, not a disclosure" a claim the
// tests actually exercise rather than a hope about AWS's behaviour.
//
// **What that does not prove, said plainly.** The verifier is written from the
// same specification as the signer and by the same hand, so a *shared*
// misreading — a header that should be signed and is signed by neither, a
// canonicalization rule both get wrong the same way — passes here and fails at
// AWS. What it does catch is the whole class of mismatches between the two
// sides: an unsigned body, a header omitted from `SignedHeaders`, a wrong
// scope, a stale date. `custody-aws-client.test.ts` adds the differential half
// — that changing any signed input changes the signature — so a body or a
// target that silently fell out of the canonical request fails there.
// `packages/aws-conformance` runs the contract against LocalStack, which is an
// independent implementation of everything except the signing.
//
// The two disagreements with AWS worth knowing, both deliberate:
// `ForceDeleteWithoutRecovery` is honoured and the recovery window is not
// modelled at all, because this backend always passes it; and `ListSecrets`
// implements only the `name` prefix filter, which is the only one used.

import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AwsEndpoints } from "./custody-aws-client.js";

export const FAKE_ACCESS_KEY_ID = "ASIAFAKEACCESSKEYID0";
export const FAKE_SECRET_ACCESS_KEY = "wJalrXUtnFEMIfakeSECRETkeyEXAMPLEKEY00000";
export const FAKE_SESSION_TOKEN = "FwoGZXIvYXdzFAKEsessionTOKEN";
export const FAKE_REGION = "eu-west-2";

interface StoredVersion {
  readonly id: string;
  value: string;
  stages: string[];
}

interface StoredSecret {
  readonly tags: Readonly<Record<string, string>>;
  readonly versions: StoredVersion[];
}

export interface FakeSecretsManager {
  /** Endpoints to hand `openAwsCustody`. Both point at this one server. */
  readonly endpoints: AwsEndpoints;
  readonly region: string;
  /** Every `X-Amz-Target` action this server has answered, in order. */
  readonly actions: readonly string[];
  /** Every IMDS path this server has answered. */
  readonly metadataPaths: readonly string[];
  /** How many calls arrived with a signature that did not recompute. */
  readonly rejectedSignatures: number;
  /** Answer every Secrets Manager call with this `__type`, or `null` to serve. */
  failWith: string | null;
  /** Answer every Secrets Manager call with a body that is not the shape. */
  malformed: boolean;
  /** How many secrets one page returns, so pagination is exercised. */
  pageSize: number | null;
  /** The staging labels a name currently holds, for a test to assert on. */
  stagesOf(name: string): Readonly<Record<string, readonly string[]>>;
  close(): Promise<void>;
}

export async function startFakeSecretsManager(): Promise<FakeSecretsManager> {
  const secrets = new Map<string, StoredSecret>();
  const actions: string[] = [];
  const metadataPaths: string[] = [];
  let rejectedSignatures = 0;
  let versionCounter = 0;

  const state = {
    failWith: null as string | null,
    malformed: false,
    pageSize: null as number | null
  };

  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://fake");

    const send = (status: number, body: unknown): void => {
      outgoing.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
      outgoing.end(JSON.stringify(body));
    };
    const text = (status: number, body: string): void => {
      outgoing.writeHead(status, { "content-type": "text/plain" });
      outgoing.end(body);
    };

    // The IMDSv2 legs. A GET without the PUT-issued token is refused, which is
    // the whole difference from v1 and the reason the client does the PUT.
    if (url.pathname.startsWith("/latest/")) {
      metadataPaths.push(url.pathname);
      if (url.pathname === "/latest/api/token") {
        if (incoming.method !== "PUT") {
          text(405, "method not allowed");
          return;
        }
        text(200, "imds-session-token");
        return;
      }
      if (incoming.headers["x-aws-ec2-metadata-token"] !== "imds-session-token") {
        text(401, "unauthorized");
        return;
      }
      if (url.pathname === "/latest/meta-data/iam/security-credentials/") {
        text(200, "libero-proxy-role\n");
        return;
      }
      if (url.pathname === "/latest/meta-data/iam/security-credentials/libero-proxy-role") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({
            Code: "Success",
            AccessKeyId: FAKE_ACCESS_KEY_ID,
            SecretAccessKey: FAKE_SECRET_ACCESS_KEY,
            Token: FAKE_SESSION_TOKEN,
            Expiration: new Date(Date.now() + 3_600_000).toISOString()
          })
        );
        return;
      }
      text(404, "not found");
      return;
    }

    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(chunk as Buffer));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const target = String(incoming.headers["x-amz-target"] ?? "");
      const action = target.slice(target.indexOf(".") + 1);

      if (!signatureHolds(incoming.headers as Record<string, string>, body)) {
        rejectedSignatures += 1;
        send(400, {
          __type: "InvalidSignatureException",
          message: "signature did not recompute"
        });
        return;
      }

      actions.push(action);

      if (state.failWith !== null) {
        send(400, { __type: state.failWith, message: "injected" });
        return;
      }
      if (state.malformed) {
        outgoing.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
        outgoing.end("{ this is not json");
        return;
      }

      route(action, JSON.parse(body === "" ? "{}" : body) as Record<string, unknown>, send);
    });
  });

  const route = (
    action: string,
    payload: Record<string, unknown>,
    send: (status: number, body: unknown) => void
  ): void => {
    const notFound = (): void => {
      send(400, { __type: "ResourceNotFoundException", message: "not found" });
    };
    const id = (): string => {
      versionCounter += 1;
      return `v${versionCounter}`;
    };

    if (action === "ListSecrets") {
      const filters = (payload["Filters"] ?? []) as { Key?: string; Values?: string[] }[];
      const prefix = filters.find(filter => filter.Key === "name")?.Values?.[0] ?? "";
      const matching = [...secrets.keys()].filter(name => name.startsWith(prefix)).sort();
      const size = state.pageSize ?? Number(payload["MaxResults"] ?? 100);
      const from = Number(payload["NextToken"] ?? "0");
      const page = matching.slice(from, from + size);
      const next = from + size < matching.length ? String(from + size) : undefined;
      send(200, {
        SecretList: page.map(name => ({ Name: name, ARN: `arn:aws:secretsmanager:::secret:${name}` })),
        ...(next !== undefined ? { NextToken: next } : {})
      });
      return;
    }

    // Required on the raw API and generated for you by the SDKs, which is how a
    // hand-written client comes to omit it. LocalStack refuses a call without
    // one; so does this, or the fast suite would be more permissive than the
    // implementation it stands in for.
    if ((action === "CreateSecret" || action === "PutSecretValue") && typeof payload["ClientRequestToken"] !== "string") {
      send(400, {
        __type: "InvalidRequestException",
        message: "You must provide a ClientRequestToken value."
      });
      return;
    }

    if (action === "CreateSecret") {
      const name = String(payload["Name"] ?? "");
      if (secrets.has(name)) {
        send(400, { __type: "ResourceExistsException", message: "exists" });
        return;
      }
      const tags = Object.fromEntries(
        ((payload["Tags"] ?? []) as { Key?: string; Value?: string }[]).map(tag => [
          tag.Key ?? "",
          tag.Value ?? ""
        ])
      );
      const version: StoredVersion = {
        id: id(),
        value: String(payload["SecretString"] ?? ""),
        stages: ["AWSCURRENT"]
      };
      secrets.set(name, { tags, versions: [version] });
      send(200, { Name: name, VersionId: version.id });
      return;
    }

    const named = (): StoredSecret | undefined => secrets.get(String(payload["SecretId"] ?? ""));

    if (action === "GetSecretValue") {
      const secret = named();
      if (secret === undefined) {
        notFound();
        return;
      }
      const current = secret.versions.find(version => version.stages.includes("AWSCURRENT"));
      if (current === undefined) {
        send(400, { __type: "InvalidRequestException", message: "no current version" });
        return;
      }
      send(200, { SecretString: current.value, VersionId: current.id });
      return;
    }

    if (action === "PutSecretValue") {
      const secret = named();
      if (secret === undefined) {
        notFound();
        return;
      }
      // AWS's own staging move: the new version takes AWSCURRENT, and the one
      // that had it takes AWSPREVIOUS. Modelled exactly, because the whole
      // point of this backend's extra call is to undo the second half.
      for (const version of secret.versions) {
        version.stages = version.stages.filter(stage => stage !== "AWSPREVIOUS");
        if (version.stages.includes("AWSCURRENT")) {
          version.stages = version.stages.filter(stage => stage !== "AWSCURRENT");
          version.stages.push("AWSPREVIOUS");
        }
      }
      const version: StoredVersion = {
        id: id(),
        value: String(payload["SecretString"] ?? ""),
        stages: ["AWSCURRENT"]
      };
      secret.versions.push(version);
      send(200, { VersionId: version.id, VersionStages: version.stages });
      return;
    }

    if (action === "DescribeSecret") {
      const secret = named();
      if (secret === undefined) {
        notFound();
        return;
      }
      send(200, {
        Name: String(payload["SecretId"]),
        VersionIdsToStages: Object.fromEntries(
          secret.versions.filter(v => v.stages.length > 0).map(v => [v.id, v.stages])
        )
      });
      return;
    }

    if (action === "UpdateSecretVersionStage") {
      const secret = named();
      const from = String(payload["RemoveFromVersionId"] ?? "");
      const stage = String(payload["VersionStage"] ?? "");
      const version = secret?.versions.find(entry => entry.id === from);
      if (secret === undefined || version === undefined) {
        notFound();
        return;
      }
      version.stages = version.stages.filter(entry => entry !== stage);
      // A version left with no staging label is deprecated; AWS removes it
      // in its own time and it stops being retrievable straight away, which is
      // the property this backend is buying. The value goes here so a test
      // cannot pass by reading bytes a real account would have taken away.
      if (version.stages.length === 0) version.value = "";
      send(200, { Name: String(payload["SecretId"]) });
      return;
    }

    if (action === "DeleteSecret") {
      const name = String(payload["SecretId"] ?? "");
      if (!secrets.has(name)) {
        notFound();
        return;
      }
      if (payload["ForceDeleteWithoutRecovery"] !== true) {
        // Not modelled: this backend always forces, so a call that did not
        // would be a bug worth failing on rather than emulating.
        send(400, { __type: "InvalidParameterException", message: "recovery window not modelled" });
        return;
      }
      secrets.delete(name);
      send(200, { Name: name });
      return;
    }

    send(400, { __type: "InvalidParameterException", message: `unknown action ${action}` });
  };

  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoints: { secretsManager: origin, metadata: origin },
    region: FAKE_REGION,
    actions,
    metadataPaths,
    get rejectedSignatures() {
      return rejectedSignatures;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(value: string | null) {
      state.failWith = value;
    },
    get malformed() {
      return state.malformed;
    },
    set malformed(value: boolean) {
      state.malformed = value;
    },
    get pageSize() {
      return state.pageSize;
    },
    set pageSize(value: number | null) {
      state.pageSize = value;
    },
    stagesOf(name: string): Readonly<Record<string, readonly string[]>> {
      const secret = secrets.get(name);
      if (secret === undefined) return {};
      return Object.fromEntries(secret.versions.map(version => [version.id, [...version.stages]]));
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

/**
 * Recompute the signature from the request as it arrived.
 *
 * Written against the specification rather than derived from the signer, which
 * is the most independence available without a real account. It reads
 * `SignedHeaders` out of the `Authorization` header and canonicalizes exactly
 * those, so a header the client *sent* but did not *sign* changes nothing here
 * and a header it signed but did not send fails — which is the mismatch class
 * worth catching.
 */
function signatureHolds(headers: Record<string, string>, body: string): boolean {
  const authorization = headers["authorization"];
  if (typeof authorization !== "string") return false;

  const credential = /Credential=([^,]+)/.exec(authorization)?.[1];
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1];
  const signature = /Signature=([0-9a-f]+)/.exec(authorization)?.[1];
  if (credential === undefined || signedHeaders === undefined || signature === undefined) {
    return false;
  }

  const [keyId, day, region, service, terminator] = credential.split("/");
  if (keyId !== FAKE_ACCESS_KEY_ID || terminator !== "aws4_request") return false;
  if (day === undefined || region === undefined || service === undefined) return false;

  // The body must be covered. A client that signed `UNSIGNED-PAYLOAD` — or an
  // empty string while sending a body — fails here, which is the assertion that
  // matters most: every one of these calls either carries a credential value or
  // asks for one.
  const canonicalHeaders = signedHeaders
    .split(";")
    .map(name => `${name}:${(headers[name] ?? "").trim()}\n`)
    .join("");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    createHash("sha256").update(body, "utf8").digest("hex")
  ].join("\n");

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    headers["x-amz-date"] ?? "",
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex")
  ].join("\n");

  const mac = (key: Buffer | string, value: string): Buffer =>
    createHmac("sha256", key).update(value, "utf8").digest();
  const signingKey = mac(mac(mac(mac(`AWS4${FAKE_SECRET_ACCESS_KEY}`, day), region), service), "aws4_request");

  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex") === signature;
}
