import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "expect";
import { startFakeTokenIssuer } from "./fake-token-issuer.js";
import type { FakeTokenIssuer } from "./fake-token-issuer.js";
import type { Logger } from "./log.js";
import { TOKEN_EXPIRY_MARGIN_MS, createTokenEngine } from "./token-engine.js";
import type { OAuthBinding, TokenEngine } from "./token-engine.js";
import { openFileSigningKeyStore } from "./signing-store.js";
import { openTokenStore } from "./token-store.js";
import type { FileTokenStore } from "./token-store.js";
import { parseVaultKey } from "./vault.js";
import type { VaultKey } from "./vault.js";
import type { GrantRecord, SigningKeyStore } from "./custody.js";

// The engine against the fake issuer over a real socket and a real store in a
// temp dir, because the claims under test are lifecycle claims: one exchange
// however many callers, a rotation that survives a second open, a dead grant
// that stays diagnosable. Expiry is the injected clock — the repo has no fake
// timers, and a stored expiry compared against now() needs none.

const NAME = "notion_grant";
const CLIENT_ID = "https://getlibero.com/client.json";

function key(): VaultKey {
  const parsed = parseVaultKey(randomBytes(32).toString("base64"));
  if (!parsed.ok) throw new Error("fixture key failed to parse");
  return parsed.key;
}

function recordingLogger(): { logger: Logger; events: string[]; text: () => string } {
  const lines: object[] = [];
  const events: string[] = [];
  return {
    logger: {
      log: (level, fields) => {
        lines.push({ level, fields });
        events.push(fields.event);
      }
    },
    events,
    text: () => JSON.stringify(lines)
  };
}

let dir: string;
let vaultFile: string;
let issuer: FakeTokenIssuer | undefined;
let store: FileTokenStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-token-engine-"));
  vaultFile = join(dir, "vault.enc");
});

