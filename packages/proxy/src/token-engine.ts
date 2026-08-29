// The token engine — a live access token for each call, shown to nobody.
//
// The serving-path half of the OAuth workstream (#256): given a sheet's auth
// block and the grant material the flow stored (./token-store.ts), keep one
// live access token per credential name in process memory and hand it out as
// a `CredentialSource`. Access tokens are memory-only by the custody decision
// — they die with the process, and a restart costs one token-endpoint round
// trip per upstream at first use, where persisting them would put a live
// bearer token on disk.
//
// The store is read at mint and refresh, never on the call path while a live
// token is in memory — which is also the freshness rule: a grant completed
// while the proxy runs takes effect at the next mint, no restart. Mints are
// single-flighted per credential name, so concurrent calls during an
// expired-token window cost one exchange, not a stampede; the keyed
// map-of-promises is ./mcp-catalog.ts's shape, cleared in a `finally` so a
// failure is never memoized.
//
// Every lifecycle event — grant missing, token minted, token rotated, grant
// dead — goes through the closed log field set, by credential name and issuer
// host; there is still no free-form message for a value to reach.

import { type Logger, createSilentLogger } from "./log.js";
import {
  type CredentialSource,
  TokenExchangeError,
  type TokenExchangeFailure,
  destinationHost,
  exchangeRefreshToken
} from "./outbound.js";
import type { TokenStore } from "./custody.js";
import type { Secret } from "./custody.js";

/**
 * How long before its stated expiry a token is treated as dead.
 *
 * The margin has to cover the gap between this check and the token reaching
 * the upstream's validator — a permit wait (`QUEUE_WAIT_MS` is five seconds),
 * a handshake's round trips — plus whatever clock skew separates this process
 * from the issuer. Thirty seconds buys all of that with an order of magnitude
 * to spare, and its whole cost is one refresh up to thirty seconds early per
 * token lifetime.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 30_000;

/** What the sheet's auth block declares, plus the name that keys the grant. */
export interface OAuthBinding {
  readonly credential: string;
  readonly issuer: string;
  readonly scopes: readonly string[];
}

/**
 * The dispatcher's pre-flight answer. The three failure arms map onto the
 * dispatch outcome's `unavailable` reasons — a dead grant is a failure, not a
 * refusal, because nothing was denied.
 */
export type TokenLease =
  | { readonly status: "ok"; readonly source: CredentialSource }
  | { readonly status: "no_grant"; readonly reason: "absent" | "issuer_mismatch" | "scopes_exceeded" }
  | { readonly status: "grant_dead" }
  | { readonly status: "mint_failed"; readonly failure: TokenExchangeFailure };

export interface TokenEngine {
  /**
   * A source for the catalog path, built without I/O.
   *
   * The listing route's `lease` is synchronous, so this cannot mint; the
   * source mints lazily inside the guarded fetch at the first request, and a
   * grantless upstream still never sees a probe — no-grant is decided at the
   * store read, before any network.
   */
  source(binding: OAuthBinding): CredentialSource;

  /**
   * A live token or one mint, before the pool is touched.
   *
   * The dispatch path's pre-flight, the fail-before-connecting shape
   * `credential_unresolved` already has: a dead grant never sends the
   * upstream so much as a discovery probe.
   */
  lease(binding: OAuthBinding): Promise<TokenLease>;

  /** Drop the cached tokens. The Secrets become unreachable; see vault.ts on heap dumps. */
  close(): void;
}

export interface TokenEngineOptions {
  readonly store: TokenStore;
  readonly logger?: Logger;
  /** Injected so expiry is a decision rather than a wait. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** A grant the store would not serve. Internal: `lease` turns it into its arm. */
class GrantMissingError extends Error {
  readonly missing: "absent" | "issuer_mismatch" | "scopes_exceeded";

