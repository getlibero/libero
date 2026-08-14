import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeTokenIssuer } from "./fake-token-issuer.js";
import type { FakeTokenIssuer } from "./fake-token-issuer.js";
import { GRANT_REDIRECT_URI, performAuthorizationGrant } from "./grant-flow.js";
import type { GrantFlowIo, GrantFlowRequest } from "./grant-flow.js";
import { createTokenEngine } from "./token-engine.js";
import { openTokenStore } from "./token-store.js";
import type { TokenStore } from "./token-store.js";
import { parseVaultKey } from "./vault.js";
import type { VaultKey } from "./vault.js";

// The flow against the fake issuer over a real socket and a real store in a
// temp dir, with the test playing the browser: fetch the URL the flow showed,
// read the 302's location, paste it back. That is the whole operator loop
// minus the human, which is the loop the acceptance criteria describe.

const NAME = "notion_grant";
const CLIENT_ID = "https://getlibero.com/client.json";

function key(): VaultKey {
  const parsed = parseVaultKey(randomBytes(32).toString("base64"));
  if (!parsed.ok) throw new Error("fixture key failed to parse");
  return parsed.key;
}

let dir: string;
let vaultFile: string;
let issuer: FakeTokenIssuer | undefined;
let store: TokenStore | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libero-grant-flow-"));
  vaultFile = join(dir, "vault.enc");
});