afterEach(async () => {
  await issuer?.close();
  issuer = undefined;
  store?.close();
  store = undefined;
  signing?.close();
  signing = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const bindingFor = (issuerUrl: string, scopes: string[] = ["mcp.read"]): OAuthBinding => ({
  credential: NAME,
  issuer: issuerUrl,
  scopes,
  dpop: "prefer"
});

/**
 * A signing store on its own file in the same temp dir (#504).
 *
 * Its own master key, because the store under test holds one of its own and
 * `close()` zeroes whatever buffer it was handed — a shared parse would leave
 * the second holder with 32 zero bytes.
 */
function signingStore(where: string = dir): SigningKeyStore {
  // The path is the *vault's*; the store lives at its sibling `signing.enc`, so
  // two stores meant to hold different keys need two directories rather than
  // two file names.
  return openFileSigningKeyStore({ vaultFile: join(where, "signing-fixture.enc"), key: key() });
}

let signing: SigningKeyStore | undefined;

async function seededEngine(options: {
  issuerOverrides?: Parameters<typeof startFakeTokenIssuer>[0];
  refreshToken?: string;
  now?: () => number;
  logger?: Logger;
  /** A signing store, for the cases that are about proofs rather than grants. */
  signing?: SigningKeyStore;
  /** Extra fields on the stored grant — `jkt` is the one #505 added. */
  grant?: Partial<GrantRecord>;
  dpop?: OAuthBinding["dpop"];
}): Promise<{ engine: TokenEngine; binding: OAuthBinding }> {
  issuer = await startFakeTokenIssuer(options.issuerOverrides ?? {});
  store = openTokenStore({ vaultFile, key: key() });
  await store.putGrant(NAME, {
    issuer: issuer.url,
    clientId: CLIENT_ID,
    refreshToken: options.refreshToken ?? issuer.currentRefreshToken,
    scopes: ["mcp.read"],
    obtainedAt: 1_700_000_000_000,
    ...options.grant
  });
  const engine = createTokenEngine({
    store,
    ...(options.signing !== undefined ? { signing: options.signing } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {})
  });
  return {
    engine,
    binding: { ...bindingFor(issuer.url), ...(options.dpop !== undefined ? { dpop: options.dpop } : {}) }
  };
}

describe("a mint", () => {
  it("exchanges the stored refresh token for a live access token", async () => {
    const { engine, binding } = await seededEngine({});
    const leased = await engine.lease(binding);

    expect(leased.status).toBe("ok");
    if (leased.status !== "ok") throw new Error("lease failed");
    const acquired = await leased.source.acquire();
    expect(acquired?.secret.reveal()).toBe(issuer?.accessTokens[0]);
    expect(issuer?.tokenRequests).toHaveLength(1);
    expect(issuer?.tokenRequests[0]?.form.client_id).toBe(CLIENT_ID);
  });

  it("costs one exchange when many callers arrive at once", async () => {
    const { engine, binding } = await seededEngine({});
    const source = engine.source(binding);

    const acquired = await Promise.all(Array.from({ length: 8 }, () => source.acquire()));

    expect(issuer?.tokenRequests).toHaveLength(1);
    const generations = new Set(acquired.map(entry => entry?.generation));
    expect(generations.size).toBe(1);
  });

  it("logs the mint by name and lifetime, never by value", async () => {
    const { logger, events, text } = recordingLogger();
    const { engine, binding } = await seededEngine({ logger });
    await engine.lease(binding);

    expect(events).toContain("token_minted");
    expect(text()).toContain(NAME);
    expect(text()).not.toContain("at_minted");
    expect(text()).not.toContain("rt_initial");
  });
});

describe("expiry and the margin", () => {
  it("serves from memory until the margin, and refreshes past it", async () => {
    let clock = 1_700_000_000_000;
    const { engine, binding } = await seededEngine({
      now: () => clock,
      issuerOverrides: { expiresInSeconds: 300 }
    });
    const source = engine.source(binding);
    await source.acquire();
    expect(issuer?.tokenRequests).toHaveLength(1);

    // One millisecond inside the margin boundary: still live, no I/O.
    clock += 300_000 - TOKEN_EXPIRY_MARGIN_MS - 1;
    await source.acquire();
    expect(issuer?.tokenRequests).toHaveLength(1);

    // At the boundary the token is treated as dead and minted anew.
    clock += 1;
    await source.acquire();
    expect(issuer?.tokenRequests).toHaveLength(2);
  });

  it("treats a token with no stated lifetime as live until a 401 says otherwise", async () => {
    let clock = 1_700_000_000_000;
    const { engine, binding } = await seededEngine({
      now: () => clock,
      issuerOverrides: { expiresInSeconds: null }
    });
    const source = engine.source(binding);
    await source.acquire();
    clock += 365 * 24 * 3_600_000;
    await source.acquire();

    expect(issuer?.tokenRequests).toHaveLength(1);
  });

  it("costs one exchange for a stampede through an expired window", async () => {
    let clock = 1_700_000_000_000;
    const { engine, binding } = await seededEngine({
      now: () => clock,
      issuerOverrides: { expiresInSeconds: 60 }
    });
    const source = engine.source(binding);
    await source.acquire();
    clock += 120_000;

    await Promise.all(Array.from({ length: 8 }, () => source.acquire()));

    expect(issuer?.tokenRequests).toHaveLength(2);
  });
});

describe("rotation", () => {
  it("persists the successor, so a restart is not a re-grant", async () => {
    issuer = await startFakeTokenIssuer();
    const k = key();
    const keyBytes = Buffer.from(k);
    store = openTokenStore({ vaultFile, key: k });
    await store.putGrant(NAME, {
      issuer: issuer.url,
      clientId: CLIENT_ID,
      refreshToken: issuer.currentRefreshToken,
      scopes: ["mcp.read"],
      obtainedAt: 1_700_000_000_000
    });
    const binding = bindingFor(issuer.url);

    const first = createTokenEngine({ store });
    expect((await first.lease(binding)).status).toBe("ok");
    // The issuer rotated: the token it will accept next is the successor the
    // exchange persisted, and only the file knows it.
    expect(issuer.currentRefreshToken).not.toBe("rt_initial");

    // A restart: close everything, reopen the same file under the same key.
    first.close();
    store.close();
    const parsed = parseVaultKey(keyBytes.toString("base64"));
    if (!parsed.ok) throw new Error("fixture key failed to re-parse");
    store = openTokenStore({ vaultFile, key: parsed.key });
    const second = createTokenEngine({ store });

    expect((await second.lease(binding)).status).toBe("ok");
    expect(issuer.accessTokens).toHaveLength(2);
    second.close();
  });
});

describe("a grant the store will not serve", () => {
  it("answers no_grant with the store's reason, before any network", async () => {
    const { engine } = await seededEngine({});
    const requests = issuer?.tokenRequests.length ?? 0;

    const wrongIssuer = await engine.lease({ credential: NAME, issuer: "https://other.example", scopes: [], dpop: "prefer" });
    expect(wrongIssuer).toEqual({ status: "no_grant", reason: "issuer_mismatch" });

    const widerScopes = await engine.lease(bindingFor(issuer?.url ?? "", ["mcp.read", "mcp.write"]));
    expect(widerScopes).toEqual({ status: "no_grant", reason: "scopes_exceeded" });

    const unknownName = await engine.lease({
      credential: "absent_grant",
      issuer: issuer?.url ?? "",
      scopes: [],
      dpop: "prefer"
    });
    expect(unknownName).toEqual({ status: "no_grant", reason: "absent" });

    expect(issuer?.tokenRequests).toHaveLength(requests);
    expect(issuer?.discoveryRequests ?? 0).toBe(0);
  });
});

describe("a dead grant", () => {
  it("is grant_dead, logged as invalid_grant — the theft signal — and never retried within the mint", async () => {
    const { logger, events } = recordingLogger();
    const { engine, binding } = await seededEngine({ refreshToken: "rt_stale_stolen", logger });

    const leased = await engine.lease(binding);

    expect(leased).toEqual({ status: "grant_dead" });
    expect(events).toContain("invalid_grant");
    expect(issuer?.tokenRequests).toHaveLength(1);
  });

  it("heals on the next call once the grant is re-run, with no restart", async () => {
    const { engine, binding } = await seededEngine({ refreshToken: "rt_stale_stolen" });
    expect(await engine.lease(binding)).toEqual({ status: "grant_dead" });

    // The operator re-runs the grant flow: a fresh refresh token lands in the
    // store through the same seam the entrypoint (#257) will use.
    await store?.putGrant(NAME, {
      issuer: issuer?.url ?? "",
      clientId: CLIENT_ID,
      refreshToken: issuer?.currentRefreshToken ?? "",
      scopes: ["mcp.read"],
      obtainedAt: 1_700_000_100_000
    });

    expect((await engine.lease(binding)).status).toBe("ok");
  });
});

describe("a mint that fails", () => {
  it("is mint_failed with the exchange's reason, and the next caller retries", async () => {
    const { engine, binding } = await seededEngine({});
    if (issuer !== undefined) {
      issuer.respondToken = () => ({ status: 500, body: { error: "server_error" } });
    }

    const leased = await engine.lease(binding);
    expect(leased).toEqual({ status: "mint_failed", failure: "exchange_failed" });

    // The failure is not memoized: clearing the fault heals the next lease.
    if (issuer !== undefined) issuer.respondToken = undefined;
    expect((await engine.lease(binding)).status).toBe("ok");
  });
});

describe("the 401 straggler", () => {
  it("hands a newer generation back rather than minting again", async () => {
    const { engine, binding } = await seededEngine({});
    const source = engine.source(binding);
    const first = await source.acquire();
    expect(first?.generation).toBe(1);

    // A straggler rejected under a generation that was already superseded: no
    // second exchange, just the current token.
    const fresh = await source.refresh(0);
    expect(fresh?.generation).toBe(1);
    expect(issuer?.tokenRequests).toHaveLength(1);

    // A rejection of the *current* generation is real, and mints.
    const minted = await source.refresh(1);
    expect(minted?.generation).toBe(2);
    expect(issuer?.tokenRequests).toHaveLength(2);
  });

  it("answers null when the grant died mid-session, letting the 401 stand", async () => {
    const { engine, binding } = await seededEngine({ issuerOverrides: { rotate: false } });
    const source = engine.source(binding);
    await source.acquire();

    // The operator revokes the grant at the issuer while a session is live.
    if (issuer !== undefined) {
      issuer.respondToken = () => ({ status: 400, body: { error: "invalid_grant" } });
    }

    expect(await source.refresh(1)).toBeNull();
  });
});

// #505 over a real socket: the client that makes proofs and the server that
// verifies them, meeting. What each half does on its own is asserted in
// outbound.test.ts and fake-token-issuer.test.ts; what is asserted here is that
// they agree — which is the only thing neither of those files can check.
describe("a sender-constrained mint", () => {
  it("proves for the exchange and reports the scheme it got", async () => {
    const { logger, text } = recordingLogger();
    signing = signingStore();
    const { engine, binding } = await seededEngine({
      issuerOverrides: { dpop: true },
      signing,
      logger
    });

    const leased = await engine.lease(binding);
    expect(leased.status).toBe("ok");
    // The fake refused nothing, which is what makes the success meaningful: it
    // checked the signature, the method, the url, the freshness and the jti.
    expect(issuer?.dpopFailures).toEqual([]);
    expect(issuer?.boundThumbprint).toBe((await signing.signingKey()).thumbprint);
    expect(text()).toContain('"scheme":"dpop"');
    engine.close();
  });

  // The retry, over a socket rather than a stub: a fresh proof carrying the
  // server's nonce, which the fake accepts only because the `jti` is new.
  it("answers a nonce challenge and gets its token", async () => {
    signing = signingStore();
    const { engine, binding } = await seededEngine({
      issuerOverrides: { dpop: true, requireNonce: true },
      signing
    });

    expect((await engine.lease(binding)).status).toBe("ok");
    expect(issuer?.dpopFailures).toEqual([]);
    engine.close();
  });

  // `prefer` against an issuer that says nothing is the bearer path, and the
  // engine says so on the line an operator reads.
  it("stays on bearer where the issuer advertises nothing", async () => {
    const { logger, text } = recordingLogger();
    signing = signingStore();
    const { engine, binding } = await seededEngine({ signing, logger });

    expect((await engine.lease(binding)).status).toBe("ok");
    expect(text()).toContain('"scheme":"bearer"');
    engine.close();
  });

  it("refuses rather than downgrading where the binding says require", async () => {
    signing = signingStore();
    const { engine, binding } = await seededEngine({ signing, dpop: "require" });

    expect(await engine.lease(binding)).toEqual({
      status: "mint_failed",
      failure: "dpop_unsupported"
    });
    engine.close();
  });

  // The continuity check, from the proxy's side. A grant bound to a key this
  // process does not hold cannot be refreshed, and saying so here means the
  // refresh token is never spent — the fake sees no token request at all.
  it("will not spend a refresh token bound to a key it no longer holds", async () => {
    const { logger, events } = recordingLogger();
    signing = signingStore();
    const { engine, binding } = await seededEngine({
      issuerOverrides: { dpop: true },
      signing,
      logger,
      grant: { jkt: "a-thumbprint-from-a-key-that-is-gone" }
    });

    expect(await engine.lease(binding)).toEqual({
      status: "mint_failed",
      failure: "dpop_key_mismatch"
    });
    expect(events).toContain("dpop_key_mismatch");
    expect(issuer?.tokenRequests).toHaveLength(0);
    engine.close();
  });

  // What a rejection by the *server* looks like from in here. The proxy's own
  // continuity check cannot catch this one — the record carries no `jkt`, so
  // nothing local knows the issuer bound the grant to another key — and the
  // answer is `exchange_failed` rather than `invalid_grant`: the grant is not
  // dead, this caller just cannot prove for it.
  it("reports the issuer's refusal of a wrong-key proof as a failure to ask", async () => {
    signing = signingStore();
    const { engine, binding } = await seededEngine({
      issuerOverrides: { dpop: true },
      signing
    });
    expect((await engine.lease(binding)).status).toBe("ok");
    engine.close();

    // A second proxy — another signing key, the same grant material, which is
    // what a stolen token store in somebody else's hands amounts to.
    const thiefDir = mkdtempSync(join(tmpdir(), "libero-token-engine-thief-"));
    const thief = signingStore(thiefDir);
    if (store === undefined) throw new Error("fixture not started");
    await store.putGrant(NAME, {
      issuer: issuer?.url ?? "",
      clientId: CLIENT_ID,
      refreshToken: issuer?.currentRefreshToken ?? "",
      scopes: ["mcp.read"],
      obtainedAt: 1_700_000_000_000
    });
    const second = createTokenEngine({ store, signing: thief });

    expect(await second.lease(binding)).toEqual({
      status: "mint_failed",
      failure: "exchange_failed"
    });
    expect(issuer?.dpopFailures).toEqual(["thumbprint_changed"]);
    second.close();
    thief.close();
    rmSync(thiefDir, { recursive: true, force: true });
  });

  // A bearer grant stays refreshable: `jkt` absent is every record written
  // before #505, and the check is about a binding that exists.
  it("refreshes a grant that was never bound at all", async () => {
    signing = signingStore();
    const { engine, binding } = await seededEngine({ signing });

    expect((await engine.lease(binding)).status).toBe("ok");
    engine.close();
  });

  // An engine composed with no signing store has nothing to prove with. Under
  // `prefer` it asks anyway, without a proof — and a strict issuer refuses,
  // which is the honest outcome: the remedy is to compose the store, and the
  // one thing that must not happen is a token arriving anyway.
  it("gets nothing from a proof-demanding issuer when it holds no signing store", async () => {
    const { engine, binding } = await seededEngine({ issuerOverrides: { dpop: true } });

    expect(await engine.lease(binding)).toEqual({
      status: "mint_failed",
      failure: "exchange_failed"
    });
    // The issuer demanded a proof and got none — which is the fake being
    // strict, not the engine being wrong. What a deployment does about it is
    // compose the store; what it must not do is get a token anyway.
    expect(issuer?.dpopFailures).toEqual(["missing_proof"]);
    engine.close();
  });
});