  constructor(missing: "absent" | "issuer_mismatch" | "scopes_exceeded") {
    super(`no grant: ${missing}`);
    this.name = "GrantMissingError";
    this.missing = missing;
  }
}

interface TokenEntry {
  readonly accessToken: Secret;
  /** Absent when the issuer named no lifetime: live until a 401 says otherwise. */
  readonly expiresAt: number | undefined;
  readonly generation: number;
}

export function createTokenEngine(options: TokenEngineOptions): TokenEngine {
  const { store } = options;
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? Date.now;

  const tokens = new Map<string, TokenEntry>();
  const minting = new Map<string, Promise<TokenEntry>>();

  const live = (entry: TokenEntry | undefined): entry is TokenEntry =>
    entry !== undefined && (entry.expiresAt === undefined || now() < entry.expiresAt - TOKEN_EXPIRY_MARGIN_MS);

  /**
   * One exchange per name, however many callers arrive during it. Throws
   * `GrantMissingError` or `TokenExchangeError`; the single flight is cleared
   * in the `finally`, so a failed mint is retried by the next caller rather
   * than memoized — a re-grant heals on the next call, no restart, at the
   * price of one bounded issuer round trip per call while a grant is dead.
   */
  const mint = (binding: OAuthBinding): Promise<TokenEntry> => {
    const name = binding.credential;
    const inFlight = minting.get(name);
    if (inFlight !== undefined) return inFlight;

    const destination = destinationHost(binding.issuer) ?? undefined;
    const started = (async (): Promise<TokenEntry> => {
      // Awaited because the contract's `read` is `Awaitable` — a managed
      // backend reaches a network here where the file backend reads a file.
      // Inside the flight rather than before it: `minting.set` below runs
      // synchronously against this IIFE, so the extra microtask cannot let a
      // second caller past the single flight.
      const grant = await store.read(name, { issuer: binding.issuer, scopes: binding.scopes });
      if (grant.status === "missing") {
        logger.log("error", {
          event: "grant_missing",
          credential: name,
          reason: grant.reason,
          ...(destination !== undefined ? { destination } : {})
        });
        throw new GrantMissingError(grant.reason);
      }

      try {
        const minted = await exchangeRefreshToken({
          issuer: binding.issuer,
          clientId: grant.clientId,
          refreshToken: grant.refreshToken,
          credentialName: name,
          persistRotation: async rotated => {
            try {
              await store.rotate(name, { issuer: binding.issuer, scopes: binding.scopes }, rotated);
            } catch (error) {
              logger.log("error", {
                event: "token_rotation_failed",
                credential: name,
                reason: error instanceof Error ? error.name : "unknown"
              });
              throw error;
            }
          },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
        });

        const entry: TokenEntry = {
          accessToken: minted.accessToken,
          expiresAt: minted.expiresInSeconds === undefined ? undefined : now() + minted.expiresInSeconds * 1_000,
          generation: (tokens.get(name)?.generation ?? 0) + 1
        };
        tokens.set(name, entry);
        logger.log("info", {
          event: "token_minted",
          credential: name,
          ...(destination !== undefined ? { destination } : {}),
          ...(minted.expiresInSeconds !== undefined ? { expiresIn: minted.expiresInSeconds } : {})
        });
        if (minted.rotated) logger.log("info", { event: "token_rotated", credential: name });
        return entry;
      } catch (error) {
        if (error instanceof TokenExchangeError && error.failure === "invalid_grant") {
          // Its own event, always — rotation's reuse detection makes a stolen
          // and used refresh token surface as exactly this, so the line is a
          // theft signal for the operator, never a retry.
          logger.log("error", {
            event: "invalid_grant",
            credential: name,
            ...(destination !== undefined ? { destination } : {})
          });
          tokens.delete(name);
        } else if (error instanceof TokenExchangeError) {
          logger.log("error", {
            event: "token_mint_failed",
            credential: name,
            reason: error.failure,
            ...(destination !== undefined ? { destination } : {})
          });
        }
        throw error;
      }
    })().finally(() => minting.delete(name));

    minting.set(name, started);
    return started;
  };

  const source = (binding: OAuthBinding): CredentialSource => ({
    scheme: "oauth",
    name: binding.credential,

    async acquire() {
      const entry = tokens.get(binding.credential);
      if (live(entry)) return { secret: entry.accessToken, generation: entry.generation };
      const fresh = await mint(binding);
      return { secret: fresh.accessToken, generation: fresh.generation };
    },

    async refresh(rejected) {
      // The generation check, `reopenSession`'s model: a straggler whose 401
      // was answered under generation n does not force a second refresh when
      // n+1 already exists — it is handed n+1 and retries with that.
      const current = tokens.get(binding.credential);
      if (current !== undefined && current.generation > rejected) {
        return { secret: current.accessToken, generation: current.generation };
      }
      try {
        const fresh = await mint(binding);
        return { secret: fresh.accessToken, generation: fresh.generation };
      } catch {
        // The mint already logged why. `null` lets the 401 stand, which flows
        // through the client as `unauthorized`; the next dispatch's pre-flight
        // names the state properly.
        return null;
      }
    }
  });

  return {
    source,

    async lease(binding) {
      const entry = tokens.get(binding.credential);
      if (live(entry)) return { status: "ok", source: source(binding) };
      try {
        await mint(binding);
        return { status: "ok", source: source(binding) };
      } catch (error) {
        if (error instanceof GrantMissingError) return { status: "no_grant", reason: error.missing };
        if (error instanceof TokenExchangeError) {
          return error.failure === "invalid_grant"
            ? { status: "grant_dead" }
            : { status: "mint_failed", failure: error.failure };
        }
        throw error;
      }
    },

    close() {
      tokens.clear();
      minting.clear();
    }
  };
}
