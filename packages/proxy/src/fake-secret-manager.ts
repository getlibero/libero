// A Secret Manager that is not one, and a metadata server that is not one.
//
// Shipped beside ./fake-token-issuer.ts and ./mcp-fake-server.ts on their
// argument: a server, holding no store, no engine and no client, which can open
// nothing. It is a module rather than a block inside ./custody-gcp.test.ts so
// that file can stay what ./custody-file.test.ts is — a harness and one call.
// Unlike its two siblings it is **not exported from ./index.ts**, because
// nothing outside this package needs it yet; the e2e suite tests the boundary
// against the file backend and #483 does not move the boundary.
//
// **A real `node:http` server on loopback, port 0, no dependency**, for
// ./mcp-fake-server.ts's reason: the bearer token and the credential value
// cross a real socket, which is the only way the assertions about what is *not*
// on that socket mean anything.
//
// **What this proves, and what it does not.** It implements the five calls
// ./custody-gcp-client.ts makes, with the semantics that matter to the
// contract: label-filtered listing with pagination, `latest:access` over an
// enabled version, add-version numbering, destroy, delete, and the 400 a
// secret whose versions are all destroyed answers. That is enough for
// ./custody-conformance.ts to mean something — replace-not-stack, freshness,
// rotation lineage and the redaction assertions all run against real HTTP.
//
// It proves **nothing about IAM, quotas, replication, CMEK, or eventual
// consistency**, and it is written from Google's published REST reference
// rather than from a run against a live project — #483 shipped without access
// to one, and `deploy/README.md` says so where an operator will read it. A
// mistake in that reading would show up here as a passing suite. Treat the
// first live deployment as the real test, and fix this fake when it disagrees.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { GcpEndpoints } from "./custody-gcp-client.js";

/** One stored version. Destroyed versions stay, so numbering never reuses. */
interface FakeVersion {
  readonly version: number;
  data: string;
  destroyed: boolean;
}

interface FakeSecret {
  readonly labels: Readonly<Record<string, string>>;
  readonly versions: FakeVersion[];
}

export interface FakeSecretManager {
  /** Endpoints to hand `openGcpCustody`. Both point at this one server. */
  readonly endpoints: GcpEndpoints;
  /** Every request path this server has answered, in order. */
  readonly requests: readonly string[];
  /** Every `authorization` header value seen, so a test can assert one arrived. */
  readonly bearers: readonly string[];
  /** The token the metadata leg hands out. Settable, so a test can expire one. */
  accessToken: string;
  /** Seconds the metadata leg claims. */
  expiresIn: number;
  /** Answer every Secret Manager call with this status, or `null` to serve. */
  failWith: number | null;
  /** Answer every Secret Manager call with a body that is not the shape. */
  malformed: boolean;
  /** How many secrets one page returns, so pagination is exercised. */
  pageSize: number | null;
  /**
   * Refuse `CreateSecret` with a 403, leaving every other call served.
   *
   * A project where the serving principal was not given
   * `secretmanager.secrets.create` — a real IAM shape, because that permission
   * is project-level and an operator may prefer to create the secrets by hand.
   * The signing key tolerates it (#504); a `failWith` of 403 cannot model it,
   * because it denies the reads that have to keep working.
   */
  denyCreate: boolean;
  close(): Promise<void>;
}