afterEach(async () => {
  await issuer?.close();
  issuer = undefined;
  store?.close();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * An Io that is the browser: follows the shown URL to the fake's authorize
 * endpoint and pastes the redirect it was sent to, with a hook for tampering
 * on the way. Every string that crossed the Io is kept for leak assertions.
 */
function browserIo(tamper: (location: string) => string = location => location): {
  io: GrantFlowIo;
  seen: string[];
} {
  const seen: string[] = [];
  let shown: string | undefined;
  return {
    seen,
    io: {
      showAuthorizationUrl: url => {
        seen.push(url);
        shown = url;
      },
      promptCallbackUrl: async () => {
        if (shown === undefined) throw new Error("nothing was shown");
        const response = await fetch(shown, { redirect: "manual" });
        const location = response.headers.get("location");
        if (location === null) throw new Error("the fake did not redirect");
        const pasted = tamper(location);
        seen.push(pasted);
        return pasted;
      }
    }
  };
}

function requestOf(io: GrantFlowIo, over: Partial<GrantFlowRequest> = {}): GrantFlowRequest {
  if (issuer === undefined || store === undefined) throw new Error("fixture not started");
  return {
    credential: NAME,
    issuer: issuer.url,
    scopes: ["mcp.read", "mcp.write"],
    clientId: CLIENT_ID,
    store,
    io,
    now: () => 1_700_000_000_000,
    ...over
  };
}

async function started(overrides: Parameters<typeof startFakeTokenIssuer>[0] = {}): Promise<void> {
  issuer = await startFakeTokenIssuer(overrides);
  store = openTokenStore({ vaultFile, key: key() });
}

function live(): FakeTokenIssuer {
  if (issuer === undefined) throw new Error("fixture not started");
  return issuer;
}

describe("the grant, end to end", () => {
  it("authorizes, exchanges and stores a readable grant", async () => {
    await started();
    const { io } = browserIo();
    const outcome = await performAuthorizationGrant(requestOf(io));

    expect(outcome.replaced).toBe(false);
    const read = store?.read(NAME, { issuer: issuer?.url ?? "", scopes: ["mcp.read"] });
    expect(read?.status).toBe("found");
    if (read?.status !== "found") throw new Error("grant not stored");
    expect(read.clientId).toBe(CLIENT_ID);
    expect(read.refreshToken.reveal()).toBe(issuer?.currentRefreshToken);
  });

  it("asks with every PKCE and binding field the front channel needs", async () => {
    await started();
    const { io } = browserIo();
    await performAuthorizationGrant(requestOf(io));

    const asked = issuer?.authorizeRequests[0];
    expect(asked?.response_type).toBe("code");
    expect(asked?.client_id).toBe(CLIENT_ID);
    expect(asked?.redirect_uri).toBe(GRANT_REDIRECT_URI);
    expect(asked?.code_challenge_method).toBe("S256");
    expect(asked?.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(asked?.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(asked?.scope).toBe("mcp.read mcp.write");
  });

  it("omits the scope parameter entirely when the sheets declare none", async () => {
    await started();
    const { io } = browserIo();
    await performAuthorizationGrant(requestOf(io, { scopes: [] }));

    expect(issuer?.authorizeRequests[0]).not.toHaveProperty("scope");
  });

  it("replaces a predecessor and says so, whatever issuer the predecessor named", async () => {
    await started();
    await store?.putGrant(NAME, {
      issuer: "http://previous.example",
      clientId: CLIENT_ID,
      refreshToken: "rt_previous",
      scopes: [],
      obtainedAt: 1
    });
    const { io } = browserIo();
    const outcome = await performAuthorizationGrant(requestOf(io));

    expect(outcome.replaced).toBe(true);
    const read = store?.read(NAME, { issuer: issuer?.url ?? "", scopes: [] });
    expect(read?.status).toBe("found");
  });

  it("feeds the engine: a stored grant mints a live token with no restart between", async () => {
    await started();
    const { io } = browserIo();
    await performAuthorizationGrant(requestOf(io));
    if (store === undefined || issuer === undefined) throw new Error("fixture not started");

    const engine = createTokenEngine({ store });
    const leased = await engine.lease({ credential: NAME, issuer: issuer.url, scopes: ["mcp.read"] });
    expect(leased.status).toBe("ok");
    engine.close();
  });

  it("stores what was granted when the issuer narrows the scopes", async () => {
    await started({ grantedScopeEcho: "mcp.read" });
    const { io } = browserIo();
    await performAuthorizationGrant(requestOf(io));

    expect(store?.read(NAME, { issuer: issuer?.url ?? "", scopes: ["mcp.read"] })?.status).toBe("found");
    // The sheet asking wider than the grant now fails closed, the store's
    // designed answer — not an upstream 403 later.
    const wider = store?.read(NAME, { issuer: issuer?.url ?? "", scopes: ["mcp.read", "mcp.write"] });
    expect(wider).toEqual({ status: "missing", reason: "scopes_exceeded" });
  });
});

describe("what the flow refuses", () => {
  it("a tampered state, before anything is exchanged", async () => {
    await started();
    const { io } = browserIo(location => location.replace(/state=[^&]+/, "state=forged"));

    await expect(performAuthorizationGrant(requestOf(io))).rejects.toMatchObject({ failure: "state_mismatch" });
    expect(issuer?.tokenRequests).toHaveLength(0);
    expect(store?.read(NAME, { issuer: issuer?.url ?? "", scopes: [] })).toEqual({
      status: "missing",
      reason: "absent"
    });
  });

  it("a denial, keeping the RFC's word and dropping any other", async () => {
    await started();
    for (const [word, kept] of [
      ["access_denied", "access_denied"],
      ["made_up_reason", undefined]
    ] as const) {
      live().respondAuthorize = query => ({
        status: 302,
        headers: { location: `${query.redirect_uri}?error=${word}&state=${query.state}` },
        body: ""
      });
      const { io } = browserIo();
      let thrown: unknown;
      try {
        await performAuthorizationGrant(requestOf(io));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ failure: "authorization_denied" });
      expect((thrown as { deniedAs?: string }).deniedAs).toBe(kept);
    }
  });

  it("a paste that is not a URL, one that is empty, and one past the line cap", async () => {
    await started();
    for (const pasted of ["not a url", "", `http://127.0.0.1/callback?${"x".repeat(17 * 1024)}`]) {
      const io: GrantFlowIo = {
        showAuthorizationUrl: () => undefined,
        promptCallbackUrl: async () => pasted
      };
      await expect(performAuthorizationGrant(requestOf(io))).rejects.toMatchObject({
        failure: "callback_not_a_url"
      });
    }
  });

  it("a redirect that carries the right state and no code", async () => {
    await started();
    const { io } = browserIo(location => location.replace(/code=[^&]+&/, ""));
    await expect(performAuthorizationGrant(requestOf(io))).rejects.toMatchObject({ failure: "code_missing" });
  });

  it("a prompt that closes instead of answering", async () => {
    await started();
    const io: GrantFlowIo = {
      showAuthorizationUrl: () => undefined,
      promptCallbackUrl: async () => null
    };
    await expect(performAuthorizationGrant(requestOf(io))).rejects.toMatchObject({ failure: "input_closed" });
  });

  it("metadata with no authorization endpoint, and one off the issuer's origin", async () => {
    for (const authorization_endpoint of [undefined, "http://elsewhere.example/authorize"]) {
      await started();
      live().respondDiscovery = () => ({
        body: {
          issuer: issuer?.url ?? "",
          token_endpoint: `${issuer?.url ?? ""}/token`,
          ...(authorization_endpoint !== undefined ? { authorization_endpoint } : {})
        }
      });
      const { io } = browserIo();
      await expect(performAuthorizationGrant(requestOf(io))).rejects.toMatchObject({
        failure: "no_authorization_endpoint"
      });
      await issuer?.close();
      issuer = undefined;
      store?.close();
      store = undefined;
    }
  });

  it("a methods list without S256; an absent list proceeds", async () => {
    await started();
    live().respondDiscovery = () => ({
      body: {
        issuer: issuer?.url ?? "",
        token_endpoint: `${issuer?.url ?? ""}/token`,
        authorization_endpoint: `${issuer?.url ?? ""}/authorize`,
        code_challenge_methods_supported: ["plain"]
      }
    });
    const { io } = browserIo();
    await expect(performAuthorizationGrant(requestOf(io))).rejects.toMatchObject({ failure: "pkce_unsupported" });

    live().respondDiscovery = () => ({
      body: {
        issuer: issuer?.url ?? "",
        token_endpoint: `${issuer?.url ?? ""}/token`,
        authorization_endpoint: `${issuer?.url ?? ""}/authorize`
      }
    });
    const absent = browserIo();
    await expect(performAuthorizationGrant(requestOf(absent.io))).resolves.toEqual({ replaced: false });
  });

  it("an issuer that grants no refresh token, leaving the store untouched", async () => {
    await started({ issueRefreshToken: false });
    await store?.putGrant(NAME, {
      issuer: issuer?.url ?? "",
      clientId: CLIENT_ID,
      refreshToken: "rt_previous",
      scopes: [],
      obtainedAt: 1
    });
    const { io } = browserIo();
    await expect(performAuthorizationGrant(requestOf(io))).rejects.toMatchObject({ failure: "no_refresh_token" });

    const kept = store?.read(NAME, { issuer: issuer?.url ?? "", scopes: [] });
    expect(kept?.status).toBe("found");
    if (kept?.status !== "found") throw new Error("predecessor lost");
    expect(kept.refreshToken.reveal()).toBe("rt_previous");
  });
});

describe("what never crosses the Io", () => {
  it("shows no code, no verifier and no refresh token, on success or denial", async () => {
    await started();
    const success = browserIo();
    await performAuthorizationGrant(requestOf(success.io));
    const granted = issuer?.currentRefreshToken ?? "";
    const verifierHash = issuer?.authorizeRequests[0]?.code_challenge ?? "";

    // The Io saw the authorization URL and the pasted redirect — the redirect
    // carries the code by design, that is the paste — but the URL the flow
    // *authored* carries only the challenge, and the granted refresh token
    // appears nowhere.
    expect(success.seen[0]).toContain(verifierHash);
    expect(success.seen.join(" ")).not.toContain(granted);

    // A failing run's thrown error carries nothing of the paste either.
    const tampered = browserIo(location => location.replace(/state=[^&]+/, "state=forged"));
    let thrown: unknown;
    try {
      await performAuthorizationGrant(requestOf(tampered.io));
    } catch (error) {
      thrown = error;
    }
    const seen = `${String(thrown)} ${JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object))}`;
    expect(seen).not.toContain("code_");
    expect(seen).not.toContain("forged");
  });
});