export async function startFakeSecretManager(): Promise<FakeSecretManager> {
  const secrets = new Map<string, FakeSecret>();
  const requests: string[] = [];
  const bearers: string[] = [];

  const state = {
    accessToken: "ya29.fake-access-token",
    expiresIn: 3600,
    failWith: null as number | null,
    malformed: false,
    pageSize: null as number | null,
    denyCreate: false
  };

  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://fake");
    requests.push(url.pathname);

    const send = (status: number, body: unknown): void => {
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(body));
    };

    // The metadata leg. Plain HTTP, one header, no bearer — GCP's own shape.
    if (url.pathname === "/computeMetadata/v1/instance/service-accounts/default/token") {
      if (incoming.headers["metadata-flavor"] !== "Google") {
        send(403, { error: "Metadata-Flavor header required" });
        return;
      }
      send(200, {
        access_token: state.accessToken,
        expires_in: state.expiresIn,
        token_type: "Bearer"
      });
      return;
    }

    const authorization = incoming.headers.authorization;
    if (typeof authorization === "string") bearers.push(authorization);
    // Every Secret Manager call carries a bearer; without one the real API
    // answers 401, which is what makes `denied` reachable in a test.
    if (authorization !== `Bearer ${state.accessToken}`) {
      send(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
      return;
    }

    if (state.failWith !== null) {
      send(state.failWith, { error: { code: state.failWith, status: "FAILED" } });
      return;
    }
    if (state.malformed) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end("{ this is not json");
      return;
    }

    const body: Buffer[] = [];
    incoming.on("data", chunk => body.push(chunk as Buffer));
    incoming.on("end", () => {
      const payload = body.length === 0 ? undefined : (JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, unknown>);
      route(url, incoming.method ?? "GET", payload, send);
    });
  });

  const route = (
    url: URL,
    method: string,
    payload: Record<string, unknown> | undefined,
    send: (status: number, body: unknown) => void
  ): void => {
    const path = url.pathname;
    const secretsPrefix = /^\/v1\/projects\/[^/]+\/secrets$/;
    const secretPath = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+)$/;
    // `latest` or a version number (#529). The signing key is read by number,
    // because it is the one secret that is written once and never rotated —
    // see `SecretManagerClient.accessFirst`.
    const accessPath = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+)\/versions\/(latest|\d+):access$/;
    const addPath = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+):addVersion$/;
    const destroyPath = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+)\/versions\/(\d+):destroy$/;

    if (secretsPrefix.test(path) && method === "GET") {
      const filter = url.searchParams.get("filter") ?? "";
      const wanted = new Map(
        filter
          .split(" AND ")
          .filter(clause => clause.startsWith("labels."))
          .map(clause => {
            const [key, value] = clause.slice("labels.".length).split("=");
            return [key ?? "", value ?? ""] as const;
          })
      );
      const matching = [...secrets]
        .filter(([, secret]) => [...wanted].every(([key, value]) => secret.labels[key] === value))
        .map(([id, secret]) => ({ name: `projects/p/secrets/${id}`, labels: secret.labels }));

      const size = state.pageSize ?? Number(url.searchParams.get("pageSize") ?? "100");
      const from = Number(url.searchParams.get("pageToken") ?? "0");
      const page = matching.slice(from, from + size);
      const next = from + size < matching.length ? String(from + size) : undefined;
      send(200, { secrets: page, ...(next !== undefined ? { nextPageToken: next } : {}) });
      return;
    }

    if (secretsPrefix.test(path) && method === "POST") {
      if (state.denyCreate) {
        send(403, { error: { code: 403, status: "PERMISSION_DENIED" } });
        return;
      }
      const id = url.searchParams.get("secretId") ?? "";
      if (secrets.has(id)) {
        send(409, { error: { code: 409, status: "ALREADY_EXISTS" } });
        return;
      }
      secrets.set(id, {
        labels: (payload?.["labels"] ?? {}) as Record<string, string>,
        versions: []
      });
      send(200, { name: `projects/p/secrets/${id}` });
      return;
    }

    const accessed = accessPath.exec(path);
    if (accessed !== null && method === "GET") {
      const secret = secrets.get(accessed[1] ?? "");
      if (secret === undefined) {
        send(404, { error: { code: 404, status: "NOT_FOUND" } });
        return;
      }
      const wantedVersion = accessed[2] ?? "latest";
      // `latest` is the newest live version; a number is that version and only
      // that one, absent when it was never written or has been destroyed.
      const live =
        wantedVersion === "latest"
          ? [...secret.versions].reverse().find(version => !version.destroyed)
          : secret.versions.find(
              version => version.version === Number(wantedVersion) && !version.destroyed
            );
      if (live === undefined) {
        // What the real API answers for a secret whose every version is
        // destroyed: a 400, not a 404. Both mean "no value under this name".
        send(400, { error: { code: 400, status: "FAILED_PRECONDITION" } });
        return;
      }
      send(200, {
        name: `projects/p/secrets/${accessed[1]}/versions/${live.version}`,
        payload: { data: live.data }
      });
      return;
    }

    const added = addPath.exec(path);
    if (added !== null && method === "POST") {
      const secret = secrets.get(added[1] ?? "");
      if (secret === undefined) {
        send(404, { error: { code: 404, status: "NOT_FOUND" } });
        return;
      }
      const data = (payload?.["payload"] as { data?: unknown } | undefined)?.data;
      if (typeof data !== "string") {
        send(400, { error: { code: 400, status: "INVALID_ARGUMENT" } });
        return;
      }
      const version = secret.versions.length + 1;
      secret.versions.push({ version, data, destroyed: false });
      send(200, { name: `projects/p/secrets/${added[1]}/versions/${version}` });
      return;
    }

    const destroyed = destroyPath.exec(path);
    if (destroyed !== null && method === "POST") {
      const secret = secrets.get(destroyed[1] ?? "");
      const version = secret?.versions.find(entry => entry.version === Number(destroyed[2]));
      if (version === undefined) {
        send(404, { error: { code: 404, status: "NOT_FOUND" } });
        return;
      }
      if (version.destroyed) {
        send(400, { error: { code: 400, status: "FAILED_PRECONDITION" } });
        return;
      }
      version.destroyed = true;
      // Destroyed means the bytes are gone, not merely unselected. A fake that
      // kept them would let a test pass that a real project would fail.
      version.data = "";
      send(200, { name: `projects/p/secrets/${destroyed[1]}/versions/${destroyed[2]}` });
      return;
    }

    const one = secretPath.exec(path);
    if (one !== null && method === "DELETE") {
      const existed = secrets.delete(one[1] ?? "");
      send(existed ? 200 : 404, existed ? {} : { error: { code: 404, status: "NOT_FOUND" } });
      return;
    }

    send(404, { error: { code: 404, status: "NOT_FOUND" } });
  };

  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoints: { secretManager: origin, metadata: origin },
    requests,
    bearers,
    get accessToken() {
      return state.accessToken;
    },
    set accessToken(value: string) {
      state.accessToken = value;
    },
    get expiresIn() {
      return state.expiresIn;
    },
    set expiresIn(value: number) {
      state.expiresIn = value;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(value: number | null) {
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
    get denyCreate() {
      return state.denyCreate;
    },
    set denyCreate(value: boolean) {
      state.denyCreate = value;
    },
    // `closeAllConnections()` first, so a parked request cannot stall teardown
    // — ./fake-token-issuer.ts's shape.
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
